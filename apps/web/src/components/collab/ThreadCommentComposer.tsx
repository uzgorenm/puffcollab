import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { THREAD_COMMENT_MAX_LENGTH, type ScopedThreadRef } from "@t3tools/contracts";
import { EyeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useThreadCollaborationActions } from "../../hooks/useThreadCollaborationActions";
import {
  useThreadCollabFocusRequested,
  useThreadCollabFocusStore,
} from "../../threadCollabFocusStore";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/**
 * What a teammate sees instead of the composer on someone else's thread
 * (Puff Collab): who drives it, and a comment box. Comments are visible to
 * everyone following the thread and never reach the agent.
 */
export function ThreadCommentComposer(props: { threadRef: ScopedThreadRef; ownerName: string }) {
  const { addThreadComment } = useThreadCollaborationActions();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const trimmed = text.trim();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The command palette's "Comment on thread" focuses the box.
  const focusRequested = useThreadCollabFocusRequested(scopedThreadKey(props.threadRef), "comment");
  const clearFocusRequest = useThreadCollabFocusStore((state) => state.clear);
  useEffect(() => {
    if (!focusRequested) return;
    textareaRef.current?.focus();
    clearFocusRequest();
  }, [clearFocusRequest, focusRequested]);
  const submit = async () => {
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    const result = await addThreadComment(props.threadRef, trimmed);
    setSending(false);
    if (result._tag === "Success") setText("");
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <EyeIcon aria-hidden className="size-3.5" />
        {`Following ${props.ownerName}'s thread. Only ${props.ownerName} can instruct the agent; your comments are not sent to it.`}
      </p>
      <Textarea
        ref={textareaRef}
        size="sm"
        value={text}
        maxLength={THREAD_COMMENT_MAX_LENGTH}
        placeholder="Comment for the team…"
        aria-label="Comment on this thread"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={trimmed.length === 0 || sending} onClick={() => void submit()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
