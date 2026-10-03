import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentMembers } from "../../state/members";
import { Alert, AlertDescription } from "../ui/alert";

/**
 * Tells a team member why host-wide settings on this environment refuse their
 * changes. Hidden for admins (the owner always is one) and on single-user
 * servers, and until the roster has loaded so admins never see it flash.
 */
export function AdminOnlySettingsNotice({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  const viewer = currentMemberId === null ? undefined : members.get(currentMemberId);
  if (viewer === undefined || viewer.role === "admin") return null;
  return (
    <Alert>
      <AlertDescription>
        Only admins can change these settings on this environment. You can still use what an admin
        has set up.
      </AlertDescription>
    </Alert>
  );
}
