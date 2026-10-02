import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  OWNER_MEMBER_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import type { CooperationAnalystOutput } from "../textGeneration/CooperationAnalysisPrompt.ts";
import { CooperationAnalyst, type CooperationAnalystError } from "./CooperationAnalyst.ts";
import { CooperationService, layer as cooperationServiceLayer } from "./CooperationService.ts";

const PROJECT = ProjectId.make("project-1");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const ADA = MemberId.make("ada");

function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT,
    title: `Title ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    visibility: "shared",
    ...overrides,
  };
}

/** A fake text-generation layer: records prompts and answers from `respond`. */
function makeHarness() {
  const shells = new Map<ThreadId, OrchestrationThreadShell>([
    [THREAD_A, shell(THREAD_A)],
    [THREAD_B, shell(THREAD_B, { createdBy: ADA })],
  ]);
  const prompts: string[] = [];
  const dispatched: Array<{ command: OrchestrationCommand; actor: MemberId | undefined }> = [];
  const analyst = {
    respond: (_prompt: string): Effect.Effect<CooperationAnalystOutput, CooperationAnalystError> =>
      Effect.succeed({ summaries: [], notes: [] }),
  };
  const layer = cooperationServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) => {
            const found = shells.get(threadId);
            return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
          },
        }),
        Layer.mock(TeamAccess.TeamAccess)({
          canSeeThread: () => Effect.succeed(true),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command, options) =>
            Effect.sync(() => {
              dispatched.push({ command, actor: options?.actor });
              return { sequence: 0 };
            }),
        }),
        Layer.mock(CooperationAnalyst)({
          available: Effect.succeed(true),
          analyze: ({ prompt }) =>
            Effect.suspend(() => {
              prompts.push(prompt);
              return analyst.respond(prompt);
            }),
        }),
      ),
    ),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return { layer, shells, prompts, dispatched, analyst };
}

let eventCounter = 0;
const appendMessage = (threadId: ThreadId, text: string, role: "user" | "assistant" = "user") =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    eventCounter += 1;
    return yield* store.append({
      eventId: EventId.make(`event-${threadId}-${eventCounter}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.message-sent",
      occurredAt: "2026-10-01T00:00:00.000Z",
      commandId: CommandId.make(`command-${eventCounter}`),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        messageId: MessageId.make(`message-${eventCounter}`),
        role,
        text,
        turnId: null,
        streaming: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
  });

const consent = (
  memberId: MemberId,
  threadId: ThreadId,
  overrides: { textEnabled?: boolean; awarenessNotify?: boolean; analysisEnabled?: boolean } = {},
) =>
  Effect.gen(function* () {
    const cooperation = yield* CooperationService;
    const current = yield* cooperation.getThreadState(memberId, threadId);
    return yield* cooperation.updateSettings(memberId, {
      threadId,
      expectedVersion: current.settings.version,
      featureTopic: "billing",
      relationship: "unspecified",
      analysisEnabled: overrides.analysisEnabled ?? true,
      textEnabled: overrides.textEnabled ?? false,
      awarenessNotify: overrides.awarenessNotify ?? true,
    });
  });

const goodOutput: CooperationAnalystOutput = {
  summaries: [
    { thread: "A", summary: "Owner is reworking invoices.", evidence: ["A1"] },
    { thread: "B", summary: "Ada is adding refunds.", evidence: ["B1"] },
  ],
  notes: [
    {
      to: "B",
      kind: "note",
      text: "Thread A reworked the invoice table.",
      evidence: ["A1", "B1"],
    },
  ],
};

