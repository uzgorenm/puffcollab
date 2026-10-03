import { describe, expect, it } from "vite-plus/test";

import { MemberId, type MembersListResult, OWNER_MEMBER_ID, ProjectId } from "@t3tools/contracts";

import {
  canRemoveProjectMember,
  indexMembers,
  memberAuthorLabel,
  memberSignInUrl,
} from "./members.ts";

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

describe("memberSignInUrl", () => {
  it("opens the hosted app for an HTTPS host and the host itself otherwise", () => {
    const hosted = memberSignInUrl("https://box.tail1.ts.net", "secret", "https://app.example");
    expect(hosted?.startsWith("https://app.example/pair?host=https%3A%2F%2Fbox.tail1.ts.net")).toBe(
      true,
    );
    expect(hosted).toContain("token=secret");
    expect(memberSignInUrl("http://192.168.1.5:3773", "secret")).toBe(
      "http://192.168.1.5:3773/pair#token=secret",
    );
  });

  it("gives no link for a loopback address", () => {
    expect(memberSignInUrl("http://localhost:3773", "secret")).toBeNull();
    expect(memberSignInUrl("http://127.0.0.1:3773", "secret")).toBeNull();
    expect(memberSignInUrl(null, "secret")).toBeNull();
  });
});

describe("canRemoveProjectMember", () => {
  const bob = MemberId.make("member-bob");
  const projectMembers = { projectId: ProjectId.make("p"), memberIds: [ada, bob], creatorId: ada };

  it("lets the creator and admins remove others, never themselves", () => {
    const check = (viewerId: MemberId, viewerIsAdmin: boolean, targetId: MemberId) =>
      canRemoveProjectMember({ projectMembers, viewerId, viewerIsAdmin, targetId });
    expect(check(ada, false, bob)).toBe(true);
    expect(check(bob, false, ada)).toBe(false);
    expect(check(OWNER_MEMBER_ID, true, ada)).toBe(true);
    expect(check(ada, false, ada)).toBe(false);
  });
});
