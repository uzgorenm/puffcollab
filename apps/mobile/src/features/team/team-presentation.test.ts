import {
  HubAccountId,
  HubLocalError,
  type Member,
  MemberId,
  type OrchestrationThreadComment,
  ThreadCommentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  briefChangedSinceDraft,
  insertThreadCommentEntries,
  isHubConflict,
  teamActivityLine,
  teamMemberName,
  threadRowMenuActionsForViewer,
} from "./team-presentation";
import { resolveNewThreadVisibility } from "../../state/new-thread-visibility";

const member = (id: string, displayName: string): Member => ({
  memberId: MemberId.make(id),
  username: id,
  displayName,
  role: "member",
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
});
const members = new Map([member("ada", "Ada"), member("bob", "Bob")].map((m) => [m.memberId, m]));
const ada = MemberId.make("ada");
const bob = MemberId.make("bob");

const comment = (id: string, createdAt: string): OrchestrationThreadComment => ({
  id: ThreadCommentId.make(id),
  authorId: bob,
  text: `comment ${id}`,
  createdAt,
});

describe("teamMemberName", () => {
  it("names the viewer, teammates, and unknown members", () => {
    expect(teamMemberName(members, ada, ada)).toBe("You");
    expect(teamMemberName(members, bob, ada)).toBe("Bob");
    expect(teamMemberName(members, MemberId.make("gone"), ada)).toBe("A former member");
    expect(teamMemberName(members, null, ada)).toBe("Someone");
  });
});

describe("teamActivityLine", () => {
  it("leads with the actor only for member-caused activity", () => {
    const bobAccount = HubAccountId.make("acct-bob");
    const team = {
      viewerAccountId: HubAccountId.make("acct-ada"),
      members: [
        {
          accountId: bobAccount,
          githubLogin: "bob",
          displayName: "Bob",
          role: "member" as const,
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(teamActivityLine({ kind: "thread-created", actorId: bobAccount }, team)).toBe(
      "Bob started a thread",
    );
    expect(teamActivityLine({ kind: "focus-set", actorId: team.viewerAccountId }, team)).toBe(
      "You set their focus",
    );
    expect(teamActivityLine({ kind: "turn-completed", actorId: null }, team)).toBe(
      "Agent finished a turn",
    );
  });
});

describe("briefChangedSinceDraft", () => {
  it("flags a brief saved by someone else after the draft started", () => {
    expect(briefChangedSinceDraft(null, null)).toBe(false);
    expect(briefChangedSinceDraft(2, { version: 2 })).toBe(false);
    expect(briefChangedSinceDraft(2, { version: 3 })).toBe(true);
    expect(briefChangedSinceDraft(null, { version: 1 })).toBe(true);
  });
});

describe("isHubConflict", () => {
  it("recognizes only the hub's conflict reason", () => {
    const conflict = new HubLocalError({ reason: "conflict", message: "Brief changed" });
    const forbidden = new HubLocalError({ reason: "forbidden", message: "Not a member" });
    expect(isHubConflict(Cause.fail(conflict))).toBe(true);
    expect(isHubConflict(Cause.fail(forbidden))).toBe(false);
    expect(isHubConflict(Cause.die(new Error("boom")))).toBe(false);
  });
});

describe("insertThreadCommentEntries", () => {
  const message = (id: string, createdAt: string) => ({ type: "message", id, createdAt });

  it("returns the feed untouched without comments", () => {
    const feed = [message("m1", "2026-01-01T00:00:01.000Z")];
    expect(insertThreadCommentEntries(feed, undefined)).toBe(feed);
    expect(insertThreadCommentEntries(feed, [])).toBe(feed);
  });

  it("interleaves comments by time and keeps live rows last", () => {
    const feed = [
      message("m1", "2026-01-01T00:00:01.000Z"),
      message("m2", "2026-01-01T00:00:05.000Z"),
      { type: "thinking", id: "thinking", createdAt: "2026-01-01T00:00:06.000Z" },
      {
        type: "message",
        id: "queued",
        createdAt: "2026-01-01T00:00:07.000Z",
        pendingMessage: {},
      },
    ];
    const ids = insertThreadCommentEntries(feed, [
      comment("late", "2026-01-01T00:00:09.000Z"),
      comment("early", "2026-01-01T00:00:03.000Z"),
    ]).map((entry) => entry.id);
    expect(ids).toEqual([
      "m1",
      "thread-comment:early",
      "m2",
      "thread-comment:late",
      "thinking",
      "queued",
    ]);
  });
});

describe("threadRowMenuActionsForViewer", () => {
  const actions = [
    { id: "new-thread-on-branch" },
    { id: "copy-thread-id" },
    { id: "settle" },
    { id: "snooze", subactions: [{ id: "snooze:1h" }] },
    { id: "rename" },
    { id: "auto-settle" },
    { id: "pin" },
    { id: "archive" },
    { id: "delete" },
  ];

  it("keeps every action on the viewer's own threads", () => {
    expect(threadRowMenuActionsForViewer(actions, { remote: false })).toEqual(actions);
  });

  it("leaves a teammate's mirror only actions on the viewer's own view", () => {
    expect(threadRowMenuActionsForViewer(actions, { remote: true }).map((a) => a.id)).toEqual([
      "copy-thread-id",
      "snooze",
      "pin",
    ]);
  });
});

describe("resolveNewThreadVisibility", () => {
  it("prefers the explicit toggle, then a queued task's choice, else private", () => {
    expect(resolveNewThreadVisibility(null, undefined)).toBe("private");
    expect(resolveNewThreadVisibility(null, "shared")).toBe("shared");
    expect(resolveNewThreadVisibility("private", "shared")).toBe("private");
    expect(resolveNewThreadVisibility("shared", undefined)).toBe("shared");
  });
});
