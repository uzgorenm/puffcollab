import {
  type EnvironmentId,
  type Member,
  type MemberId,
  type MembersListResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

// Bumped after every roster or membership change so the queries refetch.
const membersRevision = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:members:revision:${environmentId}`),
  ),
);

const bumpMembersRevision = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.update(membersRevision(target.environmentId), (revision) => revision + 1);
  });

/**
 * Puff Collab team members of an environment: the roster every client reads
 * (author names) and the admin-only commands that change it.
 */
export function createMemberEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    membersRevision(environmentId);
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:members:list",
      tag: WS_METHODS.membersList,
      staleTimeMs: 60_000,
      refreshTrigger,
    }),
    projectMembers: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:members:project-members",
      tag: WS_METHODS.projectMembersList,
      staleTimeMs: 30_000,
      refreshTrigger,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:add",
      tag: WS_METHODS.membersAdd,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:remove",
      tag: WS_METHODS.membersRemove,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    issueCredential: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:issue-credential",
      tag: WS_METHODS.membersIssueCredential,
      scheduler,
      concurrency,
    }),
    revokeAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:revoke-access",
      tag: WS_METHODS.membersRevokeAccess,
      scheduler,
      concurrency,
    }),
    addProjectMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:add-project-member",
      tag: WS_METHODS.projectMembersAdd,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    removeProjectMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:remove-project-member",
      tag: WS_METHODS.projectMembersRemove,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
  };
}

/** Members keyed by id, including removed ones so old authors keep their names. */
export function indexMembers(
  roster: MembersListResult | null | undefined,
): ReadonlyMap<MemberId, Member> {
  return new Map((roster?.members ?? []).map((member) => [member.memberId, member]));
}

/**
 * The name to show for an author. Null when there is nothing worth showing:
 * no author recorded, the viewer wrote it, or a single-person environment.
 */
export function memberAuthorLabel(
  members: ReadonlyMap<MemberId, Member>,
  authorId: MemberId | null | undefined,
  currentMemberId: MemberId | null,
): string | null {
  if (authorId == null || authorId === currentMemberId || members.size <= 1) return null;
  return members.get(authorId)?.displayName ?? null;
}
