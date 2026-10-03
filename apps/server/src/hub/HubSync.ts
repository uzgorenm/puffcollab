/**
 * HubSync - this server's connection to a Puff Collab team hub (Stage 7).
 *
 * - Link: a PKCE link code the user approves on the hub yields a long-lived
 *   environment credential, kept in the server secret store (never settings,
 *   never logs). The hub URL and account live in SQLite (`hub_link`).
 * - Publish (owner side): a reactor off committed orchestration events turns
 *   each shared thread in a hub-linked project into a contiguous hub stream
 *   (`toHubThreadEventBody` + `redactForHub`) in a durable SQLite queue. A
 *   thread's stream starts with a bootstrap rebuilt from its current state, so
 *   sharing later carries recent history. Private threads and unlinked
 *   projects are never read into the queue.
 * - Ingest (follower side): teammates' shared threads become read-only
 *   mirrors. Their events run through the ordinary engine as
 *   `thread.hub-mirror.apply`, so shells, thread streams, search and resume
 *   all work unchanged; `metadata.hubOrigin` keeps reactors off them and
 *   ThreadAccess rejects every command but comments.
 * - Comments on any hub-linked thread go to the hub; hub comments project
 *   into the thread's comments. Neither ever reaches a provider.
 * - Team data (brief, focus, activity, members, invitations, analysis) is
 *   mirrored in memory for Team overview (`teamSnapshot`, `subscribeTeam`).
 *
 * @module HubSync
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  CommandId,
  HubLocalInvitationsResult as HubLocalInvitationsResultSchema,
  HubLocalStatus as HubLocalStatusSchema,
  HubThreadEventBody as HubThreadEventBodySchema,
  HubThreadLink as HubThreadLinkSchema,
  HUB_CLOSE_CODES,
  HUB_LINK_CODE_TTL_SECONDS,
  HUB_PING,
  HUB_PONG,
  HUB_PROTOCOL_RANGE,
  HUB_SYNC_LIMITS,
  HUB_SYNC_PATH,
  HubClientFrame,
  type HubClientMessage,
  type HubAccount,
  type HubEnvironmentLinkId,
  HubLinkProjectResult,
  HubLinkStartResponse,
  HubLinkTokenResponse,
  type HubLocalInvitation,
  type HubLocalInvitationsResult,
  type HubLocalProjectLink,
  type HubLocalStatus,
  HubLocalError,
  type HubPendingLink,
  type HubProjectId,
  type HubProjectInvitation,
  HubProjectLinkResponse,
  type HubProjectState,
  HubServerFrame,
  type HubServerMessage,
  type HubThreadCursor,
  type HubThreadEventBody,
  type HubThreadId,
  type HubThreadLink,
  type HubThreadSummary,
  hubProtocolMismatchSide,
  hubRepositoryKey,
  hubThreadIdOf,
  type HubConfigureInput,
  type HubInvitationCancelInput,
  type HubInvitationRespondInput,
  type HubInviteInput,
  type HubLinkProjectInput,
  type HubUnlinkProjectInput,
  normalizeGithubLogin,
  type OrchestrationEvent,
  parseHubThreadId,
  ProjectId,
  type ThreadHubMirrorEvent,
  ThreadId,
  toHubThreadEventBody,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { redactForHub } from "@t3tools/shared/hubRedaction";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as HubTransport from "./HubTransport.ts";
import {
  type HubOutboundRow,
  type HubPublishedThreadRow,
  type HubRemoteThreadRow,
  makeHubStore,
} from "./hubStore.ts";
import {
  accountOrPlaceholder,
  bootstrapBodies,
  HUB_BOOTSTRAP_TURN_LIMIT,
  hubSummaryOf,
  mirrorThreadIdOf,
  sameSummary,
  toLocalInvitation,
  toMirrorEvent,
} from "./hubThreads.ts";

/** Secret-store entry holding the environment credential. */
export const HUB_CREDENTIAL_SECRET = "hub-environment-credential";

const KEEPALIVE_INTERVAL = "25 seconds";
const KEEPALIVE_TIMEOUT_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT = "15 seconds";
const STATUS_QUEUE_REFRESH = "1 second";
const CURSOR_SAVE_EVERY = 500;

/** One project the hub account belongs to, and the local projects linked to it. */
export interface HubTeamProject {
  readonly state: HubProjectState;
  readonly localProjectIds: ReadonlyArray<ProjectId>;
}

/** Team data mirrored from the hub, for Team overview (Stage 7.4). */
export interface HubTeamSnapshot {
  readonly account: HubAccount | null;
  readonly projects: ReadonlyArray<HubTeamProject>;
  /** This account's pending incoming invitations. */
  readonly incomingInvitations: ReadonlyArray<HubProjectInvitation>;
}

export class HubSync extends Context.Service<
  HubSync,
  {
    /** Starts publishing and, when linked, the hub connection. Reactor entry point. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly status: Effect.Effect<HubLocalStatus>;
    readonly subscribeStatus: Stream.Stream<HubLocalStatus>;
    readonly configure: (input: HubConfigureInput) => Effect.Effect<HubLocalStatus, HubLocalError>;
    readonly linkStart: () => Effect.Effect<HubPendingLink, HubLocalError>;
    readonly linkCancel: () => Effect.Effect<HubLocalStatus, HubLocalError>;
    readonly unlink: () => Effect.Effect<HubLocalStatus, HubLocalError>;
    readonly linkProject: (
      input: HubLinkProjectInput,
    ) => Effect.Effect<HubLinkProjectResult, HubLocalError>;
    readonly unlinkProject: (
      input: HubUnlinkProjectInput,
    ) => Effect.Effect<HubLocalStatus, HubLocalError>;
    readonly subscribeInvitations: Stream.Stream<HubLocalInvitationsResult>;
    readonly invite: (input: HubInviteInput) => Effect.Effect<HubLocalInvitation, HubLocalError>;
    readonly respondInvitation: (
      input: HubInvitationRespondInput,
    ) => Effect.Effect<HubLocalInvitation, HubLocalError>;
    readonly cancelInvitation: (
      input: HubInvitationCancelInput,
    ) => Effect.Effect<HubLocalInvitation, HubLocalError>;
    /** Team data from the hub now. */
    readonly teamSnapshot: Effect.Effect<HubTeamSnapshot>;
    /** Team data now and after every change. */
    readonly subscribeTeam: Stream.Stream<HubTeamSnapshot>;
    /** The full patch of a teammate's turn, when the hub delivered one. */
    readonly getRemoteTurnDiff: (
      threadId: ThreadId,
      checkpointTurnCount: number,
    ) => Effect.Effect<string | null>;
    /** Resolves once the publisher has processed everything queued so far (tests). */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/hub/HubSync") {}

const hubError = (reason: HubLocalError["reason"], message: string) =>
  new HubLocalError({ reason, message });

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const errorFromHubStatus = (status: number, fallback: string): HubLocalError => {
  switch (status) {
    case 401:
      return hubError("not-linked", "The hub no longer accepts this server's link.");
    case 403:
      return hubError("forbidden", "The hub refused that.");
    case 404:
      return hubError("not-found", "The hub could not find that.");
    case 409:
      return hubError("conflict", "That conflicts with the hub's current state.");
    case 400:
      return hubError("invalid", "The hub rejected that request.");
    default:
      return hubError("unavailable", fallback);
  }
};

const errorFromReject = (reason: string, message: string): HubLocalError => {
  switch (reason) {
    case "unauthorized":
      return hubError("not-linked", message);
    case "forbidden":
      return hubError("forbidden", message);
    case "not-found":
      return hubError("not-found", message);
    case "conflict":
      return hubError("conflict", message);
    case "invalid":
      return hubError("invalid", message);
    default:
      return hubError("unavailable", message);
  }
};

const normalizeHubUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

const syncUrlOf = (hubUrl: string) => `${hubUrl.replace(/^http/, "ws")}${HUB_SYNC_PATH}`;

const decodeServerFrame = Schema.decodeUnknownOption(HubServerFrame);
const isHubLocalError = Schema.is(HubLocalError);
const encodeHubLink = Schema.encodeSync(Schema.fromJsonString(HubThreadLinkSchema));
const encodeEventBody = Schema.encodeSync(Schema.fromJsonString(HubThreadEventBodySchema));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(HubLocalStatusSchema));
const encodeInvitations = Schema.encodeSync(Schema.fromJsonString(HubLocalInvitationsResultSchema));
const encodeClientFrame = Schema.encodeSync(HubClientFrame);
const decodeLinkStart = Schema.decodeUnknownEffect(HubLinkStartResponse);
const decodeLinkToken = Schema.decodeUnknownOption(HubLinkTokenResponse);
const decodeProjectLink = Schema.decodeUnknownEffect(HubProjectLinkResponse);

