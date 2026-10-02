import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadVisibility } from "@t3tools/contracts";
import { View } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useEnvironmentMembers } from "../../state/members";
import {
  newThreadVisibilityAtom,
  resolveNewThreadVisibility,
  setNewThreadVisibility,
} from "../../state/new-thread-visibility";

/**
 * Explicit opt-in to share a new thread with project members (Puff Collab).
 * Hidden in single-user environments.
 */
export function NewThreadVisibilityToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  /** The choice already queued with a pending task being edited. */
  readonly queuedVisibility: ThreadVisibility | undefined;
  readonly disabled?: boolean;
}) {
  const { members } = useEnvironmentMembers(props.environmentId);
  const chosen = useAtomValue(newThreadVisibilityAtom(props.draftKey));
  if (members.size <= 1) return null;
  const shared = resolveNewThreadVisibility(chosen, props.queuedVisibility) === "shared";
  return (
    <View className="flex-row justify-end px-1 pb-1">
      <ComposerInlineControl
        accessibilityLabel={shared ? "Shared with project" : "Private thread"}
        accessibilityHint={
          shared
            ? "Project members can follow this thread and comment. Only you can instruct the agent."
            : "Only you and admins can see this thread. Double tap to share it with the project."
        }
        disabled={props.disabled}
        icon={shared ? "person.2" : "lock"}
        label={shared ? "Shared with project" : "Private"}
        selected={shared}
        showChevron={false}
        onPress={() => setNewThreadVisibility(props.draftKey, shared ? "private" : "shared")}
      />
    </View>
  );
}
