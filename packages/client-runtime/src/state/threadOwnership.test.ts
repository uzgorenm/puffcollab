import { type Member, MemberId, OWNER_MEMBER_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canDeleteThreadComment, threadCollaboration } from "./threadOwnership.ts";

const member = (id: string, displayName: string, role: Member["role"] = "member"): Member => ({
  memberId: MemberId.make(id),
  username: id,
  displayName,
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
});
const members = new Map(
  [member("owner", "Owner", "admin"), member("ada", "Ada"), member("bob", "Bob")].map((entry) => [
    entry.memberId,
    entry,
  ]),
);
const ada = MemberId.make("ada");
const bob = MemberId.make("bob");

describe("threadCollaboration", () => {
  it("lets only the owner drive and names them for followers", () => {
    const thread = { createdBy: ada, visibility: "shared" as const };
    expect(threadCollaboration({ thread, currentMemberId: ada, members }).isOwner).toBe(true);
    const followed = threadCollaboration({ thread, currentMemberId: bob, members });
    expect(followed).toMatchObject({ isOwner: false, ownerName: "Ada", shared: true });
  });

  it("treats creator-less threads as the environment owner's and missing visibility as private", () => {
    const legacy = threadCollaboration({ thread: {}, currentMemberId: bob, members });
    expect(legacy).toMatchObject({ ownerId: OWNER_MEMBER_ID, isOwner: false, shared: false });
    expect(legacy.visibility).toBe("private");
    expect(threadCollaboration({ thread: {}, currentMemberId: null, members }).isOwner).toBe(true);
  });

  it("lets authors and admins delete comments", () => {
    const comment = { authorId: bob };
    expect(canDeleteThreadComment({ comment, currentMemberId: bob, members })).toBe(true);
    expect(canDeleteThreadComment({ comment, currentMemberId: ada, members })).toBe(false);
    expect(canDeleteThreadComment({ comment, currentMemberId: OWNER_MEMBER_ID, members })).toBe(
      true,
    );
  });
});
