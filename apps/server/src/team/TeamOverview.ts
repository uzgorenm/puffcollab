/**
 * TeamOverview - Puff Collab's per-project team view: the versioned project
 * brief, each member's current focus, and the recent activity feed.
 *
 * Brief and focus changes are orchestration commands on the project aggregate
 * (`project.brief.update`, `project.member-focus.set`) so they get the event
 * log's history and `metadata.actor` authorship for free; this service is the
 * only dispatcher and checks project membership first. Reads come from the
 * `projection.team-overview` tables. Activity is filtered per viewer: shared
 * threads plus the viewer's own (see `isThreadOnTeamOverview`).
 *
 * @module TeamOverview
 */
import {
  CommandId,
  isThreadOnTeamOverview,
  MemberId,
  type OrchestrationEvent,
  type ProjectBriefHistoryInput,
  type ProjectBriefHistoryResult,
  type ProjectBriefUpdateInput,
  type ProjectBriefVersion,
  ProjectId,
  type ProjectMemberFocus,
  type ProjectMemberFocusSetInput,
  type ProjectMemberFocusSetResult,
  TEAM_ACTIVITY_SNAPSHOT_LIMIT,
  type TeamActivityItem,
  type TeamActivityKind,
  type TeamActivityPageInput,
  type TeamActivityPageResult,
  type TeamOverviewSnapshot,
  type TeamOverviewStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamAccess from "./TeamAccess.ts";

export class TeamOverviewForbiddenError extends Schema.TaggedError<TeamOverviewForbiddenError>()(
  "TeamOverviewForbiddenError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `You are not a member of project ${this.projectId}.`;
  }
}

export class TeamOverviewBriefConflictError extends Schema.TaggedError<TeamOverviewBriefConflictError>()(
  "TeamOverviewBriefConflictError",
  { projectId: Schema.String, currentVersion: Schema.NullOr(Schema.Number) },
) {
  override get message(): string {
    return "The brief changed since you started editing. Reload it and try again.";
  }
}

export class TeamOverviewDispatchError extends Schema.TaggedError<TeamOverviewDispatchError>()(
  "TeamOverviewDispatchError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to save the team overview change (${this.operation}).`;
  }
}

export class TeamOverviewPersistenceError extends Schema.TaggedError<TeamOverviewPersistenceError>()(
  "TeamOverviewPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Team overview storage failed during ${this.operation}.`;
  }
}

export type TeamOverviewError =
  | TeamOverviewForbiddenError
  | TeamOverviewBriefConflictError
  | TeamOverviewDispatchError
  | TeamOverviewPersistenceError;

export class TeamOverview extends Context.Service<
  TeamOverview,
  {
    readonly snapshot: (
      memberId: MemberId,
      projectId: ProjectId,
    ) => Effect.Effect<TeamOverviewSnapshot, TeamOverviewError>;
    /** A snapshot, then brief/focus/activity deltas until the scope closes. */
    readonly stream: (
      memberId: MemberId,
      projectId: ProjectId,
    ) => Stream.Stream<TeamOverviewStreamItem, TeamOverviewError>;
    readonly activityPage: (
      memberId: MemberId,
      input: TeamActivityPageInput,
    ) => Effect.Effect<TeamActivityPageResult, TeamOverviewError>;
    readonly briefHistory: (
      memberId: MemberId,
      input: ProjectBriefHistoryInput,
    ) => Effect.Effect<ProjectBriefHistoryResult, TeamOverviewError>;
    /** Saves a new brief version authored by `memberId`. */
    readonly updateBrief: (
      memberId: MemberId,
      input: ProjectBriefUpdateInput,
    ) => Effect.Effect<ProjectBriefVersion, TeamOverviewError>;
    /** Sets or clears `memberId`'s own focus. */
    readonly setFocus: (
      memberId: MemberId,
      input: ProjectMemberFocusSetInput,
    ) => Effect.Effect<ProjectMemberFocusSetResult, TeamOverviewError>;
  }
>()("t3/team/TeamOverview") {}

