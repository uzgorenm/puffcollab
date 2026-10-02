import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { CooperationAnalyst } from "./CooperationAnalyst.ts";
import { CooperationReactor, make } from "./CooperationReactor.ts";
import { CooperationService } from "./CooperationService.ts";

const THREAD = ThreadId.make("thread-a");

function harness(options: { readonly enabled: boolean; readonly cooldownMs: number }) {
  const analyzed: Array<{ threadId: ThreadId; trigger: string }> = [];
  const layer = Layer.effect(CooperationReactor, make({ cooldownMs: options.cooldownMs })).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.empty),
        }),
        Layer.mock(CooperationService)({
          isAnalysisEnabled: () => Effect.succeed(options.enabled),
          analyzeThread: (threadId, trigger) =>
            Effect.sync(() => {
              analyzed.push({ threadId, trigger });
              return 1;
            }),
        }),
        Layer.mock(CooperationAnalyst)({ available: Effect.succeed(true) }),
      ),
    ),
  );
  return { layer, analyzed };
}

it.effect("analyzes after a turn and debounces turns inside the cooldown", () => {
  const { layer, analyzed } = harness({ enabled: true, cooldownMs: 60_000 });
  return Effect.gen(function* () {
    const reactor = yield* CooperationReactor;
    yield* reactor.notifyTurnCompleted(THREAD);
    yield* reactor.notifyTurnCompleted(THREAD);
    yield* reactor.drain;
    yield* reactor.notifyTurnCompleted(THREAD);
    yield* reactor.drain;
    expect(analyzed).toEqual([{ threadId: THREAD, trigger: "turn-completed" }]);
  }).pipe(Effect.provide(layer));
});

it.effect("skips threads that are not opted in", () => {
  const { layer, analyzed } = harness({ enabled: false, cooldownMs: 0 });
  return Effect.gen(function* () {
    const reactor = yield* CooperationReactor;
    yield* reactor.notifyTurnCompleted(THREAD);
    yield* reactor.drain;
    expect(analyzed).toEqual([]);
  }).pipe(Effect.provide(layer));
});
