/**
 * A hub project's team as a client sees it through its own local server
 * (Stage 7.4). The hub owns this data (hub.ts); the local server keeps the
 * latest copy in memory and maps hub thread ids to the local thread ids a
 * client can open (the owner's own threads and teammates' mirrors). Split from
 * hubLocal.ts because it builds on hub.ts, which orchestration contracts
 * cannot import.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HubProjectBriefVersion, HubProjectMemberFocus, HubProjectRole } from "./hub.ts";
import { GithubLogin, HubAccountId, HubProjectId, HubThreadId } from "./hubIds.ts";
import { ProjectBriefText, ProjectMemberFocusText } from "./orchestration.ts";
import { TeamActivityKind, TeamWorkCardAnalysis, TeamWorkCardStatus } from "./teamOverview.ts";

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

/** A hub activity item with its thread mapped to the local id a client can open. */
export const HubLocalActivityItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: TeamActivityKind,
  threadId: Schema.NullOr(ThreadId),
  actorId: Schema.NullOr(HubAccountId),
  detail: Schema.NullOr(Schema.String),
  occurredAt: IsoDateTime,
  /** The hub's per-project activity sequence; newest first. */
  sequence: NonNegativeInt,
});
export type HubLocalActivityItem = typeof HubLocalActivityItem.Type;

/**
 * One shared thread on Team overview: the viewer's own (published) threads
 * and teammates' mirrors. `threadId` is the local id to open.
 */
export const HubLocalWorkCard = Schema.Struct({
  threadId: ThreadId,
  hubThreadId: HubThreadId,
  ownerId: HubAccountId,
  title: TrimmedNonEmptyString,
  status: TeamWorkCardStatus,
  lastActivityAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  analysis: Schema.NullOr(TeamWorkCardAnalysis),
});
export type HubLocalWorkCard = typeof HubLocalWorkCard.Type;

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
  brief: Schema.NullOr(HubProjectBriefVersion),
  focuses: Schema.Array(HubProjectMemberFocus),
  /** Newest first, as the hub keeps it (at most `TEAM_ACTIVITY_SNAPSHOT_LIMIT`). */
  activity: Schema.Array(HubLocalActivityItem),
  /** Most urgent first, then most recently active. */
  workCards: Schema.Array(HubLocalWorkCard),
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

/** Rejected with `conflict` when a teammate saved a newer version first. */
export const HubBriefUpdateInput = Schema.Struct({
  projectId: ProjectId,
  text: ProjectBriefText,
  /** The version the editor started from; null for a project with no brief. */
  expectedVersion: Schema.NullOr(PositiveInt),
});
export type HubBriefUpdateInput = typeof HubBriefUpdateInput.Type;

/** Always the viewer's own focus. Null clears it. */
export const HubFocusSetInput = Schema.Struct({
  projectId: ProjectId,
  focus: Schema.NullOr(ProjectMemberFocusText),
});
export type HubFocusSetInput = typeof HubFocusSetInput.Type;

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
