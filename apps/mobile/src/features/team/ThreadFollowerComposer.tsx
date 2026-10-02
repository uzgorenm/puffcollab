import { THREAD_COMMENT_MAX_LENGTH, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { followingThreadNotice } from "./team-presentation";
import { TeamPillButton } from "./TeamPillButton";

/**
 * What a teammate gets instead of the composer on someone else's thread
 * (Puff Collab): who drives it, and a comment box. Comments are visible to
 * everyone following the thread and never reach the agent.
 */
export function ThreadFollowerComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly ownerName: string;
  readonly bottomInset: number;
  readonly contentMaxWidth?: number;
  readonly onFocusChange?: (focused: boolean) => void;
}) {
  const addComment = useAtomCommand(threadEnvironment.addComment, "Comment on thread");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const trimmed = text.trim();
  const submit = async () => {
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    const result = await addComment({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, text: trimmed },
    });
    setSending(false);
    if (result._tag === "Success") setText("");
  };

  return (
    <View
      className="w-full self-center gap-2 border-t border-border-subtle bg-screen px-4 pt-3"
      style={{ maxWidth: props.contentMaxWidth, paddingBottom: props.bottomInset + 8 }}
    >
      <View className="flex-row items-start gap-1.5">
        <SymbolView
          name="eye"
          size={13}
          tintColorClassName="accent-icon-subtle"
          style={{ marginTop: 2 }}
        />
        <Text className="flex-1 text-xs text-foreground-muted">
          {followingThreadNotice(props.ownerName)}
        </Text>
      </View>
      <View className="flex-row items-end gap-2">
        <AppTextInput
          className="max-h-32 min-h-11 flex-1 py-2.5"
          multiline
          value={text}
          maxLength={THREAD_COMMENT_MAX_LENGTH}
          placeholder="Comment for the team…"
          accessibilityLabel="Comment on this thread"
          onChangeText={setText}
          onFocus={() => props.onFocusChange?.(true)}
          onBlur={() => props.onFocusChange?.(false)}
        />
        <TeamPillButton
          label="Comment"
          tone="primary"
          disabled={trimmed.length === 0}
          loading={sending}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
