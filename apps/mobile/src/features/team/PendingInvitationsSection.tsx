import type { EnvironmentId, HubLocalInvitation, ProjectInvitation } from "@t3tools/contracts";
import { View } from "react-native";

import { useEnvironments } from "../../state/environments";
import { hubEnvironment, useHubInvitationGroups, useIsHubLinked } from "../../state/hub";
import {
  memberEnvironment,
  useEnvironmentMembers,
  useMyProjectInvitations,
} from "../../state/members";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText } from "./TeamRows";
import { AppText as Text } from "../../components/AppText";

function InvitationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly invitation: ProjectInvitation;
  readonly inviterName: string;
  readonly divided: boolean;
}) {
  const accept = useAtomCommand(memberEnvironment.acceptInvitation, "Accept invitation");
  const decline = useAtomCommand(memberEnvironment.declineInvitation, "Decline invitation");
  const input = {
    environmentId: props.environmentId,
    input: { invitationId: props.invitation.invitationId },
  };
  return (
    <TeamCardBody divided={props.divided}>
      <Text className="text-base text-foreground">
        {props.invitation.projectTitle || "A project"}
      </Text>
      <TeamMutedText>{`${props.inviterName} invited you to work on this project.`}</TeamMutedText>
      <View className="flex-row justify-end gap-2">
        <TeamPillButton label="Decline" onPress={() => void decline(input)} />
        <TeamPillButton label="Accept" tone="primary" onPress={() => void accept(input)} />
      </View>
    </TeamCardBody>
  );
}

function HubInvitationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly invitation: HubLocalInvitation;
  readonly divided: boolean;
}) {
  const respond = useAtomCommand(hubEnvironment.respondInvitation, "Answer invitation");
  const answer = (decision: "accept" | "decline") =>
    void respond({
      environmentId: props.environmentId,
      input: { invitationId: props.invitation.invitationId, decision },
    });
  return (
    <TeamCardBody divided={props.divided}>
      <Text className="text-base text-foreground">{props.invitation.projectTitle}</Text>
      <TeamMutedText>{`@${props.invitation.inviterLogin} invited you to this project on the team hub.`}</TeamMutedText>
      <View className="flex-row justify-end gap-2">
        <TeamPillButton label="Decline" onPress={() => answer("decline")} />
        <TeamPillButton label="Accept" tone="primary" onPress={() => answer("accept")} />
      </View>
    </TeamCardBody>
  );
}

function HubInvitations(props: { readonly environmentId: EnvironmentId }) {
  const { incoming } = useHubInvitationGroups(props.environmentId);
  if (incoming.length === 0) return null;
  return (
    <View className="pb-3">
      <SettingsSection title="Team hub invitations">
        {incoming.map((invitation, index) => (
          <HubInvitationRow
            key={invitation.invitationId}
            environmentId={props.environmentId}
            invitation={invitation}
            divided={index > 0}
          />
        ))}
      </SettingsSection>
    </View>
  );
}

// Team hub invitations replace the environment's own once it is linked to a hub.
function EnvironmentInvitations(props: { readonly environmentId: EnvironmentId }) {
  const hubLinked = useIsHubLinked(props.environmentId);
  return hubLinked ? (
    <HubInvitations environmentId={props.environmentId} />
  ) : (
    <LocalInvitations environmentId={props.environmentId} />
  );
}

function LocalInvitations(props: { readonly environmentId: EnvironmentId }) {
  const invitations = useMyProjectInvitations(props.environmentId);
  const { members } = useEnvironmentMembers(props.environmentId);
  if (invitations.length === 0) return null;
  return (
    <View className="pb-3">
      <SettingsSection title="Project invitations">
        {invitations.map((invitation, index) => (
          <InvitationRow
            key={invitation.invitationId}
            environmentId={props.environmentId}
            invitation={invitation}
            inviterName={members.get(invitation.inviterId)?.displayName ?? "A teammate"}
            divided={index > 0}
          />
        ))}
      </SettingsSection>
    </View>
  );
}

/** Project invitations waiting for the viewer's answer, in every saved environment. */
export function PendingInvitationsSection() {
  const { environments } = useEnvironments();
  return (
    <View className="px-4">
      {environments.map((environment) => (
        <EnvironmentInvitations
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </View>
  );
}
