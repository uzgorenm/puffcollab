import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type MemberId,
  type OrchestrationCommand,
  OWNER_MEMBER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type TeamOverviewStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamAccess from "./TeamAccess.ts";
import * as TeamOverview from "./TeamOverview.ts";

const engineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
);

const testLayer = TeamOverview.layer.pipe(
  Layer.provideMerge(engineLayer),
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-overview-test-" })),
);

const projectId = ProjectId.make("project-team");
const NOW = "2026-01-01T00:00:00.000Z";
let commandCounter = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCounter += 1)}`);

const dispatchAs = (actor: MemberId, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch(command, { actor });
  });

/** Owner creates the project; Ada is a project member, Bob is not. */
const setup = Effect.gen(function* () {
  const team = yield* TeamAccess.TeamAccess;
  const ada = yield* team.addMember({ username: "ada", displayName: "Ada", role: "member" });
  const bob = yield* team.addMember({ username: "bob", displayName: "Bob", role: "member" });
  yield* dispatchAs(OWNER_MEMBER_ID, {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Team",
    workspaceRoot: "/tmp/team-overview-project",
    createdAt: NOW,
  });
  yield* team.addProjectMember({ projectId, memberId: ada.memberId });
  return { ada: ada.memberId, bob: bob.memberId };
});

const createThread = (actor: MemberId, threadId: ThreadId, title: string) =>
  dispatchAs(actor, {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId,
    projectId,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });

const setSession = (threadId: ThreadId, status: "running" | "ready", turnId: string | null) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId === null ? null : TurnId.make(turnId),
        lastError: null,
        updatedAt: NOW,
      },
      createdAt: NOW,
    });
  });

it.layer(NodeServices.layer)("TeamOverview", (it) => {
  it.effect("versions the brief with each author and rejects stale or outside edits", () =>
    Effect.gen(function* () {
      const { ada, bob } = yield* setup;
      const overview = yield* TeamOverview.TeamOverview;

      const first = yield* overview.updateBrief(OWNER_MEMBER_ID, {
        projectId,
        text: "Ship the team view.",
        expectedVersion: null,
      });
      const second = yield* overview.updateBrief(ada, {
        projectId,
        text: "Ship the team view, then analysis.",
        expectedVersion: 1,
      });
      const stale = yield* Effect.flip(
        overview.updateBrief(ada, { projectId, text: "Overwrite", expectedVersion: 1 }),
      );
      const outsider = yield* Effect.flip(
        overview.updateBrief(bob, { projectId, text: "Hi", expectedVersion: 2 }),
      );

      expect([first.version, first.authorId]).toEqual([1, OWNER_MEMBER_ID]);
      expect([second.version, second.authorId]).toEqual([2, ada]);
      expect(stale._tag).toBe("TeamOverviewBriefConflictError");
      expect(outsider._tag).toBe("TeamOverviewForbiddenError");

      const history = yield* overview.briefHistory(ada, { projectId, limit: 1 });
      expect(history.versions.map((version) => version.version)).toEqual([2]);
      expect(history.hasMore).toBe(true);
      const older = yield* overview.briefHistory(ada, { projectId, beforeVersion: 2, limit: 10 });
      expect(older.versions.map((version) => [version.version, version.text])).toEqual([
        [1, "Ship the team view."],
      ]);
      expect((yield* overview.snapshot(ada, projectId)).brief?.version).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sets and clears only the caller's own focus", () =>
    Effect.gen(function* () {
      const { ada, bob } = yield* setup;
      const overview = yield* TeamOverview.TeamOverview;

      const set = yield* overview.setFocus(ada, { projectId, focus: "Reviewing the feed" });
      yield* overview.setFocus(OWNER_MEMBER_ID, { projectId, focus: "Migrations" });
      expect(set.focus).toMatchObject({ memberId: ada, focus: "Reviewing the feed" });

      const cleared = yield* overview.setFocus(ada, { projectId, focus: null });
      expect(cleared.focus).toBeNull();
      const outsider = yield* Effect.flip(overview.setFocus(bob, { projectId, focus: "Hello" }));
      expect(outsider._tag).toBe("TeamOverviewForbiddenError");

      const snapshot = yield* overview.snapshot(OWNER_MEMBER_ID, projectId);
      expect(snapshot.focuses.map((focus) => [focus.memberId, focus.focus])).toEqual([
        [OWNER_MEMBER_ID, "Migrations"],
      ]);
      expect(
        snapshot.activity
          .filter((item) => item.kind.startsWith("focus"))
          .map((item) => [item.kind, item.actorId]),
      ).toEqual([
        ["focus-cleared", ada],
        ["focus-set", OWNER_MEMBER_ID],
        ["focus-set", ada],
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps other members' private threads out of the activity feed", () =>
    Effect.gen(function* () {
      const { ada } = yield* setup;
      const overview = yield* TeamOverview.TeamOverview;
      const adaThread = ThreadId.make("thread-ada");
      const ownerThread = ThreadId.make("thread-owner");

      yield* createThread(ada, adaThread, "Ada's work");
      yield* createThread(OWNER_MEMBER_ID, ownerThread, "Owner's private work");
      yield* setSession(adaThread, "running", "turn-1");
      yield* setSession(adaThread, "ready", null);
      // A repeated ready session does not complete the turn twice.
      yield* setSession(adaThread, "ready", null);
      yield* setSession(ownerThread, "running", "turn-2");
      yield* overview.updateBrief(OWNER_MEMBER_ID, {
        projectId,
        text: "Brief",
        expectedVersion: null,
      });

      const adaFeed = (yield* overview.snapshot(ada, projectId)).activity;
      expect(adaFeed.map((item) => [item.kind, item.threadId, item.actorId])).toEqual([
        ["brief-updated", null, OWNER_MEMBER_ID],
        ["turn-completed", adaThread, null],
        ["thread-created", adaThread, ada],
      ]);
      expect(adaFeed.at(-1)?.detail).toBe("Ada's work");

      const ownerFeed = (yield* overview.snapshot(OWNER_MEMBER_ID, projectId)).activity;
      expect(ownerFeed.some((item) => item.threadId === adaThread)).toBe(false);
      expect(ownerFeed.filter((item) => item.threadId === ownerThread).map((i) => i.kind)).toEqual([
        "thread-created",
      ]);

      // Paging skips hidden rows and reports where to continue.
      const page = yield* overview.activityPage(ada, {
        projectId,
        beforeSequence: Number.MAX_SAFE_INTEGER,
        limit: 2,
      });
      expect(page.items.map((item) => item.kind)).toEqual(["brief-updated", "turn-completed"]);
      const rest = yield* overview.activityPage(ada, {
        projectId,
        beforeSequence: page.nextBeforeSequence ?? 0,
        limit: 2,
      });
      expect(rest.items.map((item) => item.kind)).toEqual(["thread-created"]);
      expect(rest.nextBeforeSequence).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("streams a snapshot, then brief and activity deltas", () =>
    Effect.gen(function* () {
      const { ada } = yield* setup;
      const overview = yield* TeamOverview.TeamOverview;
      const items = yield* Queue.unbounded<TeamOverviewStreamItem>();
      // Live clock: deltas pass through the stream's real-time coalescing window.
      yield* overview.stream(ada, projectId).pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        TestClock.withLive,
        Effect.forkScoped,
      );

      const first = yield* Queue.take(items);
      expect(first.kind).toBe("snapshot");

      yield* overview.updateBrief(OWNER_MEMBER_ID, {
        projectId,
        text: "Live",
        expectedVersion: null,
      });
      const brief = yield* Queue.take(items);
      const activity = yield* Queue.take(items);
      expect(brief).toMatchObject({ kind: "brief", brief: { version: 1, text: "Live" } });
      expect(activity.kind === "activity" && activity.items.map((item) => item.kind)).toEqual([
        "brief-updated",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
