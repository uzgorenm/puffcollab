/**
 * Pure mapping from the hub's project state to the team a client sees for one
 * of its local projects (`HubLocalTeam`).
 *
 * @module hubTeamView
 */
import type {
  HubAccount,
  HubAccountId,
  HubLocalTeam,
  HubProjectState,
  HubTeamMember,
  ProjectId,
} from "@t3tools/contracts";

import { accountOrPlaceholder } from "./hubThreads.ts";

/** Creator first, then admins, then members in the order they joined. */
const memberOrder = (creatorId: HubAccountId) => (left: HubTeamMember, right: HubTeamMember) =>
  Number(right.accountId === creatorId) - Number(left.accountId === creatorId) ||
  Number(right.role === "admin") - Number(left.role === "admin") ||
  left.joinedAt.localeCompare(right.joinedAt);

export const hubTeamMembersOf = (
  state: HubProjectState,
  accounts: ReadonlyMap<string, HubAccount>,
): ReadonlyArray<HubTeamMember> =>
  state.members
    .map((member): HubTeamMember => {
      const account = accountOrPlaceholder(accounts, member.accountId);
      return {
        accountId: member.accountId,
        githubLogin: account.githubLogin,
        displayName: account.displayName,
        ...(account.avatarUrl !== undefined ? { avatarUrl: account.avatarUrl } : {}),
        role: member.role,
        joinedAt: member.joinedAt,
      };
    })
    .sort(memberOrder(state.project.createdBy));

export const hubLocalTeamOf = (input: {
  readonly projectId: ProjectId;
  readonly state: HubProjectState;
  readonly viewer: HubAccount;
  readonly accounts: ReadonlyMap<string, HubAccount>;
}): HubLocalTeam => ({
  projectId: input.projectId,
  hubProjectId: input.state.project.projectId,
  title: input.state.project.title,
  viewerAccountId: input.viewer.accountId,
  creatorId: input.state.project.createdBy,
  members: hubTeamMembersOf(input.state, input.accounts),
});
