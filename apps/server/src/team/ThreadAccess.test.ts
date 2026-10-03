import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HubThreadLink,
  HubAccountId,
  HubThreadId,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadAccess from "./ThreadAccess.ts";

const encodeHubLink = Schema.encodeSync(Schema.fromJsonString(HubThreadLink));

const testLayer = ThreadAccess.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const LOCAL = ThreadId.make("thread-local");
const MIRROR = ThreadId.make("hub:link-ada:t1");
const mirrorLink: HubThreadLink = {
  threadId: HubThreadId.make("link-ada:t1"),
  ownerId: HubAccountId.make("acct-ada"),
  ownerLogin: "ada",
  ownerDisplayName: "Ada",
  remote: true,
  syncState: "synced",
};

// The policy reads only the routing fields of a command.
const command = (threadId: ThreadId, fields: Record<string, unknown>) =>
  ({ commandId: "cmd", threadId, ...fields }) as unknown as OrchestrationCommand;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [threadId, hub] of [
    [LOCAL, null],
    [MIRROR, encodeHubLink(mirrorLink)],
  ] as const) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, hub_link_json
      )
      VALUES (
        ${threadId}, 'project-1', 'T', '{}', 'full-access', 'default',
        NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ${hub}
      )
    `;
  }
  yield* sql`
    INSERT INTO hub_link (id, hub_url, link_id, account_json, linked_at)
    VALUES (1, 'https://hub.test', 'link-me', '{"accountId":"acct-me"}', '2026-01-01T00:00:00.000Z')
  `;
  for (const [commentId, threadId, authorId] of [
    ["c-local", LOCAL, "owner"],
    ["c-mine", MIRROR, "hub:acct-me"],
    ["c-ada", MIRROR, "hub:acct-ada"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_thread_comments (comment_id, thread_id, author_id, text, created_at)
      VALUES (${commentId}, ${threadId}, ${authorId}, 'hi', '2026-01-01T00:00:00.000Z')
    `;
  }
});

it.layer(NodeServices.layer)("ThreadAccess", (it) => {
  it.effect("lets the owner do anything to local threads", () =>
    Effect.gen(function* () {
      yield* seed;
      const access = yield* ThreadAccess.ThreadAccess;
      for (const type of [
        "thread.turn.start",
        "thread.archive",
        "thread.delete",
        "thread.settle",
      ]) {
        yield* access.authorizeCommand(command(LOCAL, { type }));
      }
      yield* access.authorizeCommand(
        command(LOCAL, { type: "thread.comment.delete", commentId: "c-local" }),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps mirrors read-only except comments and the viewer's own organization", () =>
    Effect.gen(function* () {
      yield* seed;
      const access = yield* ThreadAccess.ThreadAccess;
      for (const type of [
        "thread.turn.start",
        "thread.archive",
        "thread.settle",
        "thread.delete",
        "thread.meta.update",
        "thread.related-thread.link",
      ]) {
        const denied = yield* Effect.flip(access.authorizeCommand(command(MIRROR, { type })));
        expect(denied).toMatchObject({ reason: "remote-hub-thread" });
      }
      for (const type of ["thread.comment.add", "thread.pin", "thread.unpin", "thread.snooze"]) {
        yield* access.authorizeCommand(command(MIRROR, { type }));
      }
      yield* access.authorizeCommand(
        command(MIRROR, { type: "thread.comment.delete", commentId: "c-mine" }),
      );
      const notMine = yield* Effect.flip(
        access.authorizeCommand(
          command(MIRROR, { type: "thread.comment.delete", commentId: "c-ada" }),
        ),
      );
      expect(notMine).toMatchObject({ reason: "not-comment-author" });
    }).pipe(Effect.provide(testLayer)),
  );
});
