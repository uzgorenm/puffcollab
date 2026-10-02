import {
  MemberId,
  OWNER_MEMBER_ID,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationSessionStatus,
  type TeamActivityItem,
  type TeamOverviewSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOlderTeamActivity,
  deriveTeamWorkCards,
  deriveTeamWorkCardStatus,
  reduceTeamOverview,
} from "./teamOverview.ts";

const projectId = ProjectId.make("project-1");
const ada = MemberId.make("ada");
const NOW = "2026-01-01T00:00:00.000Z";

const session = (status: OrchestrationSessionStatus) => ({
  threadId: ThreadId.make("t"),
  status,
  providerName: "codex",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
});

const baseStatus = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
  settledAt: null,
};

const thread = (
  id: string,
  overrides: Partial<Parameters<typeof deriveTeamWorkCards>[0]["threads"][number]> = {},
) => ({
  ...baseStatus,
  id: ThreadId.make(id),
  projectId,
  title: `Thread ${id}`,
  createdBy: ada,
  visibility: undefined,
  updatedAt: NOW,
  branch: null,
  worktreePath: null,
  archivedAt: null,
  ...overrides,
});

describe("deriveTeamWorkCardStatus", () => {
  it("maps turn and session state in a fixed precedence", () => {
    expect(
      deriveTeamWorkCardStatus({
        ...baseStatus,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session: session("running"),
      }),
    ).toBe("waiting-approval");
    expect(
      deriveTeamWorkCardStatus({
        ...baseStatus,
        hasPendingUserInput: true,
        session: session("running"),
      }),
    ).toBe("waiting-input");
    expect(deriveTeamWorkCardStatus({ ...baseStatus, session: session("starting") })).toBe(
      "working",
    );
    expect(
      deriveTeamWorkCardStatus({
        ...baseStatus,
        session: session("error"),
        backgroundLiveness: "working",
      }),
    ).toBe("errored");
    expect(
      deriveTeamWorkCardStatus({
        ...baseStatus,
        session: session("ready"),
        latestTurn: {
          turnId: TurnId.make("turn"),
          state: "error",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
    ).toBe("errored");
    expect(deriveTeamWorkCardStatus({ ...baseStatus, backgroundLiveness: "monitoring" })).toBe(
      "working",
    );
    expect(
      deriveTeamWorkCardStatus({ ...baseStatus, session: session("ready"), settledAt: NOW }),
    ).toBe("settled");
    expect(deriveTeamWorkCardStatus({ ...baseStatus, session: session("ready") })).toBe("idle");
  });
});

describe("deriveTeamWorkCards", () => {
  it("shows shared threads and the member's own, never others' private ones", () => {
    const cards = deriveTeamWorkCards({
      projectId,
      memberId: ada,
      threads: [
        thread("own-private"),
        thread("other-shared", { createdBy: MemberId.make("bob"), visibility: "shared" }),
        thread("other-private", { createdBy: MemberId.make("bob"), visibility: "private" }),
        thread("ownerless", { createdBy: null }),
        thread("archived", { archivedAt: NOW }),
        thread("elsewhere", { projectId: ProjectId.make("project-2"), visibility: "shared" }),
      ],
    });
    expect(cards.map((card) => card.threadId)).toEqual(["own-private", "other-shared"]);

    // Threads without a creator belong to the environment owner.
    const ownerCards = deriveTeamWorkCards({
      projectId,
      memberId: OWNER_MEMBER_ID,
      threads: [thread("ownerless", { createdBy: null })],
    });
    expect(ownerCards.map((card) => [card.threadId, card.ownerId])).toEqual([["ownerless", null]]);
  });

  it("orders by urgency then recency and attaches analysis when present", () => {
    const cards = deriveTeamWorkCards({
      projectId,
      memberId: ada,
      threads: [
        thread("idle-new", { updatedAt: "2026-01-03T00:00:00.000Z" }),
        thread("idle-old", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        thread("approval", { hasPendingApprovals: true }),
      ],
      analysisByThreadId: new Map([
        [ThreadId.make("approval"), { summary: "Needs a migration review", updatedAt: NOW }],
      ]),
    });
    expect(
      cards.map((card) => [card.threadId, card.status, card.analysis?.summary ?? null]),
    ).toEqual([
      ["approval", "waiting-approval", "Needs a migration review"],
      ["idle-new", "idle", null],
      ["idle-old", "idle", null],
    ]);
  });
});

const activity = (sequence: number): TeamActivityItem => ({
  id: `a-${sequence}`,
  projectId,
  kind: "turn-started",
  threadId: null,
  actorId: ada,
  detail: null,
  occurredAt: NOW,
  sequence,
});

describe("reduceTeamOverview", () => {
  const snapshot: TeamOverviewSnapshot = {
    projectId,
    brief: { projectId, version: 2, text: "v2", authorId: ada, createdAt: NOW },
    focuses: [{ projectId, memberId: ada, focus: "Feed", updatedAt: NOW }],
    activity: [activity(5), activity(4)],
    activityNextBeforeSequence: 4,
  };

  it("folds deltas onto the snapshot", () => {
    let state = reduceTeamOverview(null, { kind: "activity", items: [activity(9)] });
    expect(state).toBeNull();
    state = reduceTeamOverview(state, { kind: "snapshot", snapshot });
    state = reduceTeamOverview(state, {
      kind: "brief",
      brief: { projectId, version: 1, text: "stale", authorId: null, createdAt: NOW },
    });
    expect(state?.brief?.text).toBe("v2");
    state = reduceTeamOverview(state, { kind: "focus", memberId: ada, focus: null });
    expect(state?.focuses).toEqual([]);
    state = reduceTeamOverview(state, { kind: "activity", items: [activity(6), activity(5)] });
    expect(state?.activity.map((item) => item.sequence)).toEqual([6, 5, 4]);

    const paged = appendOlderTeamActivity(state!, {
      items: [activity(4), activity(2)],
      nextBeforeSequence: null,
    });
    expect(paged.activity.map((item) => item.sequence)).toEqual([6, 5, 4, 2]);
    expect(paged.activityNextBeforeSequence).toBeNull();
  });
});
