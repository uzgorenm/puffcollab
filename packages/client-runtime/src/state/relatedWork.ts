import {
  type EnvironmentId,
  type MemberId,
  type OrchestrationThreadShell,
  type RelatedThreadLink,
  threadOwnerOf,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type LinkRelatedThreadInput,
  linkRelatedThread,
  type UnlinkRelatedThreadInput,
  unlinkRelatedThread,
} from "../operations/commands.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export type { LinkRelatedThreadInput, UnlinkRelatedThreadInput };

/** Clients wait this long after the last keystroke before asking for suggestions. */
export const RELATED_WORK_SUGGEST_DEBOUNCE_MS = 400;
/** Drafts shorter than this are not worth matching. */
export const RELATED_WORK_MIN_DRAFT_LENGTH = 12;

/**
 * Related work (Puff Collab): suggestions while starting a thread, and the
 * owner's link/unlink commands for related threads.
 */
export function createRelatedWorkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    suggest: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:related-work:suggest",
      tag: WS_METHODS.relatedWorkSuggest,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    link: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-related-thread",
      execute: (input: LinkRelatedThreadInput) => linkRelatedThread(input),
      scheduler,
      concurrency,
    }),
    unlink: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-related-thread",
      execute: (input: UnlinkRelatedThreadInput) => unlinkRelatedThread(input),
      scheduler,
      concurrency,
    }),
  };
}

/** Threads without a recorded creator belong to the environment owner. */
export function isRelatedThreadOwner(
  thread: { readonly createdBy?: MemberId | null | undefined },
  currentMemberId: MemberId | null,
): boolean {
  return currentMemberId !== null && threadOwnerOf(thread) === currentMemberId;
}

export type RelatedThreadStatus = "working" | "active" | "settled" | "archived";

export type ResolvedRelatedThread =
  | {
      readonly kind: "visible";
      readonly link: RelatedThreadLink;
      readonly title: string;
      readonly createdBy: MemberId | null;
      readonly status: RelatedThreadStatus;
    }
  // The viewer cannot see the other thread (private, removed, or another
  // project they do not belong to). Only the relationship is shown.
  | { readonly kind: "unavailable"; readonly link: RelatedThreadLink };

type RelatedThreadShell = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "createdBy" | "archivedAt" | "settledAt" | "session"
>;

export function relatedThreadStatus(thread: RelatedThreadShell): RelatedThreadStatus {
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledAt !== null) return "settled";
  return thread.session?.status === "running" ? "working" : "active";
}

/**
 * Resolve links against the threads this viewer already has. A link carries
 * only the other thread's id, so a thread missing from the viewer's shell
 * renders as unavailable and nothing about it leaks.
 */
export function resolveRelatedThreads(
  links: ReadonlyArray<RelatedThreadLink> | undefined,
  visibleThreads: ReadonlyMap<ThreadId, RelatedThreadShell>,
): ReadonlyArray<ResolvedRelatedThread> {
  return (links ?? []).map((link) => {
    const thread = visibleThreads.get(link.relatedThreadId);
    return thread === undefined
      ? { kind: "unavailable", link }
      : {
          kind: "visible",
          link,
          title: thread.title,
          createdBy: thread.createdBy ?? null,
          status: relatedThreadStatus(thread),
        };
  });
}

/** The suggestion query input for a draft, or null when it is not worth asking. */
export function relatedWorkSuggestInput(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: OrchestrationThreadShell["projectId"];
  readonly text: string;
  readonly excludeThreadId?: ThreadId;
}) {
  const text = input.text.trim().slice(0, 4000);
  if (text.length < RELATED_WORK_MIN_DRAFT_LENGTH) return null;
  return {
    environmentId: input.environmentId,
    input: {
      projectId: input.projectId,
      text,
      ...(input.excludeThreadId === undefined ? {} : { excludeThreadId: input.excludeThreadId }),
    },
  };
}
