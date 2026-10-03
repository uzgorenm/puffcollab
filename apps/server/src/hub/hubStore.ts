/**
 * SQLite access for HubSync (tables from migration 090). Plain queries; the
 * sync rules live in HubSync.
 *
 * @module hubStore
 */
import {
  HubAccount,
  HubEnvironmentLinkId,
  HubProjectId,
  HubThreadId,
  HubThreadLink,
  HubThreadSummaryFields,
  ProjectId,
  ThreadId,
  type HubThreadEventBody,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class HubSyncPersistenceError extends Schema.TaggedError<HubSyncPersistenceError>()(
  "HubSyncPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Team hub sync storage failed during ${this.operation}.`;
  }
}

const decodeAccount = Schema.decodeUnknownOption(Schema.fromJsonString(HubAccount));
const decodeLink = Schema.decodeUnknownOption(Schema.fromJsonString(HubThreadLink));
const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(HubThreadSummaryFields));

export interface HubLinkRow {
  readonly hubUrl: string | null;
  readonly linkId: HubEnvironmentLinkId | null;
  readonly account: HubAccount | null;
}

export interface HubProjectLinkRow {
  readonly projectId: ProjectId;
  readonly hubProjectId: HubProjectId;
  readonly hubProjectTitle: string;
}

export interface HubPublishedThreadRow {
  readonly threadId: ThreadId;
  readonly hubProjectId: HubProjectId;
  /** The next `seq` to assign. */
  readonly nextSeq: number;
  /** Highest `seq` the hub accepted. */
  readonly ackedSeq: number;
  readonly generation: number | null;
  /** Orchestration events at or below this sequence are already in the stream. */
  readonly sourceSequence: number;
  readonly summary: HubThreadSummaryFields | null;
}

export interface HubOutboundRow {
  readonly threadId: ThreadId;
  readonly seq: number;
  readonly hubProjectId: HubProjectId;
  readonly reset: boolean;
  readonly occurredAt: string;
  readonly truncated: boolean;
  readonly body: HubThreadEventBody;
}

export interface HubRemoteThreadRow {
  readonly hubThreadId: HubThreadId;
  readonly localThreadId: ThreadId;
  readonly localProjectId: ProjectId;
  readonly hubProjectId: HubProjectId;
  readonly link: HubThreadLink;
  readonly generation: number;
  readonly seq: number;
}

export interface HubCommentOpRow {
  readonly commentId: string;
  readonly op: "add" | "delete";
  readonly hubThreadId: HubThreadId;
  readonly text: string | null;
}

