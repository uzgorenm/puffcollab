import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  hubTeamMemberName,
  TEAM_WORK_CARD_STATUS_LABELS,
} from "@t3tools/client-runtime/state/team-overview";
import {
  EnvironmentId,
  type HubLocalTeam,
  PROJECT_BRIEF_MAX_LENGTH,
  PROJECT_MEMBER_FOCUS_MAX_LENGTH,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { relativeTime } from "../../lib/time";
import { useProject } from "../../state/entities";
import { hubEnvironment, useHubProjectLink, useHubStatus, useHubTeam } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HubProjectLinkSection } from "./HubTeamSections";
import { briefChangedSinceDraft, isHubConflict, teamActivityLine } from "./team-presentation";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText, TeamRow } from "./TeamRows";

type TeamOverviewRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

/**
 * The team view of a hub-linked project (Puff Collab): the shared brief,
 * everyone's focus, a work card per shared thread with its analysis summary,
 * and recent activity, all from the team hub. A project that is not on the
 * hub shows how to link it instead.
 */
export function TeamOverviewRouteScreen(props: TeamOverviewRouteProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const project = useProject(
    useMemo(() => scopeProjectRef(environmentId, projectId), [environmentId, projectId]),
  );
  const status = useHubStatus(environmentId);
  const link = useHubProjectLink(environmentId, projectId);
  const team = useHubTeam(environmentId, projectId);
  const openThread = useCallback(
    (threadId: ThreadId) =>
      navigation.dispatch(
        StackActions.push("Thread", { environmentId: String(environmentId), threadId }),
      ),
    [environmentId, navigation],
  );

  return (
    <SettingsScreen title={project ? `${project.title} · Team` : "Team overview"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {link === null ? (
          <>
            <TeamMutedText>
              Team overview shows the brief, focus, shared work and activity of a project you share
              with teammates on the team hub.
            </TeamMutedText>
            <HubProjectLinkSection environmentId={environmentId} projectId={projectId} />
          </>
        ) : team === null ? (
          status?.state === "online" ? (
            <ActivityIndicator />
          ) : (
            <TeamMutedText>
              Team overview appears once this computer reaches the team hub.
            </TeamMutedText>
          )
        ) : (
          <>
            <BriefSection environmentId={environmentId} team={team} />
            <FocusSection environmentId={environmentId} team={team} />
            <SettingsSection title="Work">
              {team.workCards.length === 0 ? (
                <TeamCardBody>
                  <TeamMutedText>
                    No shared threads yet. Shared threads from you and your teammates show up here.
                  </TeamMutedText>
                </TeamCardBody>
              ) : (
                team.workCards.map((card, index) => (
                  <TeamRow
                    key={card.hubThreadId}
                    divided={index > 0}
                    title={card.title}
                    detail={[
                      `${TEAM_WORK_CARD_STATUS_LABELS[card.status]} · ${hubTeamMemberName(team, card.ownerId)} · ${relativeTime(card.lastActivityAt)}${card.branch ? ` · ${card.branch}` : ""}`,
                      card.analysis?.summary ?? null,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                    onPress={() => openThread(card.threadId)}
                  />
                ))
              )}
            </SettingsSection>
            <ActivitySection team={team} onOpenThread={openThread} />
            <SettingsSection title="People">
              <TeamRow
                icon="person.badge.plus"
                title={`${team.members.length} ${team.members.length === 1 ? "member" : "members"}`}
                detail="Members, invitations by GitHub login, and leaving the project."
                onPress={() =>
                  navigation.navigate("ProjectPeople", {
                    environmentId: String(environmentId),
                    projectId: String(projectId),
                  })
                }
              />
            </SettingsSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function BriefSection(props: {
  readonly environmentId: EnvironmentId;
  readonly team: HubLocalTeam;
}) {
  const { team } = props;
  const brief = team.brief;
  const updateBrief = useAtomCommand(hubEnvironment.updateBrief, {
    label: "Save project brief",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<{ text: string; baseVersion: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const staleDraft = draft !== null && briefChangedSinceDraft(draft.baseVersion, brief);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await updateBrief({
      environmentId: props.environmentId,
      input: {
        projectId: team.projectId,
        text: draft.text.trim(),
        expectedVersion: draft.baseVersion,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      return;
    }
    Alert.alert(
      isHubConflict(result.cause) ? "Someone saved the brief first" : "Could not save",
      isHubConflict(result.cause)
        ? "Your draft is kept. Review their version, then edit again to save on top of it."
        : "Your draft is kept. Try again.",
    );
  };

  return (
    <SettingsSection title="Project brief">
      {draft === null ? (
        <TeamCardBody>
          {brief && brief.text.length > 0 ? (
            <Text className="text-sm text-foreground" selectable>
              {brief.text}
            </Text>
          ) : (
            <TeamMutedText>
              No brief yet. Describe what the team is building and what matters right now.
            </TeamMutedText>
          )}
          {brief ? (
            <Text className="text-xs text-foreground-muted">
              {`Version ${brief.version} by ${hubTeamMemberName(team, brief.authorId)}, ${relativeTime(brief.createdAt)}`}
            </Text>
          ) : null}
          <View className="flex-row justify-end gap-2 pt-1">
            <TeamPillButton
              label="Edit"
              onPress={() =>
                setDraft({ text: brief?.text ?? "", baseVersion: brief?.version ?? null })
              }
            />
          </View>
        </TeamCardBody>
      ) : (
        <TeamCardBody>
          {staleDraft ? (
            <Text className="text-xs text-warning-foreground">
              {`Conflict: ${hubTeamMemberName(team, brief?.authorId ?? null)} saved a newer version while you were editing. Saving now will be refused; cancel to see it.`}
            </Text>
          ) : null}
          <AppTextInput
            multiline
            className="min-h-40"
            textAlignVertical="top"
            value={draft.text}
            maxLength={PROJECT_BRIEF_MAX_LENGTH}
            accessibilityLabel="Project brief"
            onChangeText={(text) => setDraft({ ...draft, text })}
          />
          <View className="flex-row justify-end gap-2">
            <TeamPillButton label="Cancel" disabled={saving} onPress={() => setDraft(null)} />
            <TeamPillButton
              label="Save"
              tone="primary"
              loading={saving}
              onPress={() => void save()}
            />
          </View>
        </TeamCardBody>
      )}
    </SettingsSection>
  );
}

function FocusSection(props: {
  readonly environmentId: EnvironmentId;
  readonly team: HubLocalTeam;
}) {
  const { team } = props;
  const setFocus = useAtomCommand(hubEnvironment.setFocus, "Update your focus");
  const own = team.focuses.find((focus) => focus.accountId === team.viewerAccountId) ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? own?.focus ?? "";
  const others = team.focuses.filter((focus) => focus.accountId !== team.viewerAccountId);

  const submit = async (focus: string | null) => {
    setSaving(true);
    const result = await setFocus({
      environmentId: props.environmentId,
      input: { projectId: team.projectId, focus },
    });
    setSaving(false);
    if (result._tag === "Success") setDraft(null);
  };

  return (
    <SettingsSection title="Current focus">
      <TeamCardBody>
        <AppTextInput
          value={value}
          maxLength={PROJECT_MEMBER_FOCUS_MAX_LENGTH}
          placeholder="What are you working on?"
          accessibilityLabel="Your current focus"
          returnKeyType="done"
          onChangeText={setDraft}
          onSubmitEditing={() => {
            if (value.trim()) void submit(value.trim());
          }}
        />
        <View className="flex-row justify-end gap-2">
          {own ? (
            <TeamPillButton label="Clear" disabled={saving} onPress={() => void submit(null)} />
          ) : null}
          <TeamPillButton
            label="Set"
            tone="primary"
            disabled={draft === null || !value.trim()}
            loading={saving}
            onPress={() => void submit(value.trim())}
          />
        </View>
      </TeamCardBody>
      {others.map((focus) => (
        <TeamRow
          key={focus.accountId}
          divided
          title={focus.focus}
          detail={`${hubTeamMemberName(team, focus.accountId)} · ${relativeTime(focus.updatedAt)}`}
        />
      ))}
    </SettingsSection>
  );
}

function ActivitySection(props: {
  readonly team: HubLocalTeam;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { team } = props;
  const threadTitles = useMemo(
    () => new Map<string, string>(team.workCards.map((card) => [card.threadId, card.title])),
    [team.workCards],
  );
  return (
    <SettingsSection title="Activity">
      {team.activity.length === 0 ? (
        <TeamCardBody>
          <TeamMutedText>No recent activity.</TeamMutedText>
        </TeamCardBody>
      ) : (
        team.activity.map((item, index) => {
          const threadTitle = item.threadId ? threadTitles.get(item.threadId) : undefined;
          const threadId = item.threadId;
          return (
            <TeamRow
              key={item.id}
              divided={index > 0}
              title={`${teamActivityLine(item, team)}${threadTitle ? ` in ${threadTitle}` : ""}`}
              detail={[
                relativeTime(item.occurredAt),
                item.detail && item.kind !== "thread-created" ? item.detail : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {...(threadId && threadTitle ? { onPress: () => props.onOpenThread(threadId) } : {})}
            />
          );
        })
      )}
    </SettingsSection>
  );
}
