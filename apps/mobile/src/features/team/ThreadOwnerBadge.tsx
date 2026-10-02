import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ThreadCollaborationView } from "../../state/thread-collaboration";

/**
 * Thread-list marker for team threads (Puff Collab): the owner's name on a
 * teammate's thread, a people glyph on your own shared thread.
 */
export function ThreadOwnerBadge(props: {
  readonly collaboration: ThreadCollaborationView;
  readonly textClassName: string;
  readonly iconTintClassName: string;
}) {
  const { collaboration } = props;
  if (!collaboration.teamEnabled) return null;
  if (!collaboration.isOwner) {
    return (
      <Text
        accessibilityLabel={`${collaboration.ownerName}'s thread`}
        className={`max-w-24 shrink-0 text-xs ${props.textClassName}`}
        numberOfLines={1}
      >
        {collaboration.ownerName}
      </Text>
    );
  }
  if (!collaboration.shared) return null;
  return (
    <View accessible accessibilityLabel="Shared with project">
      <SymbolView
        name="person.2"
        size={12}
        tintColorClassName={props.iconTintClassName}
        type="monochrome"
      />
    </View>
  );
}
