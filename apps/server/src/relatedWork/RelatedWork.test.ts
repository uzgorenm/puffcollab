import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HubAccountId,
  HubThreadLink,
  HubThreadId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as RelatedWork from "./RelatedWork.ts";

const testLayer = RelatedWork.layer.pipe(
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-related-work-test-" })),
);

const encodeHubLink = Schema.encodeSync(Schema.fromJsonString(HubThreadLink));

const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const NOW = "2026-01-01T00:00:00.000Z";

const seedThread = (input: {
  readonly id: string;
  readonly title: string;
  readonly visibility: "shared" | "private" | null;
  /** A teammate's mirror from the team hub. */
  readonly hub?: HubThreadLink;
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
      createdBy: null,
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
    if (input.hub !== undefined) {
      yield* sql`UPDATE projection_threads SET hub_link_json = ${encodeHubLink(input.hub)} WHERE thread_id = ${threadId}`;
    }
  });

const bobsLink = (id: string): HubThreadLink => ({
  threadId: HubThreadId.make(`link-bob:${id}`),
  ownerId: HubAccountId.make("acct-bob"),
  ownerLogin: "bob",
  ownerDisplayName: "Bob",
  remote: true,
  syncState: "synced",
});

const linkToHub = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO hub_project_links (project_id, hub_project_id, hub_project_title, linked_at)
      VALUES (${projectId}, ${`hub-${projectId}`}, 'Team app', ${NOW})
    `;
  });

const setup = Effect.gen(function* () {
  yield* linkToHub(PROJECT);
  yield* seedThread({
    id: "hub:link-bob:shared",
    title: "OAuth login redirect loop",
    visibility: "shared",
    hub: bobsLink("shared"),
  });
  yield* seedThread({
    id: "hub:link-bob:shared-message",
    title: "Auth cleanup",
    visibility: "shared",
    hub: bobsLink("shared-message"),
    firstMessage: "The oauth login redirect never returns to settings",
  });
  yield* seedThread({
    id: "mine-shared",
    title: "OAuth login redirect mine",
    visibility: "shared",
  });
  yield* seedThread({
    id: "mine-private",
    title: "OAuth login redirect secret plan",
    visibility: "private",
  });
  yield* seedThread({ id: "mine-legacy", title: "OAuth login redirect legacy", visibility: null });
  yield* seedThread({
    id: "hub:link-bob:archived",
    title: "OAuth login redirect archived",
    visibility: "shared",
    hub: bobsLink("archived"),
    archived: true,
  });
  yield* seedThread({
    id: "unlinked-shared",
    title: "OAuth login redirect elsewhere",
    visibility: "shared",
    projectId: OTHER_PROJECT,
  });
});

const DRAFT = "Fix the OAuth login redirect";

it.layer(NodeServices.layer)("RelatedWork.suggest", (it) => {
  it.effect("suggests mirrors and own shared threads of a hub-linked project", () =>
    Effect.gen(function* () {
      yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const result = yield* relatedWork.suggest({ projectId: PROJECT, text: DRAFT, limit: 5 });
      expect(result.suggestions.map((entry) => entry.threadId).toSorted()).toEqual([
        "hub:link-bob:shared",
        "hub:link-bob:shared-message",
        "mine-shared",
      ]);
      // A title match outranks a first-message match.
      expect(result.suggestions.at(-1)?.threadId).toBe("hub:link-bob:shared-message");
      expect(
        result.suggestions.find((entry) => entry.threadId === "hub:link-bob:shared")?.hub,
      ).toMatchObject({ remote: true, ownerLogin: "bob" });
      expect(
        result.suggestions.find((entry) => entry.threadId === "mine-shared")?.hub,
      ).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never matches private threads or projects off the hub", () =>
    Effect.gen(function* () {
      yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const ids = (yield* relatedWork.suggest({
        projectId: PROJECT,
        text: DRAFT,
        limit: 5,
      })).suggestions.map((entry) => entry.threadId);
      expect(ids).not.toContain("mine-private");
      expect(ids).not.toContain("mine-legacy");
      const unlinked = yield* relatedWork.suggest({ projectId: OTHER_PROJECT, text: DRAFT });
      expect(unlinked.suggestions).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("excludes the thread being composed", () =>
    Effect.gen(function* () {
      yield* setup;
      const relatedWork = yield* RelatedWork.RelatedWork;
      const excluded = yield* relatedWork.suggest({
        projectId: PROJECT,
        text: DRAFT,
        excludeThreadId: ThreadId.make("hub:link-bob:shared"),
        limit: 5,
      });
      expect(excluded.suggestions.map((entry) => entry.threadId)).not.toContain(
        "hub:link-bob:shared",
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
