import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isRelatedThreadOwner,
  relatedThreadOwnerLabel,
  type RelatedThreadStatus,
  type ResolvedRelatedThread,
} from "@t3tools/client-runtime/state/related-work";
import type {
  EnvironmentId,
  ProjectId,
  RelatedThreadRelationship,
  RelatedWorkSuggestion,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { GitCompareArrowsIcon, Link2Icon, Link2OffIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { type ComposerThreadTarget, useComposerThreadDraft } from "~/composerDraftStore";
import { useRelatedWorkReviewStore } from "~/relatedWorkReviewStore";
import { useThreadCollabFocusRequested, useThreadCollabFocusStore } from "~/threadCollabFocusStore";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useThreadDetail } from "~/state/entities";
import {
  relatedWorkEnvironment,
  useRelatedWorkSuggestions,
  useResolvedRelatedThreads,
} from "~/state/relatedWork";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const RELATIONSHIP_LABEL: Record<RelatedThreadRelationship, string> = {
  complementary: "Complementary",
  alternative: "Alternative",
};

const STATUS_LABEL: Record<RelatedThreadStatus, string> = {
  working: "Working",
  active: "Active",
  settled: "Settled",
  archived: "Archived",
};

function ThreadLink(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(props.environmentId, props.threadId))}
      className="min-w-0 truncate font-medium text-foreground hover:underline"
    >
      {props.children}
    </Link>
  );
}

/**
 * Possibly related shared threads while composing a new thread's first
 * message. Shown, never sent: nothing here reaches the agent.
 */
export function RelatedWorkComposerStrip(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  composerDraftTarget: ComposerThreadTarget;
}) {
  const prompt = useComposerThreadDraft(props.composerDraftTarget).prompt;
  const suggestions = useRelatedWorkSuggestions({
    environmentId: props.environmentId,
    projectId: props.projectId,
    text: prompt,
  });
  if (suggestions.length === 0) return null;
  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-muted-foreground text-xs"
      aria-label="Possibly related threads"
    >
      <span className="inline-flex items-center gap-1">
        <GitCompareArrowsIcon aria-hidden className="size-3.5" />
        Possibly related:
      </span>
      {suggestions.map((suggestion) => (
        <span key={suggestion.threadId} className="inline-flex min-w-0 max-w-64 items-center gap-1">
          <ThreadLink environmentId={props.environmentId} threadId={suggestion.threadId}>
            {suggestion.title}
          </ThreadLink>
          <span className="shrink-0">· {relatedThreadOwnerLabel(suggestion)}</span>
        </span>
      ))}
    </div>
  );
}

function LinkedRow(props: {
  environmentId: EnvironmentId;
  entry: ResolvedRelatedThread;
  onUnlink: (() => void) | null;
}) {
  const { entry } = props;
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <Badge variant="outline">{RELATIONSHIP_LABEL[entry.link.relationship]}</Badge>
      {entry.kind === "visible" ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ThreadLink environmentId={props.environmentId} threadId={entry.link.relatedThreadId}>
            {entry.title}
          </ThreadLink>
          <span className="shrink-0 text-muted-foreground text-xs">
            {relatedThreadOwnerLabel(entry)} · {STATUS_LABEL[entry.status]}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-muted-foreground italic">Unavailable thread</span>
      )}
      {props.onUnlink ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Unlink related thread"
          onClick={props.onUnlink}
        >
          <Link2OffIcon />
        </Button>
      ) : null}
    </li>
  );
}

