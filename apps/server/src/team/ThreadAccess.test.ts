import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type MemberId,
  type OrchestrationCommand,
  OWNER_MEMBER_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
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

const testLayer = ThreadAccess.layer.pipe(
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-access-test-" })),
);

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadId = ThreadId.make("thread-ada");

// The policy reads only the routing fields of a command.
const command = (fields: Record<string, unknown>) =>
  ({ commandId: "cmd", threadId, ...fields }) as unknown as OrchestrationCommand;

/** Every owner-controlled client command, as the policy sees it. */
const OWNER_ONLY_COMMANDS: ReadonlyArray<OrchestrationCommand> = [
  command({ type: "thread.turn.start" }),
  command({ type: "thread.approval.respond", requestId: "req" }),
  command({ type: "thread.user-input.respond", requestId: "req" }),
  command({ type: "thread.user-input.dismiss", requestId: "req" }),
  command({ type: "thread.turn.interrupt" }),
  command({ type: "thread.checkpoint.revert", turnCount: 0 }),
  command({ type: "thread.conversation.revert", turnCount: 0 }),
  command({ type: "thread.session.stop" }),
  command({ type: "thread.runtime-mode.set", runtimeMode: "full-access" }),
  command({ type: "thread.interaction-mode.set", interactionMode: "plan" }),
  command({ type: "thread.visibility.set", visibility: "private" }),
  command({ type: "thread.archive" }),
  command({ type: "thread.unarchive" }),
  command({ type: "thread.delete" }),
  command({ type: "thread.meta.update", title: "Renamed" }),
  command({ type: "thread.settle" }),
  command({ type: "thread.pin" }),
];

const ADMIN_HOUSEKEEPING = new Set([
  "thread.session.stop",
  "thread.turn.interrupt",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
]);

