// @effect-diagnostics globalConsole:off - Durable Object boundary; Workers Logs collect console output.
/**
 * One Durable Object per environment link: it holds that link's sync
 * WebSocket (hibernation API, `HUB_PING`/`HUB_PONG` auto-response) and routes
 * each client message to the project Durable Object that owns the data.
 *
 * Why per link: a WebSocket belongs to exactly one Durable Object and one
 * sync socket spans many projects, so the socket can't live in a project
 * object. Keying by link makes "a newer socket replaces the older one" (4409)
 * a local decision, and one busy environment never queues behind another of
 * the same account.
 *
 * Frames from one socket are handled strictly in order. State that must
 * survive hibernation lives in the socket attachment and in SQLite.
 */
import { DurableObject } from "cloudflare:workers";
import {
  HUB_CLOSE_CODES,
  HUB_PING,
  HUB_PONG,
  HUB_PROTOCOL_RANGE,
  HUB_SYNC_LIMITS,
  type HubAccountId,
  type HubClientMessage,
  type HubEnvironmentLinkId,
  type HubProjectId,
  type HubProjectState,
  type HubServerMessage,
  type HubThreadCursor,
  type HubThreadId,
  hubProtocolMismatchSide,
  negotiateHubProtocol,
} from "@t3tools/contracts/hub";

import { isoOf, nowMs } from "../clock.ts";
import { randomToken } from "../crypto.ts";
import * as Db from "../db.ts";
import type { Env } from "../env.ts";
import type { AccessChange, Caller } from "../project/ProjectHub.ts";
import {
  type ReplyMessage,
  encodeServerMessage,
  exceedsBytes,
  parseClientFrame,
  reject,
  requestIdOf,
} from "../protocol.ts";

/** Headers the Worker sets after authenticating the bearer credential. */
export const SYNC_LINK_HEADER = "x-puffcollab-hub-link";
export const SYNC_ACCOUNT_HEADER = "x-puffcollab-hub-account";

interface Attachment {
  readonly connId: string;
  readonly linkId: HubEnvironmentLinkId;
  readonly accountId: HubAccountId;
  readonly phase: "hello" | "welcoming" | "ready";
}

type Category = "publish" | "write" | "read";

/** Token buckets per socket: burst capacity and refill per second. */
const RATE_LIMITS: Record<Category, { readonly burst: number; readonly perSecond: number }> = {
  publish: { burst: 60, perSecond: 20 },
  write: { burst: 20, perSecond: 0.5 },
  read: { burst: 300, perSecond: 50 },
};
/** Consecutive rate-limited frames before the socket is closed with 4429. */
const RATE_LIMIT_STRIKES_MAX = 50;

