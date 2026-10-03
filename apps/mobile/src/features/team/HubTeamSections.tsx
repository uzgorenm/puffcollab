import {
  hasPendingHubInvitation,
  hubProjectLinkOf,
  hubStatusSummary,
  HUB_URL_PLACEHOLDER,
  isHubLinked,
  parseGithubLoginInput,
  parseHubUrlInput,
} from "@t3tools/client-runtime/state/hub";
import type {
  EnvironmentId,
  HubLinkProjectResult,
  HubLocalStatus,
  HubPendingLink,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { hubEnvironment, useHubInvitationGroups, useHubStatus } from "../../state/hub";
import { useEnvironmentMembers } from "../../state/members";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText, TeamRow } from "./TeamRows";

type Alternatives = HubLinkProjectResult["alternatives"];

function openVerificationUrl(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

function PendingLinkCode(props: {
  readonly environmentId: EnvironmentId;
  readonly pendingLink: HubPendingLink;
  readonly disabled: boolean;
}) {
  const linkCancel = useAtomCommand(hubEnvironment.linkCancel, "Cancel linking");
  return (
    <TeamCardBody divided>
      <TeamMutedText>
        Enter this code on the hub page, signed in with GitHub, to approve this computer.
      </TeamMutedText>
      <Text
        selectable
        className="text-center text-2xl font-t3-medium tracking-widest text-foreground"
      >
        {props.pendingLink.userCode}
      </Text>
      <View className="flex-row justify-end gap-2">
        <TeamPillButton
          label="Cancel"
          disabled={props.disabled}
          onPress={() => void linkCancel({ environmentId: props.environmentId, input: {} })}
        />
        <TeamPillButton
          label="Open hub"
          tone="primary"
          onPress={() => openVerificationUrl(props.pendingLink.verificationUrl)}
        />
      </View>
    </TeamCardBody>
  );
}

function HubUrlEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly status: HubLocalStatus;
  readonly disabled: boolean;
}) {
  const configure = useAtomCommand(hubEnvironment.configure, "Save hub address");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? props.status.hubUrl ?? "";
  const parsed = parseHubUrlInput(value);
  const changed = parsed.ok && parsed.hubUrl !== props.status.hubUrl;

  const save = async () => {
    if (!parsed.ok || !changed) return;
    setBusy(true);
    const result = await configure({
      environmentId: props.environmentId,
      input: { hubUrl: parsed.hubUrl },
    });
    setBusy(false);
    if (result._tag === "Success") setDraft(null);
  };
  const requestSave = () => {
    if (!isHubLinked(props.status)) {
      void save();
      return;
    }
    Alert.alert("Change hub address?", "This computer is unlinked from its current hub.", [
      { text: "Cancel", style: "cancel" },
      { text: "Change", style: "destructive", onPress: () => void save() },
    ]);
  };

  return (
    <TeamCardBody divided>
      <TeamMutedText>
        {!parsed.ok && value.trim() !== ""
          ? parsed.error
          : "Hub address: your team's hosted hub, or one on your network."}
      </TeamMutedText>
      <AppTextInput
        value={value}
        placeholder={HUB_URL_PLACEHOLDER}
        accessibilityLabel="Team hub address"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!props.disabled}
        returnKeyType="done"
        onChangeText={setDraft}
        onSubmitEditing={requestSave}
      />
      {changed ? (
        <View className="flex-row justify-end">
          <TeamPillButton
            label="Save"
            tone="primary"
            disabled={props.disabled}
            loading={busy}
            onPress={requestSave}
          />
        </View>
      ) : null}
    </TeamCardBody>
  );
}

/**
 * The team hub for one environment's server (Stage 7): status, the linked
 * account, the hub address, and the link flow. Linking is host-wide, so only
 * the environment's admins change it.
 */
