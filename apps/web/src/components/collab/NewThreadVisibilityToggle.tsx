import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { LockIcon, UsersIcon } from "lucide-react";

import { useHubProjectLink } from "../../state/hub";
import { useThreadVisibilityDraftStore } from "../../threadVisibilityDraftStore";
import { Button } from "../ui/button";

/**
 * Explicit opt-in to share a new thread with teammates on the team hub (Puff
 * Collab). Hidden for projects that are not linked to the hub.
 */
export function NewThreadVisibilityToggle(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadKey: string;
}) {
  const hubLink = useHubProjectLink(props.environmentId, props.projectId);
  const visibility = useThreadVisibilityDraftStore(
    (state) => state.byThreadKey[props.threadKey] ?? "private",
  );
  const setVisibility = useThreadVisibilityDraftStore((state) => state.setVisibility);
  if (hubLink === null) return null;
  const shared = visibility === "shared";
  return (
    <div className="flex justify-end px-1 pt-1.5">
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={shared}
        title={
          shared
            ? "Syncs to the team hub: teammates can follow and comment. Only you instruct the agent."
            : "Stays on this computer."
        }
        onClick={() => setVisibility(props.threadKey, shared ? "private" : "shared")}
      >
        {shared ? <UsersIcon /> : <LockIcon />}
        {shared ? "Shared with team" : "Private"}
      </Button>
    </div>
  );
}
