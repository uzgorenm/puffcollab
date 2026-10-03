import { hubConnectionLabel } from "@t3tools/client-runtime/state/hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { useHubStatus } from "../../state/hub";
import { SettingsRow } from "../settings/components/SettingsRow";

/**
 * Settings index row for the team hub of the selected environment, opening
 * its environment page where the Team hub section lives. Hidden on servers
 * without hub support.
 */
export function TeamHubSettingsRow(props: { readonly environmentId: EnvironmentId | null }) {
  const navigation = useNavigation();
  const status = useHubStatus(props.environmentId);
  const environmentId = props.environmentId;
  if (environmentId === null || status === null) return null;
  return (
    <SettingsRow
      icon="point.3.connected.trianglepath.dotted"
      label="Team hub"
      value={hubConnectionLabel(status.state)}
      valuePosition="trailing"
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironmentDetail", params: { environmentId } },
        })
      }
    />
  );
}
