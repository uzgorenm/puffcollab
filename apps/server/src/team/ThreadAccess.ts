/**
 * ThreadAccess - what a client may do to a thread (Puff Collab).
 *
 * Each local server is single-user: every paired session is the environment
 * owner's, and the owner controls every local thread. Teammates' threads
 * mirrored from the team hub (`isRemoteHubThread`) are read-only here: their
 * agent runs on the owner's machine. On a mirror this server may comment,
 * delete its own hub comments, and organize its own view (pin, snooze).
 *
 * Every client-dispatched orchestration command goes through
 * `authorizeCommand` before it reaches the engine (WebSocket, HTTP and MCP),
 * so transports share one rule.
 *
 * @module ThreadAccess
 */
import {
  HubThreadLink,
  isRemoteHubThread,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Organizing a mirror only changes this server's view of it (it is never
 * published), so pinning and snoozing work there like on any thread. Archive
 * and settle stay with the owner: they are the owner's state, synced from
 * their machine.
 */
const MIRROR_LOCAL_COMMANDS: ReadonlySet<OrchestrationCommand["type"]> = new Set([
  "thread.comment.add",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.snooze",
  "thread.unsnooze",
]);

export type ThreadAccessDeniedReason = "not-comment-author" | "remote-hub-thread";

export class ThreadAccessDeniedError extends Schema.TaggedError<ThreadAccessDeniedError>()(
  "ThreadAccessDeniedError",
  {
    commandType: Schema.String,
    reason: Schema.Literals(["not-comment-author", "remote-hub-thread"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-comment-author":
        return "You can only delete your own comments.";
      case "remote-hub-thread":
        return "This is a teammate's thread from the team hub. You can follow and comment on it.";
    }
  }
}

export class ThreadAccessPersistenceError extends Schema.TaggedError<ThreadAccessPersistenceError>()(
  "ThreadAccessPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread access check failed during ${this.operation}.`;
  }
}

export class ThreadAccess extends Context.Service<
  ThreadAccess,
  {
    /**
     * Reject a client-dispatched command this server may not issue. Run it on
     * every command a client sends, before dispatch.
     */
    readonly authorizeCommand: (
      command: OrchestrationCommand,
    ) => Effect.Effect<void, ThreadAccessDeniedError | ThreadAccessPersistenceError>;
  }
>()("t3/team/ThreadAccess") {}

const decodeHubLink = Schema.decodeUnknownOption(Schema.fromJsonString(HubThreadLink));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ThreadAccessPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new ThreadAccessPersistenceError({ operation, cause })),
      );

  const isMirror = (threadId: ThreadId) =>
    sql<{ readonly hubLink: string | null }>`
      SELECT hub_link_json AS "hubLink" FROM projection_threads WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => {
        const hubLink = rows[0]?.hubLink;
        if (hubLink == null) return false;
        const hub = Option.getOrUndefined(decodeHubLink(hubLink));
        return hub !== undefined && isRemoteHubThread({ hub });
      }),
      persistence("ThreadAccess.findThread"),
    );

  /** This server's hub account, as hub comments record their author (`hub:<accountId>`). */
  const hubAccountId = sql<{ readonly accountId: string | null }>`
    SELECT json_extract(account_json, '$.accountId') AS "accountId" FROM hub_link WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]?.accountId ?? null),
    persistence("ThreadAccess.hubAccount"),
  );

  const deny = (command: OrchestrationCommand, reason: ThreadAccessDeniedReason) =>
    Effect.fail(new ThreadAccessDeniedError({ commandType: command.type, reason }));

  const authorizeCommand: ThreadAccess["Service"]["authorizeCommand"] = (command) =>
    Effect.gen(function* () {
      if (command.type === "thread.comment.delete") {
        const authors = yield* sql<{ readonly authorId: string }>`
          SELECT author_id AS "authorId"
          FROM projection_thread_comments
          WHERE comment_id = ${command.commentId} AND thread_id = ${command.threadId}
        `.pipe(persistence("ThreadAccess.commentAuthor"));
        const authorId = authors[0]?.authorId;
        // A hub comment is deleted by its author only. This server's own
        // (back from the hub after a mirror rebuild) routes to the hub by
        // comment id; a teammate's stays theirs.
        if (authorId === undefined || !authorId.startsWith("hub:")) return;
        return authorId === `hub:${yield* hubAccountId}`
          ? undefined
          : yield* deny(command, "not-comment-author");
      }
      if (!("threadId" in command) || command.type === "thread.create") return;
      if (MIRROR_LOCAL_COMMANDS.has(command.type)) return;
      if (yield* isMirror(command.threadId)) return yield* deny(command, "remote-hub-thread");
    });

  return ThreadAccess.of({ authorizeCommand });
});

export const layer = Layer.effect(ThreadAccess, make);
