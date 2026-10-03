import type { EnvironmentId, ProjectInvitation } from "@t3tools/contracts";
import { memo } from "react";

import { useEnvironments } from "../../state/environments";
import {
  memberEnvironment,
  useEnvironmentMembers,
  useMyProjectInvitations,
} from "../../state/members";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

function InvitationNotice({
  environmentId,
  invitation,
  inviterName,
}: {
  environmentId: EnvironmentId;
  invitation: ProjectInvitation;
  inviterName: string;
}) {
  const accept = useAtomCommand(memberEnvironment.acceptInvitation);
  const decline = useAtomCommand(memberEnvironment.declineInvitation);
  const input = { environmentId, input: { invitationId: invitation.invitationId } };
  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        <span>
          {inviterName} invited you to <strong>{invitation.projectTitle || "a project"}</strong>.
        </span>
        <span className="flex gap-1 pt-1">
          <Button size="xs" onClick={() => void accept(input)}>
            Accept
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => void decline(input)}>
            Decline
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function EnvironmentInvitations({ environmentId }: { environmentId: EnvironmentId }) {
  const invitations = useMyProjectInvitations(environmentId);
  const { members } = useEnvironmentMembers(environmentId);
  return invitations.map((invitation) => (
    <InvitationNotice
      key={invitation.invitationId}
      environmentId={environmentId}
      invitation={invitation}
      inviterName={members.get(invitation.inviterId)?.displayName ?? "A teammate"}
    />
  ));
}

/** Project invitations waiting for the viewer's answer, in every connected environment. */
export const SidebarProjectInvitations = memo(function SidebarProjectInvitations() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentInvitations
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
});