const categoryOf = (type: HubClientMessage["type"]): Category => {
  switch (type) {
    case "publish":
      return "publish";
    case "hello":
    case "ack":
    case "thread.subscribe":
    case "thread.unsubscribe":
      return "read";
    default:
      return "write";
  }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS subscriptions (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
`;

export class SyncSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Frames that arrive while `welcome` is being built; flushed right after it. */
  private readonly pending = new Map<string, Array<string>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly buckets = new Map<Category, { tokens: number; at: number }>();
  private strikes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HUB_PING, HUB_PONG));
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const linkId = request.headers.get(SYNC_LINK_HEADER) as HubEnvironmentLinkId | null;
    const accountId = request.headers.get(SYNC_ACCOUNT_HEADER) as HubAccountId | null;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !linkId || !accountId) {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    for (const previous of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(previous);
      previous.serializeAttachment(null);
      try {
        previous.close(HUB_CLOSE_CODES.replaced, "Replaced by a newer connection");
      } catch {
        // Already closing.
      }
      if (attachment) await this.detachProjects(attachment);
    }
    this.sql.exec("DELETE FROM projects");
    this.sql.exec("DELETE FROM subscriptions");
    this.pending.clear();
    this.buckets.clear();
    this.strikes = 0;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { connId: randomToken(12), linkId, accountId, phase: "hello" };
    server.serializeAttachment(attachment);
    await Db.setLiveConnection(this.env.DB, linkId, attachment.connId, nowMs());
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const run = this.queue.then(() => this.handleFrame(ws, message));
    this.queue = run.catch((cause: unknown) => {
      console.error("hub sync frame failed", cause);
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.closed(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.closed(ws);
  }

  private async closed(ws: WebSocket) {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;
    ws.serializeAttachment(null);
    this.pending.delete(attachment.connId);
    await this.detachProjects(attachment);
    this.sql.exec("DELETE FROM projects");
    this.sql.exec("DELETE FROM subscriptions");
    await Db.clearLiveConnection(this.env.DB, attachment.linkId, attachment.connId);
    try {
      ws.close(1000, "Closed");
    } catch {
      // Already closed.
    }
  }

  private async detachProjects(attachment: Attachment) {
    const projectIds = this.sql
      .exec<{ project_id: string }>("SELECT project_id FROM projects")
      .toArray()
      .map((row) => row.project_id);
    await Promise.all(
      projectIds.map((projectId) =>
        this.project(projectId)
          .detach({ linkId: attachment.linkId, connId: attachment.connId })
          .catch(() => undefined),
      ),
    );
  }

  /** Closes the socket for good: the link was revoked (4403). */
  async revoke(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      ws.serializeAttachment(null);
      try {
        ws.close(HUB_CLOSE_CODES.linkRevoked, "This environment link was revoked");
      } catch {
        // Already closed.
      }
      if (attachment) this.pending.delete(attachment.connId);
    }
    this.sql.exec("DELETE FROM projects");
    this.sql.exec("DELETE FROM subscriptions");
  }

  /**
   * Called by project objects (and the HTTP API) to push frames to this
   * link's socket. False when `connId` is no longer the live socket.
   */
  async deliver(
    connId: string,
    frames: Array<string>,
    change: AccessChange | null,
  ): Promise<boolean> {
    const ws = this.socketFor(connId);
    if (!ws) return false;
    if (change?.added) {
      this.sql.exec("INSERT OR IGNORE INTO projects (project_id) VALUES (?)", change.added);
    }
    if (change?.removed) {
      this.sql.exec("DELETE FROM projects WHERE project_id = ?", change.removed);
      this.sql.exec("DELETE FROM subscriptions WHERE project_id = ?", change.removed);
    }
    const buffer = this.pending.get(connId);
    if (buffer) {
      buffer.push(...frames);
      return true;
    }
    for (const frame of frames) ws.send(frame);
    return true;
  }

  private socketFor(connId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachmentOf(ws)?.connId === connId) return ws;
    }
    return null;
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private project(projectId: string) {
    return this.env.PROJECT_HUB.get(this.env.PROJECT_HUB.idFromName(projectId));
  }

  private send(ws: WebSocket, message: HubServerMessage) {
    ws.send(encodeServerMessage(message));
  }

  private closeWith(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  private takeToken(category: Category): number | null {
    const limit = RATE_LIMITS[category];
    const now = nowMs();
    const bucket = this.buckets.get(category) ?? { tokens: limit.burst, at: now };
    bucket.tokens = Math.min(
      limit.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * limit.perSecond,
    );
    bucket.at = now;
    this.buckets.set(category, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / limit.perSecond));
  }

  private async handleFrame(ws: WebSocket, raw: string | ArrayBuffer) {
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;
    if (typeof raw !== "string") {
      this.send(ws, reject(null, "invalid", "Frames must be JSON text."));
      return;
    }
    if (exceedsBytes(raw, HUB_SYNC_LIMITS.frameMaxBytes)) {
      this.send(
        ws,
        reject(
          requestIdOf(raw.slice(0, 512)),
          "invalid",
          "Frame exceeds HUB_SYNC_LIMITS.frameMaxBytes.",
        ),
      );
      return;
    }
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      this.send(ws, reject(requestIdOf(raw), "invalid", "Could not decode this message."));
      if (attachment.phase === "hello")
        this.closeWith(ws, HUB_CLOSE_CODES.invalid, "Expected hello");
      return;
    }
    const message = parsed.message;
    if (attachment.phase === "hello" && message.type !== "hello") {
      this.send(ws, reject(null, "invalid", "The first message must be hello."));
      this.closeWith(ws, HUB_CLOSE_CODES.invalid, "Expected hello");
      return;
    }
    if (attachment.phase !== "hello" && message.type === "hello") {
      this.send(ws, reject(null, "invalid", "Already said hello."));
      return;
    }
    const retryAfterSeconds = this.takeToken(categoryOf(message.type));
    if (retryAfterSeconds !== null) {
      this.strikes += 1;
      const requestId = "requestId" in message ? message.requestId : null;
      this.send(ws, reject(requestId, "rate-limited", "Slow down.", { retryAfterSeconds }));
      if (this.strikes > RATE_LIMIT_STRIKES_MAX) {
        this.closeWith(ws, HUB_CLOSE_CODES.rateLimited, "Too many requests");
      }
      return;
    }
    this.strikes = 0;
    try {
      const reply = await this.dispatch(ws, attachment, message);
      if (reply) this.send(ws, reply);
    } catch (cause) {
      console.error("hub sync message failed", message.type, cause);
      const requestId = "requestId" in message ? message.requestId : null;
      this.send(
        ws,
        reject(
          requestId,
          "rate-limited",
          "The hub could not process this request; retry shortly.",
          {
            retryAfterSeconds: 5,
          },
        ),
      );
    }
  }

  private async dispatch(
    ws: WebSocket,
    attachment: Attachment,
    message: HubClientMessage,
  ): Promise<HubServerMessage | null> {
    const caller = (projectId: string): Caller => ({
      projectId: projectId as HubProjectId,
      linkId: attachment.linkId,
      accountId: attachment.accountId,
      connId: attachment.connId,
    });
    switch (message.type) {
      case "hello":
        await this.hello(ws, attachment, message);
        return null;
      case "publish":
        return this.project(message.projectId).publish({ ...caller(message.projectId), message });
      case "ack":
        await this.ackCursors(message.cursors, caller);
        return null;
      case "thread.subscribe":
        return this.subscribe(ws, message.threadId, message.cursor ?? null, caller);
      case "thread.unsubscribe": {
        const row = this.sql
          .exec<{ project_id: string }>(
            "SELECT project_id FROM subscriptions WHERE thread_id = ?",
            message.threadId,
          )
          .toArray()[0];
        this.sql.exec("DELETE FROM subscriptions WHERE thread_id = ?", message.threadId);
        if (row) {
          await this.project(row.project_id).unsubscribe({
            linkId: attachment.linkId,
            threadId: message.threadId,
          });
        }
        return null;
      }
      case "comment.add":
      case "comment.delete": {
        const index = await Db.getThreadIndex(this.env.DB, message.threadId);
        if (!index || index.removed_reason !== null) {
          return reject(message.requestId, "not-found", "No such shared thread.");
        }
        const stub = this.project(index.project_id);
        return message.type === "comment.add"
          ? stub.commentAdd({ ...caller(index.project_id), message })
          : stub.commentDelete({ ...caller(index.project_id), message });
      }
      case "brief.update":
        return this.project(message.projectId).briefUpdate({
          ...caller(message.projectId),
          message,
        });
      case "focus.set":
        return this.project(message.projectId).focusSet({ ...caller(message.projectId), message });
      case "invitation.create":
        return this.project(message.projectId).invitationCreate({
          ...caller(message.projectId),
          message,
        });
      case "invitation.accept":
      case "invitation.decline":
      case "invitation.cancel": {
        const invitation = await Db.getInvitation(this.env.DB, message.invitationId);
        if (!invitation) return reject(message.requestId, "not-found", "No such invitation.");
        return this.project(invitation.projectId).invitationAction({
          ...caller(invitation.projectId),
          message,
        });
      }
      case "member.leave":
        return this.project(message.projectId).memberLeave({
          ...caller(message.projectId),
          message,
        });
      case "member.remove":
        return this.project(message.projectId).memberRemove({
          ...caller(message.projectId),
          message,
        });
      case "analysis.post":
        return this.project(message.projectId).analysisPost({
          ...caller(message.projectId),
          message,
        });
    }
  }

  private async hello(
    ws: WebSocket,
    attachment: Attachment,
    message: Extract<HubClientMessage, { type: "hello" }>,
  ) {
    const version = negotiateHubProtocol(message.protocol);
    if (version === null) {
      const side = hubProtocolMismatchSide(message.protocol);
      this.send(
        ws,
        reject(
          null,
          "version-mismatch",
          side === "client-outdated"
            ? "This Puff Collab is too old for the hub. Update it to keep syncing."
            : "The hub is older than this Puff Collab. Ask the hub's operator to update it.",
          { protocol: HUB_PROTOCOL_RANGE },
        ),
      );
      this.closeWith(ws, HUB_CLOSE_CODES.versionMismatch, "Protocol version mismatch");
      return;
    }
    if (message.subscriptions.length > HUB_SYNC_LIMITS.subscriptionsMax) {
      this.send(ws, reject(null, "invalid", "Too many subscriptions."));
      this.closeWith(ws, HUB_CLOSE_CODES.invalid, "Too many subscriptions");
      return;
    }
    const db = this.env.DB;
    const [account, link] = await Promise.all([
      Db.getAccount(db, attachment.accountId),
      Db.getLink(db, attachment.linkId),
    ]);
    if (!account || !link || link.revoked) {
      this.closeWith(ws, HUB_CLOSE_CODES.linkRevoked, "This environment link was revoked");
      return;
    }

    const welcoming: Attachment = { ...attachment, phase: "welcoming" };
    ws.serializeAttachment(welcoming);
    this.pending.set(attachment.connId, []);

    const projectIds = await Db.projectIdsForAccount(db, attachment.accountId);
    const memberOf = new Set<string>(projectIds);
    const indexes = await Db.getThreadIndexes(
      db,
      message.subscriptions.map((cursor) => cursor.threadId),
    );
    const projectOfThread = new Map(indexes.map((row) => [row.thread_id, row.project_id]));
    const cursorsByProject = new Map<string, Array<HubThreadCursor>>();
    const lost: Array<HubServerMessage> = [];
    for (const cursor of message.subscriptions) {
      const projectId = projectOfThread.get(cursor.threadId);
      if (!projectId) {
        lost.push(reject(null, "not-found", `Unknown thread ${cursor.threadId}.`));
      } else if (!memberOf.has(projectId)) {
        lost.push({
          type: "thread.removed",
          projectId: projectId as HubProjectId,
          threadId: cursor.threadId,
          reason: "access-lost",
        });
      } else {
        cursorsByProject.set(projectId, [...(cursorsByProject.get(projectId) ?? []), cursor]);
      }
    }

    const attached = await Promise.all(
      projectIds.map(async (projectId) => ({
        projectId,
        result: await this.project(projectId).attach({
          projectId,
          linkId: attachment.linkId,
          accountId: attachment.accountId,
          connId: attachment.connId,
          subscriptions: cursorsByProject.get(projectId) ?? [],
        }),
      })),
    );
    const states: Array<HubProjectState> = [];
    const published: Array<HubThreadCursor> = [];
    for (const { projectId, result } of attached) {
      if (!result.ok) continue;
      states.push(result.state);
      published.push(...result.published);
      this.sql.exec("INSERT OR IGNORE INTO projects (project_id) VALUES (?)", projectId);
      for (const cursor of cursorsByProject.get(projectId) ?? []) {
        this.sql.exec(
          "INSERT OR REPLACE INTO subscriptions (thread_id, project_id) VALUES (?, ?)",
          cursor.threadId,
          projectId,
        );
      }
    }
    await Db.expireInvitations(db, nowMs());
    const invitations = await Db.pendingInvitationsForAccount(db, account);

    // A newer socket may have replaced this one while we awaited.
    if (this.attachmentOf(ws)?.connId !== attachment.connId) return;
    this.send(ws, {
      type: "welcome",
      protocolVersion: version,
      account,
      linkId: attachment.linkId,
      projects: states,
      published,
      invitations,
      serverTime: isoOf(nowMs()),
    });
    ws.serializeAttachment({ ...attachment, phase: "ready" } satisfies Attachment);
    const buffered = this.pending.get(attachment.connId) ?? [];
    this.pending.delete(attachment.connId);
    for (const frame of buffered) ws.send(frame);
    for (const frame of lost) this.send(ws, frame);
    await Promise.all(
      attached
        .filter(({ result }) => result.ok)
        .map(({ projectId }) =>
          this.project(projectId).resume({
            projectId,
            linkId: attachment.linkId,
            accountId: attachment.accountId,
            connId: attachment.connId,
          }),
        ),
    );
  }

  private async subscribe(
    ws: WebSocket,
    threadId: HubThreadId,
    cursor: HubThreadCursor | null,
    caller: (projectId: string) => Caller,
  ): Promise<ReplyMessage | null> {
    const index = await Db.getThreadIndex(this.env.DB, threadId);
    if (!index) return reject(null, "not-found", `Unknown thread ${threadId}.`);
    if (index.removed_reason !== null) {
      this.send(ws, {
        type: "thread.removed",
        projectId: index.project_id as HubProjectId,
        threadId,
        reason: index.removed_reason,
      });
      return null;
    }
    const known = this.sql
      .exec<{ thread_id: string }>(
        "SELECT thread_id FROM subscriptions WHERE thread_id = ?",
        threadId,
      )
      .toArray()[0];
    const count = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM subscriptions")
      .one().count;
    if (!known && count >= HUB_SYNC_LIMITS.subscriptionsMax) {
      return reject(null, "invalid", "Too many subscriptions.");
    }
    const denied = await this.project(index.project_id).subscribe({
      ...caller(index.project_id),
      threadId,
      cursor,
    });
    if (denied) return denied;
    this.sql.exec(
      "INSERT OR REPLACE INTO subscriptions (thread_id, project_id) VALUES (?, ?)",
      threadId,
      index.project_id,
    );
    return null;
  }

  private async ackCursors(
    cursors: ReadonlyArray<HubThreadCursor>,
    caller: (projectId: string) => Caller,
  ) {
    const byProject = new Map<string, Array<HubThreadCursor>>();
    for (const cursor of cursors) {
      const row = this.sql
        .exec<{ project_id: string }>(
          "SELECT project_id FROM subscriptions WHERE thread_id = ?",
          cursor.threadId,
        )
        .toArray()[0];
      if (row) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), cursor]);
    }
    await Promise.all(
      [...byProject].map(([projectId, projectCursors]) =>
        this.project(projectId).ack({ ...caller(projectId), cursors: projectCursors }),
      ),
    );
  }
}
