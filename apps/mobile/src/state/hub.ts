import {
  createHubEnvironmentAtoms,
  groupHubInvitations,
  type HubInvitationGroups,
  hubProjectLinkOf,
  isHubLinked,
} from "@t3tools/client-runtime/state/hub";
import type {
  EnvironmentId,
  HubLocalProjectLink,
  HubLocalStatus,
  HubLocalTeam,
  ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const hubEnvironment = createHubEnvironmentAtoms(connectionAtomRuntime);

/**
 * The environment's team hub connection, pushed by its server. Null while
 * loading and on servers without hub support, so callers render as before.
 */
export function useHubStatus(environmentId: EnvironmentId | null): HubLocalStatus | null {
  return useEnvironmentQuery(
    environmentId === null ? null : hubEnvironment.status({ environmentId, input: {} }),
  ).data;
}

const NO_ENVIRONMENT_KEY = Atom.make("").pipe(Atom.withLabel("hub:linked-projects:none"));

/** Linked project ids as a stable key; re-renders only when links change. */
export function useHubLinkedProjectsKey(environmentId: EnvironmentId | null): string {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_KEY : hubEnvironment.linkedProjectsKey(environmentId),
  );
}

export function useIsHubLinked(environmentId: EnvironmentId | null): boolean {
  return isHubLinked(useHubStatus(environmentId));
}

export function useHubProjectLink(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): HubLocalProjectLink | null {
  const status = useHubStatus(environmentId);
  return projectId === null ? null : hubProjectLinkOf(status, projectId);
}

const EMPTY_GROUPS: HubInvitationGroups = { incoming: [], outgoingByProject: new Map() };

/** Hub invitations, grouped. Nothing is subscribed until the environment is linked. */
export function useHubInvitationGroups(environmentId: EnvironmentId | null): HubInvitationGroups {
  const linked = useIsHubLinked(environmentId);
  const invitations = useEnvironmentQuery(
    linked && environmentId !== null
      ? hubEnvironment.invitations({ environmentId, input: {} })
      : null,
  ).data?.invitations;
  return useMemo(
    () =>
      invitations === undefined
        ? EMPTY_GROUPS
        : groupHubInvitations(invitations, new Date().toISOString()),
    [invitations],
  );
}

/** A hub-linked project's team, pushed by the server; null while loading or unlinked. */
export function useHubTeam(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): HubLocalTeam | null {
  const link = useHubProjectLink(environmentId, projectId);
  return (
    useEnvironmentQuery(
      link !== null && environmentId !== null && projectId !== null
        ? hubEnvironment.team({ environmentId, input: { projectId } })
        : null,
    ).data?.team ?? null
  );
}
