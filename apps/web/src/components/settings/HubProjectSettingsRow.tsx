import { isHubLinked, hubProjectLinkOf } from "@t3tools/client-runtime/state/hub";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useHubStatus } from "../../state/hub";
import { openHubProjectDialog } from "../team/hubProjectDialogStore";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** Project settings row for the team hub link; hidden until the environment is linked. */
export function HubProjectSettingsRow({
  environmentId,
  projectId,
  title,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
}) {
  const status = useHubStatus(environmentId);
  if (!isHubLinked(status)) return null;
  const link = hubProjectLinkOf(status, projectId);
  return (
    <SettingsRow
      title={title}
      description={
        link === null
          ? "Not on the team hub. Link it so teammates can follow its shared threads."
          : `Linked to ${link.hubProjectTitle} on the team hub.`
      }
      control={
        <Button
          size="xs"
          variant="outline"
          onClick={() => openHubProjectDialog({ environmentId, projectId })}
        >
          {link === null ? "Link to team hub" : "Manage"}
        </Button>
      }
    />
  );
}