const setup = Effect.gen(function* () {
  const team = yield* TeamAccess.TeamAccess;
  const access = yield* ThreadAccess.ThreadAccess;
  const sql = yield* SqlClient.SqlClient;
  const ada = yield* team.addMember({ username: "ada", displayName: "Ada", role: "member" });
  const bob = yield* team.addMember({ username: "bob", displayName: "Bob", role: "member" });
  const carol = yield* team.addMember({ username: "carol", displayName: "Carol", role: "admin" });
  yield* team.addProjectMember({ projectId: projectA, memberId: ada.memberId });
  yield* team.addProjectMember({ projectId: projectA, memberId: bob.memberId });
  const insertThread = (id: string, projectId: ProjectId, createdBy: MemberId | null) => sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, created_by
    )
    VALUES (
      ${id}, ${projectId}, 'T', '{}', 'full-access', 'default',
      NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ${createdBy}
    )
  `;
  yield* insertThread(threadId, projectA, ada.memberId);
  const share = (visibility: "shared" | "private") =>
    sql`UPDATE projection_threads SET visibility = ${visibility} WHERE thread_id = ${threadId}`;
  const authorize = (memberId: MemberId, next: OrchestrationCommand) =>
    access.authorizeCommand(memberId, next).pipe(
      Effect.as("allowed" as const),
      Effect.catchTag("ThreadAccessDeniedError", (error) => Effect.succeed(error.reason)),
    );
  return {
    access,
    sql,
    ada: ada.memberId,
    bob: bob.memberId,
    carol: carol.memberId,
    insertThread,
    share,
    authorize,
  };
});

it.layer(NodeServices.layer)("ThreadAccess", (it) => {
  it.effect(
    "lets only the owner control a thread; admins only stop, interrupt, archive, delete",
    () =>
      Effect.gen(function* () {
        const { ada, bob, carol, share, authorize } = yield* setup;
        yield* share("shared");
        for (const next of OWNER_ONLY_COMMANDS) {
          expect([next.type, yield* authorize(ada, next)]).toEqual([next.type, "allowed"]);
          expect([next.type, yield* authorize(bob, next)]).toEqual([next.type, "not-thread-owner"]);
          expect([next.type, yield* authorize(carol, next)]).toEqual([
            next.type,
            ADMIN_HOUSEKEEPING.has(next.type) ? "allowed" : "not-thread-owner",
          ]);
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("hides private threads from teammates, including in command errors", () =>
    Effect.gen(function* () {
      const { access, ada, bob, carol, share, authorize, insertThread } = yield* setup;
      const interrupt = command({ type: "thread.turn.interrupt" });
      const comment = command({ type: "thread.comment.add", commentId: "c1", text: "hi" });

      expect(yield* authorize(bob, interrupt)).toBe("thread-not-visible");
      expect(yield* authorize(bob, comment)).toBe("thread-not-visible");
      expect(yield* authorize(ada, comment)).toBe("allowed");
      expect(yield* authorize(carol, comment)).toBe("allowed");

      yield* share("shared");
      expect(yield* authorize(bob, comment)).toBe("allowed");

      yield* insertThread("thread-legacy", projectA, null);
      const visible = yield* access.visibleThreadIds(bob, [
        threadId,
        ThreadId.make("thread-legacy"),
        ThreadId.make("thread-missing"),
      ]);
      expect([...visible]).toEqual([threadId]);
      // Creator-less threads belong to the environment owner.
      expect(
        yield* access.canControlThread(
          OWNER_MEMBER_ID,
          ThreadId.make("thread-legacy"),
          "thread.turn.start",
        ),
      ).toBe(true);
      expect(
        yield* access.canControlThread(ada, ThreadId.make("thread-legacy"), "thread.turn.start"),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("lets authors (and admins) delete comments", () =>
    Effect.gen(function* () {
      const { ada, bob, carol, sql, share, authorize } = yield* setup;
      yield* share("shared");
      yield* sql`
        INSERT INTO projection_thread_comments (comment_id, thread_id, author_id, text, created_at)
        VALUES ('c-bob', ${threadId}, ${bob}, 'Nice', '2026-01-01T00:00:00.000Z')
      `;
      const remove = command({ type: "thread.comment.delete", commentId: "c-bob" });
      expect(yield* authorize(bob, remove)).toBe("allowed");
      expect(yield* authorize(ada, remove)).toBe("not-comment-author");
      expect(yield* authorize(carol, remove)).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires project membership to create threads and admin to delete projects", () =>
    Effect.gen(function* () {
      const { ada, carol, authorize } = yield* setup;
      const create = (projectId: ProjectId) =>
        command({ type: "thread.create", threadId: "new-thread", projectId });
      expect(yield* authorize(ada, create(projectA))).toBe("allowed");
      expect(yield* authorize(ada, create(projectB))).toBe("not-project-member");
      const bootstrapStart = command({
        type: "thread.turn.start",
        threadId: "new-thread",
        bootstrap: { createThread: { projectId: projectB } },
      });
      expect(yield* authorize(ada, bootstrapStart)).toBe("not-project-member");
      expect(yield* authorize(carol, bootstrapStart)).toBe("allowed");

      expect(
        yield* authorize(ada, command({ type: "project.meta.update", projectId: projectA })),
      ).toBe("allowed");
      expect(yield* authorize(ada, command({ type: "project.delete", projectId: projectA }))).toBe(
        "admin-only",
      );
      expect(
        yield* authorize(carol, command({ type: "project.delete", projectId: projectA })),
      ).toBe("allowed");
    }).pipe(Effect.provide(testLayer)),
  );

  it("filters snapshots to what a viewer can see", () => {
    const ada = "ada" as MemberId;
    const viewer: ThreadAccess.ThreadViewer = {
      memberId: ada,
      projects: { all: false, projectIds: new Set([projectA]) },
    };
    const snapshot = ThreadAccess.filterSnapshotForViewer(
      {
        projects: [{ id: projectA }, { id: projectB }],
        threads: [
          { id: "mine-private", projectId: projectB, createdBy: ada },
          { id: "theirs-private", projectId: projectA, createdBy: "bob" as MemberId },
          {
            id: "theirs-shared",
            projectId: projectA,
            createdBy: "bob" as MemberId,
            visibility: "shared" as const,
          },
          { id: "other-project-shared", projectId: projectB, visibility: "shared" as const },
          { id: "legacy", projectId: projectA, createdBy: null },
        ],
      },
      viewer,
    );
    expect(snapshot.projects.map((project) => project.id)).toEqual([projectA]);
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["mine-private", "theirs-shared"]);
  });
});
