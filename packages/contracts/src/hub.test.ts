import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import {
  HUB_DENIED_ORCHESTRATION_EVENT_TYPES,
  HUB_PROTOCOL_RANGE,
  HUB_SYNCED_ORCHESTRATION_EVENT_TYPES,
  HUB_THREAD_EVENT_TYPES,
  HubClientFrame,
  HubClientMessage,
  HubEnvironmentLinkId,
  HubLinkTokenResponse,
  HubServerFrame,
  HubServerMessage,
  HubThreadEventBody,
  hubProtocolMismatchSide,
  hubRepositoryKey,
  hubThreadIdOf,
  hubWorkCardOf,
  negotiateHubProtocol,
  parseHubThreadId,
  toHubThreadEventBody,
} from "./hub.ts";
import { OrchestrationEvent, OrchestrationEventType } from "./orchestration.ts";

const at = "2026-10-02T12:00:00.000Z";
const threadId = "link_1:thread-1";
const projectId = "project-1";
const account = { accountId: "acct-1", githubLogin: "uzgorenm", displayName: "Mehmet" };
const cursor = { threadId, generation: 1, seq: 3 };
const summary = {
  threadId,
  projectId,
  ownerId: "acct-1",
  title: "Hub contracts",
  branch: "stage-7-0-contracts",
  status: "working",
  updatedAt: at,
  generation: 1,
  lastSeq: 3,
};
const invitation = {
  invitationId: "inv-1",
  projectId,
  projectTitle: "Puff Collab",
  inviterId: "acct-1",
  inviteeLogin: "teammate",
  inviteeId: null,
  state: "pending",
  createdAt: at,
  expiresAt: at,
  resolvedAt: null,
};
const comment = {
  commentId: "comment-1",
  threadId,
  authorId: "acct-2",
  text: "Looks good",
  createdAt: at,
};
const brief = { projectId, version: 2, text: "Ship the hub", authorId: "acct-1", createdAt: at };
const focus = { projectId, accountId: "acct-1", focus: "contracts", updatedAt: at };
const activity = {
  id: "activity-1",
  projectId,
  kind: "turn-started",
  threadId,
  actorId: null,
  detail: null,
  occurredAt: at,
  sequence: 7,
};
const analysis = { threadId, summary: "Defines the protocol.", updatedAt: at };
const awareness = {
  itemId: "aw-1",
  kind: "note",
  sourceThreadId: threadId,
  sourceThreadTitle: "Hub contracts",
  targetThreadId: "link_2:thread-9",
  text: "Both threads touch hub.ts.",
  citations: [{ threadId, generation: 1, seq: 2 }],
  createdAt: at,
};
const projectState = {
  project: {
    projectId,
    repositoryKey: "github.com/uzgorenm/puffcollab",
    title: "Puff Collab",
    createdBy: "acct-1",
    createdAt: at,
  },
  members: [{ accountId: "acct-1", role: "admin", joinedAt: at, invitedBy: null }],
  accounts: [account],
  brief,
  focuses: [focus],
  activity: [activity],
  threads: [summary],
  analyses: [analysis],
  awareness: [awareness],
  invitations: [invitation],
};
const events = [
  {
    seq: 1,
    occurredAt: at,
    body: {
      type: "thread.summary-set",
      payload: {
        title: "Hub contracts",
        branch: null,
        status: "idle",
        updatedAt: at,
        cooperation: {
          featureTopic: "hub",
          analysisEnabled: false,
          textEnabled: false,
          awarenessNotify: false,
        },
      },
    },
  },
  {
    seq: 2,
    occurredAt: at,
    body: {
      type: "thread.message-sent",
      payload: {
        threadId: "thread-1",
        messageId: "message-1",
        role: "user",
        text: "Write the contracts",
        turnId: null,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    },
  },
  {
    seq: 3,
    occurredAt: at,
    truncated: true,
    body: {
      type: "thread.turn-diff",
      payload: { threadId: "thread-1", turnId: "turn-1", checkpointTurnCount: 1, diff: "+a" },
    },
  },
];

const clientMessages = [
  { type: "hello", protocol: { min: 1, max: 1 }, appVersion: "0.0.44", subscriptions: [cursor] },
  { type: "publish", requestId: "r1", projectId, threadId, reset: true, events },
  { type: "ack", cursors: [cursor] },
  { type: "thread.subscribe", threadId, cursor },
  { type: "thread.unsubscribe", threadId },
  { type: "comment.add", requestId: "r2", threadId, commentId: "comment-1", text: "Nice" },
  { type: "comment.delete", requestId: "r3", threadId, commentId: "comment-1" },
  { type: "brief.update", requestId: "r4", projectId, text: "New brief", expectedVersion: null },
  { type: "focus.set", requestId: "r5", projectId, focus: null },
  { type: "invitation.create", requestId: "r6", projectId, githubLogin: "teammate" },
  { type: "invitation.accept", requestId: "r7", invitationId: "inv-1" },
  { type: "invitation.decline", requestId: "r8", invitationId: "inv-1" },
  { type: "invitation.cancel", requestId: "r9", invitationId: "inv-1" },
  { type: "member.leave", requestId: "r10", projectId },
  { type: "member.remove", requestId: "r11", projectId, accountId: "acct-2" },
  {
    type: "analysis.post",
    requestId: "r12",
    projectId,
    summaries: [analysis],
    awareness: [awareness],
  },
];

const serverMessages = [
  {
    type: "welcome",
    protocolVersion: 1,
    account,
    linkId: "link_1",
    projects: [projectState],
    published: [cursor],
    invitations: [invitation],
    serverTime: at,
  },
  { type: "ack", requestId: "r1", cursor },
  {
    type: "reject",
    requestId: "r1",
    reason: "conflict",
    message: "Expected seq 4.",
    expectedSeq: 4,
  },
  { type: "thread.events", projectId, threadId, generation: 2, reset: true, events },
  { type: "thread.removed", projectId, threadId, reason: "private" },
  { type: "comment.snapshot", projectId, threadId, comments: [comment] },
  { type: "comment.added", projectId, comment },
  { type: "comment.deleted", projectId, threadId, commentId: "comment-1" },
  { type: "team.snapshot", state: projectState },
  { type: "team.removed", projectId, reason: "removed" },
  { type: "team.thread", summary },
  { type: "team.brief", brief },
  { type: "team.focus", projectId, accountId: "acct-1", focus: null },
  { type: "team.activity", projectId, items: [activity] },
  { type: "team.members", projectId, members: projectState.members, accounts: [account] },
  { type: "team.invitations", projectId, invitations: [invitation] },
  { type: "team.analysis", projectId, summaries: [analysis] },
  { type: "team.awareness", projectId, items: [awareness] },
  { type: "invitations", invitations: [invitation] },
];

const decodeClient = Schema.decodeUnknownSync(HubClientMessage);
const encodeClient = Schema.encodeSync(HubClientMessage);
const decodeServer = Schema.decodeUnknownSync(HubServerMessage);
const encodeServer = Schema.encodeSync(HubServerMessage);
const encodeClientFrame = Schema.encodeSync(HubClientFrame);
const decodeClientFrame = Schema.decodeSync(HubClientFrame);
const encodeServerFrame = Schema.encodeSync(HubServerFrame);
const decodeServerFrame = Schema.decodeSync(HubServerFrame);
const decodeLinkToken = Schema.decodeUnknownSync(HubLinkTokenResponse);
const encodeLinkToken = Schema.encodeSync(HubLinkTokenResponse);
const decodeOrchestrationEvent = Schema.decodeUnknownSync(OrchestrationEvent);

describe("hub sync protocol messages", () => {
  it("covers every client message type", () => {
    expect(clientMessages).toHaveLength(HubClientMessage.members.length);
    expect(new Set(clientMessages.map((message) => message.type)).size).toBe(
      HubClientMessage.members.length,
    );
  });

  it("covers every server message type", () => {
    expect(serverMessages).toHaveLength(HubServerMessage.members.length);
    expect(new Set(serverMessages.map((message) => message.type)).size).toBe(
      HubServerMessage.members.length,
    );
  });

  it.each(clientMessages)("round-trips client $type", (message) => {
    expect(encodeClient(decodeClient(message))).toEqual(message);
    const frame = encodeClientFrame(decodeClient(message));
    expect(typeof frame).toBe("string");
    expect(encodeClient(decodeClientFrame(frame))).toEqual(message);
  });

  it.each(serverMessages)("round-trips server $type", (message) => {
    expect(encodeServer(decodeServer(message))).toEqual(message);
    const frame = encodeServerFrame(decodeServer(message));
    expect(encodeServer(decodeServerFrame(frame))).toEqual(message);
  });

  it("round-trips every link token response", () => {
    for (const response of [
      { status: "pending" },
      { status: "denied" },
      { status: "expired" },
      { status: "linked", linkId: "link_1", credential: "opaque", account },
    ]) {
      expect(encodeLinkToken(decodeLinkToken(response))).toEqual(response);
    }
  });

  it("rejects unknown message types and oversized or empty publishes", () => {
    const decode = Schema.decodeUnknownOption(HubClientMessage);
    expect(decode({ type: "thread.delete-everything" })._tag).toBe("None");
    const publish = clientMessages[1]!;
    expect(decode({ ...publish, events: [] })._tag).toBe("None");
    expect(decode({ ...publish, events: Array.from({ length: 101 }, () => events[0]) })._tag).toBe(
      "None",
    );
  });

  it("rejects thread event bodies outside the allowlist", () => {
    const decode = Schema.decodeUnknownOption(HubThreadEventBody);
    expect(
      decode({
        type: "thread.turn-start-requested",
        payload: { threadId: "t", messageId: "m", createdAt: at },
      })._tag,
    ).toBe("None");
  });
});

describe("hub protocol versions", () => {
  it("accepts the current range", () => {
    expect(negotiateHubProtocol(HUB_PROTOCOL_RANGE)).toBe(1);
  });

  it("picks the highest common version when ranges overlap", () => {
    expect(negotiateHubProtocol({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
    expect(negotiateHubProtocol({ min: 2, max: 4 }, { min: 1, max: 2 })).toBe(2);
  });

  it("refuses non-overlapping ranges and names the outdated side", () => {
    expect(negotiateHubProtocol({ min: 1, max: 1 }, { min: 2, max: 3 })).toBeNull();
    expect(hubProtocolMismatchSide({ min: 1, max: 1 }, { min: 2, max: 3 })).toBe("client-outdated");
    expect(negotiateHubProtocol({ min: 4, max: 5 }, { min: 2, max: 3 })).toBeNull();
    expect(hubProtocolMismatchSide({ min: 4, max: 5 }, { min: 2, max: 3 })).toBe("hub-outdated");
    expect(hubProtocolMismatchSide({ min: 1, max: 3 }, { min: 2, max: 3 })).toBeNull();
  });

  it("decodes a version-mismatch reject carrying the hub range", () => {
    const reject = {
      type: "reject",
      requestId: null,
      reason: "version-mismatch",
      message: "Update Puff Collab to sync with this hub.",
      protocol: { min: 2, max: 3 },
    };
    expect(encodeServer(decodeServer(reject))).toEqual(reject);
  });
});

describe("hubRepositoryKey", () => {
  const identity = (remoteUrl: string, canonicalKey = "unused") => ({
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
  });

  it("collapses ssh, https, scp, .git, trailing slash and case", () => {
    for (const url of [
      "git@github.com:UzgorenM/PuffCollab.git",
      "https://github.com/uzgorenm/puffcollab.git",
      "https://github.com/UzgorenM/PuffCollab/",
      "ssh://git@github.com/uzgorenm/puffcollab",
      "https://user:token@github.com/uzgorenm/puffcollab.git",
    ]) {
      expect(hubRepositoryKey(identity(url))).toBe("github.com/uzgorenm/puffcollab");
    }
  });

  it("keeps GitLab subgroups and drops self-hosted ports", () => {
    expect(hubRepositoryKey(identity("git@gitlab.com:Team/Platform/App.git"))).toBe(
      "gitlab.com/team/platform/app",
    );
    expect(hubRepositoryKey(identity("https://gitlab.com/team/platform/app"))).toBe(
      "gitlab.com/team/platform/app",
    );
    expect(hubRepositoryKey(identity("ssh://git@git.example.com:2222/Team/App.git"))).toBe(
      "git.example.com/team/app",
    );
    expect(hubRepositoryKey(identity("gitea@git.example.com:team/app.git"))).toBe(
      "git.example.com/team/app",
    );
  });

  it("falls back to the canonical key, then to null", () => {
    expect(hubRepositoryKey(identity("not a url", "github.com/a/b"))).toBe("github.com/a/b");
    expect(hubRepositoryKey(identity("not a url", "also not"))).toBeNull();
  });
});

describe("hub thread ids and the sync allowlist", () => {
  it("derives and parses thread ids", () => {
    const linkId = HubEnvironmentLinkId.make("link_1");
    const id = hubThreadIdOf(linkId, ThreadId.make("thread:with:colons"));
    expect(id).toBe("link_1:thread:with:colons");
    expect(parseHubThreadId(id)).toEqual({ linkId: "link_1", threadId: "thread:with:colons" });
  });

  it("splits every orchestration event type into synced or denied", () => {
    expect(
      [...HUB_SYNCED_ORCHESTRATION_EVENT_TYPES, ...HUB_DENIED_ORCHESTRATION_EVENT_TYPES].toSorted(),
    ).toEqual([...OrchestrationEventType.literals].toSorted());
    expect(HUB_DENIED_ORCHESTRATION_EVENT_TYPES).toContain("thread.comment-added");
    expect(HUB_DENIED_ORCHESTRATION_EVENT_TYPES).toContain("thread.user-input-response-requested");
    expect(HUB_DENIED_ORCHESTRATION_EVENT_TYPES).toContain("project.created");
    expect(HubThreadEventBody.members).toHaveLength(HUB_THREAD_EVENT_TYPES.length);
  });

  it("keeps only allowlisted orchestration events", () => {
    const base = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const decode = decodeOrchestrationEvent;
    const visibility = decode({
      ...base,
      type: "thread.visibility-set",
      payload: { threadId: "thread-1", visibility: "private", updatedAt: at },
    });
    expect(toHubThreadEventBody(visibility)?.type).toBe("thread.visibility-set");
    const comment = decode({
      ...base,
      type: "thread.comment-added",
      payload: { threadId: "thread-1", commentId: "c", text: "hi", createdAt: at },
    });
    expect(toHubThreadEventBody(comment)).toBeNull();
  });

  it("derives a work card from a summary", () => {
    const decoded = decodeServer({ type: "team.thread", summary });
    if (decoded.type !== "team.thread") throw new Error("unexpected");
    expect(hubWorkCardOf(decoded.summary)).toMatchObject({
      threadId,
      ownerId: "acct-1",
      lastActivityAt: at,
      analysis: null,
    });
  });
});
