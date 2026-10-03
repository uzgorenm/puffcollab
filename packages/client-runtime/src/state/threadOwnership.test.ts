import {
  HubAccountId,
  HubThreadId,
  type HubThreadLink,
  type Member,
  MemberId,
  OWNER_MEMBER_ID,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteThreadComment,
  threadCollaboration,
  threadCollaborationView,
} from "./threadOwnership.ts";

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

const hubLink = (overrides: Partial<HubThreadLink> = {}): HubThreadLink => ({
  threadId: HubThreadId.make("link-1:thread-1"),
  ownerId: HubAccountId.make("acct-ada"),
  ownerLogin: "ada-l",
  ownerDisplayName: "Ada Lovelace",
  remote: true,
  syncState: "synced",
  ...overrides,
});

describe("threadCollaboration with the team hub", () => {
  it("follows a remote hub thread and names its hub owner, even for the local owner", () => {
    const thread = { createdBy: null, hub: hubLink() };
    for (const currentMemberId of [null, OWNER_MEMBER_ID, ada]) {
      expect(threadCollaboration({ thread, currentMemberId, members })).toMatchObject({
        isOwner: false,
        ownerName: "Ada Lovelace",
        shared: true,
        visibility: "shared",
        remote: true,
        hubSync: null,
      });
    }
  });

  it("falls back to the GitHub login when the display name is empty", () => {
    const thread = { hub: hubLink({ ownerDisplayName: "" }) };
    expect(threadCollaboration({ thread, currentMemberId: null, members }).ownerName).toBe("ada-l");
  });

  it("shows sync state only on the viewer's own shared hub thread", () => {
    const own = {
      visibility: "shared" as const,
      hub: hubLink({ remote: false, syncState: "pending" }),
    };
    expect(threadCollaboration({ thread: own, currentMemberId: null, members })).toMatchObject({
      isOwner: true,
      remote: false,
      hubSync: { state: "pending" },
    });
    const privateThread = { visibility: "private" as const, hub: hubLink({ remote: false }) };
    expect(
      threadCollaboration({ thread: privateThread, currentMemberId: null, members }).hubSync,
    ).toBeNull();
    expect(threadCollaboration({ thread: {}, currentMemberId: null, members }).hubSync).toBeNull();
  });

  it("enables team controls on hub projects and never grants admin housekeeping on mirrors", () => {
    const solo = new Map<MemberId, Member>();
    expect(
      threadCollaborationView({ thread: {}, currentMemberId: null, members: solo }).teamEnabled,
    ).toBe(false);
    expect(
      threadCollaborationView({
        thread: {},
        currentMemberId: null,
        members: solo,
        projectOnHub: true,
      }).teamEnabled,
    ).toBe(true);
    const remote = threadCollaborationView({
      thread: { hub: hubLink() },
      currentMemberId: null,
      members: solo,
    });
    expect(remote).toMatchObject({ teamEnabled: true, isAdmin: false, isOwner: false });
    expect(
      threadCollaborationView({ thread: {}, currentMemberId: OWNER_MEMBER_ID, members }).isAdmin,
    ).toBe(true);
  });
});
