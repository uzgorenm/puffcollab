import type {
  HubAccountId,
  HubLocalTeam,
  TeamActivityKind,
  TeamWorkCardStatus,
} from "@t3tools/contracts";

/**
 * Team overview presentation shared by web and mobile. The data itself is the
 * hub team of a linked project (`hub.subscribeTeam`); see `state/hub`.
 */

const ACTIVITY_PHRASES: Readonly<Record<TeamActivityKind, string>> = {
  "thread-created": "started a thread",
  "turn-started": "sent a message",
  "turn-completed": "Agent finished a turn",
  "turn-errored": "Agent hit an error",
  "turn-interrupted": "Agent was interrupted",
  "approval-requested": "Agent is waiting for approval",
  "input-requested": "Agent asked a question",
  "brief-updated": "updated the brief",
  "focus-set": "set their focus",
  "focus-cleared": "cleared their focus",
};

/** Whether the phrase reads after the actor's name ("Ada started a thread"). */
export function teamActivityHasActor(kind: TeamActivityKind): boolean {
  switch (kind) {
    case "turn-completed":
    case "turn-errored":
    case "turn-interrupted":
    case "approval-requested":
    case "input-requested":
      return false;
    default:
      return true;
  }
}

/** Plain-language phrase for a feed item, shared by every client. */
export function teamActivityPhrase(kind: TeamActivityKind): string {
  return ACTIVITY_PHRASES[kind];
}

export const TEAM_WORK_CARD_STATUS_LABELS: Readonly<Record<TeamWorkCardStatus, string>> = {
  "waiting-approval": "Waiting on approval",
  "waiting-input": "Waiting on input",
  working: "Working",
  errored: "Errored",
  settled: "Settled",
  idle: "Idle",
};

/** "You", a member's display name, or a neutral fallback for someone who left. */
export function hubTeamMemberName(
  team: Pick<HubLocalTeam, "viewerAccountId" | "members">,
  accountId: HubAccountId | null,
): string {
  if (accountId === null) return "Someone";
  if (accountId === team.viewerAccountId) return "You";
  return (
    team.members.find((member) => member.accountId === accountId)?.displayName ?? "A former member"
  );
}
