import type { EnvironmentId, MemberId, ThreadVisibility } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";

import { useThreadCollaboration } from "../../state/threadCollaboration";

/**
 * Sidebar marker for team threads (Puff Collab): the owner's name on a
 * teammate's thread, a people glyph on your own shared thread.
 */
export function ThreadOwnerBadge(props: {
  environmentId: EnvironmentId;
  thread: {
    readonly createdBy?: MemberId | null | undefined;
    readonly visibility?: ThreadVisibility | undefined;
  };
}) {
  const collaboration = useThreadCollaboration(props.environmentId, props.thread);
  if (!collaboration.teamEnabled) return null;
  if (!collaboration.isOwner) {
    return (
      <span
        aria-label={`${collaboration.ownerName}'s thread`}
        className="max-w-20 shrink-0 truncate text-secondary-label text-xs"
      >
        {collaboration.ownerName}
      </span>
    );
  }
  return collaboration.shared ? (
    <UsersIcon
      role="img"
      aria-label="Shared with project"
      className="size-3 shrink-0 text-muted-foreground/65"
    />
  ) : null;
}
