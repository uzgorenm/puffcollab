import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TeamOverviewView } from "../components/team/TeamOverviewView";

export const Route = createFileRoute("/_chat/team/$environmentId/$projectId")({
  component: TeamOverviewRouteView,
});

function TeamOverviewRouteView() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  // Keyed so switching projects resets drafts and pages.
  return (
    <TeamOverviewView
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId}
      projectId={projectId}
    />
  );
}
