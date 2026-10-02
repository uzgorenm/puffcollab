import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type MemberId,
  type OrchestrationCommand,
  OWNER_MEMBER_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { makeMcpThreadDispatch } from "./McpThreadDispatch.ts";

const projectId = ProjectId.make("project-a");

const setup = Effect.gen(function* () {
  const dispatched = yield* Ref.make<
    ReadonlyArray<{ readonly type: string; readonly actor: MemberId | undefined }>
  >([]);
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
    dispatch: (command, options) =>
      Ref.update(dispatched, (all) => [...all, { type: command.type, actor: options?.actor }]).pipe(
        Effect.as({ sequence: 1 }),
      ),
  });
  const team = yield* TeamAccess.TeamAccess;
  const sql = yield* SqlClient.SqlClient;
  const ada = yield* team.addMember({ username: "ada", displayName: "Ada", role: "member" });
  const bob = yield* team.addMember({ username: "bob", displayName: "Bob", role: "member" });
  yield* team.addProjectMember({ projectId, memberId: ada.memberId });
  yield* team.addProjectMember({ projectId, memberId: bob.memberId });
  const insertThread = (id: string, createdBy: MemberId | null) => sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, created_by,
      visibility
    )
    VALUES (
      ${id}, ${projectId}, 'T', '{}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
      ${createdBy}, 'shared'
    )
  `;
  yield* insertThread("thread-ada", ada.memberId);
  yield* insertThread("thread-bob", bob.memberId);
  yield* insertThread("thread-legacy", null);
  const dispatch = yield* makeMcpThreadDispatch.pipe(Effect.provide(engineLayer));
  return { ada: ada.memberId, bob: bob.memberId, dispatch, dispatched };
});

const testLayer = ThreadAccess.layer.pipe(
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-dispatch-test-" })),
);

const settle = (threadId: string) =>
  ({
    type: "thread.settle",
    commandId: CommandId.make(`cmd-${threadId}`),
    threadId: ThreadId.make(threadId),
  }) as unknown as OrchestrationCommand;

it.layer(NodeServices.layer)("McpThreadDispatch", (it) => {
  it.effect("acts as the invocation thread's owner and stamps that actor", () =>
    Effect.gen(function* () {
      const { bob, dispatch, dispatched } = yield* setup;
      yield* dispatch({ createdBy: bob }, settle("thread-bob"));
      // A creator-less thread belongs to the environment owner, an admin.
      yield* dispatch({ createdBy: null }, settle("thread-legacy"));
      expect(yield* Ref.get(dispatched)).toEqual([
        { type: "thread.settle", actor: bob },
        { type: "thread.settle", actor: OWNER_MEMBER_ID },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an MCP command aimed at another member's thread", () =>
    Effect.gen(function* () {
      const { bob, dispatch, dispatched } = yield* setup;
      const error = yield* Effect.flip(dispatch({ createdBy: bob }, settle("thread-ada")));
      expect(error).toMatchObject({ _tag: "ThreadAccessDeniedError", reason: "not-thread-owner" });
      expect(yield* Ref.get(dispatched)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
