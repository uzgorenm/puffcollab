/**
 * Pure mapping from the hub's project state to the team a client sees for one
 * of its local projects (`HubLocalTeam`).
 *
 * @module hubTeamView
 */
import {
  type HubAccount,
  type HubAccountId,
  type HubLocalActivityItem,
  type HubLocalTeam,
  type HubLocalWorkCard,
  type HubProjectState,
  type HubTeamMember,
  type HubThreadId,
  hubWorkCardOf,
  type ProjectId,
  type TeamWorkCardStatus,
  type ThreadId,
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

const STATUS_ORDER: Readonly<Record<TeamWorkCardStatus, number>> = {
  "waiting-approval": 0,
  "waiting-input": 1,
  working: 2,
  errored: 3,
  idle: 4,
  settled: 5,
};

/** Work cards from the hub's thread summaries and analyses, most urgent first. */
export const hubWorkCardsOf = (
  state: HubProjectState,
  localThreadIdOf: (hubThreadId: HubThreadId) => ThreadId,
): ReadonlyArray<HubLocalWorkCard> => {
  const analyses = new Map(state.analyses.map((analysis) => [analysis.threadId, analysis]));
  return state.threads
    .map((summary): HubLocalWorkCard => {
      const card = hubWorkCardOf(summary, analyses.get(summary.threadId) ?? null);
      return {
        threadId: localThreadIdOf(summary.threadId),
        hubThreadId: summary.threadId,
        ownerId: card.ownerId,
        title: card.title,
        status: card.status,
        lastActivityAt: card.lastActivityAt,
        branch: card.branch,
        analysis: card.analysis ?? null,
      };
    })
    .sort(
      (left, right) =>
        STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
        right.lastActivityAt.localeCompare(left.lastActivityAt),
    );
};

export const hubLocalActivityOf = (
  state: HubProjectState,
  localThreadIdOf: (hubThreadId: HubThreadId) => ThreadId,
): ReadonlyArray<HubLocalActivityItem> =>
  state.activity.map((item) => ({
    id: item.id,
    kind: item.kind,
    threadId: item.threadId === null ? null : localThreadIdOf(item.threadId),
    actorId: item.actorId,
    detail: item.detail,
    occurredAt: item.occurredAt,
    sequence: item.sequence,
  }));

export const hubLocalTeamOf = (input: {
  readonly projectId: ProjectId;
  readonly state: HubProjectState;
  readonly viewer: HubAccount;
  readonly accounts: ReadonlyMap<string, HubAccount>;
  /** The viewer's own threads map to their local id; teammates' to their mirror. */
  readonly localThreadIdOf: (hubThreadId: HubThreadId) => ThreadId;
}): HubLocalTeam => ({
  projectId: input.projectId,
  hubProjectId: input.state.project.projectId,
  title: input.state.project.title,
  viewerAccountId: input.viewer.accountId,
  creatorId: input.state.project.createdBy,
  members: hubTeamMembersOf(input.state, input.accounts),
  brief: input.state.brief,
  focuses: input.state.focuses,
  activity: hubLocalActivityOf(input.state, input.localThreadIdOf),
  workCards: hubWorkCardsOf(input.state, input.localThreadIdOf),
});
