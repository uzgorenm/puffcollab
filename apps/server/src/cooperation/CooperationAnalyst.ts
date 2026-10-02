/**
 * CooperationAnalyst - runs the cooperation analyst prompt on the provider
 * instance chosen in `cooperationAnalysisModelSelection`. Text generation
 * only: the instance's `generateCooperationAnalysis` op, which exists solely
 * on drivers that can run a tool-free, workspace-free helper.
 *
 * @module CooperationAnalyst
 */
import { isCooperationAnalysisDriverSupported } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { CooperationAnalystOutput } from "../textGeneration/CooperationAnalysisPrompt.ts";

export class CooperationAnalystError extends Schema.TaggedError<CooperationAnalystError>()(
  "CooperationAnalystError",
  {
    /** `off` when no analysis model is configured. */
    reason: Schema.Literals(["off", "unsupported", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class CooperationAnalyst extends Context.Service<
  CooperationAnalyst,
  {
    /** Whether an analysis model is configured on a driver that supports it. */
    readonly available: Effect.Effect<boolean>;
    readonly analyze: (input: {
      readonly prompt: string;
    }) => Effect.Effect<CooperationAnalystOutput, CooperationAnalystError>;
  }
>()("t3/cooperation/CooperationAnalyst") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry;

  const resolve = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new CooperationAnalystError({
            reason: "failed",
            detail: `Settings unavailable: ${cause.message}`,
          }),
      ),
    );
    const selection = current.cooperationAnalysisModelSelection;
    if (selection === null) {
      return yield* new CooperationAnalystError({
        reason: "off",
        detail: "No cooperation analysis model is configured.",
      });
    }
    const instance = yield* registry.getInstance(selection.instanceId);
    // The provider decision lives in COOPERATION_ANALYSIS_DRIVER_SUPPORT; the
    // op check guards drivers that are listed but lack an implementation.
    const generate = instance?.textGeneration.generateCooperationAnalysis;
    if (
      instance === undefined ||
      !instance.enabled ||
      !isCooperationAnalysisDriverSupported(instance.driverKind) ||
      generate === undefined
    ) {
      return yield* new CooperationAnalystError({
        reason: "unsupported",
        detail: `Provider instance '${selection.instanceId}' cannot run tool-free cooperation analysis.`,
      });
    }
    return { selection, generate };
  });

  return CooperationAnalyst.of({
    available: resolve.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
    analyze: (input) =>
      resolve.pipe(
        Effect.flatMap(({ selection, generate }) =>
          generate({ prompt: input.prompt, modelSelection: selection }).pipe(
            Effect.mapError(
              (cause) => new CooperationAnalystError({ reason: "failed", detail: cause.detail }),
            ),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(CooperationAnalyst, make);
