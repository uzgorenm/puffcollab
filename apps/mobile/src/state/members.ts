import type { EnvironmentId, Member, MemberId, ProjectInvitation } from "@t3tools/contracts";
import { createMemberEnvironmentAtoms, indexMembers } from "@t3tools/client-runtime/state/members";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const memberEnvironment = createMemberEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentMembers {
  readonly members: ReadonlyMap<MemberId, Member>;
  readonly currentMemberId: MemberId | null;
}

const EMPTY_MEMBERS: ReadonlyMap<MemberId, Member> = new Map();

/**
 * The environment's team roster (Puff Collab). Empty on servers without team
 * members, so callers render exactly as a single-user environment.
 */
export function useEnvironmentMembers(environmentId: EnvironmentId | null): EnvironmentMembers {
  const roster = useEnvironmentQuery(
    environmentId === null ? null : memberEnvironment.list({ environmentId, input: {} }),
  ).data;
  return useMemo(
    () => ({
      members: roster ? indexMembers(roster) : EMPTY_MEMBERS,
      currentMemberId: roster?.currentMemberId ?? null,
    }),
    [roster],
  );
}

const EMPTY_INVITATIONS: ReadonlyArray<ProjectInvitation> = [];

/**
 * The viewer's pending project invitations, pushed by the server. Admins see
 * every project, so nobody invites them and nothing is subscribed.
 */
export function useMyProjectInvitations(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ProjectInvitation> {
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  const viewer = currentMemberId === null ? undefined : members.get(currentMemberId);
  const subscribed = environmentId !== null && viewer !== undefined && viewer.role !== "admin";
  return (
    useEnvironmentQuery(
      subscribed ? memberEnvironment.myInvitations({ environmentId, input: {} }) : null,
    ).data?.invitations ?? EMPTY_INVITATIONS
  );
}

/** Whether the viewer is an admin of the environment (the owner always is). */
export function useIsEnvironmentAdmin(environmentId: EnvironmentId | null): boolean {
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  return currentMemberId !== null && members.get(currentMemberId)?.role === "admin";
}
