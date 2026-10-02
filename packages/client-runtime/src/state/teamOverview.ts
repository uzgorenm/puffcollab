import {
  type EnvironmentId,
  isThreadOnTeamOverview,
  type MemberId,
  type OrchestrationThreadShell,
  type ProjectId,
  type TeamActivityItem,
  type TeamActivityPageResult,
  type TeamOverviewSnapshot,
  type TeamOverviewStreamItem,
  type TeamWorkCard,
  type TeamWorkCardAnalysis,
  type TeamWorkCardStatus,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** Live team overview of one project, folded from `subscribeTeamOverview`. */
export type TeamOverviewState = TeamOverviewSnapshot;

/** Applies one stream item. Activity stays newest first and deduplicated by id. */
export function reduceTeamOverview(
  state: TeamOverviewState | null,
  item: TeamOverviewStreamItem,
): TeamOverviewState | null {
  if (item.kind === "snapshot") return item.snapshot;
  if (state === null) return null;
  switch (item.kind) {
    case "brief":
      return state.brief !== null && state.brief.version >= item.brief.version
        ? state
        : { ...state, brief: item.brief };
    case "focus": {
      const others = state.focuses.filter((focus) => focus.memberId !== item.memberId);
      return { ...state, focuses: item.focus === null ? others : [item.focus, ...others] };
    }
    case "activity":
      return { ...state, activity: mergeActivity(item.items, state.activity) };
  }
}

/** Appends an older activity page fetched with `activityNextBeforeSequence`. */
export function appendOlderTeamActivity(
  state: TeamOverviewState,
  page: TeamActivityPageResult,
): TeamOverviewState {
  return {
    ...state,
    activity: mergeActivity(state.activity, page.items),
    activityNextBeforeSequence: page.nextBeforeSequence,
  };
}

function mergeActivity(
  newer: ReadonlyArray<TeamActivityItem>,
  older: ReadonlyArray<TeamActivityItem>,
): ReadonlyArray<TeamActivityItem> {
  const seen = new Set<string>();
  const merged: TeamActivityItem[] = [];
  for (const item of [...newer, ...older]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged.sort((left, right) => right.sequence - left.sequence);
}

type WorkCardStatusInput = Pick<
  OrchestrationThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
  | "backgroundLiveness"
  | "settledAt"
>;

/**
 * Deterministic work-card status. Precedence: blocked on a person, live work,
 * failure, then rest. Mirrors the sidebar's status order so a thread reads the
 * same everywhere; a failed session outranks lingering background work.
 */
export function deriveTeamWorkCardStatus(thread: WorkCardStatusInput): TeamWorkCardStatus {
  if (thread.hasPendingApprovals) return "waiting-approval";
  if (thread.hasPendingUserInput) return "waiting-input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "errored";
  }
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return "working";
  }
  if (thread.settledAt != null) return "settled";
  return "idle";
}

const STATUS_ORDER: Readonly<Record<TeamWorkCardStatus, number>> = {
  "waiting-approval": 0,
  "waiting-input": 1,
  working: 2,
  errored: 3,
  idle: 4,
  settled: 5,
};

type WorkCardThreadInput = WorkCardStatusInput &
  Pick<
    OrchestrationThreadShell,
    | "id"
    | "projectId"
    | "title"
    | "createdBy"
    | "visibility"
    | "updatedAt"
    | "branch"
    | "worktreePath"
    | "archivedAt"
  >;

/**
 * One card per thread of `projectId` on `memberId`'s team overview, most
 * urgent first, then most recently active. `analysisByThreadId` is the
 * extension point for agent-written summaries: pass whatever the analysis
 * feature has; threads without an entry get `analysis: null`.
 */
export function deriveTeamWorkCards(input: {
  readonly threads: ReadonlyArray<WorkCardThreadInput>;
  readonly projectId: ProjectId;
  readonly memberId: MemberId;
  readonly analysisByThreadId?: ReadonlyMap<ThreadId, TeamWorkCardAnalysis>;
}): ReadonlyArray<TeamWorkCard> {
  return input.threads
    .filter(
      (thread) =>
        thread.projectId === input.projectId &&
        thread.archivedAt === null &&
        isThreadOnTeamOverview(thread, input.memberId),
    )
    .map((thread): TeamWorkCard => ({
      threadId: thread.id,
      projectId: thread.projectId,
      ownerId: thread.createdBy ?? null,
      title: thread.title,
      status: deriveTeamWorkCardStatus(thread),
      lastActivityAt: thread.updatedAt,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      analysis: input.analysisByThreadId?.get(thread.id) ?? null,
    }))
    .sort(
      (left, right) =>
        STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
        right.lastActivityAt.localeCompare(left.lastActivityAt),
    );
}

// Bumped after a brief save so brief history refetches.
const briefRevision = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:team-overview:brief-revision:${environmentId}`),
  ),
);

const bumpBriefRevision = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.update(briefRevision(target.environmentId), (revision) => revision + 1);
  });

/** Puff Collab team overview atoms shared by web and mobile. */
export function createTeamOverviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  return {
    /** The folded live overview; null until the first snapshot arrives. */
    overview: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:team-overview:overview",
      idleTtlMs: 30_000,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeTeamOverview>) =>
        subscribe(WS_METHODS.subscribeTeamOverview, input).pipe(
          Stream.scan(null as TeamOverviewState | null, reduceTeamOverview),
          Stream.filter((state): state is TeamOverviewState => state !== null),
        ),
    }),
    briefHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:team-overview:brief-history",
      tag: WS_METHODS.teamOverviewBriefHistory,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId }) => briefRevision(environmentId),
    }),
    activityPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-overview:activity-page",
      tag: WS_METHODS.teamOverviewActivityPage,
    }),
    updateBrief: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-overview:update-brief",
      tag: WS_METHODS.teamOverviewUpdateBrief,
      scheduler,
      concurrency,
      onSettled: bumpBriefRevision,
    }),
    setFocus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-overview:set-focus",
      tag: WS_METHODS.teamOverviewSetFocus,
      scheduler,
      concurrency,
    }),
  };
}