function SuggestionRow(props: {
  environmentId: EnvironmentId;
  suggestion: RelatedWorkSuggestion;
  onLink: (relationship: RelatedThreadRelationship) => void;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        <ThreadLink environmentId={props.environmentId} threadId={props.suggestion.threadId}>
          {props.suggestion.title}
        </ThreadLink>
        <span className="shrink-0 text-muted-foreground text-xs">
          {relatedThreadOwnerLabel(props.suggestion)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <Button size="xs" variant="outline" onClick={() => props.onLink("complementary")}>
          <Link2Icon />
          Complementary
        </Button>
        <Button size="xs" variant="outline" onClick={() => props.onLink("alternative")}>
          <Link2Icon />
          Alternative
        </Button>
      </span>
    </li>
  );
}

/**
 * Related threads in the thread header: linked threads for everyone who can
 * see this thread, plus suggestions and link/unlink for its owner. Right after
 * the owner shares the thread it opens by itself when there is something to
 * link.
 */
export function RelatedThreadsControl(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const threadKey = scopedThreadKey(threadRef);
  const thread = useThreadDetail(threadRef);
  const reviewRequested = useRelatedWorkReviewStore((state) => state.threadKeys.has(threadKey));
  const clearReview = useRelatedWorkReviewStore((state) => state.clear);
  // The command palette's "Link related thread" opens the popover.
  const paletteRequested = useThreadCollabFocusRequested(threadKey, "related-threads");
  const clearPaletteRequest = useThreadCollabFocusStore((state) => state.clear);
  const resolved = useResolvedRelatedThreads(props.environmentId, thread);
  const [open, setOpen] = useState(false);
  const link = useAtomCommand(relatedWorkEnvironment.link);
  const unlink = useAtomCommand(relatedWorkEnvironment.unlink);
  const isOwner = thread !== null && isRelatedThreadOwner(thread);
  const draftText = useMemo(() => {
    if (thread === null) return "";
    const firstUserMessage = thread.messages.find((message) => message.role === "user")?.text;
    return [thread.title, firstUserMessage ?? ""].join("\n");
  }, [thread]);
  const linkedIds = useMemo(
    () => new Set(resolved.map((entry) => entry.link.relatedThreadId)),
    [resolved],
  );
  // Only ask for suggestions while the owner has the popover open or just
  // shared the thread.
  const suggestions = useRelatedWorkSuggestions({
    environmentId:
      (open || paletteRequested || reviewRequested) && isOwner ? props.environmentId : null,
    projectId: thread?.projectId ?? null,
    text: draftText,
    excludeThreadId: props.threadId,
  }).filter((suggestion) => !linkedIds.has(suggestion.threadId));

  // Opens by itself right after sharing, once there is something to link;
  // closing it ends the review.
  const popoverOpen =
    open || paletteRequested || (reviewRequested && isOwner && suggestions.length > 0);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      clearReview(threadKey);
      if (paletteRequested) clearPaletteRequest();
    }
  };

  // Single-person environments have nobody's work to relate to.
  if (thread === null || (resolved.length === 0 && !(isOwner && thread.hub !== undefined)))
    return null;

  const target = (input: { relatedThreadId: ThreadId }) => ({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, ...input },
  });

  return (
    <Popover open={popoverOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost" aria-label="Related threads" className="shrink-0" />
        }
      >
        <GitCompareArrowsIcon />
        {resolved.length > 0 ? resolved.length : null}
      </PopoverTrigger>
      <PopoverPopup align="start" aria-label="Related threads">
        <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3">
          <PopoverTitle>Related threads</PopoverTitle>
          {resolved.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {resolved.map((entry) => (
                <LinkedRow
                  key={entry.link.relatedThreadId}
                  environmentId={props.environmentId}
                  entry={entry}
                  onUnlink={
                    isOwner
                      ? () => void unlink(target({ relatedThreadId: entry.link.relatedThreadId }))
                      : null
                  }
                />
              ))}
            </ul>
          ) : null}
          {isOwner ? (
            suggestions.length > 0 ? (
              <>
                <p className="text-muted-foreground text-xs">
                  Possibly related shared threads. Linking shows the relationship to teammates; it
                  is never sent to the agent.
                </p>
                <ul className="flex flex-col gap-3">
                  {suggestions.map((suggestion) => (
                    <SuggestionRow
                      key={suggestion.threadId}
                      environmentId={props.environmentId}
                      suggestion={suggestion}
                      onLink={(relationship) =>
                        void link({
                          environmentId: props.environmentId,
                          input: {
                            threadId: props.threadId,
                            relatedThreadId: suggestion.threadId,
                            relationship,
                          },
                        })
                      }
                    />
                  ))}
                </ul>
              </>
            ) : resolved.length === 0 ? (
              <p className="text-muted-foreground text-sm">No related shared threads found.</p>
            ) : null
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
