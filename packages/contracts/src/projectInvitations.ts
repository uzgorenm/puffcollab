import * as Schema from "effect/Schema";

import { IsoDateTime, MemberId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MemberCredentialResult, MemberUsername } from "./members.ts";

/**
 * Puff Collab project invitations: the only way into someone else's project.
 * Any project member invites a teammate (or a new person, who gets a pending
 * member account and a one-time sign-in link); the invitee joins only once
 * they accept.
 */

export const ProjectInvitationId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectInvitationId"));
export type ProjectInvitationId = typeof ProjectInvitationId.Type;

export const ProjectInvitationState = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
]);
export type ProjectInvitationState = typeof ProjectInvitationState.Type;

/** Pending invitations one member may have outstanding at a time. */
export const PROJECT_INVITATION_PENDING_LIMIT = 20;

export const ProjectInvitation = Schema.Struct({
  invitationId: ProjectInvitationId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  inviterId: MemberId,
  inviteeId: MemberId,
  state: ProjectInvitationState,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectInvitation = typeof ProjectInvitation.Type;

/** A person who is not a member yet: they get a pending member account. */
export const ProjectInvitationNewPerson = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  /** Derived from the display name when omitted. */
  username: Schema.optional(MemberUsername),
});
export type ProjectInvitationNewPerson = typeof ProjectInvitationNewPerson.Type;

export const ProjectInvitationInviteInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, memberId: MemberId }),
  Schema.Struct({ projectId: ProjectId, newPerson: ProjectInvitationNewPerson }),
]);
export type ProjectInvitationInviteInput = typeof ProjectInvitationInviteInput.Type;

export const ProjectInvitationInviteResult = Schema.Struct({
  invitation: ProjectInvitation,
  /** Only for a new person: their one-time sign-in link credential. */
  signIn: Schema.optional(MemberCredentialResult),
});
export type ProjectInvitationInviteResult = typeof ProjectInvitationInviteResult.Type;

export const ProjectInvitationsListInput = Schema.Struct({
  /** One project's invitations (members only); omitted lists the caller's pending invitations. */
  projectId: Schema.optional(ProjectId),
});
export type ProjectInvitationsListInput = typeof ProjectInvitationsListInput.Type;

export const ProjectInvitationsListResult = Schema.Struct({
  invitations: Schema.Array(ProjectInvitation),
});
export type ProjectInvitationsListResult = typeof ProjectInvitationsListResult.Type;

export const ProjectInvitationIdInput = Schema.Struct({
  invitationId: ProjectInvitationId,
});
export type ProjectInvitationIdInput = typeof ProjectInvitationIdInput.Type;

export const ProjectLeaveInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectLeaveInput = typeof ProjectLeaveInput.Type;

export class ProjectInvitationsError extends Schema.TaggedError<ProjectInvitationsError>()(
  "ProjectInvitationsError",
  {
    reason: Schema.Literals([
      "not-found",
      "forbidden",
      "already-member",
      "already-invited",
      "limit-reached",
      "username-taken",
      "not-pending",
      "internal",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
