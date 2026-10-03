import { describe, expect, it } from "vite-plus/test";

import { teamWorkCardStatusOf } from "./teamOverview.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const base = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
  settledAt: null,
};

describe("teamWorkCardStatusOf", () => {
  it("maps turn and session state in a fixed precedence", () => {
    expect(
      teamWorkCardStatusOf({
        ...base,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session: { status: "running" },
      }),
    ).toBe("waiting-approval");
    expect(
      teamWorkCardStatusOf({ ...base, hasPendingUserInput: true, session: { status: "running" } }),
    ).toBe("waiting-input");
    expect(teamWorkCardStatusOf({ ...base, session: { status: "starting" } })).toBe("working");
    expect(
      teamWorkCardStatusOf({
        ...base,
        session: { status: "error" },
        backgroundLiveness: "working",
      }),
    ).toBe("errored");
    expect(
      teamWorkCardStatusOf({
        ...base,
        session: { status: "ready" },
        latestTurn: { state: "error" },
      }),
    ).toBe("errored");
    expect(teamWorkCardStatusOf({ ...base, backgroundLiveness: "monitoring" })).toBe("working");
    expect(teamWorkCardStatusOf({ ...base, session: { status: "ready" }, settledAt: NOW })).toBe(
      "settled",
    );
    expect(teamWorkCardStatusOf({ ...base, session: { status: "ready" } })).toBe("idle");
  });
});
