// @effect-diagnostics preferSchemaOverJson:off - stored rows and outbound frames are JSON written by this object from already-decoded, typed values.
/**
 * One Durable Object per hub project. It owns the project's team data (brief,
 * focus, activity, comments, analyses, awareness) and the ordered mirror of
 * every shared thread, in its own SQLite storage, and fans changes out to the
 * sync sessions of connected members.
 *
 * Every mutation runs inside `exclusive`, so a publish's seq check and its
 * writes can't interleave with another request across a D1 await. Nothing
 * lives only in memory except caches that reload from D1 or storage, so the
 * object can be evicted (or hibernate) at any time.
 */
import { DurableObject } from "cloudflare:workers";
import {
  HUB_SYNC_LIMITS,
  type HubAccountId,
  type HubAnalysisSummary,
  type HubAwarenessItem,
  type HubClientMessage,
  type HubEnvironmentLinkId,
  type HubProject,
  type HubProjectBriefVersion,
  type HubProjectId,
  type HubProjectMember,
  type HubProjectMemberFocus,
  type HubProjectState,
  type HubServerMessage,
  type HubTeamActivityItem,
  type HubThreadComment,
  type HubThreadCursor,
  type HubThreadEvent,
  type HubThreadId,
  type HubThreadSummary,
  type HubThreadSummaryFields,
  normalizeGithubLogin,
  parseHubThreadId,
} from "@t3tools/contracts/hub";
import { redactForHub } from "@t3tools/shared/hubRedaction";

import { isoOf, nowMs } from "../clock.ts";
import * as Db from "../db.ts";
import type { Env } from "../env.ts";
import { type ReplyMessage, ack, encodeServerMessage, reject, utf8Bytes } from "../protocol.ts";

type Msg<T extends HubClientMessage["type"]> = Extract<HubClientMessage, { type: T }>;
type ActivityKind = HubTeamActivityItem["kind"];
type RemovalReason = "private" | "deleted" | "access-lost";

export interface Caller {
  readonly projectId: HubProjectId;
  readonly linkId: HubEnvironmentLinkId;
  readonly accountId: HubAccountId;
  readonly connId: string;
}

/** What a sync session receives besides frames: project access it gained or lost. */
export interface AccessChange {
  readonly added?: HubProjectId;
  readonly removed?: HubProjectId;
}

export type AttachResult =
  | {
      readonly ok: true;
      readonly state: HubProjectState;
      readonly published: ReadonlyArray<HubThreadCursor>;
    }
  | { readonly ok: false };

interface ThreadRow extends Record<string, SqlStorageValue> {
  thread_id: string;
  owner_account_id: string;
  owner_link_id: string;
  generation: number;
  last_seq: number;
  summary_json: string | null;
  removed_reason: string | null;
}

interface SubscriptionRow extends Record<string, SqlStorageValue> {
  link_id: string;
  thread_id: string;
  generation: number;
  delivered_seq: number;
  acked_seq: number;
}

interface ConnectionRow extends Record<string, SqlStorageValue> {
  link_id: string;
  account_id: string;
  conn_id: string;
}

