import {
  CommandId,
  EventId,
  MemberId,
  OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadCommentId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const threadId = ThreadId.make("thread-1");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const emptyReadModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [],
  updatedAt: NOW,
};

const events = (event: Effect.Success<ReturnType<typeof decideOrchestrationCommand>>) =>
  Array.isArray(event) ? event : [event];

/** Decide a command and fold its events into the read model, as the engine does. */
const run = (
  readModel: OrchestrationReadModel,
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  actor?: MemberId,
) =>
  Effect.gen(function* () {
    const decided = events(yield* decideOrchestrationCommand({ command, readModel }));
    let next = readModel;
    for (const [index, planned] of decided.entries()) {
      next = yield* projectEvent(next, {
        ...planned,
        sequence: next.snapshotSequence + index + 1,
        metadata: { ...planned.metadata, ...(actor !== undefined ? { actor } : {}) },
      } as OrchestrationEvent);
    }
    return { decided, readModel: next };
  });

const createThread = (visibility?: "shared" | "private") => ({
  type: "thread.create" as const,
  commandId: CommandId.make("cmd-create"),
  threadId,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  ...(visibility !== undefined ? { visibility } : {}),
});

it.layer(NodeServices.layer)("shared threads decider", (it) => {
  it.effect("records opt-in visibility at creation and changes it both ways", () =>
    Effect.gen(function* () {
      const ada = MemberId.make("ada");
      const created = yield* run(emptyReadModel, createThread("shared"), ada);
      expect(created.decided[0]?.type).toBe("thread.created");
      const thread = created.readModel.threads[0];
      expect(thread?.visibility).toBe("shared");
      expect(thread?.createdBy).toBe(ada);

      const setVisibility = (visibility: "shared" | "private") => ({
        type: "thread.visibility.set" as const,
        commandId: CommandId.make(`cmd-${visibility}`),
        threadId,
        visibility,
      });
      const madePrivate = yield* run(created.readModel, setVisibility("private"), ada);
      expect(madePrivate.decided.map((event) => event.type)).toEqual(["thread.visibility-set"]);
      expect(madePrivate.readModel.threads[0]?.visibility).toBe("private");
      const sharedAgain = yield* run(madePrivate.readModel, setVisibility("shared"), ada);
      expect(sharedAgain.readModel.threads[0]?.visibility).toBe("shared");

      const defaulted = yield* run(emptyReadModel, createThread());
      expect(defaulted.readModel.threads[0]?.visibility).toBeUndefined();
    }),
  );

  it.effect("turns comments into events without touching the conversation", () =>
    Effect.gen(function* () {
      const { readModel } = yield* run(emptyReadModel, createThread("shared"));
      const added = yield* run(
        readModel,
        {
          type: "thread.comment.add",
          commandId: CommandId.make("cmd-comment"),
          threadId,
          commentId: ThreadCommentId.make("comment-1"),
          text: "Looks good",
          createdAt: NOW,
        },
        MemberId.make("bob"),
      );
      expect(added.decided.map((event) => event.type)).toEqual(["thread.comment-added"]);
      expect(added.readModel.threads[0]?.messages).toEqual([]);
      expect(added.readModel.threads[0]?.updatedAt).toBe(NOW);

      const deleted = yield* run(added.readModel, {
        type: "thread.comment.delete",
        commandId: CommandId.make("cmd-comment-delete"),
        threadId,
        commentId: ThreadCommentId.make("comment-1"),
      });
      expect(deleted.decided.map((event) => event.type)).toEqual(["thread.comment-deleted"]);

      const missing = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.comment.add",
            commandId: CommandId.make("cmd-comment-missing"),
            threadId: ThreadId.make("thread-missing"),
            commentId: ThreadCommentId.make("comment-2"),
            text: "Hello?",
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(missing._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it("decodes events and threads persisted before sharing existed", () => {
    const legacyCreated = decodeEvent({
      sequence: 1,
      eventId: EventId.make("event-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: NOW,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.created",
      payload: {
        threadId,
        projectId: "project-1",
        title: "Old thread",
        modelSelection,
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    expect(legacyCreated.type === "thread.created" && legacyCreated.payload.visibility).toBe(
      undefined,
    );

    const legacyThread = decodeThread({
      id: threadId,
      projectId: "project-1",
      title: "Old thread",
      modelSelection,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      messages: [],
      activities: [],
      checkpoints: [],
      session: null,
    });
    expect(legacyThread.visibility).toBeUndefined();
    expect(legacyThread.comments).toBeUndefined();
  });
});
