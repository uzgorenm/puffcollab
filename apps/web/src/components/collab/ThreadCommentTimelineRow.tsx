import { canDeleteThreadComment } from "@t3tools/client-runtime/state/thread-ownership";
import type { OrchestrationThreadComment, ScopedThreadRef } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { MessageCircleIcon, Trash2Icon } from "lucide-react";

import { useThreadCollaborationActions } from "../../hooks/useThreadCollaborationActions";
import type { EnvironmentMembers } from "../../state/members";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";

/**
 * A teammate's comment in the thread timeline (Puff Collab). Styled apart
 * from the conversation because the agent never sees it.
 */
export function ThreadCommentTimelineRow(props: {
  comment: OrchestrationThreadComment;
  members: EnvironmentMembers;
  threadRef: ScopedThreadRef | null;
  timestampFormat: TimestampFormat;
}) {
  const { comment, members, threadRef } = props;
  const { deleteThreadComment } = useThreadCollaborationActions();
  const isMine = comment.authorId === members.currentMemberId;
  const author = isMine
    ? "You"
    : (members.members.get(comment.authorId)?.displayName ?? "A teammate");
  const canDelete = threadRef !== null && canDeleteThreadComment({ comment, ...members });
  return (
    <div className="group/comment flex justify-center">
      <div className="flex w-full max-w-[85%] items-start gap-2 rounded-xl border border-dashed border-border px-3 py-2">
        <MessageCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="sr-only select-none">{`Comment from ${author}`}</h3>
          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">{author}</span>
            {" · comment, not sent to the agent · "}
            {formatShortTimestamp(comment.createdAt, props.timestampFormat)}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{comment.text}</p>
        </div>
        {canDelete ? (
          <span className="opacity-0 group-hover/comment:opacity-100 has-focus-visible:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Delete comment"
              onClick={() => void deleteThreadComment(threadRef, comment.id)}
            >
              <Trash2Icon />
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
