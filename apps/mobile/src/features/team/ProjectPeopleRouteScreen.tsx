import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  canCancelInvitation,
  canRemoveProjectMember,
  invitableMembers,
  memberSignInUrl,
} from "@t3tools/client-runtime/state/members";
import {
  EnvironmentId,
  type MemberId,
  ProjectId,
  type ProjectInvitation,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useProject } from "../../state/entities";
import {
  memberEnvironment,
  useEnvironmentMembers,
  useIsEnvironmentAdmin,
} from "../../state/members";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { teamMemberName } from "./team-presentation";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText, TeamRow } from "./TeamRows";

type ProjectPeopleRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

const STATE_LABELS: Record<ProjectInvitation["state"], string> = {
  pending: "Invited",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

/**
 * One project's people (Puff Collab): members with Leave and Remove,
 * invitations with Cancel and Invite again, and inviting a teammate or
 * someone new, whose one-time sign-in link is shared from here.
 */
export function ProjectPeopleRouteScreen(props: ProjectPeopleRouteProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const project = useProject(
    useMemo(() => scopeProjectRef(environmentId, projectId), [environmentId, projectId]),
  );
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  const viewerIsAdmin = useIsEnvironmentAdmin(environmentId);
  const projectMembers = useEnvironmentQuery(
    memberEnvironment.projectMembers({ environmentId, input: { projectId } }),
  ).data;
  const invitations =
    useEnvironmentQuery(
      memberEnvironment.projectInvitations({ environmentId, input: { projectId } }),
    ).data?.invitations ?? [];
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;

  const invite = useAtomCommand(memberEnvironment.invite, "Invite");
  const cancel = useAtomCommand(memberEnvironment.cancelInvitation, "Cancel invitation");
  const leave = useAtomCommand(memberEnvironment.leaveProject, "Leave project");
  const remove = useAtomCommand(memberEnvironment.removeProjectMember, "Remove from project");
  const [newName, setNewName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [signIn, setSignIn] = useState<{ readonly name: string; readonly value: string } | null>(
    null,
  );

  const memberIds = projectMembers?.memberIds ?? [];
  const viewerInProject =
    viewerIsAdmin || (currentMemberId !== null && memberIds.includes(currentMemberId));
  const candidates = invitableMembers({
    members,
    projectMemberIds: memberIds,
    invitations,
    viewerId: currentMemberId,
  });
  const shown = invitations.filter(
    (invitation, index) =>
      invitation.state === "pending" ||
      (invitation.state !== "accepted" &&
        invitations.findIndex((other) => other.inviteeId === invitation.inviteeId) === index),
  );
  const nameOf = (memberId: MemberId) => teamMemberName(members, memberId, currentMemberId);

  const inviteNewPerson = async () => {
    const name = newName.trim();
    if (!name) return;
    setInviting(true);
    const result = await invite({
      environmentId,
      input: { projectId, newPerson: { displayName: name } },
    });
    setInviting(false);
    if (result._tag === "Success" && result.value.signIn !== undefined) {
      const credential = result.value.signIn.credential;
      setSignIn({ name, value: memberSignInUrl(httpBaseUrl, credential) ?? credential });
      setNewName("");
    }
  };

  return (
    <SettingsScreen
      title={project ? `People · ${project.title}` : "People"}
      formSheet={Platform.OS === "ios"}
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!viewerInProject ? (
          <TeamMutedText>You are not a member of this project.</TeamMutedText>
        ) : (
          <>
            <SettingsSection title="Members">
              {memberIds.length === 0 ? (
                <TeamCardBody>
                  <TeamMutedText>Admins see every project.</TeamMutedText>
                </TeamCardBody>
              ) : (
                memberIds.map((memberId, index) => (
                  <TeamRow
                    key={memberId}
                    divided={index > 0}
                    icon="person.crop.circle"
                    title={nameOf(memberId)}
                    detail={memberId === projectMembers?.creatorId ? "Created the project" : null}
                    trailing={
                      memberId === currentMemberId ? (
                        <TeamPillButton
                          label="Leave"
                          onPress={async () => {
                            const result = await leave({ environmentId, input: { projectId } });
                            if (result._tag === "Success" && !viewerIsAdmin) navigation.goBack();
                          }}
                        />
                      ) : canRemoveProjectMember({
                          projectMembers,
                          viewerId: currentMemberId,
                          viewerIsAdmin,
                          targetId: memberId,
                        }) ? (
                        <TeamPillButton
                          label="Remove"
                          onPress={() =>
                            void remove({ environmentId, input: { projectId, memberId } })
                          }
                        />
                      ) : null
                    }
                  />
                ))
              )}
            </SettingsSection>

            {shown.length > 0 ? (
              <SettingsSection title="Invitations">
                {shown.map((invitation, index) => {
                  const canReinvite =
                    invitation.state !== "pending" &&
                    candidates.some((member) => member.memberId === invitation.inviteeId);
                  return (
                    <TeamRow
                      key={invitation.invitationId}
                      divided={index > 0}
                      title={nameOf(invitation.inviteeId)}
                      detail={`${STATE_LABELS[invitation.state]} by ${nameOf(invitation.inviterId)}${members.get(invitation.inviteeId)?.pending === true ? " · has not signed in yet" : ""}`}
                      trailing={
                        canCancelInvitation({
                          invitation,
                          viewerId: currentMemberId,
                          viewerInProject,
                        }) ? (
                          <TeamPillButton
                            label="Cancel"
                            onPress={() =>
                              void cancel({
                                environmentId,
                                input: { invitationId: invitation.invitationId },
                              })
                            }
                          />
                        ) : canReinvite ? (
                          <TeamPillButton
                            label="Invite again"
                            onPress={() =>
                              void invite({
                                environmentId,
                                input: { projectId, memberId: invitation.inviteeId },
                              })
                            }
                          />
                        ) : null
                      }
                    />
                  );
                })}
              </SettingsSection>
            ) : null}

            <SettingsSection title="Invite people">
              {candidates.map((member, index) => (
                <TeamRow
                  key={member.memberId}
                  divided={index > 0}
                  icon="person.badge.plus"
                  title={member.displayName}
                  detail={`@${member.username}`}
                  trailing={
                    <TeamPillButton
                      label="Invite"
                      onPress={() =>
                        void invite({
                          environmentId,
                          input: { projectId, memberId: member.memberId },
                        })
                      }
                    />
                  }
                />
              ))}
              <TeamCardBody divided={candidates.length > 0}>
                <TeamMutedText>
                  Someone new gets a member account and a one-time sign-in link. They join once they
                  accept.
                </TeamMutedText>
                <AppTextInput
                  value={newName}
                  placeholder="Their name"
                  accessibilityLabel="New person's name"
                  returnKeyType="done"
                  onChangeText={setNewName}
                  onSubmitEditing={() => void inviteNewPerson()}
                />
                <View className="flex-row justify-end">
                  <TeamPillButton
                    label="Invite"
                    tone="primary"
                    disabled={!newName.trim()}
                    loading={inviting}
                    onPress={() => void inviteNewPerson()}
                  />
                </View>
                {signIn ? (
                  <>
                    <Text className="text-sm text-foreground" selectable>
                      {signIn.value}
                    </Text>
                    <TeamMutedText>
                      {`Send ${signIn.name} this sign-in link. One use, expires in 24 hours.`}
                    </TeamMutedText>
                    <View className="flex-row justify-end">
                      <TeamPillButton
                        label="Share link"
                        onPress={() => void Share.share({ message: signIn.value })}
                      />
                    </View>
                  </>
                ) : null}
              </TeamCardBody>
            </SettingsSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
