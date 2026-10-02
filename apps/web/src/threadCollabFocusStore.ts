import { create } from "zustand";

/** Where a request sends the user on a thread (Puff Collab). */
export type ThreadCollabFocusTarget = "comment" | "related-threads";

/**
 * One-shot requests from the command palette to open a thread's
 * related-threads popover or focus its comment box. The owning component
 * consumes the request for its thread. In-memory and per window.
 */
interface ThreadCollabFocusState {
  readonly request: { readonly threadKey: string; readonly target: ThreadCollabFocusTarget } | null;
  readonly focus: (threadKey: string, target: ThreadCollabFocusTarget) => void;
  readonly clear: () => void;
}

export const useThreadCollabFocusStore = create<ThreadCollabFocusState>()((set) => ({
  request: null,
  focus: (threadKey, target) => set({ request: { threadKey, target } }),
  clear: () => set({ request: null }),
}));

/** Whether a pending request targets this thread's `target`. */
export const useThreadCollabFocusRequested = (
  threadKey: string,
  target: ThreadCollabFocusTarget,
): boolean =>
  useThreadCollabFocusStore(
    (state) => state.request?.threadKey === threadKey && state.request.target === target,
  );