type HubReply =
  | { readonly type: "ack"; readonly cursor?: HubThreadCursor | undefined }
  | {
      readonly type: "reject";
      readonly reason: string;
      readonly message: string;
      readonly expectedSeq?: number | undefined;
    };

interface Session {
  readonly socket: HubTransport.HubSocket;
  welcomed: boolean;
  versionMessage: string | null;
  lastReceivedAt: number;
  readonly subscribed: Set<HubThreadId>;
  readonly inFlight: Map<ThreadId, { readonly requestId: string; readonly count: number }>;
  readonly publishRequests: Map<string, ThreadId>;
  readonly commentsInFlight: Set<string>;
  readonly pending: Map<string, Deferred.Deferred<HubReply>>;
}

type PublisherItem =
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "reconcile" }
  | { readonly kind: "bootstrap"; readonly threadId: ThreadId; readonly reset: boolean }
  | { readonly kind: "orphan"; readonly threadId: ThreadId; readonly cursor: HubThreadCursor };

interface TeamState {
  readonly account: HubAccount | null;
  readonly projects: ReadonlyMap<HubProjectId, HubProjectState>;
  readonly incoming: ReadonlyArray<HubProjectInvitation>;
}

interface ThreadFacts {
  readonly projectId: ProjectId;
  readonly shared: boolean;
  readonly deleted: boolean;
  readonly remote: boolean;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}