interface BriefRow {
  readonly projectId: string;
  readonly version: number;
  readonly text: string;
  readonly authorId: string | null;
  readonly createdAt: string;
}

interface FocusRow {
  readonly projectId: string;
  readonly memberId: string;
  readonly focus: string;
  readonly updatedAt: string;
}

interface ActivityRow {
  readonly activityId: string;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly kind: string;
  readonly actorId: string | null;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly sequence: number;
}

const toBrief = (row: BriefRow): ProjectBriefVersion => ({
  projectId: ProjectId.make(row.projectId),
  version: row.version,
  text: row.text,
  authorId: row.authorId === null ? null : MemberId.make(row.authorId),
  createdAt: row.createdAt,
});

const toFocus = (row: FocusRow): ProjectMemberFocus => ({
  projectId: ProjectId.make(row.projectId),
  memberId: MemberId.make(row.memberId),
  focus: row.focus,
  updatedAt: row.updatedAt,
});

const toActivity = (row: ActivityRow): TeamActivityItem => ({
  id: row.activityId,
  projectId: ProjectId.make(row.projectId),
  kind: row.kind as TeamActivityKind,
  threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
  actorId: row.actorId === null ? null : MemberId.make(row.actorId),
  detail: row.detail,
  occurredAt: row.occurredAt,
  sequence: row.sequence,
});

/** Events that can add a row to the activity feed. */
const ACTIVITY_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "project.brief-updated",
  "project.member-focus-set",
  "thread.created",
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.activity-appended",
]);

