import {
  HubAccountId,
  HubThreadId,
  type HubThreadLink,
  MemberId,
  OWNER_MEMBER_ID,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteThreadComment,
  threadCollaboration,
  threadCollaborationView,
  threadCommentAuthorName,
} from "./threadOwnership.ts";

const ME = HubAccountId.make("acct-me");
const mirror: HubThreadLink = {
  threadId: HubThreadId.make("link-ada:t1"),
  ownerId: HubAccountId.make("acct-ada"),
  ownerLogin: "ada-l",
  ownerDisplayName: "",
  remote: true,
  syncState: "synced",
};

describe("threadCollaboration", () => {
  it("owns every local thread and follows teammates' mirrors", () => {
    expect(threadCollaboration({ thread: { visibility: "private" } })).toMatchObject({
      isOwner: true,
      remote: false,
      shared: false,
    });
    expect(threadCollaboration({ thread: { hub: mirror } })).toMatchObject({
      isOwner: false,
      remote: true,
      shared: true,
      ownerName: "ada-l",
      hubSync: null,
    });
  });

  it("shows the sync marker only on the viewer's own shared thread", () => {
    const own = { visibility: "shared" as const, hub: { ...mirror, remote: false } };
    expect(threadCollaboration({ thread: own }).hubSync?.state).toBe("synced");
    expect(threadCollaboration({ thread: { ...own, visibility: "private" } }).hubSync).toBeNull();
    expect(threadCollaboration({ thread: {} }).hubSync).toBeNull();
  });

  it("enables team controls only on the hub", () => {
    expect(threadCollaborationView({ thread: {} }).teamEnabled).toBe(false);
    expect(threadCollaborationView({ thread: {}, projectOnHub: true }).teamEnabled).toBe(true);
    expect(threadCollaborationView({ thread: { hub: mirror } }).teamEnabled).toBe(true);
  });
});

describe("canDeleteThreadComment", () => {
  it("deletes local comments and the viewer's own hub comments only", () => {
    expect(
      canDeleteThreadComment({ comment: { authorId: OWNER_MEMBER_ID }, viewerHubAccountId: null }),
    ).toBe(true);
    const own = { authorId: MemberId.make(`hub:${ME}`) };
    expect(canDeleteThreadComment({ comment: own, viewerHubAccountId: ME })).toBe(true);
    expect(canDeleteThreadComment({ comment: own, viewerHubAccountId: null })).toBe(false);
    expect(
      canDeleteThreadComment({
        comment: { authorId: MemberId.make("hub:acct-ada") },
        viewerHubAccountId: ME,
      }),
    ).toBe(false);
  });
});

describe("threadCommentAuthorName", () => {
  it("names the viewer, hub teammates, and pre-hub members", () => {
    const hubAuthor = {
      accountId: HubAccountId.make("acct-ada"),
      githubLogin: "ada",
      displayName: "Ada",
    };
    expect(
      threadCommentAuthorName({ comment: { authorId: OWNER_MEMBER_ID }, viewerHubAccountId: null }),
    ).toBe("You");
    expect(
      threadCommentAuthorName({
        comment: { authorId: MemberId.make("hub:acct-ada"), hubAuthor },
        viewerHubAccountId: ME,
      }),
    ).toBe("Ada");
    expect(
      threadCommentAuthorName({
        comment: {
          authorId: MemberId.make(`hub:${ME}`),
          hubAuthor: { ...hubAuthor, accountId: ME },
        },
        viewerHubAccountId: ME,
      }),
    ).toBe("You");
    expect(
      threadCommentAuthorName({
        comment: { authorId: MemberId.make("m-1") },
        viewerHubAccountId: ME,
      }),
    ).toBe("A former member");
  });
});
