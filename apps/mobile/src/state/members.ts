import type { EnvironmentId, Member, MemberId } from "@t3tools/contracts";
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
