import type { ThreadVisibility } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * The sharing choice for a thread that does not exist yet (Puff Collab).
 * Keyed by the draft route's thread key and read once when the first send
 * creates the thread. In-memory: new threads start private unless the owner
 * opts in.
 */
interface ThreadVisibilityDraftState {
  readonly byThreadKey: Readonly<Record<string, ThreadVisibility>>;
  readonly setVisibility: (threadKey: string, visibility: ThreadVisibility) => void;
}

export const useThreadVisibilityDraftStore = create<ThreadVisibilityDraftState>()((set) => ({
  byThreadKey: {},
  setVisibility: (threadKey, visibility) =>
    set((state) => ({ byThreadKey: { ...state.byThreadKey, [threadKey]: visibility } })),
}));

/** The visibility to create a draft thread with; private unless opted in. */
export function readDraftThreadVisibility(threadKey: string): ThreadVisibility {
  return useThreadVisibilityDraftStore.getState().byThreadKey[threadKey] ?? "private";
}
