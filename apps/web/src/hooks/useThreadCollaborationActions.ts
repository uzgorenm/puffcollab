import type { ScopedThreadRef, ThreadCommentId, ThreadVisibility } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Puff Collab thread actions shared by the chat view, the thread menus, and
 * the command palette: share/unshare (owner only) and comments (anyone who
 * can see the thread). The server enforces who may do what.
 */
export function useThreadCollaborationActions() {
  const setVisibilityMutation = useAtomCommand(threadEnvironment.setVisibility, {
    label: "Change thread sharing",
  });
  const addCommentMutation = useAtomCommand(threadEnvironment.addComment, {
    label: "Comment on thread",
  });
  const deleteCommentMutation = useAtomCommand(threadEnvironment.deleteComment, {
    label: "Delete comment",
  });

  const setThreadVisibility = useCallback(
    (target: ScopedThreadRef, visibility: ThreadVisibility) =>
      setVisibilityMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visibility },
      }),
    [setVisibilityMutation],
  );
  const addThreadComment = useCallback(
    (target: ScopedThreadRef, text: string) =>
      addCommentMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, text },
      }),
    [addCommentMutation],
  );
  const deleteThreadComment = useCallback(
    (target: ScopedThreadRef, commentId: ThreadCommentId) =>
      deleteCommentMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, commentId },
      }),
    [deleteCommentMutation],
  );
  return { setThreadVisibility, addThreadComment, deleteThreadComment };
}
