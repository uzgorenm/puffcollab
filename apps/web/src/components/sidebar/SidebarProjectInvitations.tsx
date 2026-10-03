import type { EnvironmentId, HubLocalInvitation } from "@t3tools/contracts";
import { memo } from "react";

import { useEnvironments } from "../../state/environments";
import { hubEnvironment, useHubInvitationGroups } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

function HubInvitationNotice({
  environmentId,
  invitation,
}: {
  environmentId: EnvironmentId;
  invitation: HubLocalInvitation;
}) {
  const respond = useAtomCommand(hubEnvironment.respondInvitation);
  const answer = (decision: "accept" | "decline") =>
    void respond({ environmentId, input: { invitationId: invitation.invitationId, decision } });
  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        <span>
          @{invitation.inviterLogin} invited you to <strong>{invitation.projectTitle}</strong> on
          the team hub.
        </span>
        <span className="flex gap-1 pt-1">
          <Button size="xs" onClick={() => answer("accept")}>
            Accept
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => answer("decline")}>
            Decline
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function HubInvitations({ environmentId }: { environmentId: EnvironmentId }) {
  const { incoming } = useHubInvitationGroups(environmentId);
  return incoming.map((invitation) => (
    <HubInvitationNotice
      key={invitation.invitationId}
      environmentId={environmentId}
      invitation={invitation}
    />
  ));
}

/** Team hub invitations waiting for the viewer's answer, in every connected environment. */
export const SidebarProjectInvitations = memo(function SidebarProjectInvitations() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <HubInvitations key={environment.environmentId} environmentId={environment.environmentId} />
  ));
});
