import {
  COOPERATION_AWARENESS_CONTEXT_KIND,
  type ComposerContextId,
  type ComposerContextRecord,
  type CooperationAwarenessItem,
  type CooperationSettings,
  type CooperationSettingsUpdateInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Puff Collab cooperation analysis for one environment: a thread's consent
 * and latest summary, the viewer's awareness inbox, and the owner commands.
 * Both reads are server pushed, so commands need no refetch.
 */
export function createCooperationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  return {
    threadState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cooperation:thread",
      tag: WS_METHODS.cooperationSubscribeThread,
    }),
    inbox: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cooperation:inbox",
      tag: WS_METHODS.cooperationSubscribeInbox,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cooperation:update-settings",
      tag: WS_METHODS.cooperationUpdateSettings,
      scheduler,
      concurrency,
    }),
    runAnalysis: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cooperation:run-analysis",
      tag: WS_METHODS.cooperationRunAnalysis,
      scheduler,
      concurrency,
    }),
    resolveItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cooperation:resolve-item",
      tag: WS_METHODS.cooperationResolveItem,
      scheduler,
      concurrency,
    }),
  };
}

/** The update that keeps everything else and applies `patch`, against the version shown. */
export function cooperationSettingsUpdate(
  settings: CooperationSettings,
  patch: Partial<
    Pick<
      CooperationSettings,
      "featureTopic" | "relationship" | "analysisEnabled" | "textEnabled" | "awarenessNotify"
    >
  >,
): CooperationSettingsUpdateInput {
  const next = { ...settings, ...patch };
  const analysisEnabled = next.analysisEnabled;
  return {
    threadId: settings.threadId,
    expectedVersion: settings.version,
    featureTopic: next.featureTopic.trim(),
    relationship: next.relationship,
    analysisEnabled,
    textEnabled: analysisEnabled && next.textEnabled,
    awarenessNotify: analysisEnabled && next.awarenessNotify,
  };
}

/**
 * The composer context for an admitted awareness note: a record carrying the
 * note and the inline reference that makes the provider see it. Only the
 * owner's next sent message carries it; nothing is sent on admit.
 */
export function awarenessNoteComposerContext(item: CooperationAwarenessItem): {
  readonly record: ComposerContextRecord;
  readonly reference: string;
} {
  const contextId = `awareness-${item.itemId}`
    .replace(/[^a-z0-9_-]/gi, "-")
    .slice(0, 128) as ComposerContextId;
  const label = `Note from ${item.sourceThreadTitle}`;
  return {
    record: {
      version: 1,
      kind: COOPERATION_AWARENESS_CONTEXT_KIND,
      contextId,
      label,
      payload: {
        informational: true,
        sourceThread: item.sourceThreadTitle,
        note: item.text,
        evidence: item.citations.map((citation) => citation.eventId),
      },
    },
    reference: formatComposerContextReference({
      kind: COOPERATION_AWARENESS_CONTEXT_KIND,
      contextId,
      label,
    }),
  };
}