it.layer(NodeServices.layer)("CooperationService", (it) => {
  it.effect("starts with every switch off and lets only the owner change it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      const asAda = yield* cooperation.getThreadState(ADA, THREAD_A);
      expect(asAda.ownerMemberId).toBe(OWNER_MEMBER_ID);
      expect(asAda.canEdit).toBe(false);
      expect(asAda.settings).toMatchObject({
        version: 0,
        analysisEnabled: false,
        textEnabled: false,
        awarenessNotify: false,
      });
      expect(asAda.summary).toBeNull();

      const forbidden = yield* Effect.flip(consent(ADA, THREAD_A));
      expect(forbidden.reason).toBe("forbidden");

      // Threads without a creator belong to the environment owner.
      const updated = yield* consent(OWNER_MEMBER_ID, THREAD_A, { textEnabled: true });
      expect(updated).toMatchObject({ version: 1, analysisEnabled: true, textEnabled: true });

      // Turning analysis off also turns off what depends on it.
      const off = yield* consent(OWNER_MEMBER_ID, THREAD_A, { analysisEnabled: false });
      expect(off).toMatchObject({
        version: 2,
        analysisEnabled: false,
        textEnabled: false,
        awarenessNotify: false,
      });

      const stale = yield* Effect.flip(
        cooperation.updateSettings(OWNER_MEMBER_ID, {
          threadId: THREAD_A,
          expectedVersion: 1,
          featureTopic: "billing",
          relationship: "unspecified",
          analysisEnabled: false,
          textEnabled: false,
          awarenessNotify: false,
        }),
      );
      expect(stale.reason).toBe("conflict");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("analyzes consented shared threads and delivers notes only to the target owner", () => {
    const harness = makeHarness();
    harness.analyst.respond = () => Effect.succeed(goodOutput);
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      const sourceEvent = yield* appendMessage(THREAD_A, "rewrite invoices with token=abc123");
      const targetEvent = yield* appendMessage(THREAD_B, "ada private text");
      yield* consent(OWNER_MEMBER_ID, THREAD_A, { textEnabled: true });
      yield* consent(ADA, THREAD_B, { textEnabled: false });

      expect(yield* cooperation.requestAnalysis(OWNER_MEMBER_ID, THREAD_A)).toBe(1);

      // Text permission is per thread, and secrets never leave the thread.
      const prompt = harness.prompts[0]!;
      expect(prompt).toContain("rewrite invoices");
      expect(prompt).not.toContain("abc123");
      expect(prompt).not.toContain("ada private text");

      expect(yield* cooperation.latestSummaryForThread(THREAD_B)).toMatchObject({
        summary: "Ada is adding refunds.",
      });
      expect((yield* cooperation.getInbox(OWNER_MEMBER_ID)).items).toEqual([]);
      const inbox = yield* cooperation.getInbox(ADA);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: "note",
        sourceThreadId: THREAD_A,
        targetThreadId: THREAD_B,
        sourceThreadTitle: "Title thread-a",
        state: "pending",
        citations: [
          { threadId: THREAD_A, eventId: sourceEvent.eventId, sequence: sourceEvent.sequence },
          { threadId: THREAD_B, eventId: targetEvent.eventId, sequence: targetEvent.sequence },
        ],
      });

      // Nothing was sent to any thread: a note is not a message.
      expect(harness.dispatched).toEqual([]);
      const admitted = yield* cooperation.resolveItem(ADA, {
        itemId: inbox.items[0]!.itemId,
        action: "admit",
      });
      expect(admitted.state).toBe("admitted");
      expect(harness.dispatched).toEqual([]);
      expect((yield* cooperation.getInbox(ADA)).items).toEqual([]);

      const again = yield* Effect.flip(
        cooperation.resolveItem(ADA, { itemId: admitted.itemId, action: "dismiss" }),
      );
      expect(again.reason).toBe("conflict");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a run whose consent changed while the analyst was working", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b");
      yield* consent(OWNER_MEMBER_ID, THREAD_A);
      yield* consent(ADA, THREAD_B);
      const services = yield* Effect.context<CooperationService>();
      harness.analyst.respond = () =>
        consent(ADA, THREAD_B, { textEnabled: true }).pipe(
          Effect.provide(services),
          Effect.orDie,
          Effect.as(goodOutput),
        );

      yield* cooperation.analyzeThread(THREAD_A, "manual");

      const state = yield* cooperation.getThreadState(ADA, THREAD_B);
      expect(state.lastRun).toMatchObject({
        state: "rejected",
        reason: "consent changed during analysis",
      });
      expect(state.summary).toBeNull();
      expect((yield* cooperation.getInbox(ADA)).items).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a run that cites events it was never given", () => {
    const harness = makeHarness();
    harness.analyst.respond = () =>
      Effect.succeed({
        ...goodOutput,
        notes: [{ to: "B", kind: "note", text: "Invented.", evidence: ["A9"] }],
      });
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b");
      yield* consent(OWNER_MEMBER_ID, THREAD_A);
      yield* consent(ADA, THREAD_B);

      yield* cooperation.analyzeThread(THREAD_A, "turn-completed");

      const state = yield* cooperation.getThreadState(OWNER_MEMBER_ID, THREAD_A);
      expect(state.lastRun).toMatchObject({
        state: "rejected",
        reason: "note cites an event that was not exported",
      });
      expect(state.summary).toBeNull();
      expect((yield* cooperation.getInbox(ADA)).items).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never exports private threads or threads without consent", () => {
    const harness = makeHarness();
    harness.shells.set(THREAD_B, shell(THREAD_B, { createdBy: ADA, visibility: "private" }));
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b");
      yield* consent(OWNER_MEMBER_ID, THREAD_A);
      expect(yield* cooperation.analyzeThread(THREAD_A, "manual")).toBe(0);
      yield* consent(ADA, THREAD_B);
      expect(yield* cooperation.analyzeThread(THREAD_A, "manual")).toBe(0);
      expect(harness.prompts).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends a proposal only after its recipient approves it, as their message", () => {
    const harness = makeHarness();
    harness.analyst.respond = () =>
      Effect.succeed({
        ...goodOutput,
        notes: [
          {
            to: "B",
            kind: "proposal",
            text: "Reuse the invoice table from thread A for refunds.",
            evidence: ["A1"],
          },
        ],
      });
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b");
      yield* consent(OWNER_MEMBER_ID, THREAD_A);
      yield* consent(ADA, THREAD_B);
      yield* cooperation.analyzeThread(THREAD_A, "manual");

      const [proposal] = (yield* cooperation.getInbox(ADA)).items;
      expect(proposal?.kind).toBe("proposal");
      expect(harness.dispatched).toEqual([]);

      const wrongAction = yield* Effect.flip(
        cooperation.resolveItem(ADA, { itemId: proposal!.itemId, action: "admit" }),
      );
      expect(wrongAction.reason).toBe("invalid");
      const notRecipient = yield* Effect.flip(
        cooperation.resolveItem(OWNER_MEMBER_ID, { itemId: proposal!.itemId, action: "approve" }),
      );
      expect(notRecipient.reason).toBe("not-found");

      yield* cooperation.resolveItem(ADA, { itemId: proposal!.itemId, action: "approve" });
      expect(harness.dispatched).toHaveLength(1);
      const [{ command, actor }] = harness.dispatched as [
        { command: OrchestrationCommand; actor: MemberId | undefined },
      ];
      expect(actor).toBe(ADA);
      expect(command).toMatchObject({
        type: "thread.turn.start",
        threadId: THREAD_B,
        message: { role: "user", text: "Reuse the invoice table from thread A for refunds." },
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("withdraws pending notes and the summary when consent is turned off", () => {
    const harness = makeHarness();
    harness.analyst.respond = () => Effect.succeed(goodOutput);
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b");
      yield* consent(OWNER_MEMBER_ID, THREAD_A);
      yield* consent(ADA, THREAD_B);
      yield* cooperation.analyzeThread(THREAD_A, "manual");
      expect((yield* cooperation.getInbox(ADA)).items).toHaveLength(1);

      yield* consent(OWNER_MEMBER_ID, THREAD_A, { analysisEnabled: false });

      expect((yield* cooperation.getInbox(ADA)).items).toEqual([]);
      expect(yield* cooperation.latestSummaryForThread(THREAD_A)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });
});
