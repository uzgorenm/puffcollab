/**
 * A hub project's team as a client sees it through its own local server
 * (Stage 7.4). The hub owns this data (hub.ts); the local server keeps the
 * latest copy in memory and maps hub thread ids to the local thread ids a
 * client can open (the owner's own threads and teammates' mirrors). Split from
 * hubLocal.ts because it builds on hub.ts, which orchestration contracts
 * cannot import.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubProjectRole } from "./hub.ts";
import { GithubLogin, HubAccountId, HubProjectId } from "./hubIds.ts";

/** One member of a hub project, with the account fields a list needs. */
export const HubTeamMember = Schema.Struct({
  accountId: HubAccountId,
  githubLogin: GithubLogin,
  displayName: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(TrimmedNonEmptyString),
  role: HubProjectRole,
  joinedAt: IsoDateTime,
});
export type HubTeamMember = typeof HubTeamMember.Type;

/** The team of the hub project a local project is linked to. */
export const HubLocalTeam = Schema.Struct({
  projectId: ProjectId,
  hubProjectId: HubProjectId,
  title: TrimmedNonEmptyString,
  /** The local server's hub account. */
  viewerAccountId: HubAccountId,
  /** The project's creator: an admin who cannot leave or be removed. */
  creatorId: HubAccountId,
  members: Schema.Array(HubTeamMember),
});
export type HubLocalTeam = typeof HubLocalTeam.Type;

export const HubTeamInput = Schema.Struct({ projectId: ProjectId });
export type HubTeamInput = typeof HubTeamInput.Type;

/** Null while the project is not linked to the hub or the hub has not sent it yet. */
export const HubTeamResult = Schema.Struct({ team: Schema.NullOr(HubLocalTeam) });
export type HubTeamResult = typeof HubTeamResult.Type;

/** Admins remove other members; the creator cannot be removed. */
export const HubMemberRemoveInput = Schema.Struct({
  projectId: ProjectId,
  accountId: HubAccountId,
});
export type HubMemberRemoveInput = typeof HubMemberRemoveInput.Type;

/** Leaves the hub project; the local project stays and is unlinked from it. */
export const HubLeaveProjectInput = Schema.Struct({ projectId: ProjectId });
export type HubLeaveProjectInput = typeof HubLeaveProjectInput.Type;

/** Whether `viewer` may remove `member`: admins remove anyone but the creator and themselves. */
export const canRemoveHubMember = (
  team: Pick<HubLocalTeam, "viewerAccountId" | "creatorId" | "members">,
  member: Pick<HubTeamMember, "accountId">,
): boolean =>
  member.accountId !== team.creatorId &&
  member.accountId !== team.viewerAccountId &&
  team.members.some((entry) => entry.accountId === team.viewerAccountId && entry.role === "admin");

/** Everyone but the creator may leave. */
export const canLeaveHubProject = (team: Pick<HubLocalTeam, "viewerAccountId" | "creatorId">) =>
  team.viewerAccountId !== team.creatorId;
