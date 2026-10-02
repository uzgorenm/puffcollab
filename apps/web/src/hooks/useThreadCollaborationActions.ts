import type { ScopedThreadRef, ThreadCommentId, ThreadVisibility } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";

import { useRelatedWorkReviewStore } from "../relatedWorkReviewStore";

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

  const requestRelatedWorkReview = useRelatedWorkReviewStore((state) => state.request);
  const setThreadVisibility = useCallback(
    async (target: ScopedThreadRef, visibility: ThreadVisibility) => {
      const result = await setVisibilityMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visibility },
      });
      // Newly shared: offer teammates' possibly related threads to link.
      if (visibility === "shared" && result._tag === "Success") {
        requestRelatedWorkReview(scopedThreadKey(target));
      }
      return result;
    },
    [requestRelatedWorkReview, setVisibilityMutation],
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
