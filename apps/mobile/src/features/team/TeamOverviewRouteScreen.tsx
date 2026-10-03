import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  appendOlderTeamActivity,
  deriveTeamWorkCards,
  TEAM_WORK_CARD_STATUS_LABELS,
  type TeamOverviewState,
} from "@t3tools/client-runtime/state/team-overview";
import {
  EnvironmentId,
  PROJECT_BRIEF_MAX_LENGTH,
  PROJECT_MEMBER_FOCUS_MAX_LENGTH,
  ProjectId,
  type TeamActivityPageResult,
  type ThreadId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { relativeTime } from "../../lib/time";
import { useCooperationProjectSummaries } from "../../state/cooperation";
import { useProject, useThreadShells } from "../../state/entities";
import { type EnvironmentMembers, useEnvironmentMembers } from "../../state/members";
import { useEnvironmentQuery } from "../../state/query";
import { teamOverviewEnvironment, useTeamOverview } from "../../state/team-overview";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  briefChangedSinceDraft,
  isTeamOverviewConflict,
  teamActivityLine,
  teamMemberName,
  teamRosterRows,
} from "./team-presentation";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText, TeamRow } from "./TeamRows";

type TeamOverviewRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

/**
 * The team view of one project (Puff Collab): the shared brief, everyone's
 * focus, a work card per visible thread with its analysis summary, recent
 * activity, and the team roster. Adding environment members stays on web and desktop;
 * project invitations open from here.
 */
