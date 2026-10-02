import { describe, expect, it } from "vite-plus/test";

import { MemberId, type MembersListResult, OWNER_MEMBER_ID } from "@t3tools/contracts";

import { indexMembers, memberAuthorLabel } from "./members.ts";

const ada = MemberId.make("member-ada");
const roster: MembersListResult = {
  currentMemberId: OWNER_MEMBER_ID,
  members: [
    {
      memberId: OWNER_MEMBER_ID,
      username: "owner",
      displayName: "Owner",
      role: "admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      removedAt: null,
    },
    {
      memberId: ada,
      username: "ada",
      displayName: "Ada Lovelace",
      role: "member",
      createdAt: "2026-01-02T00:00:00.000Z",
      removedAt: "2026-01-03T00:00:00.000Z",
    },
  ],
};

describe("memberAuthorLabel", () => {
  it("names other authors, including removed ones, and leaves the viewer's own messages unlabeled", () => {
    const members = indexMembers(roster);
    expect(memberAuthorLabel(members, ada, OWNER_MEMBER_ID)).toBe("Ada Lovelace");
    expect(memberAuthorLabel(members, OWNER_MEMBER_ID, OWNER_MEMBER_ID)).toBeNull();
    expect(memberAuthorLabel(members, undefined, OWNER_MEMBER_ID)).toBeNull();
  });

  it("shows nothing in a single-person environment", () => {
    const solo = indexMembers({ ...roster, members: roster.members.slice(0, 1) });
    expect(memberAuthorLabel(solo, OWNER_MEMBER_ID, null)).toBeNull();
  });
});
