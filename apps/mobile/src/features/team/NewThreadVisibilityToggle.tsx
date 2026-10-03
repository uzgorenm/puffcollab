import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadVisibility } from "@t3tools/contracts";
import { View } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useHubProjectLink } from "../../state/hub";
import {
  newThreadVisibilityAtom,
  resolveNewThreadVisibility,
  setNewThreadVisibility,
} from "../../state/new-thread-visibility";

/**
 * Explicit opt-in to share a new thread with teammates on the team hub (Puff
 * Collab). Hidden for projects that are not linked to the hub.
 */
export function NewThreadVisibilityToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  /** The choice already queued with a pending task being edited. */
  readonly queuedVisibility: ThreadVisibility | undefined;
  readonly disabled?: boolean;
}) {
  const hubLink = useHubProjectLink(props.environmentId, props.projectId);
  const chosen = useAtomValue(newThreadVisibilityAtom(props.draftKey));
  if (hubLink === null) return null;
  const shared = resolveNewThreadVisibility(chosen, props.queuedVisibility) === "shared";
  return (
    <View className="flex-row justify-end px-1 pb-1">
      <ComposerInlineControl
        accessibilityLabel={shared ? "Shared with team" : "Private thread"}
        accessibilityHint={
          shared
            ? "Syncs to the team hub: teammates can follow and comment. Only you instruct the agent."
            : "Stays on this computer. Double tap to share it with your team."
        }
        disabled={props.disabled}
        icon={shared ? "person.2" : "lock"}
        label={shared ? "Shared with team" : "Private"}
        selected={shared}
        showChevron={false}
        onPress={() => setNewThreadVisibility(props.draftKey, shared ? "private" : "shared")}
      />
    </View>
  );
}
