import * as Schema from "effect/Schema";

import { IsoDateTime, MemberId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Team members are environment-level accounts. Every authenticated session
 * resolves to exactly one member: sessions issued from a member credential
 * resolve to that member, every other session (desktop, startup pairing,
 * owner-paired devices, CLI tokens) resolves to the implicit owner.
 */
export const OWNER_MEMBER_ID = MemberId.make("owner");

export const MemberRole = Schema.Literals(["admin", "member"]);
export type MemberRole = typeof MemberRole.Type;

export const MemberUsername = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
);
export type MemberUsername = typeof MemberUsername.Type;

export const Member = Schema.Struct({
  memberId: MemberId,
  username: MemberUsername,
  displayName: TrimmedNonEmptyString,
  role: MemberRole,
  createdAt: IsoDateTime,
  /** Set when an admin removes the member. Removed members cannot sign in. */
  removedAt: Schema.NullOr(IsoDateTime),
  /** The member who invited this person to a project, when they joined that way. */
  invitedBy: Schema.optional(Schema.NullOr(MemberId)),
  /** True until an invited person redeems their sign-in link. */
  pending: Schema.optional(Schema.Boolean),
});
export type Member = typeof Member.Type;

export const MembersListResult = Schema.Struct({
  /** Active and removed members, so old authors still render by name. */
  members: Schema.Array(Member),
  /** The member the calling session resolves to. */
  currentMemberId: MemberId,
});
export type MembersListResult = typeof MembersListResult.Type;

export const MembersAddInput = Schema.Struct({
  username: MemberUsername,
  displayName: TrimmedNonEmptyString,
  role: MemberRole,
});
export type MembersAddInput = typeof MembersAddInput.Type;

export const MemberIdInput = Schema.Struct({
  memberId: MemberId,
});
export type MemberIdInput = typeof MemberIdInput.Type;

export const MemberCredentialResult = Schema.Struct({
  /** Pairing link id; revocable through the regular pairing-link revoke. */
  id: TrimmedNonEmptyString,
  /** One-time pairing credential. Redeem it at `/pair#token=<credential>`. */
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type MemberCredentialResult = typeof MemberCredentialResult.Type;

export const MembersRevokeAccessResult = Schema.Struct({
  revokedSessions: Schema.Number,
  revokedCredentials: Schema.Number,
});
export type MembersRevokeAccessResult = typeof MembersRevokeAccessResult.Type;

export const ProjectMembersInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectMembersInput = typeof ProjectMembersInput.Type;

export const ProjectMembersResult = Schema.Struct({
  projectId: ProjectId,
  memberIds: Schema.Array(MemberId),
  /** The member who created the project; they and admins can remove members. */
  creatorId: Schema.optional(Schema.NullOr(MemberId)),
});
export type ProjectMembersResult = typeof ProjectMembersResult.Type;

export const ProjectMemberInput = Schema.Struct({
  projectId: ProjectId,
  memberId: MemberId,
});
export type ProjectMemberInput = typeof ProjectMemberInput.Type;

export class TeamMembersError extends Schema.TaggedError<TeamMembersError>()("TeamMembersError", {
  reason: Schema.Literals(["not-found", "username-taken", "owner-immutable", "internal"]),
  message: TrimmedNonEmptyString,
}) {}
