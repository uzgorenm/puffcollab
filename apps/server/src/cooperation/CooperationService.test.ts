import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  HubAccountId,
  type HubAnalysisSummary,
  type HubAwarenessItem,
  type HubThreadCooperation,
  HubThreadId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as HubSync from "../hub/HubSync.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import type { CooperationAnalystOutput } from "../textGeneration/CooperationAnalysisPrompt.ts";
import { CooperationAnalyst, type CooperationAnalystError } from "./CooperationAnalyst.ts";
import { CooperationService, layer as cooperationServiceLayer } from "./CooperationService.ts";

const PROJECT = ProjectId.make("project-1");
/** This server's own shared thread, published to the hub. */
const THREAD_A = ThreadId.make("thread-a");
const HUB_A = HubThreadId.make("link-me:thread-a");
/** A second thread of this server's own. */
const THREAD_C = ThreadId.make("thread-c");
/** Ada's thread, mirrored here from the team hub. */
const HUB_B = HubThreadId.make("link-ada:thread-b");
const THREAD_B = ThreadId.make(`hub:${HUB_B}`);
const ADA = HubAccountId.make("acct-ada");
const NOW = "2026-10-01T00:00:00.000Z";

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
    createdAt: NOW,
    updatedAt: NOW,
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

const mirrorShell = shell(THREAD_B, {
  hub: {
    threadId: HUB_B,
    ownerId: ADA,
    ownerLogin: "ada",
    ownerDisplayName: "Ada",
    remote: true,
    syncState: "synced",
  },
});