export function TeamOverviewRouteScreen(props: TeamOverviewRouteProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const project = useProject(
    useMemo(() => scopeProjectRef(environmentId, projectId), [environmentId, projectId]),
  );
  const shells = useThreadShells();
  const roster = useEnvironmentMembers(environmentId);
  const { overview, error } = useTeamOverview({ environmentId, projectId });
  const analysisByThreadId = useCooperationProjectSummaries(environmentId, projectId);
  const projectThreads = useMemo(
    () =>
      shells.filter(
        (shell) => shell.environmentId === environmentId && shell.projectId === projectId,
      ),
    [environmentId, projectId, shells],
  );
  const cards = useMemo(
    () =>
      roster.currentMemberId === null
        ? []
        : deriveTeamWorkCards({
            threads: projectThreads,
            projectId,
            memberId: roster.currentMemberId,
            analysisByThreadId,
          }),
    [analysisByThreadId, projectId, projectThreads, roster.currentMemberId],
  );
  const threadTitles = useMemo(
    () => new Map<string, string>(projectThreads.map((thread) => [thread.id, thread.title])),
    [projectThreads],
  );
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
        {overview === null ? (
          error ? (
            <Text className="text-sm text-danger-foreground">{error}</Text>
          ) : (
            <ActivityIndicator />
          )
        ) : (
          <>
            <BriefSection environmentId={environmentId} overview={overview} roster={roster} />
            <FocusSection environmentId={environmentId} overview={overview} roster={roster} />
            <SettingsSection title="Work">
              {cards.length === 0 ? (
                <TeamCardBody>
                  <TeamMutedText>
                    No shared threads yet. Threads you own and threads teammates share show up here.
                  </TeamMutedText>
                </TeamCardBody>
              ) : (
                cards.map((card, index) => (
                  <TeamRow
                    key={card.threadId}
                    divided={index > 0}
                    title={card.title}
                    detail={[
                      `${TEAM_WORK_CARD_STATUS_LABELS[card.status]} · ${teamMemberName(roster.members, card.ownerId, roster.currentMemberId)} · ${relativeTime(card.lastActivityAt)}${card.branch ? ` · ${card.branch}` : ""}`,
                      card.analysis?.summary ?? null,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                    onPress={() => openThread(card.threadId)}
                  />
                ))
              )}
            </SettingsSection>
            <ActivitySection
              environmentId={environmentId}
              overview={overview}
              roster={roster}
              threadTitles={threadTitles}
              onOpenThread={openThread}
            />
            <SettingsSection title="Team members">
              {teamRosterRows(roster.members, roster.currentMemberId).map((row, index) => (
                <TeamRow
                  key={row.memberId}
                  divided={index > 0}
                  icon="person.crop.circle"
                  title={row.name}
                  detail={row.detail}
                />
              ))}
              <TeamRow
                divided
                icon="person.badge.plus"
                title="Invite people"
                detail="Who is in this project, invitations, and leaving it."
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
  readonly overview: TeamOverviewState;
  readonly roster: EnvironmentMembers;
}) {
  const { overview, roster } = props;
  const brief = overview.brief;
  const updateBrief = useAtomCommand(teamOverviewEnvironment.updateBrief, {
    label: "Save project brief",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<{ text: string; baseVersion: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const staleDraft = draft !== null && briefChangedSinceDraft(draft.baseVersion, brief);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await updateBrief({
      environmentId: props.environmentId,
      input: {
        projectId: overview.projectId,
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
      isTeamOverviewConflict(result.cause) ? "Someone saved the brief first" : "Could not save",
      isTeamOverviewConflict(result.cause)
        ? "Your draft is kept. Review their version, then edit again to save on top of it."
        : "Your draft is kept. Try again.",
    );
  };

  return (
    <SettingsSection title="Project brief">
      {draft === null ? (
        <>
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
                {`Version ${brief.version} by ${teamMemberName(roster.members, brief.authorId, roster.currentMemberId)}, ${relativeTime(brief.createdAt)}`}
              </Text>
            ) : null}
            <View className="flex-row justify-end gap-2 pt-1">
              {brief && brief.version > 1 ? (
                <TeamPillButton
                  label={showHistory ? "Hide history" : "History"}
                  onPress={() => setShowHistory((open) => !open)}
                />
              ) : null}
              <TeamPillButton
                label="Edit"
                onPress={() =>
                  setDraft({ text: brief?.text ?? "", baseVersion: brief?.version ?? null })
                }
              />
            </View>
          </TeamCardBody>
          {showHistory && brief ? (
            <BriefHistory
              environmentId={props.environmentId}
              projectId={overview.projectId}
              beforeVersion={brief.version}
              roster={roster}
            />
          ) : null}
        </>
      ) : (
        <TeamCardBody>
          {staleDraft ? (
            <Text className="text-xs text-warning-foreground">
              {`Conflict: ${teamMemberName(roster.members, brief?.authorId ?? null, roster.currentMemberId)} saved a newer version while you were editing. Saving now will be refused; cancel to see it.`}
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

function BriefHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly beforeVersion: number;
  readonly roster: EnvironmentMembers;
}) {
  const history = useEnvironmentQuery(
    teamOverviewEnvironment.briefHistory({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, beforeVersion: props.beforeVersion, limit: 20 },
    }),
  ).data;
  if (history === null) {
    return (
      <TeamCardBody divided>
        <ActivityIndicator />
      </TeamCardBody>
    );
  }
  return history.versions.map((version) => (
    <TeamCardBody key={version.version} divided>
      <Text className="text-xs text-foreground-muted">
        {`Version ${version.version} by ${teamMemberName(props.roster.members, version.authorId, props.roster.currentMemberId)}, ${relativeTime(version.createdAt)}`}
      </Text>
      <Text className="text-sm text-foreground" selectable>
        {version.text || "(empty)"}
      </Text>
    </TeamCardBody>
  ));
}

function FocusSection(props: {
  readonly environmentId: EnvironmentId;
  readonly overview: TeamOverviewState;
  readonly roster: EnvironmentMembers;
}) {
  const { overview, roster } = props;
  const setFocus = useAtomCommand(teamOverviewEnvironment.setFocus, "Update your focus");
  const own = overview.focuses.find((focus) => focus.memberId === roster.currentMemberId) ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? own?.focus ?? "";
  const others = overview.focuses.filter((focus) => focus.memberId !== roster.currentMemberId);

  const submit = async (focus: string | null) => {
    setSaving(true);
    const result = await setFocus({
      environmentId: props.environmentId,
      input: { projectId: overview.projectId, focus },
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
          key={focus.memberId}
          divided
          title={focus.focus}
          detail={`${teamMemberName(roster.members, focus.memberId, roster.currentMemberId)} · ${relativeTime(focus.updatedAt)}`}
        />
      ))}
    </SettingsSection>
  );
}

function ActivitySection(props: {
  readonly environmentId: EnvironmentId;
  readonly overview: TeamOverviewState;
  readonly roster: EnvironmentMembers;
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { roster } = props;
  const loadPage = useAtomCommand(teamOverviewEnvironment.activityPage, "Load older activity");
  const [older, setOlder] = useState<TeamActivityPageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const view = older === null ? props.overview : appendOlderTeamActivity(props.overview, older);
  const nextBeforeSequence = view.activityNextBeforeSequence;

  const loadOlder = async () => {
    if (nextBeforeSequence === null) return;
    setLoading(true);
    const result = await loadPage({
      environmentId: props.environmentId,
      input: {
        projectId: props.overview.projectId,
        beforeSequence: nextBeforeSequence,
        limit: 30,
      },
    });
    setLoading(false);
    if (result._tag === "Success") {
      const page = result.value;
      setOlder((previous) => ({
        items: [...(previous?.items ?? []), ...page.items],
        nextBeforeSequence: page.nextBeforeSequence,
      }));
    }
  };

  return (
    <SettingsSection title="Activity">
      {view.activity.length === 0 ? (
        <TeamCardBody>
          <TeamMutedText>No recent activity.</TeamMutedText>
        </TeamCardBody>
      ) : (
        view.activity.map((item, index) => {
          const threadTitle = item.threadId ? props.threadTitles.get(item.threadId) : undefined;
          const threadId = item.threadId;
          return (
            <TeamRow
              key={item.id}
              divided={index > 0}
              title={`${teamActivityLine(item, roster.members, roster.currentMemberId)}${threadTitle ? ` in ${threadTitle}` : ""}`}
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
      {nextBeforeSequence !== null ? (
        <TeamCardBody divided>
          <View className="flex-row">
            <TeamPillButton label="Load older" loading={loading} onPress={() => void loadOlder()} />
          </View>
        </TeamCardBody>
      ) : null}
    </SettingsSection>
  );
}
