import type { CooperationAwarenessItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createCooperationEnvironmentAtoms } from "@t3tools/client-runtime/state/cooperation";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const cooperationEnvironment = createCooperationEnvironmentAtoms(connectionAtomRuntime);

/** A thread's cooperation consent, latest summary, and last run, pushed by the server. */
export function useCooperationThreadState(environmentId: EnvironmentId, threadId: ThreadId) {
  return useEnvironmentQuery(
    cooperationEnvironment.threadState({ environmentId, input: { threadId } }),
  );
}

const EMPTY_ITEMS: ReadonlyArray<CooperationAwarenessItem> = [];

/** The viewer's pending awareness items that target one thread. */
export function useCooperationInboxForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<CooperationAwarenessItem> {
  const inbox = useEnvironmentQuery(cooperationEnvironment.inbox({ environmentId, input: {} }));
  const items = inbox.data?.items;
  return useMemo(
    () => items?.filter((item) => item.targetThreadId === threadId) ?? EMPTY_ITEMS,
    [items, threadId],
  );
}