/** Fakes for the hub, the analyst and the engine; records what reaches each. */
function makeHarness() {
  const shells = new Map<ThreadId, OrchestrationThreadShell>([
    [THREAD_A, shell(THREAD_A)],
    [THREAD_B, mirrorShell],
    [THREAD_C, shell(THREAD_C)],
  ]);
  const prompts: string[] = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const hub = {
    /** Ada's published consent on her thread. */
    mirrorConsent: {
      featureTopic: "billing",
      analysisEnabled: true,
      textEnabled: false,
      awarenessNotify: true,
    } as HubThreadCooperation | null,
    published: new Map<ThreadId, HubThreadId>([[THREAD_A, HUB_A]]),
    refreshed: [] as ThreadId[],
    posts: [] as Array<{
      summaries: ReadonlyArray<HubAnalysisSummary>;
      awareness: ReadonlyArray<HubAwarenessItem>;
    }>,
  };
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
        Layer.mock(HubSync.HubSync)({
          mirrorInfo: (threadId) =>
            Effect.succeed(
              threadId === THREAD_B
                ? {
                    hubThreadId: HUB_B,
                    ownerId: ADA,
                    cooperation: hub.mirrorConsent,
                    analysis: null,
                  }
                : null,
            ),
          consentingMirrors: (_projectId, featureTopic) =>
            Effect.succeed(
              hub.mirrorConsent?.analysisEnabled === true &&
                hub.mirrorConsent.featureTopic === featureTopic &&
                shells.get(THREAD_B)?.visibility === "shared"
                ? [THREAD_B]
                : [],
            ),
          publishedThreadId: (threadId) => Effect.succeed(hub.published.get(threadId) ?? null),
          refreshSummary: (threadId) => Effect.sync(() => void hub.refreshed.push(threadId)),
          postAnalysis: (input) =>
            Effect.sync(() => {
              hub.posts.push({ summaries: input.summaries, awareness: input.awareness });
            }),
          incomingAwareness: Stream.empty,
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
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
  return { layer, shells, prompts, dispatched, analyst, hub };
}

let eventCounter = 0;
/** A message event; mirror events carry their place in the hub stream. */
const appendMessage = (threadId: ThreadId, text: string, hubSeq?: number) =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    eventCounter += 1;
    return yield* store.append({
      eventId: EventId.make(`event-${threadId}-${eventCounter}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.make(`command-${eventCounter}`),
      causationEventId: null,
      correlationId: null,
      metadata: hubSeq === undefined ? {} : { hubOrigin: { generation: 1, seq: hubSeq } },
      payload: {
        threadId,
        messageId: MessageId.make(`message-${eventCounter}`),
        role: "user",
        text,
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
  });

const consent = (
  threadId: ThreadId,
  overrides: { textEnabled?: boolean; awarenessNotify?: boolean; analysisEnabled?: boolean } = {},
) =>
  Effect.gen(function* () {
    const cooperation = yield* CooperationService;
    const current = yield* cooperation.getThreadState(threadId);
    return yield* cooperation.updateSettings({
      threadId,
      expectedVersion: current.settings.version,
      featureTopic: "billing",
      analysisEnabled: overrides.analysisEnabled ?? true,
      textEnabled: overrides.textEnabled ?? false,
      awarenessNotify: overrides.awarenessNotify ?? true,
    });
  });

/** A is this server's thread, B Ada's mirror. */
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
  it.effect("starts with every switch off; only this server's own threads are editable", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      const own = yield* cooperation.getThreadState(THREAD_A);
      expect(own.canEdit).toBe(true);
      expect(own.settings).toMatchObject({
        version: 0,
        analysisEnabled: false,
        textEnabled: false,
        awarenessNotify: false,
      });
      expect(own.summary).toBeNull();

      const updated = yield* consent(THREAD_A, { textEnabled: true });
      expect(updated).toMatchObject({ version: 1, analysisEnabled: true, textEnabled: true });
      // Teammates learn about consent from the thread's hub summary.
      expect(harness.hub.refreshed).toEqual([THREAD_A]);

      // Turning analysis off also turns off what depends on it.
      const off = yield* consent(THREAD_A, { analysisEnabled: false });
      expect(off).toMatchObject({
        version: 2,
        analysisEnabled: false,
        textEnabled: false,
        awarenessNotify: false,
      });

      const stale = yield* Effect.flip(
        cooperation.updateSettings({
          threadId: THREAD_A,
          expectedVersion: 1,
          featureTopic: "billing",
          analysisEnabled: false,
          textEnabled: false,
          awarenessNotify: false,
        }),
      );
      expect(stale.reason).toBe("conflict");

      // Ada's mirror shows the consent she published, read-only.
      const mirror = yield* cooperation.getThreadState(THREAD_B);
      expect(mirror.canEdit).toBe(false);
      expect(mirror.settings).toMatchObject({ featureTopic: "billing", analysisEnabled: true });
      const forbidden = yield* Effect.flip(consent(THREAD_B));
      expect(forbidden.reason).toBe("forbidden");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("exports a teammate's mirror under her consent and posts results to the hub", () => {
    const harness = makeHarness();
    harness.analyst.respond = () => Effect.succeed(goodOutput);
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "rewrite invoices with token=abc123");
      yield* appendMessage(THREAD_B, "ada private text", 7);
      yield* consent(THREAD_A, { textEnabled: true });

      expect(yield* cooperation.requestAnalysis(THREAD_A)).toBe(1);

      // Text permission is per thread, and secrets never leave the thread.
      const prompt = harness.prompts[0]!;
      expect(prompt).toContain("rewrite invoices");
      expect(prompt).not.toContain("abc123");
      expect(prompt).not.toContain("ada private text");
      expect(prompt).toContain('"relationship":"unspecified"');

      // This server's summary is kept and posted; Ada's thread gets hers from her own run.
      expect(yield* cooperation.latestSummaryForThread(THREAD_A)).toMatchObject({
        summary: "Owner is reworking invoices.",
      });
      expect(yield* cooperation.latestSummaryForThread(THREAD_B)).toBeNull();
      expect(harness.hub.posts).toHaveLength(1);
      const [post] = harness.hub.posts;
      expect(post!.summaries).toEqual([
        { threadId: HUB_A, summary: "Owner is reworking invoices.", updatedAt: expect.any(String) },
      ]);
      // The note for Ada travels to the hub, citing her events by hub position.
      expect(post!.awareness).toEqual([
        expect.objectContaining({
          kind: "note",
          sourceThreadId: HUB_A,
          sourceThreadTitle: "Title thread-a",
          targetThreadId: HUB_B,
          text: "Thread A reworked the invoice table.",
          citations: [{ threadId: HUB_B, generation: 1, seq: 7 }],
        }),
      ]);
      expect((yield* cooperation.getInbox).items).toEqual([]);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps notes for this server's own threads in the local inbox", () => {
    const harness = makeHarness();
    harness.analyst.respond = () =>
      Effect.succeed({
        ...goodOutput,
        notes: [
          { to: "A", kind: "note", text: "Ada added refunds.", evidence: ["B1"] },
          {
            to: "A",
            kind: "proposal",
            text: "Reuse the refund table from Ada's thread.",
            evidence: ["B1"],
          },
        ],
      });
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      const mirrorEvent = yield* appendMessage(THREAD_B, "b", 3);
      yield* consent(THREAD_A);
      yield* cooperation.analyzeThread(THREAD_A, "manual");

      expect(harness.hub.posts[0]?.awareness).toEqual([]);
      const inbox = (yield* cooperation.getInbox).items;
      expect(inbox.map((item) => item.kind).toSorted()).toEqual(["note", "proposal"]);
      expect(inbox[0]).toMatchObject({
        sourceThreadId: THREAD_B,
        targetThreadId: THREAD_A,
        citations: [
          { threadId: THREAD_B, eventId: mirrorEvent.eventId, sequence: mirrorEvent.sequence },
        ],
      });
      const note = inbox.find((item) => item.kind === "note")!;
      const proposal = inbox.find((item) => item.kind === "proposal")!;

      // Admitting a note sends nothing.
      expect((yield* cooperation.resolveItem({ itemId: note.itemId, action: "admit" })).state).toBe(
        "admitted",
      );
      expect(harness.dispatched).toEqual([]);
      const again = yield* Effect.flip(
        cooperation.resolveItem({ itemId: note.itemId, action: "dismiss" }),
      );
      expect(again.reason).toBe("conflict");

      const wrongAction = yield* Effect.flip(
        cooperation.resolveItem({ itemId: proposal.itemId, action: "admit" }),
      );
      expect(wrongAction.reason).toBe("invalid");
      yield* cooperation.resolveItem({ itemId: proposal.itemId, action: "approve" });
      expect(harness.dispatched).toEqual([
        expect.objectContaining({
          type: "thread.turn.start",
          threadId: THREAD_A,
          message: expect.objectContaining({ text: "Reuse the refund table from Ada's thread." }),
        }),
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("files notes the hub delivers for this server's threads, once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      const mirrorEvent = yield* appendMessage(THREAD_B, "b", 4);
      yield* consent(THREAD_A);
      const item: HubAwarenessItem = {
        itemId: "item-1",
        kind: "note",
        sourceThreadId: HUB_B,
        sourceThreadTitle: "Ada's thread",
        targetThreadId: HUB_A,
        text: "Ada changed the refund API.",
        citations: [{ threadId: HUB_B, generation: 1, seq: 4 }],
        createdAt: NOW,
      };
      // A note for a thread that is not this server's is ignored.
      const foreign = { ...item, itemId: "item-2", targetThreadId: HubThreadId.make("link-x:t") };
      yield* cooperation.admitHubAwareness([item, foreign]);
      yield* cooperation.admitHubAwareness([item]);
      const inbox = (yield* cooperation.getInbox).items;
      expect(inbox).toEqual([
        expect.objectContaining({
          kind: "note",
          sourceThreadId: THREAD_B,
          sourceThreadTitle: `Title ${THREAD_B}`,
          targetThreadId: THREAD_A,
          text: "Ada changed the refund API.",
          citations: [
            { threadId: THREAD_B, eventId: mirrorEvent.eventId, sequence: mirrorEvent.sequence },
          ],
        }),
      ]);
      yield* cooperation.resolveItem({ itemId: inbox[0]!.itemId, action: "dismiss" });
      // Delivered again later: a decided note stays decided.
      yield* cooperation.admitHubAwareness([item]);
      expect((yield* cooperation.getInbox).items).toEqual([]);

      // With notifications off, nothing is filed.
      yield* consent(THREAD_A, { awarenessNotify: false });
      yield* cooperation.admitHubAwareness([{ ...item, itemId: "item-3" }]);
      expect((yield* cooperation.getInbox).items).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells the analyst how the owners linked the pair", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      const sql = yield* SqlClient.SqlClient;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b", 1);
      yield* consent(THREAD_A);
      // Ada linked her thread to A; the link counts in either direction.
      yield* sql`
        INSERT INTO projection_thread_related_links (thread_id, related_thread_id, relationship, linked_at)
        VALUES (${THREAD_B}, ${THREAD_A}, 'alternative', ${NOW})
      `;

      yield* cooperation.analyzeThread(THREAD_A, "manual");

      expect(harness.prompts[0]).toContain('"relationship":"alternative"');
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a run whose consent changed while the analyst was working", () => {
    const harness = makeHarness();
    harness.analyst.respond = () =>
      Effect.sync(() => {
        harness.hub.mirrorConsent = { ...harness.hub.mirrorConsent!, textEnabled: true };
        return goodOutput;
      });
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b", 1);
      yield* consent(THREAD_A);

      yield* cooperation.analyzeThread(THREAD_A, "manual");

      const state = yield* cooperation.getThreadState(THREAD_A);
      expect(state.lastRun).toMatchObject({
        state: "rejected",
        reason: "consent changed during analysis",
      });
      expect(state.summary).toBeNull();
      expect(harness.hub.posts).toEqual([{ summaries: [], awareness: [] }]);
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
      yield* appendMessage(THREAD_B, "b", 1);
      yield* consent(THREAD_A);

      yield* cooperation.analyzeThread(THREAD_A, "turn-completed");

      const state = yield* cooperation.getThreadState(THREAD_A);
      expect(state.lastRun).toMatchObject({
        state: "rejected",
        reason: "note cites an event that was not exported",
      });
      expect(state.summary).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never exports private threads, threads without consent, or from a mirror", () => {
    const harness = makeHarness();
    harness.hub.mirrorConsent = null;
    harness.shells.set(THREAD_C, shell(THREAD_C, { visibility: "private" }));
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_B, "b", 1);
      yield* appendMessage(THREAD_C, "c");
      yield* consent(THREAD_A);
      yield* consent(THREAD_C);
      // Ada never opted in and C is private.
      expect(yield* cooperation.analyzeThread(THREAD_A, "manual")).toBe(0);
      // A mirror is analyzed on its owner's machine, never here.
      harness.hub.mirrorConsent = {
        featureTopic: "billing",
        analysisEnabled: true,
        textEnabled: true,
        awarenessNotify: true,
      };
      expect(yield* cooperation.analyzeThread(THREAD_B, "manual")).toBe(0);
      expect(harness.prompts).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("pairs two of this server's own threads locally", () => {
    const harness = makeHarness();
    harness.hub.mirrorConsent = null;
    harness.analyst.respond = () => Effect.succeed(goodOutput);
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_C, "c");
      yield* consent(THREAD_A);
      yield* consent(THREAD_C);
      expect(yield* cooperation.analyzeThread(THREAD_A, "manual")).toBe(1);
      // Both summaries are kept; only the published thread's goes to the hub.
      expect(yield* cooperation.latestSummaryForThread(THREAD_C)).not.toBeNull();
      expect(harness.hub.posts[0]?.summaries.map((summary) => summary.threadId)).toEqual([HUB_A]);
      expect((yield* cooperation.getInbox).items).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("withdraws pending notes and the summary when consent is turned off", () => {
    const harness = makeHarness();
    harness.hub.mirrorConsent = null;
    harness.analyst.respond = () => Effect.succeed(goodOutput);
    return Effect.gen(function* () {
      const cooperation = yield* CooperationService;
      yield* appendMessage(THREAD_A, "a");
      yield* appendMessage(THREAD_C, "c");
      yield* consent(THREAD_A);
      yield* consent(THREAD_C);
      yield* cooperation.analyzeThread(THREAD_A, "manual");
      expect((yield* cooperation.getInbox).items).toHaveLength(1);

      yield* consent(THREAD_A, { analysisEnabled: false });

      expect((yield* cooperation.getInbox).items).toEqual([]);
      expect(yield* cooperation.latestSummaryForThread(THREAD_A)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });
});
