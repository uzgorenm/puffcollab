import { canDeleteThreadComment } from "@t3tools/client-runtime/state/thread-ownership";
import type { EnvironmentId, OrchestrationThreadComment, ThreadId } from "@t3tools/contracts";
import { memo, useCallback } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { relativeTime } from "../../lib/time";
import { useEnvironmentMembers } from "../../state/members";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamMemberName } from "./team-presentation";

/**
 * A teammate's comment in the thread feed (Puff Collab). Set apart from the
 * conversation because the agent never sees it. Authors delete their own;
 * admins may delete any.
 */
export const ThreadCommentRow = memo(function ThreadCommentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly comment: OrchestrationThreadComment;
}) {
  const roster = useEnvironmentMembers(props.environmentId);
  const deleteComment = useAtomCommand(threadEnvironment.deleteComment, "Delete comment");
  const { comment } = props;
  const author = teamMemberName(roster.members, comment.authorId, roster.currentMemberId);
  const canDelete = canDeleteThreadComment({ comment, ...roster });
  const confirmDelete = useCallback(() => {
    Alert.alert("Delete comment?", "Everyone following the thread will stop seeing it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void deleteComment({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, commentId: comment.id },
          }),
      },
    ]);
  }, [comment.id, deleteComment, props.environmentId, props.threadId]);

  return (
    <View className="mb-3 flex-row items-start gap-2 rounded-2xl border border-dashed border-border px-3 py-2.5">
      <SymbolView
        name="text.bubble"
        size={14}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
        style={{ marginTop: 2 }}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs text-foreground-muted" accessibilityRole="header">
          <Text className="text-xs font-t3-medium text-foreground">{author}</Text>
          {` · comment, not sent to the agent · ${relativeTime(comment.createdAt)}`}
        </Text>
        <Text className="text-sm text-foreground" selectable>
          {comment.text}
        </Text>
      </View>
      {canDelete ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete comment"
          hitSlop={8}
          onPress={confirmDelete}
          className="active:opacity-60"
        >
          <SymbolView name="trash" size={14} tintColorClassName="accent-icon-subtle" />
        </Pressable>
      ) : null}
    </View>
  );
});
