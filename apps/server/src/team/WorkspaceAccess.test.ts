import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type MemberId, OWNER_MEMBER_ID, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamAccess from "./TeamAccess.ts";
import * as ThreadAccess from "./ThreadAccess.ts";
import * as WorkspaceAccess from "./WorkspaceAccess.ts";

const testLayer = WorkspaceAccess.layer.pipe(
  Layer.provideMerge(ThreadAccess.layer),
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-access-test-" })),
);

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const setup = Effect.gen(function* () {
  const team = yield* TeamAccess.TeamAccess;
  const access = yield* WorkspaceAccess.WorkspaceAccess;
  const sql = yield* SqlClient.SqlClient;
  const ada = (yield* team.addMember({ username: "ada", displayName: "Ada", role: "member" }))
    .memberId;
  const bob = (yield* team.addMember({ username: "bob", displayName: "Bob", role: "member" }))
    .memberId;
  const carol = (yield* team.addMember({ username: "carol", displayName: "Carol", role: "admin" }))
    .memberId;
  yield* team.addProjectMember({ projectId: projectA, memberId: ada });
  yield* team.addProjectMember({ projectId: projectA, memberId: bob });

  const insertProject = (id: ProjectId, workspaceRoot: string) => sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (${id}, 'P', ${workspaceRoot}, '[]', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', NULL)
  `;
  const insertThread = (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly createdBy: MemberId | null;
    readonly worktreePath: string | null;
    readonly visibility?: "shared" | "private";
  }) => sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, created_by,
      visibility
    )
    VALUES (
      ${input.id}, ${input.projectId}, 'T', '{}', 'full-access', 'default',
      NULL, ${input.worktreePath}, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      NULL, ${input.createdBy}, ${input.visibility ?? "private"}
    )
  `;
  yield* insertProject(projectA, "/work/alpha");
  yield* insertProject(projectB, "/work/beta");
  yield* insertThread({
    id: "thread-ada-shared",
    projectId: projectA,
    createdBy: ada,
    worktreePath: "/worktrees/ada-shared",
    visibility: "shared",
  });
  yield* insertThread({
    id: "thread-ada-private",
    projectId: projectA,
    createdBy: ada,
    worktreePath: "/work/alpha/.worktrees/ada-private",
  });

  const check = (
    memberId: MemberId,
    target: string,
    mode: WorkspaceAccess.WorkspaceAccessMode = "read",
  ) =>
    access.authorizePath(memberId, target, mode).pipe(
      Effect.as("allowed" as const),
      Effect.catchTag("WorkspaceAccessDeniedError", (error) => Effect.succeed(error.reason)),
    );
  const checkThread = (
    memberId: MemberId,
    threadId: string,
    mode: WorkspaceAccess.WorkspaceAccessMode,
  ) =>
    access.authorizeThread(memberId, ThreadId.make(threadId), mode).pipe(
      Effect.as("allowed" as const),
      Effect.catchTag("WorkspaceAccessDeniedError", (error) => Effect.succeed(error.reason)),
    );
  return { access, ada, bob, carol, check, checkThread };
});

it.layer(NodeServices.layer)("WorkspaceAccess", (it) => {
  it.effect("needs project membership for a project's checkout", () =>
    Effect.gen(function* () {
      const { ada, carol, check } = yield* setup;
      expect(yield* check(ada, "/work/alpha")).toBe("allowed");
      expect(yield* check(ada, "/work/alpha/src/index.ts", "write")).toBe("allowed");
      expect(yield* check(ada, "/work/beta")).toBe("not-project-member");
      // `..` cannot climb from a project the member belongs to into another.
      expect(yield* check(ada, "/work/alpha/../beta")).toBe("not-project-member");
      expect(yield* check(carol, "/work/beta", "write")).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("lets teammates read a shared thread's worktree and only its owner change it", () =>
    Effect.gen(function* () {
      const { ada, bob, carol, check } = yield* setup;
      expect(yield* check(ada, "/worktrees/ada-shared", "write")).toBe("allowed");
      expect(yield* check(bob, "/worktrees/ada-shared/src")).toBe("allowed");
      expect(yield* check(bob, "/worktrees/ada-shared", "write")).toBe("not-thread-owner");
      expect(yield* check(carol, "/worktrees/ada-shared", "write")).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("hides a private thread's worktree even inside a shared project root", () =>
    Effect.gen(function* () {
      const { ada, bob, check } = yield* setup;
      const worktree = "/work/alpha/.worktrees/ada-private";
      expect(yield* check(ada, worktree, "write")).toBe("allowed");
      expect(yield* check(bob, worktree)).toBe("thread-not-visible");
      // The project root around it stays open to members.
      expect(yield* check(bob, "/work/alpha/.worktrees")).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps folders outside every project for admins", () =>
    Effect.gen(function* () {
      const { ada, carol, check } = yield* setup;
      expect(yield* check(ada, "/Users/owner/.ssh")).toBe("outside-projects");
      expect(yield* check(ada, "/")).toBe("outside-projects");
      expect(yield* check(carol, "/Users/owner")).toBe("allowed");
      expect(yield* check(OWNER_MEMBER_ID, "/Users/owner", "write")).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("gates thread-scoped features by visibility and ownership", () =>
    Effect.gen(function* () {
      const { ada, bob, carol, checkThread } = yield* setup;
      expect(yield* checkThread(bob, "thread-ada-shared", "read")).toBe("allowed");
      expect(yield* checkThread(bob, "thread-ada-shared", "write")).toBe("not-thread-owner");
      expect(yield* checkThread(bob, "thread-ada-private", "read")).toBe("thread-not-visible");
      expect(yield* checkThread(ada, "thread-ada-private", "write")).toBe("allowed");
      expect(yield* checkThread(carol, "thread-ada-private", "write")).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("narrows project listings to the member's projects", () =>
    Effect.gen(function* () {
      const { access, ada, carol } = yield* setup;
      expect(yield* access.visibleProjectIds(ada, undefined)).toEqual([projectA]);
      expect(yield* access.visibleProjectIds(ada, [projectA, projectB])).toEqual([projectA]);
      expect(yield* access.visibleProjectIds(carol, undefined)).toBeUndefined();
      const denied = yield* access.authorizeProject(ada, projectB).pipe(Effect.flip);
      expect(denied).toMatchObject({ reason: "not-project-member" });
    }).pipe(Effect.provide(testLayer)),
  );
});
