import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, type OrchestrationCommand, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { makeMcpThreadDispatch } from "./McpThreadDispatch.ts";

const setup = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
    dispatch: (command) =>
      Ref.update(dispatched, (all) => [...all, "threadId" in command ? command.threadId : ""]).pipe(
        Effect.as({ sequence: 1 }),
      ),
  });
  const sql = yield* SqlClient.SqlClient;
  const insertThread = (id: string, hubLink: string | null) => sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, hub_link_json
    )
    VALUES (
      ${id}, 'project-a', 'T', '{}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ${hubLink}
    )
  `;
  yield* insertThread("thread-mine", null);
  yield* insertThread(
    "hub:link-ada:t1",
    '{"threadId":"link-ada:t1","ownerId":"acct-ada","ownerLogin":"ada","ownerDisplayName":"Ada","remote":true,"syncState":"synced"}',
  );
  const dispatch = yield* makeMcpThreadDispatch.pipe(Effect.provide(engineLayer));
  return { dispatch, dispatched };
});

const testLayer = ThreadAccess.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const settle = (threadId: string) =>
  ({
    type: "thread.settle",
    commandId: CommandId.make(`cmd-${threadId}`),
    threadId: ThreadId.make(threadId),
  }) as unknown as OrchestrationCommand;

it.layer(NodeServices.layer)("McpThreadDispatch", (it) => {
  it.effect("dispatches on the owner's threads and refuses teammates' mirrors", () =>
    Effect.gen(function* () {
      const { dispatch, dispatched } = yield* setup;
      yield* dispatch(settle("thread-mine"));
      const error = yield* Effect.flip(dispatch(settle("hub:link-ada:t1")));
      expect(error).toMatchObject({ _tag: "ThreadAccessDeniedError", reason: "remote-hub-thread" });
      expect(yield* Ref.get(dispatched)).toEqual(["thread-mine"]);
    }).pipe(Effect.provide(testLayer)),
  );
});
