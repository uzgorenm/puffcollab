import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useProject } from "../../state/entities";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { HubProjectPeopleSections } from "./HubTeamSections";

type ProjectPeopleRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

/**
 * One project's people on the team hub: members with Remove and Leave,
 * invitations by GitHub login, and the project's hub link.
 */
export function ProjectPeopleRouteScreen(props: ProjectPeopleRouteProps) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const project = useProject(
    useMemo(() => scopeProjectRef(environmentId, projectId), [environmentId, projectId]),
  );
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
        <HubProjectPeopleSections
          environmentId={environmentId}
          projectId={projectId}
          onLeft={() => navigation.goBack()}
        />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