export function TeamHubSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const status = useHubStatus(props.environmentId);
  const { members, currentMemberId } = useEnvironmentMembers(props.environmentId);
  const linkStart = useAtomCommand(hubEnvironment.linkStart, "Link this computer");
  const unlink = useAtomCommand(hubEnvironment.unlink, "Unlink from team hub");
  const [starting, setStarting] = useState(false);
  if (status === null) return null;
  const viewer = currentMemberId === null ? undefined : members.get(currentMemberId);
  const readOnly = viewer !== undefined && viewer.role !== "admin";
  const summary = hubStatusSummary(status);
  const linked = isHubLinked(status);
  const account = status.account;

  const startLink = async () => {
    setStarting(true);
    const result = await linkStart({ environmentId: props.environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Success") openVerificationUrl(result.value.verificationUrl);
  };
  const requestUnlink = () =>
    Alert.alert(
      "Unlink from the team hub?",
      "Shared threads stop syncing and teammates' threads disappear until you link again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: () => void unlink({ environmentId: props.environmentId, input: {} }),
        },
      ],
    );

  return (
    <SettingsSection title="Team hub">
      <TeamRow
        icon="point.3.connected.trianglepath.dotted"
        title={summary.label}
        detail={summary.detail}
      />
      {readOnly ? (
        <TeamCardBody divided>
          <TeamMutedText>Only admins can change the team hub on this environment.</TeamMutedText>
        </TeamCardBody>
      ) : null}
      {linked && account !== null ? (
        <TeamRow
          divided
          title={account.displayName}
          detail={`@${account.githubLogin}`}
          trailing={
            <View className="flex-row items-center gap-2">
              {account.avatarUrl ? (
                <Image
                  source={{ uri: account.avatarUrl }}
                  style={{ width: 28, height: 28, borderRadius: 14 }}
                  accessibilityIgnoresInvertColors
                />
              ) : null}
              <TeamPillButton label="Unlink" disabled={readOnly} onPress={requestUnlink} />
            </View>
          }
        />
      ) : null}
      {!linked && status.pendingLink !== null ? (
        <PendingLinkCode
          environmentId={props.environmentId}
          pendingLink={status.pendingLink}
          disabled={readOnly}
        />
      ) : null}
      {!linked && status.pendingLink === null && status.hubUrl !== null ? (
        <TeamCardBody divided>
          <View className="flex-row justify-end">
            <TeamPillButton
              label="Link this computer"
              tone="primary"
              disabled={readOnly}
              loading={starting}
              onPress={() => void startLink()}
            />
          </View>
        </TeamCardBody>
      ) : null}
      <HubUrlEditor environmentId={props.environmentId} status={status} disabled={readOnly} />
    </SettingsSection>
  );
}

