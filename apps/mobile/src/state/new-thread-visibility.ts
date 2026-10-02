import type { ThreadVisibility } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

/**
 * The sharing choice for a thread that does not exist yet (Puff Collab),
 * keyed by the new-task draft key and read when the task is queued. Null
 * until the owner touches the toggle. In memory only: new threads start
 * private unless the owner opts in.
 */
export const newThreadVisibilityAtom = Atom.family((_draftKey: string) =>
  Atom.make<ThreadVisibility | null>(null).pipe(Atom.keepAlive),
);

/** The explicit choice wins; a queued task being edited keeps its own; otherwise private. */
export function resolveNewThreadVisibility(
  chosen: ThreadVisibility | null,
  queued: ThreadVisibility | undefined,
): ThreadVisibility {
  return chosen ?? queued ?? "private";
}

export function readNewThreadVisibility(
  draftKey: string,
  queued: ThreadVisibility | undefined,
): ThreadVisibility {
  return resolveNewThreadVisibility(appAtomRegistry.get(newThreadVisibilityAtom(draftKey)), queued);
}

export function setNewThreadVisibility(draftKey: string, visibility: ThreadVisibility): void {
  appAtomRegistry.set(newThreadVisibilityAtom(draftKey), visibility);
}
