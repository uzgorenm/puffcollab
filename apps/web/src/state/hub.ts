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
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";

export const hubEnvironment = createHubEnvironmentAtoms(connectionAtomRuntime);

const statusAtom = (environmentId: EnvironmentId) =>
  hubEnvironment.status({ environmentId, input: {} });

/**
 * The environment's team hub connection, pushed by its server. Null while
 * loading and on servers without hub support, so callers render as before.
 */
export function useHubStatus(environmentId: EnvironmentId | null): HubLocalStatus | null {
  return useEnvironmentQuery(environmentId === null ? null : statusAtom(environmentId)).data;
}

/** The status as last pushed, read outside React (menus snapshot at open). */
export function readHubStatus(environmentId: EnvironmentId): HubLocalStatus | null {
  return Option.getOrNull(AsyncResult.value(appAtomRegistry.get(statusAtom(environmentId))));
}

/** Thread-menu state for the project's team hub item; null until the environment is linked. */
export function readTeamHubMenuState(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): { readonly projectLinked: boolean } | null {
  const status = readHubStatus(environmentId);
  if (!isHubLinked(status)) return null;
  return { projectLinked: hubProjectLinkOf(status, projectId) !== null };
}

const NO_ENVIRONMENT_KEY = Atom.make("").pipe(Atom.withLabel("hub:linked-projects:none"));

/** Linked project ids as a stable key; re-renders only when links change. */
export function useHubLinkedProjectsKey(environmentId: EnvironmentId | null): string {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_KEY : hubEnvironment.linkedProjectsKey(environmentId),
  );
}

function useIsHubLinked(environmentId: EnvironmentId | null): boolean {
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

/**
 * Hub invitations for a linked environment, grouped for display. Nothing is
 * subscribed until the environment is linked to a hub account.
 */
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

/**
 * A hub-linked project's team (members and Team overview data), pushed by the
 * server. Null while loading, and for projects that are not on the hub.
 */
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