/** Frames stay under the 1 MiB WebSocket cap with room for the envelope. */
const FRAME_BUDGET_BYTES = HUB_SYNC_LIMITS.frameMaxBytes - 64_000;
const ACTIVITY_KEEP = 500;
const AWARENESS_KEEP_PER_ACCOUNT = 200;
const NO_REDACTION_CONTEXT = { workspaceRoots: [], homeDirs: [] } as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  owner_link_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  summary_json TEXT,
  removed_reason TEXT
);
CREATE TABLE IF NOT EXISTS events (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE IF NOT EXISTS comments (
  comment_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments (thread_id, created_at);
CREATE TABLE IF NOT EXISTS brief_versions (
  version INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  author_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS focuses (
  account_id TEXT PRIMARY KEY,
  focus TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  thread_id TEXT,
  actor_id TEXT,
  detail TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
  thread_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS awareness (
  item_id TEXT PRIMARY KEY,
  source_thread_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS awareness_target ON awareness (target_account_id, created_at);
CREATE TABLE IF NOT EXISTS connections (
  link_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conn_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  link_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  delivered_seq INTEGER NOT NULL,
  acked_seq INTEGER NOT NULL,
  PRIMARY KEY (link_id, thread_id)
);
`;

const STATUS_ACTIVITY: Partial<Record<HubThreadSummaryFields["status"], ActivityKind>> = {
  working: "turn-started",
  errored: "turn-errored",
  "waiting-approval": "approval-requested",
  "waiting-input": "input-requested",
};

const statusActivity = (
  previous: HubThreadSummaryFields["status"] | null,
  next: HubThreadSummaryFields["status"],
): ActivityKind | null => {
  if (previous === next) return null;
  if (previous === "working" && (next === "settled" || next === "idle")) return "turn-completed";
  return STATUS_ACTIVITY[next] ?? null;
};

const removalOf = (event: HubThreadEvent): RemovalReason | null => {
  if (event.body.type === "thread.deleted") return "deleted";
  if (event.body.type === "thread.visibility-set" && event.body.payload.visibility === "private") {
    return "private";
  }
  return null;
};

export class ProjectHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private project: HubProject | null = null;
  private members: Map<string, HubProjectMember> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Runs `task` after every earlier mutation has finished. */
  private exclusive<A>(task: () => Promise<A>): Promise<A> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async load(projectId: HubProjectId): Promise<HubProject | null> {
    if (this.project && this.project.projectId === projectId && this.members) return this.project;
    const stored = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'project_id'")
      .toArray()[0];
    if (stored && stored.value !== projectId) return null;
    const project = await Db.getProject(this.env.DB, projectId);
    if (!project) return null;
    if (!stored) this.sql.exec("INSERT INTO meta (key, value) VALUES ('project_id', ?)", projectId);
    this.project = project;
    await this.reloadMembers();
    return project;
  }

  private async reloadMembers(): Promise<Map<string, HubProjectMember>> {
    const members = await Db.listMembers(this.env.DB, this.requireProject().projectId);
    this.members = new Map(members.map((member) => [member.accountId, member]));
    return this.members;
  }

  private requireProject(): HubProject {
    if (!this.project) throw new Error("project not loaded");
    return this.project;
  }

  private member(accountId: string): HubProjectMember | null {
    return this.members?.get(accountId) ?? null;
  }

  /** Loads the project and checks the caller is a member; a reject otherwise. */
  private async authorize(
    caller: Pick<Caller, "projectId" | "accountId">,
    requestId: ReplyMessage["requestId"],
  ): Promise<ReplyMessage | null> {
    if (!(await this.load(caller.projectId)))
      return reject(requestId, "not-found", "No such project.");
    if (!this.member(caller.accountId)) {
      return reject(requestId, "forbidden", "Only project members can do that.");
    }
    return null;
  }

  /** Sends frames to one sync session, in order per link. Drops the connection if it is gone. */
  private deliver(
    linkId: string,
    connId: string,
    frames: ReadonlyArray<string>,
    change?: AccessChange,
  ) {
    if (frames.length === 0 && !change) return;
    const previous = this.deliveries.get(linkId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const session = this.env.SYNC_SESSION.get(this.env.SYNC_SESSION.idFromName(linkId));
      const delivered = await session
        .deliver(connId, [...frames], change ?? null)
        .catch(() => false);
      if (!delivered) this.dropConnection(linkId, connId);
    });
    this.deliveries.set(linkId, next);
    void next.finally(() => {
      if (this.deliveries.get(linkId) === next) this.deliveries.delete(linkId);
    });
  }

  private connections(): Array<ConnectionRow> {
    return this.sql
      .exec<ConnectionRow>("SELECT link_id, account_id, conn_id FROM connections")
      .toArray();
  }

  private broadcast(messages: ReadonlyArray<HubServerMessage>, exceptAccountId?: string) {
    if (messages.length === 0) return;
    const frames = messages.map(encodeServerMessage);
    for (const connection of this.connections()) {
      if (connection.account_id !== exceptAccountId) {
        this.deliver(connection.link_id, connection.conn_id, frames);
      }
    }
  }

  private sendToAccounts(
    accountIds: ReadonlySet<string>,
    messages: ReadonlyArray<HubServerMessage>,
  ) {
    const frames = messages.map(encodeServerMessage);
    for (const connection of this.connections()) {
      if (accountIds.has(connection.account_id)) {
        this.deliver(connection.link_id, connection.conn_id, frames);
      }
    }
  }

  private dropConnection(linkId: string, connId: string) {
    const removed = this.sql.exec(
      "DELETE FROM connections WHERE link_id = ? AND conn_id = ?",
      linkId,
      connId,
    ).rowsWritten;
    if (removed > 0) this.sql.exec("DELETE FROM subscriptions WHERE link_id = ?", linkId);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private threadRow(threadId: string): ThreadRow | null {
    return (
      this.sql
        .exec<ThreadRow>(
          "SELECT thread_id, owner_account_id, owner_link_id, generation, last_seq, summary_json, removed_reason FROM threads WHERE thread_id = ?",
          threadId,
        )
        .toArray()[0] ?? null
    );
  }

  private summaryOf(row: ThreadRow): HubThreadSummary | null {
    if (row.removed_reason !== null || row.summary_json === null) return null;
    const fields = JSON.parse(row.summary_json) as HubThreadSummaryFields;
    return {
      ...fields,
      threadId: row.thread_id as HubThreadId,
      projectId: this.requireProject().projectId,
      ownerId: row.owner_account_id as HubAccountId,
      generation: row.generation,
      lastSeq: row.last_seq,
    };
  }

  private liveThreads(): Array<ThreadRow> {
    return this.sql
      .exec<ThreadRow>(
        "SELECT thread_id, owner_account_id, owner_link_id, generation, last_seq, summary_json, removed_reason FROM threads WHERE removed_reason IS NULL ORDER BY thread_id",
      )
      .toArray();
  }

  private brief(): HubProjectBriefVersion | null {
    const row = this.sql
      .exec<{ version: number; text: string; author_id: string | null; created_at: string }>(
        "SELECT version, text, author_id, created_at FROM brief_versions ORDER BY version DESC LIMIT 1",
      )
      .toArray()[0];
    return row
      ? {
          projectId: this.requireProject().projectId,
          version: row.version,
          text: row.text,
          authorId: row.author_id as HubAccountId | null,
          createdAt: row.created_at,
        }
      : null;
  }

  private focuses(): Array<HubProjectMemberFocus> {
    return this.sql
      .exec<{ account_id: string; focus: string; updated_at: string }>(
        "SELECT account_id, focus, updated_at FROM focuses ORDER BY account_id",
      )
      .toArray()
      .map((row) => ({
        projectId: this.requireProject().projectId,
        accountId: row.account_id as HubAccountId,
        focus: row.focus,
        updatedAt: row.updated_at,
      }));
  }

  private activity(limit: number, afterSequence = 0): Array<HubTeamActivityItem> {
    return this.sql
      .exec<{
        sequence: number;
        kind: string;
        thread_id: string | null;
        actor_id: string | null;
        detail: string | null;
        occurred_at: string;
      }>(
        "SELECT sequence, kind, thread_id, actor_id, detail, occurred_at FROM activity WHERE sequence > ? ORDER BY sequence DESC LIMIT ?",
        afterSequence,
        limit,
      )
      .toArray()
      .map((row) => ({
        id: `act_${row.sequence}`,
        projectId: this.requireProject().projectId,
        kind: row.kind as ActivityKind,
        threadId: row.thread_id as HubThreadId | null,
        actorId: row.actor_id as HubAccountId | null,
        detail: row.detail,
        occurredAt: row.occurred_at,
        sequence: row.sequence,
      }));
  }

  private analyses(): Array<HubAnalysisSummary> {
    return this.sql
      .exec<{ thread_id: string; summary: string; updated_at: string }>(
        "SELECT thread_id, summary, updated_at FROM analyses ORDER BY thread_id",
      )
      .toArray()
      .map((row) => ({
        threadId: row.thread_id as HubThreadId,
        summary: row.summary,
        updatedAt: row.updated_at,
      }));
  }

  private awarenessFor(accountId: string): Array<HubAwarenessItem> {
    return this.sql
      .exec<{ item_json: string }>(
        "SELECT item_json FROM awareness WHERE target_account_id = ? ORDER BY created_at DESC, item_id",
        accountId,
      )
      .toArray()
      .map((row) => JSON.parse(row.item_json) as HubAwarenessItem);
  }

  private commentSnapshot(threadId: string): HubServerMessage {
    const comments = this.sql
      .exec<{ comment_id: string; author_id: string; text: string; created_at: string }>(
        `SELECT comment_id, author_id, text, created_at FROM (
           SELECT comment_id, author_id, text, created_at FROM comments WHERE thread_id = ?
           ORDER BY created_at DESC, comment_id DESC LIMIT ?
         ) ORDER BY created_at, comment_id`,
        threadId,
        HUB_SYNC_LIMITS.commentSnapshotMax,
      )
      .toArray()
      .map((row): HubThreadComment => ({
        commentId: row.comment_id as HubThreadComment["commentId"],
        threadId: threadId as HubThreadId,
        authorId: row.author_id as HubAccountId,
        text: row.text,
        createdAt: row.created_at,
      }));
    return {
      type: "comment.snapshot",
      projectId: this.requireProject().projectId,
      threadId: threadId as HubThreadId,
      comments,
    };
  }

  private async state(accountId: string): Promise<HubProjectState> {
    const project = this.requireProject();
    const members = [...(this.members?.values() ?? [])];
    await Db.expireInvitations(this.env.DB, nowMs());
    const invitations = await Db.pendingInvitationsForProject(this.env.DB, project.projectId);
    const authors = this.sql
      .exec<{ author_id: string }>("SELECT DISTINCT author_id FROM comments")
      .toArray()
      .map((row) => row.author_id);
    const accounts = await Db.getAccounts(this.env.DB, [
      ...members.map((member) => member.accountId),
      ...invitations.map((invitation) => invitation.inviterId),
      ...authors,
    ]);
    return {
      project,
      members,
      accounts,
      brief: this.brief(),
      focuses: this.focuses(),
      activity: this.activity(HUB_SYNC_LIMITS.activitySnapshotMax),
      threads: this.liveThreads().flatMap((row) => this.summaryOf(row) ?? []),
      analyses: this.analyses(),
      awareness: this.awarenessFor(accountId),
      invitations,
    };
  }

  private async membersMessage(): Promise<HubServerMessage> {
    const members = [...(this.members?.values() ?? [])];
    return {
      type: "team.members",
      projectId: this.requireProject().projectId,
      members,
      accounts: await Db.getAccounts(
        this.env.DB,
        members.map((member) => member.accountId),
      ),
    };
  }

  private async invitationsMessage(): Promise<HubServerMessage> {
    await Db.expireInvitations(this.env.DB, nowMs());
    return {
      type: "team.invitations",
      projectId: this.requireProject().projectId,
      invitations: await Db.pendingInvitationsForProject(
        this.env.DB,
        this.requireProject().projectId,
      ),
    };
  }

  /** Sends an account's full incoming invitation list to its live sessions (any project). */
  private async notifyInvitee(accountId: string | null) {
    if (!accountId) return;
    const account = await Db.getAccount(this.env.DB, accountId);
    if (!account) return;
    const message: HubServerMessage = {
      type: "invitations",
      invitations: await Db.pendingInvitationsForAccount(this.env.DB, account),
    };
    for (const live of await Db.liveConnectionsOf(this.env.DB, [accountId])) {
      this.deliver(live.linkId, live.connId, [encodeServerMessage(message)]);
    }
  }

  private recordActivity(
    kind: ActivityKind,
    input: { threadId?: string | null; actorId?: string | null; detail?: string | null },
  ): HubTeamActivityItem | null {
    const sequence = this.sql
      .exec<{ sequence: number }>(
        "INSERT INTO activity (kind, thread_id, actor_id, detail, occurred_at) VALUES (?, ?, ?, ?, ?) RETURNING sequence",
        kind,
        input.threadId ?? null,
        input.actorId ?? null,
        input.detail ?? null,
        isoOf(nowMs()),
      )
      .one().sequence;
    this.sql.exec("DELETE FROM activity WHERE sequence <= ?", sequence - ACTIVITY_KEEP);
    return this.activity(1, sequence - 1)[0] ?? null;
  }

  private activityMessage(items: ReadonlyArray<HubTeamActivityItem | null>): HubServerMessage[] {
    const present = items.filter((item): item is HubTeamActivityItem => item !== null);
    if (present.length === 0) return [];
    return [
      {
        type: "team.activity",
        projectId: this.requireProject().projectId,
        items: [...present].sort((left, right) => right.sequence - left.sequence),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Thread streams to subscribers
  // -------------------------------------------------------------------------

  private unackedFor(linkId: string): number {
    return (
      this.sql
        .exec<{ total: number | null }>(
          "SELECT SUM(delivered_seq - acked_seq) AS total FROM subscriptions WHERE link_id = ?",
          linkId,
        )
        .one().total ?? 0
    );
  }

  /**
   * Sends a subscriber everything after its delivered position, in frames
   * under the WebSocket cap, until `unackedEventsMax` is reached. A stale
   * generation (reset, or a cursor from before a removal) restarts from seq 1.
   */
  private pump(linkId: string, connId: string, threadId: string) {
    const sub = this.sql
      .exec<SubscriptionRow>(
        "SELECT link_id, thread_id, generation, delivered_seq, acked_seq FROM subscriptions WHERE link_id = ? AND thread_id = ?",
        linkId,
        threadId,
      )
      .toArray()[0];
    if (!sub) return;
    const projectId = this.requireProject().projectId;
    const thread = this.threadRow(threadId);
    if (!thread || thread.removed_reason !== null) {
      this.sql.exec(
        "DELETE FROM subscriptions WHERE link_id = ? AND thread_id = ?",
        linkId,
        threadId,
      );
      this.deliver(linkId, connId, [
        encodeServerMessage({
          type: "thread.removed",
          projectId,
          threadId: threadId as HubThreadId,
          reason: (thread?.removed_reason as RemovalReason | undefined) ?? "deleted",
        }),
      ]);
      return;
    }
    let { delivered_seq: delivered, acked_seq: acked } = sub;
    let reset = false;
    if (sub.generation !== thread.generation || delivered > thread.last_seq) {
      reset = true;
      delivered = 0;
      acked = 0;
    }
    let budget =
      HUB_SYNC_LIMITS.unackedEventsMax -
      (this.unackedFor(linkId) - (sub.delivered_seq - sub.acked_seq)) -
      (delivered - acked);
    const frames: Array<string> = [];
    const header = (withReset: boolean) =>
      `{"type":"thread.events","projectId":${JSON.stringify(projectId)},"threadId":${JSON.stringify(threadId)},"generation":${thread.generation}${withReset ? ',"reset":true' : ""},"events":[`;
    while (delivered < thread.last_seq && budget > 0) {
      const rows = this.sql
        .exec<{ seq: number; event_json: string }>(
          "SELECT seq, event_json FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
          threadId,
          delivered,
          Math.min(HUB_SYNC_LIMITS.eventsPerBatchMax, budget),
        )
        .toArray();
      if (rows.length === 0) break;
      const batch: Array<string> = [];
      let bytes = 0;
      for (const row of rows) {
        const size = utf8Bytes(row.event_json);
        if (batch.length > 0 && bytes + size > FRAME_BUDGET_BYTES) break;
        batch.push(row.event_json);
        bytes += size;
        delivered = row.seq;
      }
      frames.push(`${header(reset)}${batch.join(",")}]}`);
      reset = false;
      budget -= batch.length;
    }
    if (reset) frames.push(`${header(true)}]}`);
    this.sql.exec(
      "UPDATE subscriptions SET generation = ?, delivered_seq = ?, acked_seq = ? WHERE link_id = ? AND thread_id = ?",
      thread.generation,
      delivered,
      acked,
      linkId,
      threadId,
    );
    this.deliver(linkId, connId, frames);
  }

  private pumpThread(threadId: string) {
    const subscribers = this.sql
      .exec<{ link_id: string; conn_id: string }>(
        `SELECT s.link_id, c.conn_id FROM subscriptions s JOIN connections c ON c.link_id = s.link_id
         WHERE s.thread_id = ?`,
        threadId,
      )
      .toArray();
    for (const subscriber of subscribers)
      this.pump(subscriber.link_id, subscriber.conn_id, threadId);
  }

  private pumpLink(linkId: string, connId: string) {
    const threads = this.sql
      .exec<{ thread_id: string }>("SELECT thread_id FROM subscriptions WHERE link_id = ?", linkId)
      .toArray();
    for (const { thread_id } of threads) this.pump(linkId, connId, thread_id);
  }

  /** Readers of a thread's comments: the owning link and its subscribers. */
  private commentReaders(thread: ThreadRow): Array<ConnectionRow> {
    return this.sql
      .exec<ConnectionRow>(
        `SELECT link_id, account_id, conn_id FROM connections
         WHERE link_id = ? OR link_id IN (SELECT link_id FROM subscriptions WHERE thread_id = ?)`,
        thread.owner_link_id,
        thread.thread_id,
      )
      .toArray();
  }

  /** Drops threads' mirrors, comments and analysis; tells every member. */
  private async removeThreads(threadIds: ReadonlyArray<string>, reason: RemovalReason) {
    if (threadIds.length === 0) return;
    const projectId = this.requireProject().projectId;
    this.ctx.storage.transactionSync(() => {
      for (const threadId of threadIds) {
        this.sql.exec(
          "UPDATE threads SET removed_reason = ?, summary_json = NULL, last_seq = 0 WHERE thread_id = ?",
          reason,
          threadId,
        );
        this.sql.exec("DELETE FROM events WHERE thread_id = ?", threadId);
        this.sql.exec("DELETE FROM comments WHERE thread_id = ?", threadId);
        this.sql.exec("DELETE FROM analyses WHERE thread_id = ?", threadId);
        this.sql.exec(
          "DELETE FROM awareness WHERE source_thread_id = ? OR target_thread_id = ?",
          threadId,
          threadId,
        );
        this.sql.exec("DELETE FROM subscriptions WHERE thread_id = ?", threadId);
      }
    });
    await Db.markThreadsRemoved(this.env.DB, threadIds, reason, nowMs());
    this.broadcast(
      threadIds.map((threadId) => ({
        type: "thread.removed",
        projectId,
        threadId: threadId as HubThreadId,
        reason,
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Registers a sync session for this project (on `hello`). Returns the
   * project state and this link's published cursors; `resume` then streams.
   */
  attach(
    input: Caller & { readonly subscriptions: ReadonlyArray<HubThreadCursor> },
  ): Promise<AttachResult> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId)) || !this.member(input.accountId)) {
        return { ok: false as const };
      }
      this.registerConnection(input.linkId, input.accountId, input.connId);
      for (const cursor of input.subscriptions) {
        this.sql.exec(
          "INSERT OR REPLACE INTO subscriptions (link_id, thread_id, generation, delivered_seq, acked_seq) VALUES (?, ?, ?, ?, ?)",
          input.linkId,
          cursor.threadId,
          cursor.generation,
          cursor.seq,
          cursor.seq,
        );
      }
      const published = this.liveThreads()
        .filter((row) => row.owner_link_id === input.linkId)
        .map((row) => ({
          threadId: row.thread_id as HubThreadId,
          generation: row.generation,
          seq: row.last_seq,
        }));
      return { ok: true as const, state: await this.state(input.accountId), published };
    });
  }

  private registerConnection(linkId: string, accountId: string, connId: string) {
    this.sql.exec("DELETE FROM subscriptions WHERE link_id = ?", linkId);
    this.sql.exec(
      "INSERT OR REPLACE INTO connections (link_id, account_id, conn_id) VALUES (?, ?, ?)",
      linkId,
      accountId,
      connId,
    );
  }

  /** After `welcome`: comment snapshots for own and subscribed threads, then catch-up events. */
  resume(input: Caller): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId))) return;
      const connection = this.connectionOf(input.linkId);
      if (!connection || connection.conn_id !== input.connId) return;
      const subscribed = new Set(
        this.sql
          .exec<{ thread_id: string }>(
            "SELECT thread_id FROM subscriptions WHERE link_id = ?",
            input.linkId,
          )
          .toArray()
          .map((row) => row.thread_id),
      );
      const snapshots = this.liveThreads()
        .filter((row) => row.owner_link_id === input.linkId || subscribed.has(row.thread_id))
        .map((row) => encodeServerMessage(this.commentSnapshot(row.thread_id)));
      this.deliver(input.linkId, input.connId, snapshots);
      this.pumpLink(input.linkId, input.connId);
    });
  }

  private connectionOf(linkId: string): ConnectionRow | null {
    return (
      this.sql
        .exec<ConnectionRow>(
          "SELECT link_id, account_id, conn_id FROM connections WHERE link_id = ?",
          linkId,
        )
        .toArray()[0] ?? null
    );
  }

  detach(input: Pick<Caller, "linkId" | "connId">): Promise<void> {
    return this.exclusive(async () => this.dropConnection(input.linkId, input.connId));
  }

  subscribe(
    input: Caller & { readonly threadId: HubThreadId; readonly cursor: HubThreadCursor | null },
  ): Promise<ReplyMessage | null> {
    return this.exclusive(async () => {
      const denied = await this.authorize(input, null);
      if (denied) return denied;
      if (this.connectionOf(input.linkId)?.conn_id !== input.connId) {
        return reject(null, "invalid", "Say hello before subscribing.");
      }
      const thread = this.threadRow(input.threadId);
      const cursor = input.cursor?.threadId === input.threadId ? input.cursor : null;
      this.sql.exec(
        "INSERT OR REPLACE INTO subscriptions (link_id, thread_id, generation, delivered_seq, acked_seq) VALUES (?, ?, ?, ?, ?)",
        input.linkId,
        input.threadId,
        cursor?.generation ?? thread?.generation ?? 1,
        cursor?.seq ?? 0,
        cursor?.seq ?? 0,
      );
      if (thread && thread.removed_reason === null) {
        this.deliver(input.linkId, input.connId, [
          encodeServerMessage(this.commentSnapshot(input.threadId)),
        ]);
      }
      this.pump(input.linkId, input.connId, input.threadId);
      return null;
    });
  }

  unsubscribe(input: Pick<Caller, "linkId"> & { readonly threadId: HubThreadId }): Promise<void> {
    return this.exclusive(async () => {
      this.sql.exec(
        "DELETE FROM subscriptions WHERE link_id = ? AND thread_id = ?",
        input.linkId,
        input.threadId,
      );
    });
  }

  ack(input: Caller & { readonly cursors: ReadonlyArray<HubThreadCursor> }): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId))) return;
      for (const cursor of input.cursors) {
        this.sql.exec(
          `UPDATE subscriptions SET acked_seq = MIN(delivered_seq, MAX(acked_seq, ?))
           WHERE link_id = ? AND thread_id = ? AND generation = ?`,
          cursor.seq,
          input.linkId,
          cursor.threadId,
          cursor.generation,
        );
      }
      this.pumpLink(input.linkId, input.connId);
    });
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  publish(input: Caller & { readonly message: Msg<"publish"> }): Promise<ReplyMessage> {
    return this.exclusive(() => this.publishNow(input));
  }

  private async publishNow(
    input: Caller & { readonly message: Msg<"publish"> },
  ): Promise<ReplyMessage> {
    const { message } = input;
    const { requestId } = message;
    if (parseHubThreadId(message.threadId).linkId !== input.linkId) {
      return reject(requestId, "forbidden", "Only the thread's own environment can publish to it.");
    }
    const denied = await this.authorize(input, requestId);
    if (denied) return denied;

    const events = message.events;
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.seq !== events[index - 1]!.seq + 1) {
        return reject(requestId, "invalid", "Events must be ascending and contiguous.");
      }
    }
    // Never trust the client's redaction for limits: run the same pass again.
    const accepted: Array<{ readonly event: HubThreadEvent; readonly json: string }> = [];
    for (const event of events) {
      const redacted = redactForHub(event.body, NO_REDACTION_CONTEXT);
      if (!redacted) {
        return reject(
          requestId,
          "invalid",
          `Event ${event.seq} may not sync or exceeds HUB_SYNC_LIMITS.`,
        );
      }
      const normalized: HubThreadEvent = {
        seq: event.seq,
        occurredAt: event.occurredAt,
        ...(event.truncated || redacted.truncated ? { truncated: true as const } : {}),
        body: redacted.body,
      };
      const json = JSON.stringify(normalized);
      if (utf8Bytes(json) > HUB_SYNC_LIMITS.eventMaxBytes) {
        return reject(
          requestId,
          "invalid",
          `Event ${event.seq} exceeds HUB_SYNC_LIMITS.eventMaxBytes.`,
        );
      }
      accepted.push({ event: normalized, json });
    }

    const thread = this.threadRow(message.threadId);
    const live = thread !== null && thread.removed_reason === null;
    const hasSummary = accepted.some(({ event }) => event.body.type === "thread.summary-set");
    let fresh = accepted;
    let generation = thread?.generation ?? 0;
    let lastSeq = live ? thread.last_seq : 0;
    const restarting = message.reset === true || !live;
    if (restarting) {
      if (accepted[0]!.event.seq !== 1) {
        return message.reset
          ? reject(requestId, "invalid", "A reset must start at seq 1.")
          : reject(requestId, "conflict", "This thread starts over at seq 1.", { expectedSeq: 1 });
      }
      if (!live && !hasSummary) {
        return reject(
          requestId,
          "invalid",
          "A thread's first publish must include thread.summary-set.",
        );
      }
      generation += 1;
      lastSeq = 0;
    } else {
      fresh = accepted.filter(({ event }) => event.seq > lastSeq);
      if (fresh.length === 0) {
        return ack(requestId, { threadId: message.threadId, generation, seq: lastSeq });
      }
      if (fresh[0]!.event.seq !== lastSeq + 1) {
        return reject(requestId, "conflict", `Expected seq ${lastSeq + 1}.`, {
          expectedSeq: lastSeq + 1,
        });
      }
    }
    if (!live) {
      const claimed = await Db.claimThreadIndex(
        this.env.DB,
        {
          threadId: message.threadId,
          projectId: input.projectId,
          linkId: input.linkId,
          ownerAccountId: input.accountId,
        },
        nowMs(),
      );
      if (!claimed)
        return reject(requestId, "forbidden", "This thread belongs to another project.");
    }

    const previousSummary =
      live && thread.summary_json
        ? (JSON.parse(thread.summary_json) as HubThreadSummaryFields)
        : null;
    let summary = previousSummary;
    let removal: { reason: RemovalReason; seq: number } | null = null;
    this.ctx.storage.transactionSync(() => {
      if (restarting) this.sql.exec("DELETE FROM events WHERE thread_id = ?", message.threadId);
      for (const { event, json } of fresh) {
        this.sql.exec(
          "INSERT OR REPLACE INTO events (thread_id, seq, event_json) VALUES (?, ?, ?)",
          message.threadId,
          event.seq,
          json,
        );
        lastSeq = event.seq;
        if (event.body.type === "thread.summary-set") summary = event.body.payload;
        const reason = removalOf(event);
        if (reason) {
          removal = { reason, seq: event.seq };
          break;
        }
      }
      this.sql.exec(
        `INSERT INTO threads (thread_id, owner_account_id, owner_link_id, generation, last_seq, summary_json, removed_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (thread_id) DO UPDATE SET generation = excluded.generation, last_seq = excluded.last_seq,
           summary_json = excluded.summary_json, removed_reason = NULL`,
        message.threadId,
        input.accountId,
        input.linkId,
        generation,
        lastSeq,
        summary ? JSON.stringify(summary) : null,
      );
    });

    const cursor = { threadId: message.threadId, generation, seq: lastSeq };
    const finalRemoval = removal as { reason: RemovalReason; seq: number } | null;
    if (finalRemoval) {
      await this.removeThreads([message.threadId], finalRemoval.reason);
      return ack(requestId, cursor);
    }

    const updates: Array<HubServerMessage> = [];
    const row = this.threadRow(message.threadId);
    const listed = row ? this.summaryOf(row) : null;
    if (listed && (restarting || summary !== previousSummary)) {
      updates.push({ type: "team.thread", summary: listed });
    }
    if (summary) {
      const kind = !live
        ? "thread-created"
        : statusActivity(previousSummary?.status ?? null, summary.status);
      if (kind) {
        updates.push(
          ...this.activityMessage([
            this.recordActivity(kind, {
              threadId: message.threadId,
              actorId: input.accountId,
              detail: kind === "thread-created" ? summary.title : null,
            }),
          ]),
        );
      }
      if (!live && summary.status !== "idle" && summary.status !== "settled") {
        const statusKind = statusActivity(null, summary.status);
        if (statusKind) {
          updates.push(
            ...this.activityMessage([
              this.recordActivity(statusKind, {
                threadId: message.threadId,
                actorId: input.accountId,
              }),
            ]),
          );
        }
      }
    }
    this.broadcast(updates);
    this.pumpThread(message.threadId);
    return ack(requestId, cursor);
  }

  // -------------------------------------------------------------------------
  // Comments, brief, focus
  // -------------------------------------------------------------------------

  commentAdd(input: Caller & { readonly message: Msg<"comment.add"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      const thread = this.threadRow(message.threadId);
      if (!thread || thread.removed_reason !== null) {
        return reject(message.requestId, "not-found", "No such shared thread.");
      }
      const existing = this.sql
        .exec<{ thread_id: string; author_id: string }>(
          "SELECT thread_id, author_id FROM comments WHERE comment_id = ?",
          message.commentId,
        )
        .toArray()[0];
      if (existing) {
        return existing.thread_id === message.threadId && existing.author_id === input.accountId
          ? ack(message.requestId)
          : reject(message.requestId, "conflict", "That comment id is taken.");
      }
      const comment: HubThreadComment = {
        commentId: message.commentId,
        threadId: message.threadId,
        authorId: input.accountId,
        text: message.text,
        createdAt: isoOf(nowMs()),
      };
      this.sql.exec(
        "INSERT INTO comments (comment_id, thread_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        comment.commentId,
        comment.threadId,
        comment.authorId,
        comment.text,
        comment.createdAt,
      );
      const frame = encodeServerMessage({
        type: "comment.added",
        projectId: input.projectId,
        comment,
      });
      for (const reader of this.commentReaders(thread))
        this.deliver(reader.link_id, reader.conn_id, [frame]);
      return ack(message.requestId);
    });
  }

  commentDelete(
    input: Caller & { readonly message: Msg<"comment.delete"> },
  ): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      const existing = this.sql
        .exec<{ thread_id: string; author_id: string }>(
          "SELECT thread_id, author_id FROM comments WHERE comment_id = ?",
          message.commentId,
        )
        .toArray()[0];
      // Already gone: a retried delete succeeds.
      if (!existing) return ack(message.requestId);
      if (existing.thread_id !== message.threadId) {
        return reject(message.requestId, "not-found", "No such comment on that thread.");
      }
      if (existing.author_id !== input.accountId) {
        return reject(message.requestId, "forbidden", "Only the comment's author can delete it.");
      }
      this.sql.exec("DELETE FROM comments WHERE comment_id = ?", message.commentId);
      const thread = this.threadRow(message.threadId);
      if (thread) {
        const frame = encodeServerMessage({
          type: "comment.deleted",
          projectId: input.projectId,
          threadId: message.threadId,
          commentId: message.commentId,
        });
        for (const reader of this.commentReaders(thread))
          this.deliver(reader.link_id, reader.conn_id, [frame]);
      }
      return ack(message.requestId);
    });
  }

  briefUpdate(input: Caller & { readonly message: Msg<"brief.update"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      const current = this.brief();
      const currentVersion = current?.version ?? null;
      if (message.expectedVersion !== currentVersion) {
        return reject(
          message.requestId,
          "conflict",
          "The brief changed since you started editing.",
          {
            currentVersion,
          },
        );
      }
      const brief: HubProjectBriefVersion = {
        projectId: input.projectId,
        version: (currentVersion ?? 0) + 1,
        text: message.text,
        authorId: input.accountId,
        createdAt: isoOf(nowMs()),
      };
      this.sql.exec(
        "INSERT INTO brief_versions (version, text, author_id, created_at) VALUES (?, ?, ?, ?)",
        brief.version,
        brief.text,
        brief.authorId,
        brief.createdAt,
      );
      this.broadcast([
        { type: "team.brief", brief },
        ...this.activityMessage([
          this.recordActivity("brief-updated", { actorId: input.accountId }),
        ]),
      ]);
      return ack(message.requestId);
    });
  }

  focusSet(input: Caller & { readonly message: Msg<"focus.set"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      let focus: HubProjectMemberFocus | null = null;
      if (message.focus === null) {
        this.sql.exec("DELETE FROM focuses WHERE account_id = ?", input.accountId);
      } else {
        focus = {
          projectId: input.projectId,
          accountId: input.accountId,
          focus: message.focus,
          updatedAt: isoOf(nowMs()),
        };
        this.sql.exec(
          "INSERT OR REPLACE INTO focuses (account_id, focus, updated_at) VALUES (?, ?, ?)",
          focus.accountId,
          focus.focus,
          focus.updatedAt,
        );
      }
      this.broadcast([
        { type: "team.focus", projectId: input.projectId, accountId: input.accountId, focus },
        ...this.activityMessage([
          this.recordActivity(focus ? "focus-set" : "focus-cleared", {
            actorId: input.accountId,
            detail: focus?.focus ?? null,
          }),
        ]),
      ]);
      return ack(message.requestId);
    });
  }

  // -------------------------------------------------------------------------
  // Membership and invitations
  // -------------------------------------------------------------------------

  invitationCreate(
    input: Caller & { readonly message: Msg<"invitation.create"> },
  ): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      const now = nowMs();
      const db = this.env.DB;
      const invitee = await Db.getAccountByLogin(db, message.githubLogin);
      if (invitee?.accountId === input.accountId) {
        return reject(message.requestId, "invalid", "You can't invite yourself.");
      }
      if (invitee && this.member(invitee.accountId)) {
        return reject(message.requestId, "conflict", `${message.githubLogin} is already a member.`);
      }
      await Db.expireInvitations(db, now);
      if (await Db.findPendingInvitation(db, input.projectId, message.githubLogin)) {
        return ack(message.requestId);
      }
      if ((await Db.countPendingByInviter(db, input.accountId)) >= Db.PENDING_INVITATION_LIMIT) {
        return reject(
          message.requestId,
          "conflict",
          `You already have ${Db.PENDING_INVITATION_LIMIT} pending invitations. Cancel some or wait for answers first.`,
        );
      }
      await Db.createInvitation(
        db,
        {
          projectId: input.projectId,
          inviterId: input.accountId,
          login: message.githubLogin,
          inviteeId: invitee?.accountId ?? null,
        },
        now,
      );
      this.broadcast([await this.invitationsMessage()]);
      await this.notifyInvitee(invitee?.accountId ?? null);
      return ack(message.requestId);
    });
  }

  invitationAction(
    input: Caller & {
      readonly message: Msg<"invitation.accept" | "invitation.decline" | "invitation.cancel">;
    },
  ): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const db = this.env.DB;
      if (!(await this.load(input.projectId))) {
        return reject(message.requestId, "not-found", "No such invitation.");
      }
      const now = nowMs();
      await Db.expireInvitations(db, now);
      const invitation = await Db.getInvitation(db, message.invitationId);
      if (!invitation || invitation.projectId !== input.projectId) {
        return reject(message.requestId, "not-found", "No such invitation.");
      }
      if (invitation.state !== "pending") {
        return reject(message.requestId, "conflict", `This invitation is ${invitation.state}.`);
      }
      if (message.type === "invitation.cancel") {
        const admin = this.member(input.accountId)?.role === "admin";
        if (invitation.inviterId !== input.accountId && !admin) {
          return reject(
            message.requestId,
            "forbidden",
            "Only the inviter or a project admin can cancel.",
          );
        }
        await Db.resolveInvitation(
          db,
          { invitationId: invitation.invitationId, state: "cancelled" },
          now,
        );
        this.broadcast([await this.invitationsMessage()]);
        await this.notifyInvitee(invitation.inviteeId);
        return ack(message.requestId);
      }

      const account = await Db.getAccount(db, input.accountId);
      const addressedToCaller =
        invitation.inviteeId === input.accountId ||
        (invitation.inviteeId === null &&
          account !== null &&
          normalizeGithubLogin(account.githubLogin) ===
            normalizeGithubLogin(invitation.inviteeLogin));
      if (!addressedToCaller) {
        return reject(message.requestId, "forbidden", "This invitation is for someone else.");
      }
      if (message.type === "invitation.decline") {
        await Db.resolveInvitation(
          db,
          { invitationId: invitation.invitationId, state: "declined", inviteeId: input.accountId },
          now,
        );
        this.broadcast([await this.invitationsMessage()]);
        await this.notifyInvitee(input.accountId);
        return ack(message.requestId);
      }
      if (!(await Db.acceptInvitation(db, invitation, input.accountId, now))) {
        return reject(message.requestId, "conflict", "This invitation is no longer pending.");
      }
      await this.reloadMembers();
      await this.connectAccount(input.accountId);
      this.broadcast(
        [await this.membersMessage(), await this.invitationsMessage()],
        input.accountId,
      );
      await this.notifyInvitee(input.accountId);
      return ack(message.requestId);
    });
  }

  /** Registers an account's live sessions here and sends each a `team.snapshot`. */
  private async connectAccount(accountId: string) {
    const lives = await Db.liveConnectionsOf(this.env.DB, [accountId]);
    if (lives.length === 0) return;
    const snapshot = encodeServerMessage({
      type: "team.snapshot",
      state: await this.state(accountId),
    });
    for (const live of lives) {
      this.registerConnection(live.linkId, live.accountId, live.connId);
      this.deliver(live.linkId, live.connId, [snapshot], {
        added: this.requireProject().projectId,
      });
    }
  }

  memberLeave(input: Caller & { readonly message: Msg<"member.leave"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      if (this.requireProject().createdBy === input.accountId) {
        return reject(message.requestId, "forbidden", "The project's creator can't leave it.");
      }
      await this.dropMember(input.accountId, "left");
      return ack(message.requestId);
    });
  }

  memberRemove(input: Caller & { readonly message: Msg<"member.remove"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      if (this.member(input.accountId)?.role !== "admin") {
        return reject(message.requestId, "forbidden", "Only project admins can remove members.");
      }
      if (this.requireProject().createdBy === message.accountId) {
        return reject(message.requestId, "forbidden", "The project's creator can't be removed.");
      }
      if (!this.member(message.accountId)) {
        return reject(message.requestId, "not-found", "That account is not a member.");
      }
      await this.dropMember(message.accountId, "removed");
      return ack(message.requestId);
    });
  }

  private async dropMember(accountId: string, reason: "left" | "removed") {
    const projectId = this.requireProject().projectId;
    await Db.removeMember(this.env.DB, projectId, accountId);
    await this.reloadMembers();
    // A former member's threads leave with them.
    await this.removeThreads(
      this.liveThreads()
        .filter((row) => row.owner_account_id === accountId)
        .map((row) => row.thread_id),
      "access-lost",
    );
    this.sql.exec("DELETE FROM focuses WHERE account_id = ?", accountId);
    this.sql.exec("DELETE FROM awareness WHERE target_account_id = ?", accountId);
    const frame = encodeServerMessage({ type: "team.removed", projectId, reason });
    for (const connection of this.connections()) {
      if (connection.account_id !== accountId) continue;
      this.sql.exec("DELETE FROM connections WHERE link_id = ?", connection.link_id);
      this.sql.exec("DELETE FROM subscriptions WHERE link_id = ?", connection.link_id);
      this.deliver(connection.link_id, connection.conn_id, [frame], { removed: projectId });
    }
    this.broadcast([await this.membersMessage()]);
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  analysisPost(input: Caller & { readonly message: Msg<"analysis.post"> }): Promise<ReplyMessage> {
    return this.exclusive(async () => {
      const { message } = input;
      const denied = await this.authorize(input, message.requestId);
      if (denied) return denied;
      const consenting = (threadId: string) => {
        const row = this.threadRow(threadId);
        const summary = row ? this.summaryOf(row) : null;
        return summary?.cooperation?.analysisEnabled === true ? row : null;
      };
      const ownConsenting = (threadId: string) => {
        const row = consenting(threadId);
        return row && row.owner_link_id === input.linkId ? row : null;
      };
      for (const summary of message.summaries) {
        if (!ownConsenting(summary.threadId)) {
          return reject(
            message.requestId,
            "forbidden",
            `Thread ${summary.threadId} is not yours or has no analysis consent.`,
          );
        }
      }
      const targets: Array<{ item: HubAwarenessItem; owner: string }> = [];
      for (const item of message.awareness) {
        const target = consenting(item.targetThreadId);
        if (!ownConsenting(item.sourceThreadId) || !target) {
          return reject(
            message.requestId,
            "forbidden",
            `Awareness item ${item.itemId} cites a thread without consent.`,
          );
        }
        const existing = this.sql
          .exec<{ source_thread_id: string }>(
            "SELECT source_thread_id FROM awareness WHERE item_id = ?",
            item.itemId,
          )
          .toArray()[0];
        if (existing && existing.source_thread_id !== item.sourceThreadId) {
          return reject(
            message.requestId,
            "conflict",
            `Awareness item id ${item.itemId} is taken.`,
          );
        }
        targets.push({ item, owner: target.owner_account_id });
      }
      this.ctx.storage.transactionSync(() => {
        for (const summary of message.summaries) {
          this.sql.exec(
            "INSERT OR REPLACE INTO analyses (thread_id, summary, updated_at) VALUES (?, ?, ?)",
            summary.threadId,
            summary.summary,
            summary.updatedAt,
          );
        }
        for (const { item, owner } of targets) {
          this.sql.exec(
            `INSERT OR REPLACE INTO awareness (item_id, source_thread_id, target_thread_id, target_account_id, item_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            item.itemId,
            item.sourceThreadId,
            item.targetThreadId,
            owner,
            JSON.stringify(item),
            item.createdAt,
          );
          this.sql.exec(
            `DELETE FROM awareness WHERE target_account_id = ? AND item_id NOT IN (
               SELECT item_id FROM awareness WHERE target_account_id = ? ORDER BY created_at DESC LIMIT ?)`,
            owner,
            owner,
            AWARENESS_KEEP_PER_ACCOUNT,
          );
        }
      });
      if (message.summaries.length > 0) {
        this.broadcast([
          { type: "team.analysis", projectId: input.projectId, summaries: message.summaries },
        ]);
      }
      const byOwner = new Map<string, Array<HubAwarenessItem>>();
      for (const { item, owner } of targets)
        byOwner.set(owner, [...(byOwner.get(owner) ?? []), item]);
      for (const [owner, items] of byOwner) {
        this.sendToAccounts(new Set([owner]), [
          { type: "team.awareness", projectId: input.projectId, items },
        ]);
      }
      return ack(message.requestId);
    });
  }

  // -------------------------------------------------------------------------
  // Notifications from the HTTP API
  // -------------------------------------------------------------------------

  /** An account joined (project created or linked): attach its live sessions. */
  accountJoined(input: {
    readonly projectId: HubProjectId;
    readonly accountId: HubAccountId;
  }): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId))) return;
      await this.reloadMembers();
      if (!this.member(input.accountId)) return;
      const already = new Set(this.connections().map((connection) => connection.link_id));
      const lives = await Db.liveConnectionsOf(this.env.DB, [input.accountId]);
      if (lives.every((live) => already.has(live.linkId))) return;
      await this.connectAccount(input.accountId);
      this.broadcast([await this.membersMessage()], input.accountId);
    });
  }

  /** Pending invitations changed outside this object (claimed at sign-in). */
  invitationsChanged(input: { readonly projectId: HubProjectId }): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId))) return;
      this.broadcast([await this.invitationsMessage()]);
    });
  }

  /** A link was revoked: its threads leave the project and its session detaches. */
  linkRevoked(input: {
    readonly projectId: HubProjectId;
    readonly linkId: HubEnvironmentLinkId;
  }): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.load(input.projectId))) return;
      this.sql.exec("DELETE FROM connections WHERE link_id = ?", input.linkId);
      this.sql.exec("DELETE FROM subscriptions WHERE link_id = ?", input.linkId);
      await this.removeThreads(
        this.liveThreads()
          .filter((row) => row.owner_link_id === input.linkId)
          .map((row) => row.thread_id),
        "access-lost",
      );
    });
  }
}
