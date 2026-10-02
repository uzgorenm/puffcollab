import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  type MemberId,
  OWNER_MEMBER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import * as RelatedWork from "./RelatedWork.ts";

const testLayer = RelatedWork.layer.pipe(
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-related-work-test-" })),
);

const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const NOW = "2026-01-01T00:00:00.000Z";

const seedThread = (input: {
  readonly id: string;
  readonly title: string;
  readonly createdBy: MemberId | null;
  readonly visibility: "shared" | "private" | null;
  readonly projectId?: ProjectId;
  readonly firstMessage?: string;
  readonly archived?: boolean;
}) =>
  Effect.gen(function* () {
    const threads = yield* ProjectionThreadRepository;
    const messages = yield* ProjectionThreadMessageRepository;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(input.id);
    yield* threads.upsert({
      threadId,
      projectId: input.projectId ?? PROJECT,
      title: input.title,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurnId: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: input.archived ? NOW : null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      createdBy: input.createdBy,
      latestUserMessageAt: null,
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
      hasActionableProposedPlan: 0,
      deletedAt: null,
    });
    if (input.firstMessage !== undefined) {
      yield* messages.upsert({
        messageId: MessageId.make(`${input.id}-m1`),
        threadId,
        turnId: null,
        role: "user",
        text: input.firstMessage,
        isStreaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    yield* sql`UPDATE projection_threads SET visibility = ${input.visibility} WHERE thread_id = ${threadId}`;
  });

// Stands in for the shared-threads feature's projection of thread visibility.
const addVisibilityColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN visibility TEXT`;
});

const setup = Effect.gen(function* () {
  const team = yield* TeamAccess.TeamAccess;
  const alice = yield* team.addMember({ username: "alice", displayName: "Alice", role: "member" });
  const bob = yield* team.addMember({ username: "bob", displayName: "Bob", role: "member" });
  const carol = yield* team.addMember({ username: "carol", displayName: "Carol", role: "member" });
  for (const member of [alice, bob]) {
    yield* team.addProjectMember({ projectId: PROJECT, memberId: member.memberId });
    yield* team.addProjectMember({ projectId: OTHER_PROJECT, memberId: member.memberId });
  }
  yield* addVisibilityColumn;
  yield* seedThread({
    id: "bob-shared",
    title: "OAuth login redirect loop",
    createdBy: bob.memberId,
    visibility: "shared",
  });
  yield* seedThread({
    id: "bob-shared-message",
    title: "Auth cleanup",
    createdBy: bob.memberId,
    visibility: "shared",
    firstMessage: "The oauth login redirect never returns to settings",
  });
  yield* seedThread({
    id: "bob-private",
    title: "OAuth login redirect secret plan",
    createdBy: bob.memberId,
    visibility: "private",
  });
  yield* seedThread({
    id: "bob-legacy",
    title: "OAuth login redirect legacy",
    createdBy: bob.memberId,
    visibility: null,
  });
  yield* seedThread({
    id: "bob-other-project",
    title: "OAuth login redirect elsewhere",
    createdBy: bob.memberId,
    visibility: "shared",
    projectId: OTHER_PROJECT,
  });
  yield* seedThread({
    id: "bob-archived",
    title: "OAuth login redirect archived",
    createdBy: bob.memberId,
    visibility: "shared",
    archived: true,
  });
  yield* seedThread({
    id: "alice-shared",
    title: "OAuth login redirect mine",
    createdBy: alice.memberId,
    visibility: "shared",
  });
  yield* seedThread({
    id: "owner-shared",
    title: "OAuth login redirect owner",
    createdBy: null,
    visibility: "shared",
  });
  return { alice, bob, carol };
});

const DRAFT = "Fix the OAuth login redirect";

it.layer(NodeServices.layer)("RelatedWork.suggest", (it) => {
  it.effect("suggests other people's shared threads in the same project only", () =>
    Effect.gen(function* () {
      const { alice } = yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const result = yield* relatedWork.suggest(alice.memberId, {
        projectId: PROJECT,
        text: DRAFT,
        limit: 5,
      });
      expect(result.suggestions.map((entry) => entry.threadId).toSorted()).toEqual([
        "bob-shared",
        "bob-shared-message",
        "owner-shared",
      ]);
      // A title match outranks a first-message match.
      expect(result.suggestions.at(-1)?.threadId).toBe("bob-shared-message");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats ownerless threads as the environment owner's own", () =>
    Effect.gen(function* () {
      yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const result = yield* relatedWork.suggest(OWNER_MEMBER_ID, {
        projectId: PROJECT,
        text: DRAFT,
        limit: 5,
      });
      expect(result.suggestions.map((entry) => entry.threadId)).not.toContain("owner-shared");
      expect(result.suggestions.map((entry) => entry.threadId)).toContain("alice-shared");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("excludes the thread being shared and returns nothing outside the project", () =>
    Effect.gen(function* () {
      const { alice, carol } = yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const excluded = yield* relatedWork.suggest(alice.memberId, {
        projectId: PROJECT,
        text: DRAFT,
        excludeThreadId: ThreadId.make("bob-shared"),
        limit: 5,
      });
      expect(excluded.suggestions.map((entry) => entry.threadId)).not.toContain("bob-shared");

      const outsider = yield* relatedWork.suggest(carol.memberId, {
        projectId: PROJECT,
        text: DRAFT,
      });
      expect(outsider.suggestions).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("suggests nothing while threads have no visibility column", () =>
    Effect.gen(function* () {
      const relatedWork = yield* RelatedWork.RelatedWork;
      const result = yield* relatedWork.suggest(OWNER_MEMBER_ID, {
        projectId: PROJECT,
        text: DRAFT,
      });
      expect(result.suggestions).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