// Rows scanned per page before returning, so private threads of others cannot
// make one page request scan the whole feed.
const MAX_PAGE_SCAN_BATCHES = 5;
const LIVE_COALESCE_MAX = 64;
const LIVE_COALESCE_WINDOW = "100 millis";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const teamAccess = yield* TeamAccess.TeamAccess;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TeamOverviewPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new TeamOverviewPersistenceError({ operation, cause })),
      );

  const requireProjectMember = (memberId: MemberId, projectId: ProjectId) =>
    teamAccess.isProjectMember(memberId, projectId).pipe(
      persistence("requireProjectMember"),
      Effect.flatMap((isMember) =>
        isMember ? Effect.void : Effect.fail(new TeamOverviewForbiddenError({ projectId })),
      ),
    );

  const latestBrief = (projectId: ProjectId) =>
    sql<BriefRow>`
      SELECT project_id AS "projectId", version, text, author_id AS "authorId", created_at AS "createdAt"
      FROM projection_team_brief_versions
      WHERE project_id = ${projectId}
      ORDER BY version DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toBrief(rows[0]))),
      persistence("latestBrief"),
    );

  const listFocuses = (projectId: ProjectId) =>
    sql<FocusRow>`
      SELECT project_id AS "projectId", member_id AS "memberId", focus, updated_at AS "updatedAt"
      FROM projection_team_member_focus
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC, member_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(toFocus)),
      persistence("listFocuses"),
    );

  const findFocus = (projectId: ProjectId, memberId: MemberId) =>
    sql<FocusRow>`
      SELECT project_id AS "projectId", member_id AS "memberId", focus, updated_at AS "updatedAt"
      FROM projection_team_member_focus
      WHERE project_id = ${projectId} AND member_id = ${memberId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toFocus(rows[0]))),
      persistence("findFocus"),
    );

  const activityRows = (input: {
    readonly projectId: ProjectId;
    readonly beforeSequence?: number;
    readonly afterSequence?: number;
    readonly limit: number;
  }) =>
    sql<ActivityRow>`
      SELECT
        activity_id AS "activityId",
        project_id AS "projectId",
        thread_id AS "threadId",
        kind,
        actor_id AS "actorId",
        detail,
        occurred_at AS "occurredAt",
        sequence
      FROM projection_team_activity
      WHERE project_id = ${input.projectId}
        AND sequence < ${input.beforeSequence ?? Number.MAX_SAFE_INTEGER}
        AND sequence > ${input.afterSequence ?? -1}
      ORDER BY sequence DESC, activity_id DESC
      LIMIT ${input.limit}
    `.pipe(persistence("activityRows"));

  /** Keeps project-level rows and rows of threads on the member's overview. */
  const filterVisible = (memberId: MemberId, rows: ReadonlyArray<ActivityRow>) =>
    Effect.gen(function* () {
      const threadIds = [
        ...new Set(rows.flatMap((row) => (row.threadId === null ? [] : [row.threadId]))),
      ];
      const visibleThreads = new Set<string>();
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          snapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
            Effect.map((shell) => {
              if (Option.isSome(shell) && isThreadOnTeamOverview(shell.value, memberId)) {
                visibleThreads.add(threadId);
              }
            }),
          ),
        { concurrency: 1, discard: true },
      ).pipe(persistence("filterVisible"));
      return rows
        .filter((row) => row.threadId === null || visibleThreads.has(row.threadId))
        .map(toActivity);
    });

  /**
   * Newest-first visible activity before `beforeSequence`. The returned cursor
   * is the last row scanned, which may be a hidden row, so the next page never
   * rescans rows the member cannot see.
   */
  const scanActivity = (
    memberId: MemberId,
    projectId: ProjectId,
    beforeSequence: number | undefined,
    limit: number,
  ) =>
    Effect.gen(function* () {
      const items: TeamActivityItem[] = [];
      let cursor = beforeSequence;
      for (let batch = 0; batch < MAX_PAGE_SCAN_BATCHES; batch += 1) {
        const rows = yield* activityRows({
          projectId,
          ...(cursor === undefined ? {} : { beforeSequence: cursor }),
          limit,
        });
        const visible = new Map(
          (yield* filterVisible(memberId, rows)).map((item) => [item.id, item]),
        );
        for (const row of rows) {
          cursor = row.sequence;
          const item = visible.get(row.activityId);
          if (item !== undefined) items.push(item);
          if (items.length === limit) return { items, nextBeforeSequence: cursor };
        }
        if (rows.length < limit) return { items, nextBeforeSequence: null };
      }
      return { items, nextBeforeSequence: cursor ?? null };
    });

  const snapshot: TeamOverview["Service"]["snapshot"] = (memberId, projectId) =>
    Effect.gen(function* () {
      yield* requireProjectMember(memberId, projectId);
      const [brief, focuses, page] = yield* Effect.all([
        latestBrief(projectId),
        listFocuses(projectId),
        scanActivity(memberId, projectId, undefined, TEAM_ACTIVITY_SNAPSHOT_LIMIT),
      ]);
      return {
        projectId,
        brief,
        focuses,
        activity: page.items,
        activityNextBeforeSequence: page.nextBeforeSequence,
      } satisfies TeamOverviewSnapshot;
    });

  const headSequence = (projectId: ProjectId) =>
    sql<{ readonly sequence: number | null }>`
      SELECT MAX(sequence) AS "sequence" FROM projection_team_activity WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((rows) => rows[0]?.sequence ?? 0),
      persistence("headSequence"),
    );

  const stream: TeamOverview["Service"]["stream"] = (memberId, projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so nothing lands between snapshot and deltas.
        const events = yield* engine.subscribeDomainEvents;
        let cursor = yield* headSequence(projectId);
        const initial = yield* snapshot(memberId, projectId);

        const deltasFor = (batch: ReadonlyArray<OrchestrationEvent>) =>
          Effect.gen(function* () {
            const out: TeamOverviewStreamItem[] = [];
            const relevant = batch.filter((event) => ACTIVITY_EVENT_TYPES.has(event.type));
            if (relevant.length === 0) return out;
            for (const event of relevant) {
              if (event.type === "project.brief-updated" && event.payload.projectId === projectId) {
                const brief = yield* latestBrief(projectId);
                if (brief !== null) out.push({ kind: "brief", brief });
              } else if (
                event.type === "project.member-focus-set" &&
                event.payload.projectId === projectId
              ) {
                const focus = yield* findFocus(projectId, event.payload.memberId);
                out.push({ kind: "focus", memberId: event.payload.memberId, focus });
              }
            }
            const rows = yield* activityRows({
              projectId,
              afterSequence: cursor,
              limit: TEAM_ACTIVITY_SNAPSHOT_LIMIT,
            });
            const newest = rows[0];
            if (newest !== undefined) {
              cursor = newest.sequence;
              const items = yield* filterVisible(memberId, rows);
              if (items.length > 0) out.push({ kind: "activity", items });
            }
            return out;
          });

        // Losing project membership ends the stream.
        const revocations = teamAccess.visibilityChanges.pipe(
          Stream.filter((changed) => changed === memberId),
          Stream.mapEffect(() => requireProjectMember(memberId, projectId)),
          Stream.drain,
        );

        const deltas = events.pipe(
          Stream.groupedWithin(LIVE_COALESCE_MAX, LIVE_COALESCE_WINDOW),
          Stream.mapEffect(deltasFor),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

        return Stream.succeed<TeamOverviewStreamItem>({ kind: "snapshot", snapshot: initial }).pipe(
          Stream.concat(Stream.merge(deltas, revocations)),
        );
      }),
    );

  const activityPage: TeamOverview["Service"]["activityPage"] = (memberId, input) =>
    requireProjectMember(memberId, input.projectId).pipe(
      Effect.andThen(scanActivity(memberId, input.projectId, input.beforeSequence, input.limit)),
    );

  const briefHistory: TeamOverview["Service"]["briefHistory"] = (memberId, input) =>
    Effect.gen(function* () {
      yield* requireProjectMember(memberId, input.projectId);
      const rows = yield* sql<BriefRow>`
        SELECT project_id AS "projectId", version, text, author_id AS "authorId", created_at AS "createdAt"
        FROM projection_team_brief_versions
        WHERE project_id = ${input.projectId}
          AND version < ${input.beforeVersion ?? Number.MAX_SAFE_INTEGER}
        ORDER BY version DESC
        LIMIT ${input.limit + 1}
      `.pipe(persistence("briefHistory"));
      return {
        versions: rows.slice(0, input.limit).map(toBrief),
        hasMore: rows.length > input.limit,
      };
    });

  const dispatch = (
    operation: string,
    memberId: MemberId,
    build: (commandId: CommandId, createdAt: string) => Parameters<typeof engine.dispatch>[0],
  ) =>
    Effect.gen(function* () {
      const commandId = CommandId.make(yield* crypto.randomUUIDv4);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return yield* engine.dispatch(build(commandId, createdAt), { actor: memberId });
    }).pipe(Effect.mapError((cause) => new TeamOverviewDispatchError({ operation, cause })));

  const updateBrief: TeamOverview["Service"]["updateBrief"] = (memberId, input) =>
    Effect.gen(function* () {
      yield* requireProjectMember(memberId, input.projectId);
      const current = yield* latestBrief(input.projectId);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== input.expectedVersion) {
        return yield* new TeamOverviewBriefConflictError({
          projectId: input.projectId,
          currentVersion,
        });
      }
      yield* dispatch("updateBrief", memberId, (commandId, createdAt) => ({
        type: "project.brief.update",
        commandId,
        projectId: input.projectId,
        text: input.text,
        createdAt,
      }));
      const saved = yield* latestBrief(input.projectId);
      if (saved === null) {
        return yield* new TeamOverviewPersistenceError({
          operation: "updateBrief:read",
          cause: new Error("The saved brief version was not projected."),
        });
      }
      return saved;
    });

  const setFocus: TeamOverview["Service"]["setFocus"] = (memberId, input) =>
    Effect.gen(function* () {
      yield* requireProjectMember(memberId, input.projectId);
      yield* dispatch("setFocus", memberId, (commandId, createdAt) => ({
        type: "project.member-focus.set",
        commandId,
        projectId: input.projectId,
        memberId,
        focus: input.focus,
        createdAt,
      }));
      return { focus: yield* findFocus(input.projectId, memberId) };
    });

  return TeamOverview.of({
    snapshot,
    stream,
    activityPage,
    briefHistory,
    updateBrief,
    setFocus,
  });
});

export const layer = Layer.effect(TeamOverview, make);
