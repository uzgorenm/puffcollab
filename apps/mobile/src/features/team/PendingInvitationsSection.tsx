import type { EnvironmentId, HubLocalInvitation } from "@t3tools/contracts";
import { View } from "react-native";

import { useEnvironments } from "../../state/environments";
import { hubEnvironment, useHubInvitationGroups } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText } from "./TeamRows";
import { AppText as Text } from "../../components/AppText";

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

/** Team hub invitations waiting for the viewer's answer, in every saved environment. */
export function PendingInvitationsSection() {
  const { environments } = useEnvironments();
  return (
    <View className="px-4">
      {environments.map((environment) => (
        <HubInvitations key={environment.environmentId} environmentId={environment.environmentId} />
      ))}
    </View>
  );
}