export const makeHubStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const q =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new HubSyncPersistenceError({ operation, cause })));

  const getLink = sql<{
    hubUrl: string | null;
    linkId: string | null;
    accountJson: string | null;
  }>`SELECT hub_url AS "hubUrl", link_id AS "linkId", account_json AS "accountJson"
     FROM hub_link WHERE id = 1`.pipe(
    Effect.map((rows): HubLinkRow => {
      const row = rows[0];
      if (row === undefined) return { hubUrl: null, linkId: null, account: null };
      return {
        hubUrl: row.hubUrl,
        linkId: row.linkId === null ? null : HubEnvironmentLinkId.make(row.linkId),
        account: row.accountJson === null ? null : Option.getOrNull(decodeAccount(row.accountJson)),
      };
    }),
    q("getLink"),
  );

  const setHubUrl = (hubUrl: string | null) =>
    sql`INSERT INTO hub_link (id, hub_url) VALUES (1, ${hubUrl})
        ON CONFLICT (id) DO UPDATE SET hub_url = excluded.hub_url`.pipe(
      Effect.asVoid,
      q("setHubUrl"),
    );

  const setLinked = (linkId: HubEnvironmentLinkId, account: HubAccount, linkedAt: string) =>
    sql`INSERT INTO hub_link (id, link_id, account_json, linked_at)
        VALUES (1, ${linkId}, ${JSON.stringify(account)}, ${linkedAt})
        ON CONFLICT (id) DO UPDATE SET
          link_id = excluded.link_id,
          account_json = excluded.account_json,
          linked_at = excluded.linked_at`.pipe(Effect.asVoid, q("setLinked"));

  const setAccount = (account: HubAccount) =>
    sql`UPDATE hub_link SET account_json = ${JSON.stringify(account)} WHERE id = 1`.pipe(
      Effect.asVoid,
      q("setAccount"),
    );

  /** Forgets everything tied to the hub account; keeps the hub URL. */
  const clearLink = sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE hub_link SET link_id = NULL, account_json = NULL, linked_at = NULL
                   WHERE id = 1`;
        yield* sql`DELETE FROM hub_project_links`;
        yield* sql`DELETE FROM hub_published_threads`;
        yield* sql`DELETE FROM hub_outbound_events`;
        yield* sql`DELETE FROM hub_comment_outbox`;
        yield* sql`DELETE FROM hub_state`;
      }),
    )
    .pipe(q("clearLink"));

  /** Drops the outbound streams (a new link means new hub thread ids). */
  const clearPublishing = sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM hub_published_threads`;
        yield* sql`DELETE FROM hub_outbound_events`;
        yield* sql`DELETE FROM hub_comment_outbox`;
        yield* sql`DELETE FROM hub_state`;
      }),
    )
    .pipe(q("clearPublishing"));

  const getState = (key: string) =>
    sql<{ value: string }>`SELECT value FROM hub_state WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
      q("getState"),
    );

  const setState = (key: string, value: string) =>
    sql`INSERT INTO hub_state (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid, q("setState"));

  const listProjectLinks = sql<{
    projectId: string;
    hubProjectId: string;
    hubProjectTitle: string;
  }>`SELECT project_id AS "projectId", hub_project_id AS "hubProjectId",
            hub_project_title AS "hubProjectTitle"
     FROM hub_project_links ORDER BY linked_at ASC, project_id ASC`.pipe(
    Effect.map((rows) =>
      rows.map((row): HubProjectLinkRow => ({
        projectId: ProjectId.make(row.projectId),
        hubProjectId: HubProjectId.make(row.hubProjectId),
        hubProjectTitle: row.hubProjectTitle,
      })),
    ),
    q("listProjectLinks"),
  );

  const upsertProjectLink = (row: HubProjectLinkRow, linkedAt: string) =>
    sql`INSERT INTO hub_project_links (project_id, hub_project_id, hub_project_title, linked_at)
        VALUES (${row.projectId}, ${row.hubProjectId}, ${row.hubProjectTitle}, ${linkedAt})
        ON CONFLICT (project_id) DO UPDATE SET
          hub_project_id = excluded.hub_project_id,
          hub_project_title = excluded.hub_project_title`.pipe(
      Effect.asVoid,
      q("upsertProjectLink"),
    );

  const deleteProjectLink = (projectId: ProjectId) =>
    sql`DELETE FROM hub_project_links WHERE project_id = ${projectId}`.pipe(
      Effect.asVoid,
      q("deleteProjectLink"),
    );

  type PublishedDbRow = {
    threadId: string;
    hubProjectId: string;
    nextSeq: number;
    ackedSeq: number;
    generation: number | null;
    sourceSequence: number;
    summaryJson: string | null;
  };
  const toPublished = (row: PublishedDbRow): HubPublishedThreadRow => ({
    threadId: ThreadId.make(row.threadId),
    hubProjectId: HubProjectId.make(row.hubProjectId),
    nextSeq: row.nextSeq,
    ackedSeq: row.ackedSeq,
    generation: row.generation,
    sourceSequence: row.sourceSequence,
    summary: row.summaryJson === null ? null : Option.getOrNull(decodeSummary(row.summaryJson)),
  });
  const selectPublished = sql`
    SELECT thread_id AS "threadId", hub_project_id AS "hubProjectId", next_seq AS "nextSeq",
           acked_seq AS "ackedSeq", generation, source_sequence AS "sourceSequence",
           summary_json AS "summaryJson"
    FROM hub_published_threads`;

  const getPublished = (threadId: ThreadId) =>
    sql<PublishedDbRow>`${selectPublished} WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toPublished(rows[0]))),
      q("getPublished"),
    );

  const listPublished = sql<PublishedDbRow>`${selectPublished} ORDER BY thread_id`.pipe(
    Effect.map((rows) => rows.map(toPublished)),
    q("listPublished"),
  );

  const upsertPublishedRaw = (row: HubPublishedThreadRow) =>
    sql`INSERT INTO hub_published_threads
          (thread_id, hub_project_id, next_seq, acked_seq, generation, source_sequence, summary_json)
        VALUES (${row.threadId}, ${row.hubProjectId}, ${row.nextSeq}, ${row.ackedSeq},
                ${row.generation}, ${row.sourceSequence},
                ${row.summary === null ? null : JSON.stringify(row.summary)})
        ON CONFLICT (thread_id) DO UPDATE SET
          hub_project_id = excluded.hub_project_id,
          next_seq = excluded.next_seq,
          acked_seq = excluded.acked_seq,
          generation = excluded.generation,
          source_sequence = excluded.source_sequence,
          summary_json = excluded.summary_json`;

  const insertOutboundRaw = (row: HubOutboundRow) =>
    sql`INSERT OR REPLACE INTO hub_outbound_events
          (thread_id, seq, hub_project_id, reset, occurred_at, truncated, body_json)
        VALUES (${row.threadId}, ${row.seq}, ${row.hubProjectId}, ${row.reset ? 1 : 0},
                ${row.occurredAt}, ${row.truncated ? 1 : 0}, ${JSON.stringify(row.body)})`;

  /**
   * Appends events to a thread's stream and saves its new position together,
   * with the publisher cursor when given, so a crash never duplicates or loses
   * a queued event.
   */
  const commitPublish = (input: {
    readonly published: HubPublishedThreadRow | null;
    readonly deletePublished?: ThreadId;
    readonly clearQueueFor?: ThreadId;
    readonly events: ReadonlyArray<HubOutboundRow>;
    readonly cursor?: number;
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.clearQueueFor !== undefined) {
            yield* sql`DELETE FROM hub_outbound_events WHERE thread_id = ${input.clearQueueFor}`;
          }
          for (const event of input.events) yield* insertOutboundRaw(event);
          if (input.published !== null) yield* upsertPublishedRaw(input.published);
          if (input.deletePublished !== undefined) {
            yield* sql`DELETE FROM hub_published_threads WHERE thread_id = ${input.deletePublished}`;
          }
          if (input.cursor !== undefined) {
            yield* sql`INSERT INTO hub_state (key, value) VALUES ('publish_cursor', ${String(input.cursor)})
                       ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
          }
        }),
      )
      .pipe(q("commitPublish"));

  const deletePublished = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM hub_published_threads WHERE thread_id = ${threadId}`;
          yield* sql`DELETE FROM hub_outbound_events WHERE thread_id = ${threadId}`;
        }),
      )
      .pipe(q("deletePublished"));

  /** Records what the hub accepted and drops those events from the queue. */
  const acknowledge = (threadId: ThreadId, generation: number, seq: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM hub_outbound_events WHERE thread_id = ${threadId} AND seq <= ${seq}`;
          yield* sql`UPDATE hub_published_threads
                     SET acked_seq = MAX(acked_seq, ${seq}), generation = ${generation}
                     WHERE thread_id = ${threadId}`;
        }),
      )
      .pipe(q("acknowledge"));

  type OutboundDbRow = {
    threadId: string;
    seq: number;
    hubProjectId: string;
    reset: number;
    occurredAt: string;
    truncated: number;
    bodyJson: string;
  };
  const readOutbound = (threadId: ThreadId, limit: number) =>
    sql<OutboundDbRow>`
      SELECT thread_id AS "threadId", seq, hub_project_id AS "hubProjectId", reset,
             occurred_at AS "occurredAt", truncated, body_json AS "bodyJson"
      FROM hub_outbound_events WHERE thread_id = ${threadId}
      ORDER BY seq ASC LIMIT ${limit}`.pipe(
      Effect.map((rows) =>
        rows.map((row): HubOutboundRow => ({
          threadId: ThreadId.make(row.threadId),
          seq: row.seq,
          hubProjectId: HubProjectId.make(row.hubProjectId),
          reset: row.reset === 1,
          occurredAt: row.occurredAt,
          truncated: row.truncated === 1,
          // Written by this module from an already-validated body.
          body: JSON.parse(row.bodyJson) as HubThreadEventBody,
        })),
      ),
      q("readOutbound"),
    );

  const listOutboundThreads = sql<{ threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId" FROM hub_outbound_events ORDER BY thread_id`.pipe(
    Effect.map((rows) => rows.map((row) => ThreadId.make(row.threadId))),
    q("listOutboundThreads"),
  );

  const deleteOutboundBefore = (threadId: ThreadId, seq: number) =>
    sql`DELETE FROM hub_outbound_events WHERE thread_id = ${threadId} AND seq < ${seq}`.pipe(
      Effect.asVoid,
      q("deleteOutboundBefore"),
    );

  const countOutbound = (threadId?: ThreadId) =>
    (threadId === undefined
      ? sql<{ count: number }>`SELECT COUNT(*) AS count FROM hub_outbound_events`
      : sql<{ count: number }>`SELECT COUNT(*) AS count FROM hub_outbound_events
                               WHERE thread_id = ${threadId}`
    ).pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      q("countOutbound"),
    );

  type RemoteDbRow = {
    hubThreadId: string;
    localThreadId: string;
    localProjectId: string;
    hubProjectId: string;
    linkJson: string;
    generation: number;
    seq: number;
  };
  const toRemote = (row: RemoteDbRow): HubRemoteThreadRow | null => {
    const link = Option.getOrNull(decodeLink(row.linkJson));
    if (link === null) return null;
    return {
      hubThreadId: HubThreadId.make(row.hubThreadId),
      localThreadId: ThreadId.make(row.localThreadId),
      localProjectId: ProjectId.make(row.localProjectId),
      hubProjectId: HubProjectId.make(row.hubProjectId),
      link,
      generation: row.generation,
      seq: row.seq,
    };
  };
  const selectRemote = sql`
    SELECT hub_thread_id AS "hubThreadId", local_thread_id AS "localThreadId",
           local_project_id AS "localProjectId", hub_project_id AS "hubProjectId",
           link_json AS "linkJson", generation, seq
    FROM hub_remote_threads`;

  const getRemote = (hubThreadId: HubThreadId) =>
    sql<RemoteDbRow>`${selectRemote} WHERE hub_thread_id = ${hubThreadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRemote(rows[0]))),
      q("getRemote"),
    );

  const getRemoteByLocal = (threadId: ThreadId) =>
    sql<RemoteDbRow>`${selectRemote} WHERE local_thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRemote(rows[0]))),
      q("getRemoteByLocal"),
    );

  const listRemote = sql<RemoteDbRow>`${selectRemote} ORDER BY hub_thread_id`.pipe(
    Effect.map((rows) => rows.flatMap((row) => toRemote(row) ?? [])),
    q("listRemote"),
  );

  const upsertRemote = (row: HubRemoteThreadRow) =>
    sql`INSERT INTO hub_remote_threads
          (hub_thread_id, local_thread_id, local_project_id, hub_project_id, link_json, generation, seq)
        VALUES (${row.hubThreadId}, ${row.localThreadId}, ${row.localProjectId},
                ${row.hubProjectId}, ${JSON.stringify(row.link)}, ${row.generation}, ${row.seq})
        ON CONFLICT (hub_thread_id) DO UPDATE SET
          local_project_id = excluded.local_project_id,
          hub_project_id = excluded.hub_project_id,
          link_json = excluded.link_json,
          generation = excluded.generation,
          seq = excluded.seq`.pipe(Effect.asVoid, q("upsertRemote"));

  const setRemoteCursor = (hubThreadId: HubThreadId, generation: number, seq: number) =>
    sql`UPDATE hub_remote_threads SET generation = ${generation}, seq = ${seq}
        WHERE hub_thread_id = ${hubThreadId}`.pipe(Effect.asVoid, q("setRemoteCursor"));

  const deleteRemote = (hubThreadId: HubThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ localThreadId: string }>`
            SELECT local_thread_id AS "localThreadId" FROM hub_remote_threads
            WHERE hub_thread_id = ${hubThreadId}`;
          for (const row of rows) {
            yield* sql`DELETE FROM hub_remote_turn_diffs WHERE thread_id = ${row.localThreadId}`;
          }
          yield* sql`DELETE FROM hub_remote_threads WHERE hub_thread_id = ${hubThreadId}`;
        }),
      )
      .pipe(q("deleteRemote"));

  const upsertRemoteDiff = (input: {
    readonly threadId: ThreadId;
    readonly checkpointTurnCount: number;
    readonly turnId: string;
    readonly diff: string;
  }) =>
    sql`INSERT INTO hub_remote_turn_diffs (thread_id, checkpoint_turn_count, turn_id, diff)
        VALUES (${input.threadId}, ${input.checkpointTurnCount}, ${input.turnId}, ${input.diff})
        ON CONFLICT (thread_id, checkpoint_turn_count) DO UPDATE SET
          turn_id = excluded.turn_id, diff = excluded.diff`.pipe(
      Effect.asVoid,
      q("upsertRemoteDiff"),
    );

  const getRemoteDiff = (threadId: ThreadId, checkpointTurnCount: number) =>
    sql<{ diff: string }>`SELECT diff FROM hub_remote_turn_diffs
      WHERE thread_id = ${threadId} AND checkpoint_turn_count = ${checkpointTurnCount}`.pipe(
      Effect.map((rows) => rows[0]?.diff ?? null),
      q("getRemoteDiff"),
    );

  const insertCommentOp = (row: HubCommentOpRow, queuedAt: string) =>
    sql`INSERT OR REPLACE INTO hub_comment_outbox (comment_id, op, hub_thread_id, text, queued_at)
        VALUES (${row.commentId}, ${row.op}, ${row.hubThreadId}, ${row.text}, ${queuedAt})`.pipe(
      Effect.asVoid,
      q("insertCommentOp"),
    );

  const listCommentOps = sql<{
    commentId: string;
    op: string;
    hubThreadId: string;
    text: string | null;
  }>`SELECT comment_id AS "commentId", op, hub_thread_id AS "hubThreadId", text
     FROM hub_comment_outbox ORDER BY queued_at ASC`.pipe(
    Effect.map((rows) =>
      rows.map((row): HubCommentOpRow => ({
        commentId: row.commentId,
        op: row.op === "delete" ? "delete" : "add",
        hubThreadId: HubThreadId.make(row.hubThreadId),
        text: row.text,
      })),
    ),
    q("listCommentOps"),
  );

  const deleteCommentOp = (commentId: string) =>
    sql`DELETE FROM hub_comment_outbox WHERE comment_id = ${commentId}`.pipe(
      Effect.asVoid,
      q("deleteCommentOp"),
    );

  return {
    getLink,
    setHubUrl,
    setLinked,
    setAccount,
    clearLink,
    clearPublishing,
    getState,
    setState,
    listProjectLinks,
    upsertProjectLink,
    deleteProjectLink,
    getPublished,
    listPublished,
    commitPublish,
    deletePublished,
    acknowledge,
    readOutbound,
    listOutboundThreads,
    deleteOutboundBefore,
    countOutbound,
    getRemote,
    getRemoteByLocal,
    listRemote,
    upsertRemote,
    setRemoteCursor,
    deleteRemote,
    upsertRemoteDiff,
    getRemoteDiff,
    insertCommentOp,
    listCommentOps,
    deleteCommentOp,
  };
});

export type HubStore = Effect.Success<typeof makeHubStore>;
