import type {
  EnvironmentId,
  HubThreadLink,
  MemberId,
  ProjectId,
  ThreadVisibility,
} from "@t3tools/contracts";
import { CloudCheckIcon, CloudOffIcon, CloudUploadIcon, UsersIcon } from "lucide-react";

import { useThreadCollaboration } from "../../state/threadCollaboration";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SYNC_ICONS = {
  synced: CloudCheckIcon,
  pending: CloudUploadIcon,
  offline: CloudOffIcon,
} as const;

/**
 * Sidebar marker for team threads (Puff Collab): the owner's name on a
 * teammate's thread (including remote team hub threads), a people glyph on
 * your own shared thread, or a quiet static cloud glyph with its hub sync state.
 */
export function ThreadOwnerBadge(props: {
  environmentId: EnvironmentId;
  thread: {
    readonly createdBy?: MemberId | null | undefined;
    readonly visibility?: ThreadVisibility | undefined;
    readonly hub?: HubThreadLink | undefined;
    readonly projectId?: ProjectId | undefined;
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
  if (!collaboration.shared) return null;
  const sync = collaboration.hubSync;
  if (sync !== null) {
    const Icon = SYNC_ICONS[sync.state];
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span role="img" aria-label={sync.label} className="inline-flex shrink-0" />}
        >
          <Icon aria-hidden className="size-3 text-muted-foreground/65" />
        </TooltipTrigger>
        <TooltipPopup>{sync.label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <UsersIcon
      role="img"
      aria-label="Shared with project"
      className="size-3 shrink-0 text-muted-foreground/65"
    />
  );
}
