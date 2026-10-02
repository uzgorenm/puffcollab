import {
  createRelatedWorkEnvironmentAtoms,
  relatedWorkSuggestInput,
  resolveRelatedThreads,
} from "@t3tools/client-runtime/state/related-work";
import type {
  EnvironmentId,
  ProjectId,
  RelatedThreadLink,
  RelatedWorkSuggestion,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadShells } from "./entities";
import { useEnvironmentQuery } from "./query";

export const relatedWorkEnvironment = createRelatedWorkEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SUGGESTIONS: ReadonlyArray<RelatedWorkSuggestion> = [];

/**
 * Possibly related shared threads for a thread's own text. Pass a null
 * environment to skip the query (only the owner can link).
 */
export function useRelatedWorkSuggestions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly text: string;
  readonly excludeThreadId?: ThreadId;
}): ReadonlyArray<RelatedWorkSuggestion> {
  const target =
    input.environmentId === null || input.projectId === null
      ? null
      : relatedWorkSuggestInput({
          environmentId: input.environmentId,
          projectId: input.projectId,
          text: input.text,
          ...(input.excludeThreadId === undefined
            ? {}
            : { excludeThreadId: input.excludeThreadId }),
        });
  const result = useEnvironmentQuery(
    target === null ? null : relatedWorkEnvironment.suggest(target),
  );
  return target === null ? EMPTY_SUGGESTIONS : (result.data?.suggestions ?? EMPTY_SUGGESTIONS);
}

/** A thread's linked related threads, resolved against what this viewer can see. */
export function useResolvedRelatedThreads(
  environmentId: EnvironmentId,
  links: ReadonlyArray<RelatedThreadLink> | undefined,
) {
  const shells = useThreadShells();
  return useMemo(() => {
    if (links === undefined || links.length === 0) return [];
    const visible = new Map(
      shells
        .filter((shell) => shell.environmentId === environmentId)
        .map((shell) => [shell.id, shell] as const),
    );
    return resolveRelatedThreads(links, visible);
  }, [environmentId, links, shells]);
}
