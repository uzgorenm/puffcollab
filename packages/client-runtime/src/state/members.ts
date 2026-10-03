import {
  type EnvironmentId,
  type Member,
  type MemberId,
  type MembersListResult,
  OWNER_MEMBER_ID,
  type ProjectInvitation,
  type ProjectMembersResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
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
 * (author names), the admin-only commands that change it, and project
 * invitations, which every project member uses.
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
      // Revoking an unredeemed invite link removes that pending account.
      onSettled: bumpMembersRevision,
    }),
    removeProjectMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:remove-project-member",
      tag: WS_METHODS.projectMembersRemove,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    leaveProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:leave-project",
      tag: WS_METHODS.projectMembersLeave,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    /** The caller's pending invitations, pushed by the server. */
    myInvitations: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:members:my-invitations",
      tag: WS_METHODS.subscribeProjectInvitations,
    }),
    /** Recent invitations to one project (`{ projectId }`). */
    projectInvitations: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:members:project-invitations",
      tag: WS_METHODS.projectInvitationsList,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    invite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:invite",
      tag: WS_METHODS.projectInvitationsInvite,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    acceptInvitation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:accept-invitation",
      tag: WS_METHODS.projectInvitationsAccept,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    declineInvitation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:decline-invitation",
      tag: WS_METHODS.projectInvitationsDecline,
      scheduler,
      concurrency,
      onSettled: bumpMembersRevision,
    }),
    cancelInvitation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:members:cancel-invitation",
      tag: WS_METHODS.projectInvitationsCancel,
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

/** Active teammates the viewer could invite to a project: not in it, not admins, not already invited. */
export function invitableMembers(input: {
  readonly members: ReadonlyMap<MemberId, Member>;
  readonly projectMemberIds: ReadonlyArray<MemberId>;
  readonly invitations: ReadonlyArray<ProjectInvitation>;
  readonly viewerId: MemberId | null;
}): ReadonlyArray<Member> {
  const excluded = new Set<MemberId>(input.projectMemberIds);
  for (const invitation of input.invitations) {
    if (invitation.state === "pending") excluded.add(invitation.inviteeId);
  }
  return [...input.members.values()].filter(
    (member) =>
      member.removedAt === null &&
      member.role !== "admin" &&
      member.memberId !== input.viewerId &&
      !excluded.has(member.memberId),
  );
}

/** The project's creator and admins remove other members; everyone can leave. */
export function canRemoveProjectMember(input: {
  readonly projectMembers: ProjectMembersResult | null | undefined;
  readonly viewerId: MemberId | null;
  readonly viewerIsAdmin: boolean;
  readonly targetId: MemberId;
}): boolean {
  if (input.viewerId === null || input.targetId === input.viewerId) return false;
  if (input.targetId === OWNER_MEMBER_ID) return false;
  if (input.viewerIsAdmin) return true;
  const creatorId = input.projectMembers?.creatorId ?? null;
  return (
    creatorId === input.viewerId && (input.projectMembers?.memberIds ?? []).includes(creatorId)
  );
}

/** Who may cancel a pending invitation: its inviter, project members, and admins. */
export function canCancelInvitation(input: {
  readonly invitation: ProjectInvitation;
  readonly viewerId: MemberId | null;
  readonly viewerInProject: boolean;
}): boolean {
  return (
    input.invitation.state === "pending" &&
    (input.viewerInProject || input.invitation.inviterId === input.viewerId)
  );
}

/**
 * A sign-in link for a host the client reached at `httpBaseUrl`: the hosted
 * web app for an HTTPS host, else the host's own `/pair` page. Null for a
 * loopback address, which no other device can open.
 */
export function memberSignInUrl(
  httpBaseUrl: string | null | undefined,
  credential: string,
  hostedAppUrl: string = DEFAULT_HOSTED_APP_URL,
): string | null {
  if (!httpBaseUrl) return null;
  let base: URL;
  try {
    base = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  const hostname = base.hostname.replace(/^\[|\]$/gu, "");
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) return null;
  if (base.protocol === "https:") {
    const hosted = new URL("/pair", hostedAppUrl);
    hosted.searchParams.set("host", httpBaseUrl);
    return setPairingTokenOnUrl(hosted, credential).toString();
  }
  const pair = new URL("/pair", base);
  return setPairingTokenOnUrl(pair, credential).toString();
}
