import {
  CommandId,
  MemberId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ALICE = MemberId.make("alice");
const BOB = MemberId.make("bob");
const MINE = ThreadId.make("thread-mine");
const SHARED = ThreadId.make("thread-shared");
const PRIVATE = ThreadId.make("thread-private");
const OTHER_PROJECT = ThreadId.make("thread-other-project");

const makeThread = (
  id: ThreadId,
  patch: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId: ProjectId.make("project-1"),
  title: `Thread ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...patch,
});

const readModel = (mine: Partial<OrchestrationThread> = {}): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    makeThread(MINE, { createdBy: ALICE, ...mine }),
    makeThread(SHARED, { createdBy: BOB, visibility: "shared" }),
    makeThread(PRIVATE, { createdBy: BOB, visibility: "private" }),
    makeThread(OTHER_PROJECT, {
      createdBy: BOB,
      visibility: "shared",
      projectId: ProjectId.make("project-2"),
    }),
  ],
  updatedAt: NOW,
});

const link = (relatedThreadId: ThreadId, relationship: "complementary" | "alternative") =>
  ({
    type: "thread.related-thread.link",
    commandId: CommandId.make(`cmd-link-${relatedThreadId}-${relationship}`),
    threadId: MINE,
    relatedThreadId,
    relationship,
  }) as const;

const unlink = (relatedThreadId: ThreadId) =>
  ({
    type: "thread.related-thread.unlink",
    commandId: CommandId.make(`cmd-unlink-${relatedThreadId}`),
    threadId: MINE,
    relatedThreadId,
  }) as const;

it.layer(NodeServices.layer)("related-thread link decider", (it) => {
  it.effect("the owner links a shared thread and can unlink it again", () =>
    Effect.gen(function* () {
      const linked = yield* decideOrchestrationCommand({
        command: link(SHARED, "complementary"),
        readModel: readModel(),
      });
      const linkedEvent = Array.isArray(linked) ? linked[0] : linked;
      expect(linkedEvent?.type).toBe("thread.related-thread-linked");
      const afterLink = yield* projectEvent(readModel(), { ...linkedEvent!, sequence: 1 });
      const thread = afterLink.threads.find((entry) => entry.id === MINE);
      expect(thread?.relatedThreads).toEqual([
        { relatedThreadId: SHARED, relationship: "complementary", linkedAt: expect.any(String) },
      ]);
      // Linking is metadata, not activity.
      expect(thread?.updatedAt).toBe(NOW);

      const unlinked = yield* decideOrchestrationCommand({
        command: unlink(SHARED),
        readModel: afterLink,
      });
      const unlinkedEvent = Array.isArray(unlinked) ? unlinked[0] : unlinked;
      expect(unlinkedEvent?.type).toBe("thread.related-thread-unlinked");
      const afterUnlink = yield* projectEvent(afterLink, { ...unlinkedEvent!, sequence: 2 });
      expect(afterUnlink.threads.find((entry) => entry.id === MINE)?.relatedThreads).toEqual([]);
    }),
  );

  it.effect("re-linking switches the relationship and keeps linkedAt", () =>
    Effect.gen(function* () {
      const existing = {
        relatedThreadId: SHARED,
        relationship: "complementary" as const,
        linkedAt: "2025-12-01T00:00:00.000Z",
      };
      const decided = yield* decideOrchestrationCommand({
        command: link(SHARED, "alternative"),
        readModel: readModel({ relatedThreads: [existing] }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type === "thread.related-thread-linked" && event.payload.link).toEqual({
        ...existing,
        relationship: "alternative",
      });
      const duplicate = yield* Effect.exit(
        decideOrchestrationCommand({
          command: link(SHARED, "complementary"),
          readModel: readModel({ relatedThreads: [existing] }),
        }),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
  );

  // Ownership itself is enforced before dispatch (ThreadAccess.authorizeCommand).
  it.effect("the owner may also link their own private threads", () =>
    Effect.gen(function* () {
      const model = readModel();
      const ownPrivate = makeThread(ThreadId.make("thread-own-private"), {
        createdBy: ALICE,
        visibility: "private",
      });
      const linked = yield* Effect.exit(
        decideOrchestrationCommand({
          command: link(ownPrivate.id, "complementary"),
          readModel: { ...model, threads: [...model.threads, ownPrivate] },
        }),
      );
      expect(Exit.isSuccess(linked)).toBe(true);

      // A creator-less thread belongs to the environment owner, not to Alice.
      const ownerless = makeThread(ThreadId.make("thread-ownerless"), { createdBy: null });
      const rejected = yield* Effect.exit(
        decideOrchestrationCommand({
          command: link(ownerless.id, "complementary"),
          readModel: { ...model, threads: [...model.threads, ownerless] },
        }),
      );
      expect(Exit.isFailure(rejected)).toBe(true);
    }),
  );

  it.effect("rejects private, foreign-project, missing, and self links alike", () =>
    Effect.gen(function* () {
      for (const target of [PRIVATE, OTHER_PROJECT, ThreadId.make("thread-missing"), MINE]) {
        const exit = yield* Effect.exit(
          decideOrchestrationCommand({
            command: link(target, "complementary"),
            readModel: readModel(),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit) && target !== MINE) {
          // Same message whatever the reason, so rejections cannot probe threads.
          expect(String(exit.cause)).toContain("is not a shared thread in this project");
          expect(String(exit.cause)).not.toContain(`Thread ${target}`);
        }
      }
    }),
  );

  it.effect("unlinking works after the related thread was deleted", () =>
    Effect.gen(function* () {
      const model = readModel({
        relatedThreads: [{ relatedThreadId: SHARED, relationship: "alternative", linkedAt: NOW }],
      });
      const withDeleted = {
        ...model,
        threads: model.threads.map((thread) =>
          thread.id === SHARED ? { ...thread, deletedAt: NOW } : thread,
        ),
      };
      const decided = yield* decideOrchestrationCommand({
        command: unlink(SHARED),
        readModel: withDeleted,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.related-thread-unlinked");
    }),
  );
});
