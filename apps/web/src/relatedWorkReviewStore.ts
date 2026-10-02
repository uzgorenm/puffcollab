import { create } from "zustand";

/**
 * Threads their owner just shared from a thread menu (Puff Collab). The
 * thread's related-threads control checks for possibly related shared work
 * and opens once it finds some, so sharing is the moment to link or compare.
 * In-memory and per window, keyed by scoped thread key.
 */
interface RelatedWorkReviewState {
  readonly threadKeys: ReadonlySet<string>;
  readonly request: (threadKey: string) => void;
  readonly clear: (threadKey: string) => void;
}

export const useRelatedWorkReviewStore = create<RelatedWorkReviewState>()((set) => ({
  threadKeys: new Set(),
  request: (threadKey) =>
    set((state) => ({ threadKeys: new Set(state.threadKeys).add(threadKey) })),
  clear: (threadKey) =>
    set((state) => {
      if (!state.threadKeys.has(threadKey)) return state;
      const threadKeys = new Set(state.threadKeys);
      threadKeys.delete(threadKey);
      return { threadKeys };
    }),
}));
