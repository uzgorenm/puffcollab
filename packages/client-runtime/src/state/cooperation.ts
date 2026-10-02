import {
  type CooperationAwarenessItem,
  type CooperationSettings,
  type CooperationSettingsUpdateInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
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
 * The text an admitted awareness note adds to the owner's composer. It rides
 * along with the next message the owner sends, where they can still read,
 * edit, or remove it; admitting never sends anything by itself.
 */
export function awarenessNoteComposerText(item: CooperationAwarenessItem): string {
  const quoted = item.text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> Informational note from the shared thread "${item.sourceThreadTitle}" (Puff Collab):\n${quoted}`;
}

/** Appends an admitted note to whatever the owner has already typed. */
export function appendAwarenessNote(prompt: string, item: CooperationAwarenessItem): string {
  const block = awarenessNoteComposerText(item);
  const trimmed = prompt.trimEnd();
  return trimmed.length === 0 ? `${block}\n\n` : `${trimmed}\n\n${block}\n\n`;
}
