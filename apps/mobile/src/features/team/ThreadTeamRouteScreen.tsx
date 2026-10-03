import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ThreadVisibility } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useCooperationInboxForThread } from "../../state/cooperation";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentMembers } from "../../state/members";
import { threadCollaborationView } from "../../state/thread-collaboration";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { CooperationInboxSection, CooperationSection } from "./CooperationSection";
import { RelatedThreadsSection } from "./RelatedThreadsSection";
import { followingThreadNotice } from "./team-presentation";
import { TeamCardBody, TeamRow } from "./TeamRows";

type ThreadTeamRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * A thread's team details (Puff Collab): sharing, related threads,
 * cooperation analysis, the owner's awareness inbox, and the way to the
 * project's team overview. Reached from the thread header's Team button.
 */
export function ThreadTeamRouteScreen(props: ThreadTeamRouteProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const shell = useThreadShell(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  );
  // Shares the thread screen's subscription; this route sits on top of it.
  const detail = Option.getOrNull(useEnvironmentThread(environmentId, threadId).data);
  const roster = useEnvironmentMembers(environmentId);
  const collaboration = useMemo(
    () =>
      threadCollaborationView(
        { createdBy: shell?.createdBy, visibility: shell?.visibility },
        roster,
      ),
    [roster, shell?.createdBy, shell?.visibility],
  );
  const inboxItems = useCooperationInboxForThread(
    collaboration.isOwner && collaboration.teamEnabled ? environmentId : null,
    threadId,
  );
  const setVisibility = useAtomCommand(threadEnvironment.setVisibility, "Change thread sharing");
  const changeVisibility = (visibility: ThreadVisibility) => {
    if (visibility === collaboration.visibility) return;
    void setVisibility({ environmentId, input: { threadId, visibility } });
  };
  const openThread = useCallback(
    (target: ThreadId) =>
      navigation.dispatch(
        StackActions.push("Thread", { environmentId: String(environmentId), threadId: target }),
      ),
    [environmentId, navigation],
  );
  const returnToThread = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  return (
    <SettingsScreen title="Team">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {shell === null ? (
          <Text className="text-base text-foreground-muted">This thread is not available.</Text>
        ) : (
          <>
            <SettingsSection title="Sharing">
              {collaboration.isOwner ? (
                collaboration.teamEnabled ? (
                  <>
                    <TeamRow
                      icon="lock"
                      title="Private"
                      detail="Only you and admins can see this thread."
                      checked={collaboration.visibility === "private"}
                      onPress={() => changeVisibility("private")}
                    />
                    <TeamRow
                      divided
                      icon="person.2"
                      title="Shared with project members"
                      detail="Teammates can follow and comment. Only you instruct the agent."
                      checked={collaboration.visibility === "shared"}
                      onPress={() => changeVisibility("shared")}
                    />
                  </>
                ) : (
                  <TeamCardBody>
                    <Text className="text-sm text-foreground-muted">
                      Sharing is available once an admin adds team members to this environment.
                    </Text>
                  </TeamCardBody>
                )
              ) : (
                <TeamCardBody>
                  <Text className="text-sm text-foreground-muted">
                    {followingThreadNotice(collaboration.ownerName)}
                  </Text>
                </TeamCardBody>
              )}
            </SettingsSection>

            {collaboration.isOwner ? (
              <CooperationInboxSection
                environmentId={environmentId}
                threadId={threadId}
                items={inboxItems}
                onAdmitted={returnToThread}
              />
            ) : null}

            <RelatedThreadsSection
              environmentId={environmentId}
              threadId={threadId}
              thread={detail}
              isOwner={collaboration.isOwner}
              teamEnabled={collaboration.teamEnabled}
              roster={roster}
              onOpenThread={openThread}
            />

            {collaboration.teamEnabled ? (
              <CooperationSection environmentId={environmentId} threadId={threadId} />
            ) : null}

            <SettingsSection>
              <TeamRow
                icon="person.2"
                title="Team overview"
                detail="The project brief, everyone's focus, work, and activity."
                onPress={() =>
                  navigation.navigate("TeamOverview", {
                    environmentId: String(environmentId),
                    projectId: String(shell.projectId),
                  })
                }
              />
              <TeamRow
                divided
                icon="person.badge.plus"
                title="Invite people"
                detail="Invite teammates or someone new to this project, or leave it."
                onPress={() =>
                  navigation.navigate("ProjectPeople", {
                    environmentId: String(environmentId),
                    projectId: String(shell.projectId),
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
