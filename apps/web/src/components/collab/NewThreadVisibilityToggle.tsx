import type { EnvironmentId } from "@t3tools/contracts";
import { LockIcon, UsersIcon } from "lucide-react";

import { useEnvironmentMembers } from "../../state/members";
import { useThreadVisibilityDraftStore } from "../../threadVisibilityDraftStore";
import { Button } from "../ui/button";

/**
 * Explicit opt-in to share a new thread with project members (Puff Collab).
 * Hidden in single-user environments.
 */
export function NewThreadVisibilityToggle(props: {
  environmentId: EnvironmentId;
  threadKey: string;
}) {
  const { members } = useEnvironmentMembers(props.environmentId);
  const visibility = useThreadVisibilityDraftStore(
    (state) => state.byThreadKey[props.threadKey] ?? "private",
  );
  const setVisibility = useThreadVisibilityDraftStore((state) => state.setVisibility);
  if (members.size <= 1) return null;
  const shared = visibility === "shared";
  return (
    <div className="flex justify-end px-1 pt-1.5">
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={shared}
        title={
          shared
            ? "Project members can follow this thread and comment. Only you can instruct the agent."
            : "Only you (and admins) can see this thread."
        }
        onClick={() => setVisibility(props.threadKey, shared ? "private" : "shared")}
      >
        {shared ? <UsersIcon /> : <LockIcon />}
        {shared ? "Shared with project" : "Private"}
      </Button>
    </div>
  );
}