const make = Effect.gen(function* () {
  const transport = yield* HubTransport.HubTransport;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeHubStore;
  const homeDirs = [NodeOS.homedir()].filter((dir) => dir.length > 1);

  const initialLink = yield* store.getLink.pipe(Effect.orDie);
  const initialProjects = yield* store.listProjectLinks.pipe(Effect.orDie);
  const initialQueued = yield* store.countOutbound().pipe(Effect.orDie);

  // Runtime state. Every mutation happens on fibers of this service; JS runs
  // them one at a time, so plain variables are safe between yields.
  let linkId: HubEnvironmentLinkId | null = initialLink.linkId;
  let account: HubAccount | null = initialLink.account;
  let hubUrl: string | null = initialLink.hubUrl;
  let projectLinks = new Map(initialProjects.map((row) => [row.projectId, row]));
  let session: Session | null = null;
  let online = false;
  let serviceScope: Scope.Scope | null = null;
  let connectionFiber: Fiber.Fiber<void> | null = null;
  let linkFiber: Fiber.Fiber<void> | null = null;
  let lastProcessedSequence = 0;
  let processedSinceSave = 0;
  let queuedDirty = false;
  const hubLinkMemo = new Map<ThreadId, string>();

  const status = yield* SubscriptionRef.make<HubLocalStatus>({
    state: linkId !== null ? "offline" : "unlinked",
    hubUrl,
    account,
    linkId,
    pendingLink: null,
    projects: [],
    queuedEvents: initialQueued,
    lastError: null,
  });
  const team = yield* SubscriptionRef.make<TeamState>({
    account,
    projects: new Map(),
    incoming: [],
  });
  const outboxSignal = yield* Queue.sliding<void>(1);

  const updateStatus = (patch: Partial<HubLocalStatus>) =>
    SubscriptionRef.update(status, (current) => ({ ...current, ...patch }));

  const projectLinksOf = (): ReadonlyArray<HubLocalProjectLink> =>
    [...projectLinks.values()].map((row) => ({
      projectId: row.projectId,
      hubProjectId: row.hubProjectId,
      hubProjectTitle: row.hubProjectTitle,
    }));

  const reloadProjectLinks = Effect.gen(function* () {
    const rows = yield* store.listProjectLinks;
    projectLinks = new Map(rows.map((row) => [row.projectId, row]));
    yield* updateStatus({ projects: projectLinksOf() });
  });

  const localProjectsOf = (hubProjectId: HubProjectId) =>
    [...projectLinks.values()]
      .filter((row) => row.hubProjectId === hubProjectId)
      .map((row) => row.projectId);

  // queuedEvents changes on every published event; clients hear about the
  // empty/non-empty edge at once and about counts at most once a second.
  const refreshQueued = Effect.gen(function* () {
    const count = yield* store.countOutbound();
    const current = yield* SubscriptionRef.get(status);
    if ((current.queuedEvents === 0) !== (count === 0)) {
      yield* updateStatus({ queuedEvents: count });
    } else if (current.queuedEvents !== count) {
      queuedDirty = true;
    }
  }).pipe(Effect.ignore);

  const signalOutbox = Queue.offer(outboxSignal, undefined).pipe(Effect.asVoid);

  const forkInService = <A, E>(effect: Effect.Effect<A, E>) =>
    serviceScope === null
      ? Effect.succeed(null)
      : Effect.forkIn(
          effect.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("team hub task failed", { cause: Cause.pretty(cause) }),
            ),
            Effect.asVoid,
          ),
          serviceScope,
        );

  // ---------------------------------------------------------------------------
  // Credential
  // ---------------------------------------------------------------------------

  const readCredential = secrets.get(HUB_CREDENTIAL_SECRET).pipe(
    Effect.map((value) =>
      Option.isSome(value) ? new TextDecoder().decode(value.value) || null : null,
    ),
    Effect.orElseSucceed(() => null),
  );
  const writeCredential = (credential: string) =>
    secrets
      .set(HUB_CREDENTIAL_SECRET, new TextEncoder().encode(credential))
      .pipe(
        Effect.mapError(() =>
          hubError("unavailable", "Could not store the hub credential on this server."),
        ),
      );
  const forgetCredential = secrets.remove(HUB_CREDENTIAL_SECRET).pipe(Effect.ignore);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newCommandId = Effect.sync(() => CommandId.make(`hub:${NodeCrypto.randomUUID()}`));

  const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isHubLocalError(cause) ? cause : hubError("unavailable", "Team hub sync storage failed."),
      ),
    );

  // ---------------------------------------------------------------------------
  // Thread facts and hub links
  // ---------------------------------------------------------------------------

  const threadFacts = (threadId: ThreadId) =>
    sql<{
      projectId: string;
      visibility: string | null;
      deletedAt: string | null;
      worktreePath: string | null;
      hubLink: string | null;
      workspaceRoot: string | null;
    }>`
      SELECT t.project_id AS "projectId", t.visibility, t.deleted_at AS "deletedAt",
             t.worktree_path AS "worktreePath", t.hub_link_json AS "hubLink",
             p.workspace_root AS "workspaceRoot"
      FROM projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId}
    `.pipe(
      Effect.map((rows): ThreadFacts | null => {
        const row = rows[0];
        if (row === undefined) return null;
        return {
          projectId: ProjectId.make(row.projectId),
          shared: row.visibility === "shared",
          deleted: row.deletedAt !== null,
          remote: row.hubLink !== null && row.hubLink.includes('"remote":true'),
          worktreePath: row.worktreePath,
          workspaceRoot: row.workspaceRoot,
        };
      }),
    );

  /** The hub project a local thread publishes to, or null when it must stay local. */
  const publishTarget = (facts: ThreadFacts | null): HubProjectId | null => {
    if (linkId === null || facts === null) return null;
    if (facts.deleted || !facts.shared || facts.remote) return null;
    return projectLinks.get(facts.projectId)?.hubProjectId ?? null;
  };

  const redactionContext = (facts: ThreadFacts | null) => ({
    workspaceRoots: [facts?.workspaceRoot, facts?.worktreePath].filter(
      (root): root is string => typeof root === "string" && root.length > 1,
    ),
    homeDirs,
  });

  const setHubLink = (threadId: ThreadId, link: HubThreadLink | null) =>
    Effect.gen(function* () {
      const key = link === null ? "null" : encodeHubLink(link);
      if (hubLinkMemo.get(threadId) === key) return;
      yield* engine.dispatch({
        type: "thread.hub-link.set",
        commandId: yield* newCommandId,
        threadId,
        hub: link,
      });
      hubLinkMemo.set(threadId, key);
    }).pipe(Effect.ignore);

  const localLink = (threadId: ThreadId, syncState: HubThreadLink["syncState"]) =>
    linkId === null || account === null
      ? null
      : ({
          threadId: hubThreadIdOf(linkId, threadId),
          ownerId: account.accountId,
          ownerLogin: account.githubLogin,
          ownerDisplayName: account.displayName,
          remote: false,
          syncState,
        } satisfies HubThreadLink);

  const syncStateOf = (threadId: ThreadId) =>
    online
      ? store
          .countOutbound(threadId)
          .pipe(
            Effect.map((count): HubThreadLink["syncState"] => (count > 0 ? "pending" : "synced")),
          )
      : Effect.succeed<HubThreadLink["syncState"]>("offline");

  const refreshSyncState = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const link = localLink(threadId, yield* syncStateOf(threadId));
      if (link !== null) yield* setHubLink(threadId, link);
    }).pipe(Effect.ignore);

  const refreshAllSyncStates = Effect.gen(function* () {
    for (const row of yield* store.listPublished) yield* refreshSyncState(row.threadId);
  }).pipe(Effect.ignore);

  // ---------------------------------------------------------------------------
  // Publisher (owner side)
  // ---------------------------------------------------------------------------

  const toOutbound = (
    threadId: ThreadId,
    hubProjectId: HubProjectId,
    facts: ThreadFacts | null,
    firstSeq: number,
    bodies: ReadonlyArray<{ readonly occurredAt: string; readonly body: HubThreadEventBody }>,
    reset: boolean,
  ): Array<HubOutboundRow> => {
    const context = redactionContext(facts);
    const rows: Array<HubOutboundRow> = [];
    for (const { occurredAt, body } of bodies) {
      const redacted = redactForHub(body, context);
      if (redacted === null) continue;
      const seq = firstSeq + rows.length;
      rows.push({
        threadId,
        seq,
        hubProjectId,
        reset: reset && seq === 1,
        occurredAt,
        truncated: redacted.truncated,
        body: redacted.body,
      });
    }
    return rows;
  };

  const currentSummary = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map((shell) => (Option.isSome(shell) ? hubSummaryOf(shell.value) : null)),
      Effect.orElseSucceed(() => null),
    );

  /** Starts (or restarts, with `reset`) a thread's hub stream from its current state. */
  const bootstrap = (threadId: ThreadId, reset: boolean) =>
    Effect.gen(function* () {
      const facts = yield* threadFacts(threadId);
      const hubProjectId = publishTarget(facts);
      if (hubProjectId === null) return;
      const detail = yield* snapshots.getThreadDetailSnapshot(threadId, {
        turnLimit: HUB_BOOTSTRAP_TURN_LIMIT,
      });
      if (Option.isNone(detail)) return;
      const { thread, snapshotSequence } = detail.value;
      const summary =
        (yield* currentSummary(threadId)) ??
        hubSummaryOf({
          ...thread,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        });
      const rows = toOutbound(
        threadId,
        hubProjectId,
        facts,
        1,
        bootstrapBodies(thread, summary),
        reset,
      );
      const previous = yield* store.getPublished(threadId);
      yield* store.commitPublish({
        clearQueueFor: threadId,
        events: rows,
        published: {
          threadId,
          hubProjectId,
          nextSeq: rows.length + 1,
          ackedSeq: 0,
          generation: previous?.generation ?? null,
          sourceSequence: Math.max(snapshotSequence, previous?.sourceSequence ?? 0),
          summary,
        },
      });
      yield* refreshSyncState(threadId);
      yield* signalOutbox;
    });

  /** Ends a thread's hub stream: the hub drops its mirror on this body. */
  const publishRemoval = (
    published: HubPublishedThreadRow,
    body: HubThreadEventBody,
    occurredAt: string,
    cursor?: number,
  ) =>
    Effect.gen(function* () {
      const rows = toOutbound(
        published.threadId,
        published.hubProjectId,
        null,
        published.nextSeq,
        [{ occurredAt, body }],
        false,
      );
      yield* store.commitPublish({
        published: null,
        deletePublished: published.threadId,
        events: rows,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      yield* setHubLink(published.threadId, null);
      yield* signalOutbox;
    });

  const privateBody = (threadId: ThreadId, at: string): HubThreadEventBody => ({
    type: "thread.visibility-set",
    payload: { threadId, visibility: "private", updatedAt: at },
  });

  const SUMMARY_EVENT_TYPES: ReadonlySet<string> = new Set([
    "thread.meta-updated",
    "thread.session-set",
    "thread.activity-appended",
    "thread.turn-start-requested",
    "thread.turn-diff-completed",
    "thread.settled",
    "thread.unsettled",
    "thread.auto-settled",
  ]);

  const turnDiffBody = (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) =>
    checkpointDiffs
      .getTurnDiff({
        threadId: event.payload.threadId,
        fromTurnCount: Math.max(0, event.payload.checkpointTurnCount - 1),
        toTurnCount: event.payload.checkpointTurnCount,
      })
      .pipe(
        Effect.map((result): HubThreadEventBody => ({
          type: "thread.turn-diff",
          payload: {
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            diff: result.diff,
          },
        })),
        Effect.orElseSucceed(() => null),
      );

  const forwardComment = (
    event: Extract<OrchestrationEvent, { type: "thread.comment-added" | "thread.comment-deleted" }>,
  ) =>
    Effect.gen(function* () {
      if (linkId === null) return;
      const threadId = ThreadId.make(event.aggregateId);
      const remote = yield* store.getRemoteByLocal(threadId);
      const hubThreadId =
        remote?.hubThreadId ??
        ((yield* store.getPublished(threadId)) !== null ? hubThreadIdOf(linkId, threadId) : null);
      if (hubThreadId === null) return;
      yield* store.insertCommentOp(
        event.type === "thread.comment-added"
          ? {
              commentId: event.payload.commentId,
              op: "add",
              hubThreadId,
              text: event.payload.text,
            }
          : { commentId: event.payload.commentId, op: "delete", hubThreadId, text: null },
        event.occurredAt,
      );
      yield* signalOutbox;
    });

  const processEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.sequence <= lastProcessedSequence) return;
      lastProcessedSequence = event.sequence;
      // Hub-applied events (mirrors, hub comments) never go back to the hub.
      if (linkId === null || event.metadata.hubOrigin !== undefined) return;
      if (event.aggregateKind !== "thread") return;
      if (event.type === "thread.comment-added" || event.type === "thread.comment-deleted") {
        return yield* forwardComment(event);
      }
      const threadId = ThreadId.make(event.aggregateId);
      const published = yield* store.getPublished(threadId);
      const facts = yield* threadFacts(threadId);
      const target = publishTarget(facts);
      if (published === null) {
        if (target !== null) yield* bootstrap(threadId, false);
        else if (++processedSinceSave >= CURSOR_SAVE_EVERY) {
          processedSinceSave = 0;
          yield* store.setState("publish_cursor", String(event.sequence));
        }
        return;
      }
      if (event.sequence <= published.sourceSequence) return;
      if (
        event.type === "thread.deleted" ||
        (event.type === "thread.visibility-set" && event.payload.visibility === "private")
      ) {
        return yield* publishRemoval(
          published,
          { type: event.type, payload: event.payload } as HubThreadEventBody,
          event.occurredAt,
          event.sequence,
        );
      }
      if (target === null) {
        return yield* publishRemoval(
          published,
          privateBody(threadId, event.occurredAt),
          event.occurredAt,
          event.sequence,
        );
      }
      const bodies: Array<{ occurredAt: string; body: HubThreadEventBody }> = [];
      const body = toHubThreadEventBody(event);
      if (body !== null) bodies.push({ occurredAt: event.occurredAt, body });
      if (event.type === "thread.turn-diff-completed") {
        const diff = yield* turnDiffBody(event);
        if (diff !== null) bodies.push({ occurredAt: event.occurredAt, body: diff });
      }
      let summary = published.summary;
      if (SUMMARY_EVENT_TYPES.has(event.type)) {
        const next = yield* currentSummary(threadId);
        if (next !== null && !sameSummary(summary, next)) {
          summary = next;
          bodies.push({
            occurredAt: event.occurredAt,
            body: { type: "thread.summary-set", payload: next },
          });
        }
      }
      const rows = toOutbound(threadId, target, facts, published.nextSeq, bodies, false);
      if (rows.length === 0) return;
      yield* store.commitPublish({
        published: {
          ...published,
          hubProjectId: target,
          nextSeq: published.nextSeq + rows.length,
          sourceSequence: event.sequence,
          summary,
        },
        events: rows,
        cursor: event.sequence,
      });
      processedSinceSave = 0;
      yield* signalOutbox;
    });

  /** Brings every thread's stream in line with what should be shared. */
  const reconcile = Effect.gen(function* () {
    if (linkId === null) return;
    const projectIds = [...projectLinks.keys()];
    const wanted = new Set<ThreadId>();
    if (projectIds.length > 0) {
      const rows = yield* sql<{ threadId: string }>`
        SELECT thread_id AS "threadId" FROM projection_threads
        WHERE ${sql.in("project_id", projectIds)}
          AND visibility = 'shared' AND deleted_at IS NULL
          AND (hub_link_json IS NULL OR hub_link_json NOT LIKE '%"remote":true%')
      `;
      for (const row of rows) wanted.add(ThreadId.make(row.threadId));
    }
    const published = yield* store.listPublished;
    const now = yield* nowIso;
    for (const row of published) {
      if (!wanted.has(row.threadId)) {
        yield* publishRemoval(row, privateBody(row.threadId, now), now);
      }
      wanted.delete(row.threadId);
    }
    for (const threadId of wanted) yield* bootstrap(threadId, false);
    yield* signalOutbox;
  });

  /** A stream the hub has but this server lost track of. */
  const handleOrphan = (threadId: ThreadId, cursor: HubThreadCursor) =>
    Effect.gen(function* () {
      if ((yield* store.getPublished(threadId)) !== null) return;
      if (publishTarget(yield* threadFacts(threadId)) !== null) {
        return yield* bootstrap(threadId, true);
      }
      if ((yield* store.countOutbound(threadId)) > 0) return;
      const hubProjectId = [...(yield* SubscriptionRef.get(team)).projects.values()].find((state) =>
        state.threads.some((summary) => summary.threadId === cursor.threadId),
      )?.project.projectId;
      if (hubProjectId === undefined) return;
      const now = yield* nowIso;
      yield* store.commitPublish({
        published: null,
        events: toOutbound(
          threadId,
          hubProjectId,
          null,
          cursor.seq + 1,
          [{ occurredAt: now, body: privateBody(threadId, now) }],
          false,
        ),
      });
    });

  const processItem = (item: PublisherItem) =>
    (() => {
      switch (item.kind) {
        case "event":
          return processEvent(item.event);
        case "reconcile":
          return reconcile;
        case "bootstrap":
          return bootstrap(item.threadId, item.reset);
        case "orphan":
          return handleOrphan(item.threadId, item.cursor);
      }
    })().pipe(
      Effect.andThen(refreshQueued),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("team hub publishing skipped an item", {
              kind: item.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const publisher = yield* makeDrainableWorker(processItem);

  // ---------------------------------------------------------------------------
  // Team data (hub is the source of truth)
  // ---------------------------------------------------------------------------

  const accountsOf = (state: TeamState): ReadonlyMap<string, HubAccount> => {
    const accounts = new Map<string, HubAccount>();
    for (const project of state.projects.values()) {
      for (const entry of project.accounts) accounts.set(entry.accountId, entry);
    }
    if (state.account !== null) accounts.set(state.account.accountId, state.account);
    return accounts;
  };

  const updateProject = (
    projectId: HubProjectId,
    update: (state: HubProjectState) => HubProjectState,
  ) =>
    SubscriptionRef.update(team, (current) => {
      const state = current.projects.get(projectId);
      if (state === undefined) return current;
      const projects = new Map(current.projects);
      projects.set(projectId, update(state));
      return { ...current, projects };
    });

  const toTeamSnapshot = (state: TeamState): HubTeamSnapshot => ({
    account: state.account,
    projects: [...state.projects.values()].map((project) => ({
      state: project,
      localProjectIds: localProjectsOf(project.project.projectId),
    })),
    incomingInvitations: state.incoming,
  });

  const toLocalInvitations = (state: TeamState): HubLocalInvitationsResult => {
    const accounts = accountsOf(state);
    const outgoing = [...state.projects.values()].flatMap((project) =>
      project.invitations.filter(
        (invitation) =>
          state.account !== null &&
          invitation.inviterId === state.account.accountId &&
          invitation.state === "pending",
      ),
    );
    return {
      invitations: [
        ...state.incoming.map((invitation) => toLocalInvitation(invitation, "incoming", accounts)),
        ...outgoing.map((invitation) => toLocalInvitation(invitation, "outgoing", accounts)),
      ],
    };
  };

  // ---------------------------------------------------------------------------
  // Mirrors (follower side)
  // ---------------------------------------------------------------------------

  const isOwnThread = (hubThreadId: HubThreadId) =>
    linkId !== null && parseHubThreadId(hubThreadId).linkId === linkId;

  const send = (current: Session, message: HubClientMessage) =>
    current.socket.send(encodeClientFrame(message));

  const remoteLinkOf = (summary: HubThreadSummary, state: TeamState): HubThreadLink => {
    const owner = accountOrPlaceholder(accountsOf(state), summary.ownerId);
    return {
      threadId: summary.threadId,
      ownerId: summary.ownerId,
      ownerLogin: owner.githubLogin,
      ownerDisplayName: owner.displayName,
      remote: true,
      syncState: "synced",
    };
  };

  const ensureSubscribed = (current: Session, summary: HubThreadSummary) =>
    Effect.gen(function* () {
      if (isOwnThread(summary.threadId) || current.subscribed.has(summary.threadId)) return;
      const localProjectId = localProjectsOf(summary.projectId)[0];
      if (localProjectId === undefined) return;
      if (current.subscribed.size >= HUB_SYNC_LIMITS.subscriptionsMax) return;
      let remote = yield* store.getRemote(summary.threadId);
      if (remote === null) {
        remote = {
          hubThreadId: summary.threadId,
          localThreadId: mirrorThreadIdOf(summary.threadId),
          localProjectId,
          hubProjectId: summary.projectId,
          link: remoteLinkOf(summary, yield* SubscriptionRef.get(team)),
          generation: 0,
          seq: 0,
        };
        yield* store.upsertRemote(remote);
      }
      current.subscribed.add(summary.threadId);
      yield* send(current, {
        type: "thread.subscribe",
        threadId: summary.threadId,
        ...(remote.generation > 0
          ? {
              cursor: {
                threadId: summary.threadId,
                generation: remote.generation,
                seq: remote.seq,
              },
            }
          : {}),
      });
    });

  const removeMirror = (hubThreadId: HubThreadId) =>
    Effect.gen(function* () {
      const remote = yield* store.getRemote(hubThreadId);
      if (remote === null) return;
      yield* engine
        .dispatch({
          type: "thread.hub-mirror.apply",
          commandId: yield* newCommandId,
          threadId: remote.localThreadId,
          hub: remote.link,
          generation: Math.max(1, remote.generation),
          reset: true,
          events: [],
          createdAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
      yield* store.deleteRemote(hubThreadId);
      if (session !== null && session.subscribed.delete(hubThreadId) && session.welcomed) {
        yield* send(session, { type: "thread.unsubscribe", threadId: hubThreadId });
      }
    });

  const removeMirrorsOfProject = (hubProjectId: HubProjectId) =>
    Effect.gen(function* () {
      for (const remote of yield* store.listRemote) {
        if (remote.hubProjectId === hubProjectId) yield* removeMirror(remote.hubThreadId);
      }
    });

  const resubscribe = (current: Session, remote: HubRemoteThreadRow) =>
    Effect.gen(function* () {
      yield* send(current, { type: "thread.unsubscribe", threadId: remote.hubThreadId });
      yield* send(current, {
        type: "thread.subscribe",
        threadId: remote.hubThreadId,
        ...(remote.generation > 0
          ? {
              cursor: {
                threadId: remote.hubThreadId,
                generation: remote.generation,
                seq: remote.seq,
              },
            }
          : {}),
      });
    });

  const onThreadEvents = (
    current: Session,
    message: Extract<HubServerMessage, { type: "thread.events" }>,
  ) =>
    Effect.gen(function* () {
      const remote = yield* store.getRemote(message.threadId);
      if (remote === null) return;
      const reset =
        message.reset === true ||
        (remote.generation !== 0 && message.generation !== remote.generation);
      const base = reset ? 0 : remote.seq;
      const events = message.events.filter((event) => event.seq > base);
      const last = events.at(-1);
      if (last === undefined) {
        if (!reset) return;
      } else if (events[0]!.seq !== base + 1) {
        return yield* resubscribe(current, remote);
      }
      for (const event of events) {
        if (event.body.type === "thread.turn-diff") {
          yield* store.upsertRemoteDiff({
            threadId: remote.localThreadId,
            checkpointTurnCount: event.body.payload.checkpointTurnCount,
            turnId: event.body.payload.turnId,
            diff: event.body.payload.diff,
          });
        }
      }
      const mirrorEvents = events.flatMap((event) => {
        const mirrored = toMirrorEvent(event.body, remote.localThreadId, remote.localProjectId);
        return mirrored === null
          ? []
          : [
              {
                seq: event.seq,
                occurredAt: event.occurredAt,
                event: mirrored as ThreadHubMirrorEvent,
              },
            ];
      });
      if (mirrorEvents.length > 0 || reset) {
        const applied = yield* engine
          .dispatch({
            type: "thread.hub-mirror.apply",
            commandId: yield* newCommandId,
            threadId: remote.localThreadId,
            hub: remote.link,
            generation: message.generation,
            ...(reset ? { reset: true as const } : {}),
            events: mirrorEvents,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.result);
        if (applied._tag === "Failure" && !(reset && mirrorEvents.length === 0)) {
          // The mirror cannot take these events (it never saw thread.created):
          // start it over from the beginning of the hub's stream.
          yield* Effect.logWarning("team hub mirror rebuilt", { threadId: remote.localThreadId });
          const fresh = { ...remote, generation: 0, seq: 0 };
          yield* store.setRemoteCursor(remote.hubThreadId, 0, 0);
          return yield* resubscribe(current, fresh);
        }
      }
      const seq = last?.seq ?? 0;
      yield* store.setRemoteCursor(remote.hubThreadId, message.generation, seq);
      yield* send(current, {
        type: "ack",
        cursors: [{ threadId: message.threadId, generation: message.generation, seq }],
      });
    });

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  const localThreadOfHub = (hubThreadId: HubThreadId) =>
    Effect.gen(function* () {
      if (isOwnThread(hubThreadId)) {
        const threadId = parseHubThreadId(hubThreadId).threadId;
        return (yield* threadFacts(threadId)) === null ? null : threadId;
      }
      return (yield* store.getRemote(hubThreadId))?.localThreadId ?? null;
    });

  const existingComments = (threadId: ThreadId) =>
    sql<{ commentId: string; authorId: string; createdAt: string }>`
      SELECT comment_id AS "commentId", author_id AS "authorId", created_at AS "createdAt"
      FROM projection_thread_comments WHERE thread_id = ${threadId}
    `;

  const addHubComment = (
    threadId: ThreadId,
    comment: Extract<HubServerMessage, { type: "comment.added" }>["comment"],
    known: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      if (known.has(comment.commentId)) return;
      yield* engine
        .dispatch({
          type: "thread.hub-comment.add",
          commandId: yield* newCommandId,
          threadId,
          commentId: comment.commentId,
          text: comment.text,
          author: accountOrPlaceholder(
            accountsOf(yield* SubscriptionRef.get(team)),
            comment.authorId,
          ),
          createdAt: comment.createdAt,
        })
        .pipe(Effect.ignore);
    });

  const deleteHubComment = (threadId: ThreadId, commentId: string) =>
    Effect.gen(function* () {
      yield* engine
        .dispatch({
          type: "thread.hub-comment.delete",
          commandId: yield* newCommandId,
          threadId,
          commentId: commentId as never,
        })
        .pipe(Effect.ignore);
    });

  const onCommentMessage = (
    message: Extract<
      HubServerMessage,
      { type: "comment.snapshot" | "comment.added" | "comment.deleted" }
    >,
  ) =>
    Effect.gen(function* () {
      const hubThreadId =
        message.type === "comment.added" ? message.comment.threadId : message.threadId;
      const threadId = yield* localThreadOfHub(hubThreadId);
      if (threadId === null) return;
      const existing = yield* existingComments(threadId);
      const known = new Set(existing.map((row) => row.commentId));
      switch (message.type) {
        case "comment.added":
          return yield* addHubComment(threadId, message.comment, known);
        case "comment.deleted":
          if (known.has(message.commentId)) yield* deleteHubComment(threadId, message.commentId);
          return;
        case "comment.snapshot": {
          for (const comment of message.comments) yield* addHubComment(threadId, comment, known);
          const inSnapshot = new Set<string>(message.comments.map((comment) => comment.commentId));
          const oldest = message.comments[0]?.createdAt;
          const complete = message.comments.length < HUB_SYNC_LIMITS.commentSnapshotMax;
          for (const row of existing) {
            if (!row.authorId.startsWith("hub:") || inSnapshot.has(row.commentId)) continue;
            if (complete || (oldest !== undefined && row.createdAt >= oldest)) {
              yield* deleteHubComment(threadId, row.commentId);
            }
          }
          return;
        }
      }
    });

  // ---------------------------------------------------------------------------
  // Sending (queue → hub)
  // ---------------------------------------------------------------------------

  const flush = (current: Session) =>
    Effect.gen(function* () {
      if (!current.welcomed || linkId === null) return;
      for (const op of yield* store.listCommentOps) {
        if (current.commentsInFlight.has(op.commentId)) continue;
        current.commentsInFlight.add(op.commentId);
        const requestId = `cmt-${op.commentId}`.slice(0, 128);
        yield* send(
          current,
          op.op === "add" && op.text !== null
            ? {
                type: "comment.add",
                requestId,
                threadId: op.hubThreadId,
                commentId: op.commentId as never,
                text: op.text,
              }
            : {
                type: "comment.delete",
                requestId,
                threadId: op.hubThreadId,
                commentId: op.commentId as never,
              },
        );
      }
      let unacked = [...current.inFlight.values()].reduce((sum, entry) => sum + entry.count, 0);
      for (const threadId of yield* store.listOutboundThreads) {
        if (current.inFlight.has(threadId)) continue;
        const room = Math.min(
          HUB_SYNC_LIMITS.eventsPerBatchMax,
          HUB_SYNC_LIMITS.unackedEventsMax - unacked,
        );
        if (room <= 0) break;
        const rows = yield* store.readOutbound(threadId, room);
        const first = rows[0];
        if (first === undefined) continue;
        const batch: Array<HubOutboundRow> = [];
        let bytes = 512;
        for (const row of rows) {
          if (row.hubProjectId !== first.hubProjectId) break;
          const size = encodeEventBody(row.body).length + 128;
          if (batch.length > 0 && bytes + size > HUB_SYNC_LIMITS.frameMaxBytes - 4_096) break;
          bytes += size;
          batch.push(row);
        }
        const requestId = `pub-${NodeCrypto.randomUUID()}`;
        current.inFlight.set(threadId, { requestId, count: batch.length });
        current.publishRequests.set(requestId, threadId);
        unacked += batch.length;
        yield* send(current, {
          type: "publish",
          requestId,
          projectId: first.hubProjectId,
          threadId: hubThreadIdOf(linkId, threadId),
          ...(first.reset && first.seq === 1 ? { reset: true as const } : {}),
          events: batch.map((row) => ({
            seq: row.seq,
            occurredAt: row.occurredAt,
            ...(row.truncated ? { truncated: true as const } : {}),
            body: row.body,
          })),
        });
      }
    });

  const onPublishReply = (current: Session, threadId: ThreadId, reply: HubReply) =>
    Effect.gen(function* () {
      current.inFlight.delete(threadId);
      if (reply.type === "ack") {
        if (reply.cursor !== undefined) {
          yield* store.acknowledge(threadId, reply.cursor.generation, reply.cursor.seq);
        }
        yield* refreshQueued;
        yield* refreshSyncState(threadId);
      } else if (reply.reason === "conflict" && reply.expectedSeq !== undefined) {
        const lowest = (yield* store.readOutbound(threadId, 1))[0]?.seq;
        if (lowest !== undefined && reply.expectedSeq >= lowest) {
          // The hub already has these; resend from where it expects.
          yield* store.deleteOutboundBefore(threadId, reply.expectedSeq);
          const published = yield* store.getPublished(threadId);
          yield* store.acknowledge(threadId, published?.generation ?? 1, reply.expectedSeq - 1);
        } else {
          // The hub is missing events this server no longer holds: restart the stream.
          yield* publisher.enqueue({ kind: "bootstrap", threadId, reset: true });
        }
      } else {
        yield* Effect.logWarning("team hub refused a thread's events; publishing stopped", {
          threadId,
          reason: reply.reason,
        });
        yield* store.deletePublished(threadId);
        yield* setHubLink(threadId, null);
        yield* refreshQueued;
      }
      yield* signalOutbox;
    });

  const onCommentReply = (current: Session, commentId: string, reply: HubReply) =>
    Effect.gen(function* () {
      current.commentsInFlight.delete(commentId);
      if (reply.type === "reject") {
        yield* Effect.logWarning("team hub refused a comment", { reason: reply.reason });
      }
      yield* store.deleteCommentOp(commentId);
    });

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  const onWelcome = (current: Session, message: Extract<HubServerMessage, { type: "welcome" }>) =>
    Effect.gen(function* () {
      current.welcomed = true;
      if (
        account === null ||
        account.accountId !== message.account.accountId ||
        account.displayName !== message.account.displayName ||
        account.githubLogin !== message.account.githubLogin
      ) {
        account = message.account;
        yield* store.setAccount(message.account);
      }
      yield* SubscriptionRef.set(team, {
        account: message.account,
        projects: new Map(message.projects.map((state) => [state.project.projectId, state])),
        incoming: message.invitations,
      });
      online = true;
      yield* updateStatus({ state: "online", account: message.account, lastError: null });

      const cursors = new Map(message.published.map((cursor) => [cursor.threadId, cursor]));
      for (const row of yield* store.listPublished) {
        if (linkId === null) break;
        const hubThreadId = hubThreadIdOf(linkId, row.threadId);
        const cursor = cursors.get(hubThreadId);
        cursors.delete(hubThreadId);
        if (cursor === undefined) {
          if (row.ackedSeq > 0) {
            yield* publisher.enqueue({ kind: "bootstrap", threadId: row.threadId, reset: false });
          }
        } else if (cursor.seq >= row.nextSeq || cursor.seq < row.ackedSeq) {
          yield* publisher.enqueue({ kind: "bootstrap", threadId: row.threadId, reset: true });
        } else {
          yield* store.acknowledge(row.threadId, cursor.generation, cursor.seq);
        }
      }
      for (const cursor of cursors.values()) {
        if (!isOwnThread(cursor.threadId)) continue;
        yield* publisher.enqueue({
          kind: "orphan",
          threadId: parseHubThreadId(cursor.threadId).threadId,
          cursor,
        });
      }
      yield* publisher.enqueue({ kind: "reconcile" });

      // Teammates' threads: drop mirrors the hub no longer lists, follow new ones.
      const listed = new Set<HubThreadId>();
      for (const state of message.projects) {
        for (const summary of state.threads) listed.add(summary.threadId);
      }
      for (const remote of yield* store.listRemote) {
        if (!listed.has(remote.hubThreadId)) yield* removeMirror(remote.hubThreadId);
      }
      for (const state of message.projects) {
        for (const summary of state.threads) yield* ensureSubscribed(current, summary);
      }
      yield* refreshQueued;
      yield* refreshAllSyncStates;
      yield* signalOutbox;
    });

  const onTeamMessage = (current: Session, message: HubServerMessage) =>
    Effect.gen(function* () {
      switch (message.type) {
        case "team.snapshot": {
          yield* SubscriptionRef.update(team, (state) => {
            const projects = new Map(state.projects);
            projects.set(message.state.project.projectId, message.state);
            return { ...state, projects };
          });
          for (const summary of message.state.threads) yield* ensureSubscribed(current, summary);
          return;
        }
        case "team.removed": {
          yield* SubscriptionRef.update(team, (state) => {
            const projects = new Map(state.projects);
            projects.delete(message.projectId);
            return { ...state, projects };
          });
          return yield* removeMirrorsOfProject(message.projectId);
        }
        case "team.thread": {
          yield* updateProject(message.summary.projectId, (state) => ({
            ...state,
            threads: [
              ...state.threads.filter((summary) => summary.threadId !== message.summary.threadId),
              message.summary,
            ],
          }));
          return yield* ensureSubscribed(current, message.summary);
        }
        case "team.brief":
          return yield* updateProject(message.brief.projectId, (state) => ({
            ...state,
            brief: message.brief,
          }));
        case "team.focus":
          return yield* updateProject(message.projectId, (state) => ({
            ...state,
            focuses: [
              ...state.focuses.filter((focus) => focus.accountId !== message.accountId),
              ...(message.focus === null ? [] : [message.focus]),
            ],
          }));
        case "team.activity":
          return yield* updateProject(message.projectId, (state) => {
            const ids = new Set(message.items.map((item) => item.id));
            return {
              ...state,
              activity: [
                ...message.items,
                ...state.activity.filter((item) => !ids.has(item.id)),
              ].slice(0, HUB_SYNC_LIMITS.activitySnapshotMax),
            };
          });
        case "team.members":
          return yield* updateProject(message.projectId, (state) => ({
            ...state,
            members: message.members,
            accounts: message.accounts,
          }));
        case "team.invitations":
          return yield* updateProject(message.projectId, (state) => ({
            ...state,
            invitations: message.invitations,
          }));
        case "team.analysis":
          return yield* updateProject(message.projectId, (state) => {
            const ids = new Set(message.summaries.map((summary) => summary.threadId));
            return {
              ...state,
              analyses: [
                ...state.analyses.filter((summary) => !ids.has(summary.threadId)),
                ...message.summaries,
              ],
            };
          });
        case "team.awareness":
          return yield* updateProject(message.projectId, (state) => {
            const ids = new Set(message.items.map((item) => item.itemId));
            return {
              ...state,
              awareness: [
                ...state.awareness.filter((item) => !ids.has(item.itemId)),
                ...message.items,
              ],
            };
          });
        case "invitations":
          return yield* SubscriptionRef.update(team, (state) => ({
            ...state,
            incoming: message.invitations,
          }));
        default:
          return;
      }
    });

  const resolvePending = (current: Session, requestId: string, reply: HubReply) =>
    Effect.gen(function* () {
      const publishThread = current.publishRequests.get(requestId);
      if (publishThread !== undefined) {
        current.publishRequests.delete(requestId);
        return yield* onPublishReply(current, publishThread, reply);
      }
      if (requestId.startsWith("cmt-")) {
        return yield* onCommentReply(current, requestId.slice(4), reply);
      }
      const deferred = current.pending.get(requestId);
      if (deferred !== undefined) {
        current.pending.delete(requestId);
        yield* Deferred.succeed(deferred, reply);
      }
    });

  const handleFrame = (current: Session, frame: string) =>
    Effect.gen(function* () {
      current.lastReceivedAt = yield* Clock.currentTimeMillis;
      if (frame === HUB_PONG || frame === HUB_PING) return;
      const decoded = decodeServerFrame(frame);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      switch (message.type) {
        case "welcome":
          return yield* onWelcome(current, message);
        case "ack":
          return yield* resolvePending(current, message.requestId, {
            type: "ack",
            cursor: message.cursor,
          });
        case "reject":
          if (message.requestId === null) {
            if (message.reason === "version-mismatch") {
              const side =
                message.protocol === undefined
                  ? null
                  : hubProtocolMismatchSide(HUB_PROTOCOL_RANGE, message.protocol);
              current.versionMessage =
                side === "client-outdated"
                  ? "Update Puff Collab to keep syncing with this team hub."
                  : side === "hub-outdated"
                    ? "This team hub is out of date for this version of Puff Collab."
                    : "This server and the team hub speak different sync versions.";
            }
            return yield* Effect.logWarning("team hub refused the connection", {
              reason: message.reason,
            });
          }
          return yield* resolvePending(current, message.requestId, {
            type: "reject",
            reason: message.reason,
            message: message.message,
            expectedSeq: message.expectedSeq,
          });
        case "thread.events":
          return yield* onThreadEvents(current, message);
        case "thread.removed":
          return yield* removeMirror(message.threadId);
        case "comment.snapshot":
        case "comment.added":
        case "comment.deleted":
          return yield* onCommentMessage(message);
        default:
          return yield* onTeamMessage(current, message);
      }
    });

  interface SessionOutcome {
    readonly code: number;
    readonly reason: string;
    readonly welcomed: boolean;
    readonly versionMessage: string | null;
  }

  const runSession = (url: string, credential: string) =>
    Effect.gen(function* () {
      const socket = yield* transport.connect({ url: syncUrlOf(url), bearer: credential });
      const current: Session = {
        socket,
        welcomed: false,
        versionMessage: null,
        lastReceivedAt: yield* Clock.currentTimeMillis,
        subscribed: new Set(),
        inFlight: new Map(),
        publishRequests: new Map(),
        commentsInFlight: new Set(),
        pending: new Map(),
      };
      session = current;
      const resumed = (yield* store.listRemote).filter((remote) => remote.generation > 0);
      for (const remote of resumed) current.subscribed.add(remote.hubThreadId);
      yield* send(current, {
        type: "hello",
        protocol: HUB_PROTOCOL_RANGE,
        subscriptions: resumed.map((remote) => ({
          threadId: remote.hubThreadId,
          generation: remote.generation,
          seq: remote.seq,
        })),
      });
      // Raw ping/pong keepalive; a silent hub is a dead connection.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep(KEEPALIVE_INTERVAL);
          const now = yield* Clock.currentTimeMillis;
          if (now - current.lastReceivedAt > KEEPALIVE_TIMEOUT_MS) {
            yield* socket.close(4000, "keepalive timeout");
          } else {
            yield* socket.send(HUB_PING);
          }
        }).pipe(Effect.forever),
      );
      yield* Effect.forkScoped(
        Queue.take(outboxSignal).pipe(
          Effect.andThen(flush(current)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("team hub send failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.forever,
        ),
      );
      yield* socket.incoming.pipe(
        Stream.runForEach((frame) =>
          handleFrame(current, frame).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("team hub frame skipped", { cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      );
      const closed = yield* socket.closed;
      return {
        ...closed,
        welcomed: current.welcomed,
        versionMessage: current.versionMessage,
      } satisfies SessionOutcome;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const current = session;
          session = null;
          online = false;
          if (current !== null) {
            for (const deferred of current.pending.values()) {
              yield* Deferred.succeed(deferred, {
                type: "reject",
                reason: "offline",
                message: "The team hub disconnected.",
              });
            }
          }
        }),
      ),
    );

  const backoffMs = (attempt: number) =>
    Random.next.pipe(
      Effect.map((jitter) => {
        const ceiling = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
        );
        return Math.round(ceiling * (0.5 + jitter / 2));
      }),
    );

  const runConnection = Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const credential = yield* readCredential;
      if (hubUrl === null || linkId === null || credential === null) {
        return yield* updateStatus({ state: linkId === null ? "unlinked" : "error" });
      }
      yield* updateStatus({ state: "connecting" });
      const outcome = yield* Effect.scoped(runSession(hubUrl, credential)).pipe(
        Effect.catchTag("HubTransportError", (error) =>
          Effect.succeed<SessionOutcome>({
            code: 1006,
            reason: error.message,
            welcomed: false,
            versionMessage: null,
          }),
        ),
      );
      yield* refreshAllSyncStates;
      if (outcome.code === HUB_CLOSE_CODES.versionMismatch || outcome.versionMessage !== null) {
        return yield* updateStatus({
          state: "version-mismatch",
          lastError:
            outcome.versionMessage ?? "This server and the team hub speak different sync versions.",
        });
      }
      if (
        outcome.code === HUB_CLOSE_CODES.unauthorized ||
        outcome.code === HUB_CLOSE_CODES.linkRevoked
      ) {
        return yield* updateStatus({
          state: "error",
          lastError: "The team hub no longer accepts this server's link. Link it again.",
        });
      }
      if (outcome.code === HUB_CLOSE_CODES.replaced) {
        // Another connection for this link took over; do not fight it.
        return yield* updateStatus({
          state: "offline",
          lastError: "Another connection for this link replaced this one. Restart to reconnect.",
        });
      }
      attempt = outcome.welcomed ? 1 : attempt + 1;
      yield* updateStatus({ state: "offline" });
      yield* Effect.sleep(yield* backoffMs(attempt));
    }
  });

  const stopConnection = Effect.gen(function* () {
    const fiber = connectionFiber;
    connectionFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  });

  const restartConnection = Effect.gen(function* () {
    yield* stopConnection;
    if (hubUrl === null || linkId === null) return;
    connectionFiber = yield* forkInService(runConnection);
  });

  // ---------------------------------------------------------------------------
  // Requests over the socket
  // ---------------------------------------------------------------------------

  const request = (build: (requestId: string) => HubClientMessage) =>
    Effect.gen(function* () {
      const current = session;
      if (current === null || !current.welcomed) {
        return yield* hubError("offline", "The team hub is not connected.");
      }
      const requestId = `req-${NodeCrypto.randomUUID()}`;
      const deferred = yield* Deferred.make<HubReply>();
      current.pending.set(requestId, deferred);
      yield* send(current, build(requestId));
      const reply = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(hubError("unavailable", "The team hub did not answer.")),
        }),
        Effect.ensuring(Effect.sync(() => current.pending.delete(requestId))),
      );
      if (reply.type === "reject") return yield* errorFromReject(reply.reason, reply.message);
    });

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  const requireHubUrl = Effect.suspend(() =>
    hubUrl === null
      ? Effect.fail(hubError("not-configured", "Set a team hub address first."))
      : Effect.succeed(hubUrl),
  );

  const http = (input: {
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    readonly bearer?: string;
  }) =>
    Effect.gen(function* () {
      const base = yield* requireHubUrl;
      return yield* transport
        .request({
          method: input.method,
          url: `${base}${input.path}`,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.bearer !== undefined ? { bearer: input.bearer } : {}),
        })
        .pipe(Effect.mapError(() => hubError("offline", "Could not reach the team hub.")));
    });

  // ---------------------------------------------------------------------------
  // Link flow
  // ---------------------------------------------------------------------------

  const completeLink = (result: Extract<HubLinkTokenResponse, { status: "linked" }>) =>
    Effect.gen(function* () {
      const previousAccount = account;
      yield* writeCredential(result.credential);
      if (linkId !== result.linkId) {
        // Hub thread ids embed the link id; old streams cannot continue.
        yield* store.clearPublishing;
        hubLinkMemo.clear();
      }
      if (previousAccount !== null && previousAccount.accountId !== result.account.accountId) {
        yield* sql`DELETE FROM hub_project_links`;
      }
      yield* store.setLinked(result.linkId, result.account, yield* nowIso);
      linkId = result.linkId;
      account = result.account;
      lastProcessedSequence = yield* engine.latestSequence;
      yield* store.setState("publish_cursor", String(lastProcessedSequence));
      yield* reloadProjectLinks;
      yield* SubscriptionRef.update(team, (state) => ({ ...state, account: result.account }));
      yield* updateStatus({
        state: "connecting",
        linkId: result.linkId,
        account: result.account,
        pendingLink: null,
        lastError: null,
      });
      yield* publisher.enqueue({ kind: "reconcile" });
      yield* restartConnection;
    });

  const pollLink = (
    requestId: HubLinkStartResponse["requestId"],
    codeVerifier: string,
    initialInterval: number,
  ) =>
    Effect.gen(function* () {
      let interval = initialInterval;
      const finish = (lastError: string) =>
        updateStatus({
          state: linkId === null ? "unlinked" : online ? "online" : "offline",
          pendingLink: null,
          lastError,
        });
      while (true) {
        yield* Effect.sleep(`${interval} seconds`);
        const response = yield* http({
          method: "POST",
          path: "/v1/link/token",
          body: { requestId, codeVerifier },
        }).pipe(Effect.option);
        if (Option.isNone(response)) continue;
        if (response.value.status === 429) {
          interval += 5;
          continue;
        }
        if (response.value.status === 404) {
          return yield* finish("The link code expired. Start again.");
        }
        const result = decodeLinkToken(response.value.body);
        if (Option.isNone(result)) continue;
        switch (result.value.status) {
          case "pending":
            continue;
          case "denied":
            return yield* finish("The link was denied on the team hub.");
          case "expired":
            return yield* finish("The link code expired. Start again.");
          case "linked":
            return yield* completeLink(result.value);
        }
      }
    });

  const cancelPendingLink = Effect.gen(function* () {
    const fiber = linkFiber;
    linkFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  });

  const linkStart: HubSync["Service"]["linkStart"] = () =>
    Effect.gen(function* () {
      yield* requireHubUrl;
      yield* cancelPendingLink;
      const codeVerifier = toBase64Url(NodeCrypto.randomBytes(32));
      const codeChallenge = toBase64Url(
        NodeCrypto.createHash("sha256").update(codeVerifier).digest(),
      );
      const environmentLabel = (NodeOS.hostname() || "Puff Collab").slice(0, 80);
      const response = yield* http({
        method: "POST",
        path: "/v1/link/requests",
        body: { environmentLabel, codeChallenge, codeChallengeMethod: "S256" },
      });
      if (response.status !== 200 && response.status !== 201) {
        return yield* errorFromHubStatus(response.status, "The team hub could not start linking.");
      }
      const started = yield* decodeLinkStart(response.body).pipe(
        Effect.mapError(() => hubError("unavailable", "The team hub sent an unexpected answer.")),
      );
      const pendingLink: HubPendingLink = {
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        expiresAt: started.expiresAt,
      };
      yield* updateStatus({ state: "linking", pendingLink, lastError: null });
      linkFiber = yield* forkInService(
        pollLink(started.requestId, codeVerifier, started.intervalSeconds).pipe(
          Effect.timeoutOrElse({
            duration: `${HUB_LINK_CODE_TTL_SECONDS + 60} seconds`,
            orElse: () =>
              updateStatus({ pendingLink: null, lastError: "The link code expired. Start again." }),
          }),
        ),
      );
      return pendingLink;
    });

  const currentState = (): HubLocalStatus["state"] =>
    linkId === null ? "unlinked" : online ? "online" : "offline";

  const linkCancel: HubSync["Service"]["linkCancel"] = () =>
    Effect.gen(function* () {
      yield* cancelPendingLink;
      const current = yield* SubscriptionRef.get(status);
      yield* updateStatus({
        pendingLink: null,
        state: current.state === "linking" ? currentState() : current.state,
      });
      return yield* SubscriptionRef.get(status);
    });

  const forgetLink = Effect.gen(function* () {
    yield* cancelPendingLink;
    yield* stopConnection;
    yield* publisher.drain;
    for (const remote of yield* store.listRemote) yield* removeMirror(remote.hubThreadId);
    for (const row of yield* store.listPublished) yield* setHubLink(row.threadId, null);
    yield* store.clearLink;
    yield* forgetCredential;
    linkId = null;
    account = null;
    online = false;
    hubLinkMemo.clear();
    yield* reloadProjectLinks;
    yield* SubscriptionRef.set(team, { account: null, projects: new Map(), incoming: [] });
    yield* updateStatus({
      state: "unlinked",
      account: null,
      linkId: null,
      pendingLink: null,
      queuedEvents: 0,
    });
  });

  const unlink: HubSync["Service"]["unlink"] = () =>
    Effect.gen(function* () {
      const credential = yield* readCredential;
      if (credential !== null && hubUrl !== null) {
        // Best effort: the local link is forgotten even if the hub is unreachable.
        yield* http({ method: "DELETE", path: "/v1/environment", bearer: credential }).pipe(
          Effect.ignore,
        );
      }
      yield* persistence(forgetLink);
      yield* updateStatus({ lastError: null });
      return yield* SubscriptionRef.get(status);
    });

  const configure: HubSync["Service"]["configure"] = (input) =>
    Effect.gen(function* () {
      const next = input.hubUrl === null ? null : normalizeHubUrl(input.hubUrl);
      if (input.hubUrl !== null && next === null) {
        return yield* hubError("invalid", "Enter the team hub's http or https address.");
      }
      if (next !== hubUrl && linkId !== null) yield* unlink();
      yield* persistence(store.setHubUrl(next));
      hubUrl = next;
      yield* updateStatus({ hubUrl: next, lastError: null });
      return yield* SubscriptionRef.get(status);
    });

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  const requireCredential = Effect.gen(function* () {
    const credential = yield* readCredential;
    if (linkId === null || credential === null) {
      return yield* hubError("not-linked", "Link this server to the team hub first.");
    }
    return credential;
  });

  const linkProject: HubSync["Service"]["linkProject"] = (input) =>
    Effect.gen(function* () {
      const credential = yield* requireCredential;
      const project = yield* snapshots
        .getProjectShellById(input.projectId)
        .pipe(Effect.mapError(() => hubError("unavailable", "Could not read the project.")));
      if (Option.isNone(project))
        return yield* hubError("not-found", "That project was not found.");
      const repositoryKey =
        project.value.repositoryIdentity == null
          ? null
          : hubRepositoryKey(project.value.repositoryIdentity);
      if (repositoryKey === null) {
        return yield* hubError(
          "invalid",
          "This project needs a git remote before it can be linked to the team hub.",
        );
      }
      const response = yield* http({
        method: "POST",
        path: "/v1/projects/link",
        bearer: credential,
        body: {
          repositoryKey,
          title: project.value.title.slice(0, 200),
          ...(input.hubProjectId !== undefined ? { projectId: input.hubProjectId } : {}),
        },
      });
      if (response.status !== 200 && response.status !== 201) {
        return yield* errorFromHubStatus(
          response.status,
          "The team hub could not link the project.",
        );
      }
      const linked = yield* decodeProjectLink(response.body).pipe(
        Effect.mapError(() => hubError("unavailable", "The team hub sent an unexpected answer.")),
      );
      const link: HubLocalProjectLink = {
        projectId: input.projectId,
        hubProjectId: linked.project.projectId,
        hubProjectTitle: linked.project.title,
      };
      yield* persistence(
        Effect.gen(function* () {
          yield* store.upsertProjectLink(link, yield* nowIso);
          yield* reloadProjectLinks;
        }),
      );
      yield* publisher.enqueue({ kind: "reconcile" });
      const current = session;
      if (current !== null && current.welcomed) {
        const state = (yield* SubscriptionRef.get(team)).projects.get(link.hubProjectId);
        for (const summary of state?.threads ?? []) {
          yield* ensureSubscribed(current, summary).pipe(Effect.ignore);
        }
      }
      return {
        link,
        alternatives: linked.alternatives
          .filter((alternative) => alternative.projectId !== linked.project.projectId)
          .map((alternative) => ({
            hubProjectId: alternative.projectId,
            title: alternative.title,
          })),
      } satisfies HubLinkProjectResult;
    });

  const unlinkProject: HubSync["Service"]["unlinkProject"] = (input) =>
    persistence(
      Effect.gen(function* () {
        const link = projectLinks.get(input.projectId);
        if (link !== undefined) {
          yield* store.deleteProjectLink(input.projectId);
          yield* reloadProjectLinks;
          // The publisher publishes removals for this project's shared threads.
          yield* publisher.enqueue({ kind: "reconcile" });
          if (localProjectsOf(link.hubProjectId).length === 0) {
            yield* removeMirrorsOfProject(link.hubProjectId);
          }
        }
        return yield* SubscriptionRef.get(status);
      }),
    );

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  const invite: HubSync["Service"]["invite"] = (input) =>
    Effect.gen(function* () {
      const link = projectLinks.get(input.projectId);
      if (link === undefined) {
        return yield* hubError("invalid", "Link this project to the team hub first.");
      }
      const login = normalizeGithubLogin(input.githubLogin);
      yield* request((requestId) => ({
        type: "invitation.create",
        requestId,
        projectId: link.hubProjectId,
        githubLogin: input.githubLogin,
      }));
      const find = (state: TeamState) =>
        state.projects
          .get(link.hubProjectId)
          ?.invitations.find(
            (invitation) =>
              invitation.state === "pending" &&
              normalizeGithubLogin(invitation.inviteeLogin) === login,
          );
      const invitation = yield* SubscriptionRef.changes(team).pipe(
        Stream.map((state) => [find(state), state] as const),
        Stream.filter(([found]) => found !== undefined),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.succeedNone,
        }),
      );
      if (Option.isNone(invitation)) {
        return yield* hubError("unavailable", "The team hub did not confirm the invitation.");
      }
      const [found, state] = invitation.value;
      if (found === undefined) {
        return yield* hubError("unavailable", "The team hub did not confirm the invitation.");
      }
      return toLocalInvitation(found, "outgoing", accountsOf(state));
    });

  const respondInvitation: HubSync["Service"]["respondInvitation"] = (input) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(team);
      const invitation = state.incoming.find((entry) => entry.invitationId === input.invitationId);
      if (invitation === undefined) {
        return yield* hubError("not-found", "That invitation was not found.");
      }
      yield* request((requestId) => ({
        type: input.decision === "accept" ? "invitation.accept" : "invitation.decline",
        requestId,
        invitationId: input.invitationId,
      }));
      return toLocalInvitation(
        { ...invitation, state: input.decision === "accept" ? "accepted" : "declined" },
        "incoming",
        accountsOf(state),
      );
    });

  const cancelInvitation: HubSync["Service"]["cancelInvitation"] = (input) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(team);
      const invitation = [...state.projects.values()]
        .flatMap((project) => project.invitations)
        .find((entry) => entry.invitationId === input.invitationId);
      if (invitation === undefined) {
        return yield* hubError("not-found", "That invitation was not found.");
      }
      yield* request((requestId) => ({
        type: "invitation.cancel",
        requestId,
        invitationId: input.invitationId,
      }));
      return toLocalInvitation(
        { ...invitation, state: "cancelled" },
        "outgoing",
        accountsOf(state),
      );
    });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  const start: HubSync["Service"]["start"] = Effect.fn("HubSync.start")(function* () {
    serviceScope = yield* Effect.scope;
    yield* updateStatus({ projects: projectLinksOf() });
    const memo = yield* sql<{ threadId: string; hubLink: string }>`
      SELECT thread_id AS "threadId", hub_link_json AS "hubLink"
      FROM projection_threads WHERE hub_link_json IS NOT NULL
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of memo) hubLinkMemo.set(ThreadId.make(row.threadId), row.hubLink);

    const domainEvents = yield* engine.subscribeDomainEvents;
    if (linkId !== null) {
      // Resume after the last event that reached the queue, so nothing
      // committed while the server was down is missed.
      const head = yield* engine.latestSequence;
      const saved = yield* store.getState("publish_cursor").pipe(Effect.orElseSucceed(() => null));
      const cursor = saved === null ? head : Number(saved);
      lastProcessedSequence = 0;
      if (cursor < head) {
        yield* engine.readEvents(cursor, head - cursor).pipe(
          Stream.runForEach((event) => publisher.enqueue({ kind: "event", event })),
          Effect.ignore,
        );
      } else {
        lastProcessedSequence = head;
      }
      yield* publisher.enqueue({ kind: "reconcile" });
    } else {
      lastProcessedSequence = yield* engine.latestSequence;
    }
    yield* Effect.forkScoped(
      Stream.runForEach(domainEvents, (event) => publisher.enqueue({ kind: "event", event })),
    );
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.sleep(STATUS_QUEUE_REFRESH);
        if (!queuedDirty) return;
        queuedDirty = false;
        const count = yield* store.countOutbound();
        yield* updateStatus({ queuedEvents: count });
      }).pipe(Effect.ignore, Effect.forever),
    );
    yield* restartConnection;
  });

  return HubSync.of({
    start,
    status: SubscriptionRef.get(status),
    subscribeStatus: SubscriptionRef.changes(status).pipe(
      Stream.changesWith((left, right) => encodeStatus(left) === encodeStatus(right)),
    ),
    configure,
    linkStart,
    linkCancel,
    unlink,
    linkProject,
    unlinkProject,
    subscribeInvitations: SubscriptionRef.changes(team).pipe(
      Stream.map(toLocalInvitations),
      Stream.changesWith((left, right) => encodeInvitations(left) === encodeInvitations(right)),
    ),
    invite,
    respondInvitation,
    cancelInvitation,
    teamSnapshot: SubscriptionRef.get(team).pipe(Effect.map(toTeamSnapshot)),
    subscribeTeam: SubscriptionRef.changes(team).pipe(Stream.map(toTeamSnapshot)),
    getRemoteTurnDiff: (threadId, checkpointTurnCount) =>
      store.getRemoteDiff(threadId, checkpointTurnCount).pipe(Effect.orElseSucceed(() => null)),
    drain: publisher.drain,
  });
});

export const layer = Layer.effect(HubSync, make);
