/**
 * CooperationReactor - runs cooperation analysis after a turn completes on an
 * opted-in thread. Side effects stay out of the decider: this reacts to
 * `thread.turn-diff-completed` (the end of every turn) outside orchestration.
 *
 * Debounced two ways: a thread already queued is not queued again, and a
 * thread analyzed within the cooldown waits for a later turn.
 *
 * @module CooperationReactor
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { CooperationAnalyst } from "./CooperationAnalyst.ts";
import { CooperationService } from "./CooperationService.ts";

const DEFAULT_COOPERATION_COOLDOWN_MS = 2 * 60_000;

export class CooperationReactor extends Context.Service<
  CooperationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Queue a thread as if one of its turns just completed. */
    readonly notifyTurnCompleted: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/cooperation/CooperationReactor") {}

export const make = (options?: { readonly cooldownMs?: number }) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const cooperation = yield* CooperationService;
    const analyst = yield* CooperationAnalyst;
    const cooldownMs = options?.cooldownMs ?? DEFAULT_COOPERATION_COOLDOWN_MS;
    const queued = new Set<ThreadId>();
    const lastRunAt = new Map<ThreadId, number>();

    const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
      Effect.gen(function* () {
        queued.delete(threadId);
        lastRunAt.set(threadId, yield* Clock.currentTimeMillis);
        yield* cooperation.analyzeThread(threadId, "turn-completed");
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("cooperation analysis skipped", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
    );

    const notifyTurnCompleted: CooperationReactor["Service"]["notifyTurnCompleted"] = (threadId) =>
      Effect.gen(function* () {
        if (queued.has(threadId)) return;
        const last = lastRunAt.get(threadId);
        if (last !== undefined && (yield* Clock.currentTimeMillis) - last < cooldownMs) return;
        if (!(yield* cooperation.isAnalysisEnabled(threadId))) return;
        if (!(yield* analyst.available)) return;
        queued.add(threadId);
        yield* worker.enqueue(threadId);
      });

    const processEvent = (event: OrchestrationEvent) =>
      event.type === "thread.turn-diff-completed"
        ? notifyTurnCompleted(event.payload.threadId)
        : Effect.void;

    const start: CooperationReactor["Service"]["start"] = Effect.fn("CooperationReactor.start")(
      function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* forkParked(Stream.runForEach(events, processEvent));
      },
    );

    return {
      start,
      notifyTurnCompleted,
      drain: worker.drain,
    } satisfies CooperationReactor["Service"];
  });

export const layer = Layer.effect(CooperationReactor, make());
