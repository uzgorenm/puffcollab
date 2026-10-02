import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  createTeamOverviewEnvironmentAtoms,
  type TeamOverviewState,
} from "@t3tools/client-runtime/state/team-overview";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const teamOverviewEnvironment = createTeamOverviewEnvironmentAtoms(connectionAtomRuntime);

/** The live team overview of a project, or null while the first snapshot loads. */
export function useTeamOverview(target: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): { readonly overview: TeamOverviewState | null; readonly error: string | null } {
  const query = useEnvironmentQuery(
    teamOverviewEnvironment.overview({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
  );
  return { overview: query.data ?? null, error: query.error ?? null };
}