/** "Link to team hub" for a project: link, join a teammate's hub project, or unlink. */
export function HubProjectLinkSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation = useNavigation();
  const status = useHubStatus(props.environmentId);
  const linkProject = useAtomCommand(hubEnvironment.linkProject, "Link to team hub");
  const unlinkProject = useAtomCommand(hubEnvironment.unlinkProject, "Unlink from team hub");
  const [busy, setBusy] = useState(false);
  const [alternatives, setAlternatives] = useState<Alternatives>([]);
  // Servers without hub support never report a status; keep the screen as before.
  if (status === null) return null;
  const link = hubProjectLinkOf(status, props.projectId);

  if (!isHubLinked(status)) {
    return (
      <SettingsSection title="Team hub">
        <TeamRow
          icon="point.3.connected.trianglepath.dotted"
          title="Set up the team hub"
          detail="Link this computer to your team hub to share threads with teammates."
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: {
                screen: "SettingsEnvironmentDetail",
                params: { environmentId: props.environmentId },
              },
            })
          }
        />
      </SettingsSection>
    );
  }

  const linkTo = async (hubProjectId?: Alternatives[number]["hubProjectId"]) => {
    setBusy(true);
    const result = await linkProject({
      environmentId: props.environmentId,
      input:
        hubProjectId === undefined
          ? { projectId: props.projectId }
          : { projectId: props.projectId, hubProjectId },
    });
    setBusy(false);
    if (result._tag === "Success") setAlternatives(result.value.alternatives);
  };
  const others = alternatives.filter(
    (alternative) => alternative.hubProjectId !== link?.hubProjectId,
  );

  return (
    <SettingsSection title="Team hub">
      {link === null ? (
        <TeamRow
          icon="point.3.connected.trianglepath.dotted"
          title="Link to team hub"
          detail="Teammates who join can follow and comment on this project's shared threads."
          trailing={
            <TeamPillButton
              label="Link"
              tone="primary"
              loading={busy}
              onPress={() => void linkTo()}
            />
          }
        />
      ) : (
        <TeamRow
          icon="point.3.connected.trianglepath.dotted"
          title={link.hubProjectTitle}
          detail="Linked to the team hub."
          trailing={
            <TeamPillButton
              label="Unlink"
              loading={busy}
              onPress={async () => {
                setBusy(true);
                const result = await unlinkProject({
                  environmentId: props.environmentId,
                  input: { projectId: props.projectId },
                });
                setBusy(false);
                if (result._tag === "Success") setAlternatives([]);
              }}
            />
          }
        />
      )}
      {others.map((alternative) => (
        <TeamRow
          key={alternative.hubProjectId}
          divided
          title={alternative.title}
          detail="A teammate's hub project for the same repository."
          trailing={
            <TeamPillButton
              label="Join"
              accessibilityLabel={`Join ${alternative.title}`}
              disabled={busy}
              onPress={() => void linkTo(alternative.hubProjectId)}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

/** Invite by GitHub login into a hub-linked project, and cancel pending invitations. */
export function HubProjectPeopleSections(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const status = useHubStatus(props.environmentId);
  const groups = useHubInvitationGroups(props.environmentId);
  const invite = useAtomCommand(hubEnvironment.invite, "Invite");
  const cancel = useAtomCommand(hubEnvironment.cancelInvitation, "Cancel invitation");
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const link = hubProjectLinkOf(status, props.projectId);
  if (link === null) {
    return (
      <>
        <TeamMutedText>Link this project to the team hub to invite people.</TeamMutedText>
        <HubProjectLinkSection environmentId={props.environmentId} projectId={props.projectId} />
      </>
    );
  }
  const outgoing = groups.outgoingByProject.get(link.hubProjectId) ?? [];
  const parsed = parseGithubLoginInput(login);
  const alreadyInvited = parsed !== null && hasPendingHubInvitation(outgoing, parsed);

  const send = async () => {
    if (parsed === null || alreadyInvited) return;
    setBusy(true);
    const result = await invite({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, githubLogin: parsed },
    });
    setBusy(false);
    if (result._tag === "Success") setLogin("");
  };

  return (
    <>
      <SettingsSection title="Invite by GitHub login">
        <TeamCardBody>
          <TeamMutedText>
            {alreadyInvited
              ? "Already invited."
              : "They accept from their own Puff Collab once they sign in to the hub with GitHub."}
          </TeamMutedText>
          <AppTextInput
            value={login}
            placeholder="github-login"
            accessibilityLabel="GitHub login"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onChangeText={setLogin}
            onSubmitEditing={() => void send()}
          />
          <View className="flex-row justify-end">
            <TeamPillButton
              label="Invite"
              tone="primary"
              disabled={parsed === null || alreadyInvited}
              loading={busy}
              onPress={() => void send()}
            />
          </View>
        </TeamCardBody>
      </SettingsSection>
      {outgoing.length > 0 ? (
        <SettingsSection title="Pending invitations">
          {outgoing.map((invitation, index) => (
            <TeamRow
              key={invitation.invitationId}
              divided={index > 0}
              icon="person.crop.circle"
              title={`@${invitation.inviteeLogin}`}
              detail="Invited"
              trailing={
                <TeamPillButton
                  label="Cancel"
                  onPress={() =>
                    void cancel({
                      environmentId: props.environmentId,
                      input: { invitationId: invitation.invitationId },
                    })
                  }
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      <HubProjectLinkSection environmentId={props.environmentId} projectId={props.projectId} />
    </>
  );
}
