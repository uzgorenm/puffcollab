// @effect-diagnostics nodeBuiltinImport:off - a temp directory for the restart test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HUB_PING, HUB_SYNC_LIMITS } from "@t3tools/contracts/hub";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  TestHub,
  WORKER_NAME,
  deletedEvent,
  messageEvent,
  summaryEvent,
  visibilityEvent,
} from "./harness.ts";

let hub: TestHub;
beforeAll(async () => {
  hub = await TestHub.start();
});
afterAll(async () => {
  await hub?.dispose();
});

let teamCounter = 0;

/** An owner with a project, a member who accepted an invitation, and an outsider. */
const team = async () => {
  teamCounter += 1;
  const prefix = `t${teamCounter}`;
  const owner = await hub.member(`${prefix}-owner`);
  const project = (await hub.linkProject(owner.link.credential, `github.com/acme/${prefix}`)).body
    .project;
  await owner.client.nextOfType("team.snapshot");
  const mate = await hub.member(`${prefix}-mate`);
  await owner.client.request({
    type: "invitation.create",
    projectId: project.projectId,
    githubLogin: `${prefix}-mate`,
  });
  const incoming = await mate.client.nextOfType("invitations", (m) => m.invitations.length > 0);
  const accepted = await mate.client.request({
    type: "invitation.accept",
    invitationId: incoming.invitations[0].invitationId,
  });
  expect(accepted.type).toBe("ack");
  await mate.client.nextOfType("team.snapshot");
  await owner.client.nextOfType("team.members", (m) => m.members.length === 2);
  const outsider = await hub.member(`${prefix}-outsider`);
  return { owner, mate, outsider, projectId: project.projectId as string };
};

const publish = (
  client: Awaited<ReturnType<typeof hub.member>>["client"],
  projectId: string,
  threadId: string,
  events: ReadonlyArray<unknown>,
  reset?: boolean,
) =>
  client.request({
    type: "publish",
    projectId,
    threadId,
    events,
    ...(reset ? { reset: true } : {}),
  });

describe("publishing", () => {
  it("accepts contiguous events, acks re-publishes, rejects gaps, and resets generations", async () => {
    const { owner, mate, projectId } = await team();
    const threadId = `${owner.linkId}:thread-1`;

    const noSummary = await publish(owner.client, projectId, threadId, [
      messageEvent(1, "thread-1"),
    ]);
    expect(noSummary).toMatchObject({ type: "reject", reason: "invalid" });
    const notFromOne = await publish(owner.client, projectId, threadId, [summaryEvent(2)]);
    expect(notFromOne).toMatchObject({ type: "reject", reason: "conflict", expectedSeq: 1 });

    const first = await publish(owner.client, projectId, threadId, [
      summaryEvent(1),
      messageEvent(2, "thread-1"),
    ]);
    expect(first).toMatchObject({ type: "ack", cursor: { threadId, generation: 1, seq: 2 } });
    const listed = await mate.client.nextOfType("team.thread");
    expect(listed.summary).toMatchObject({
      threadId,
      ownerId: owner.accountId,
      generation: 1,
      lastSeq: 2,
    });

    mate.client.send({ type: "thread.subscribe", threadId });
    await mate.client.nextOfType("comment.snapshot", (m) => m.threadId === threadId);
    const initial = await mate.client.nextOfType("thread.events", (m) => m.threadId === threadId);
    expect(initial.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);

    const overlap = await publish(owner.client, projectId, threadId, [
      messageEvent(2, "thread-1"),
      messageEvent(3, "thread-1"),
    ]);
    expect(overlap).toMatchObject({ type: "ack", cursor: { seq: 3 } });
    const replay = await publish(owner.client, projectId, threadId, [messageEvent(3, "thread-1")]);
    expect(replay).toMatchObject({ type: "ack", cursor: { seq: 3 } });
    const delta = await mate.client.nextOfType("thread.events", (m) => m.threadId === threadId);
    expect(delta.events.map((event: { seq: number }) => event.seq)).toEqual([3]);

    const gap = await publish(owner.client, projectId, threadId, [messageEvent(5, "thread-1")]);
    expect(gap).toMatchObject({ type: "reject", reason: "conflict", expectedSeq: 4 });
    const jumbled = await publish(owner.client, projectId, threadId, [
      messageEvent(4, "thread-1"),
      messageEvent(6, "thread-1"),
    ]);
    expect(jumbled).toMatchObject({ type: "reject", reason: "invalid" });

    const reset = await publish(
      owner.client,
      projectId,
      threadId,
      [messageEvent(1, "thread-1", "fresh")],
      true,
    );
    expect(reset).toMatchObject({ type: "ack", cursor: { generation: 2, seq: 1 } });
    const rebuilt = await mate.client.nextOfType(
      "thread.events",
      (m) => m.threadId === threadId && m.reset,
    );
    expect(rebuilt).toMatchObject({ generation: 2 });
    expect(rebuilt.events[0].body.payload.text).toBe("fresh");
    const relisted = await mate.client.nextOfType("team.thread", (m) => m.summary.generation === 2);
    expect(relisted.summary.title).toBe("Fix login");

    // A reconnect resumes from the published cursor in `welcome`.
    owner.client.close();
    const again = await hub.connect(owner.link.credential);
    const welcome = await again.hello();
    expect(welcome.published).toEqual([{ threadId, generation: 2, seq: 1 }]);
  });

  it("only the thread's own link may publish to it, and only members may publish at all", async () => {
    const { owner, mate, outsider, projectId } = await team();
    const ownersThread = `${owner.linkId}:t`;
    const hijack = await publish(mate.client, projectId, ownersThread, [summaryEvent(1)]);
    expect(hijack).toMatchObject({ type: "reject", reason: "forbidden" });
    const outside = await publish(outsider.client, projectId, `${outsider.linkId}:t`, [
      summaryEvent(1),
    ]);
    expect(outside).toMatchObject({ type: "reject", reason: "forbidden" });
  });

  it("removes the mirror on private or deleted and tells subscribers", async () => {
    const { owner, mate, projectId } = await team();
    const privateThread = `${owner.linkId}:p`;
    const deletedThread = `${owner.linkId}:d`;
    await publish(owner.client, projectId, privateThread, [summaryEvent(1), messageEvent(2, "p")]);
    await publish(owner.client, projectId, deletedThread, [summaryEvent(1)]);
    mate.client.send({ type: "thread.subscribe", threadId: privateThread });
    await mate.client.nextOfType("thread.events", (m) => m.threadId === privateThread);
    const comment = await mate.client.request({
      type: "comment.add",
      threadId: privateThread,
      commentId: "c-private",
      text: "nice",
    });
    expect(comment.type).toBe("ack");

    expect(
      await publish(owner.client, projectId, privateThread, [visibilityEvent(3, "p", "private")]),
    ).toMatchObject({
      type: "ack",
      cursor: { seq: 3 },
    });
    expect(
      await mate.client.nextOfType("thread.removed", (m) => m.threadId === privateThread),
    ).toMatchObject({
      reason: "private",
      projectId,
    });
    await publish(owner.client, projectId, deletedThread, [deletedEvent(2, "d")]);
    expect(
      await mate.client.nextOfType("thread.removed", (m) => m.threadId === deletedThread),
    ).toMatchObject({
      reason: "deleted",
    });

    // Gone for late subscribers too, and a re-share starts a new generation.
    mate.client.send({ type: "thread.subscribe", threadId: privateThread });
    expect(
      await mate.client.nextOfType("thread.removed", (m) => m.threadId === privateThread),
    ).toMatchObject({
      reason: "private",
    });
    const reshared = await publish(owner.client, projectId, privateThread, [summaryEvent(1)]);
    expect(reshared).toMatchObject({ type: "ack", cursor: { generation: 2, seq: 1 } });
    mate.client.send({ type: "thread.subscribe", threadId: privateThread });
    expect(
      (await mate.client.nextOfType("comment.snapshot", (m) => m.threadId === privateThread))
        .comments,
    ).toEqual([]);
  });
});

describe("authorization", () => {
  it("non-members see nothing of the project", async () => {
    const { owner, outsider, projectId } = await team();
    const threadId = `${owner.linkId}:secret`;
    await publish(owner.client, projectId, threadId, [summaryEvent(1)]);

    const fresh = await hub.connect(outsider.link.credential);
    const welcome = await fresh.hello([{ threadId, generation: 1, seq: 0 }]);
    expect(welcome.projects).toEqual([]);
    expect(await fresh.nextOfType("thread.removed")).toMatchObject({
      threadId,
      reason: "access-lost",
    });

    fresh.send({ type: "thread.subscribe", threadId });
    expect(await fresh.nextOfType("reject")).toMatchObject({ reason: "forbidden" });
    for (const message of [
      { type: "comment.add", threadId, commentId: "c-x", text: "hi" },
      { type: "brief.update", projectId, text: "mine now", expectedVersion: null },
      { type: "focus.set", projectId, focus: "lurking" },
      { type: "invitation.create", projectId, githubLogin: "friend" },
    ]) {
      expect(await fresh.request(message)).toMatchObject({ type: "reject", reason: "forbidden" });
    }
  });

  it("admins remove members, the creator stays, and removed members lose their threads", async () => {
    const { owner, mate, projectId } = await team();
    const matesThread = `${mate.linkId}:m`;
    await publish(mate.client, projectId, matesThread, [summaryEvent(1)]);
    await owner.client.nextOfType("team.thread", (m) => m.summary.threadId === matesThread);

    expect(
      await mate.client.request({ type: "member.remove", projectId, accountId: owner.accountId }),
    ).toMatchObject({
      reason: "forbidden",
    });
    expect(await owner.client.request({ type: "member.leave", projectId })).toMatchObject({
      reason: "forbidden",
    });
    expect(
      await owner.client.request({ type: "member.remove", projectId, accountId: owner.accountId }),
    ).toMatchObject({ reason: "forbidden" });

    expect(
      await owner.client.request({ type: "member.remove", projectId, accountId: mate.accountId }),
    ).toMatchObject({
      type: "ack",
    });
    expect(await mate.client.nextOfType("team.removed")).toMatchObject({
      projectId,
      reason: "removed",
    });
    expect(
      await owner.client.nextOfType("thread.removed", (m) => m.threadId === matesThread),
    ).toMatchObject({
      reason: "access-lost",
    });
    expect(await publish(mate.client, projectId, matesThread, [summaryEvent(1)])).toMatchObject({
      reason: "forbidden",
    });
  });
});

describe("members", () => {
  it("lists members with their accounts and updates everyone when one leaves", async () => {
    const { owner, mate, projectId } = await team();
    const joined = owner.client.received.findLast(
      (message) => message.type === "team.members" && message.members.length === 2,
    );
    expect(
      joined?.members.map((member: { accountId: string; role: string }) => [
        member.accountId,
        member.role,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [owner.accountId, "admin"],
        [mate.accountId, "member"],
      ]),
    );
    const accountIds = new Set(
      joined?.accounts.map((account: { accountId: string }) => account.accountId),
    );
    expect(accountIds.has(owner.accountId) && accountIds.has(mate.accountId)).toBe(true);

    expect(await mate.client.request({ type: "member.leave", projectId })).toMatchObject({
      type: "ack",
    });
    expect(await mate.client.nextOfType("team.removed")).toMatchObject({
      projectId,
      reason: "left",
    });
    const members = await owner.client.nextOfType("team.members", (m) => m.members.length === 1);
    expect(members.members[0]?.accountId).toBe(owner.accountId);
  });
});

describe("comments and brief", () => {
  it("comments are idempotent, reach the owner, and only their author deletes them", async () => {
    const { owner, mate, projectId } = await team();
    const threadId = `${owner.linkId}:c`;
    await publish(owner.client, projectId, threadId, [summaryEvent(1)]);
    const add = { type: "comment.add", threadId, commentId: "c-1", text: "Looks good" };
    expect(await mate.client.request(add)).toMatchObject({ type: "ack" });
    expect(await mate.client.request(add)).toMatchObject({ type: "ack" });
    const added = await owner.client.nextOfType("comment.added");
    expect(added.comment).toMatchObject({
      commentId: "c-1",
      authorId: mate.accountId,
      text: "Looks good",
    });

    expect(
      await owner.client.request({
        type: "comment.add",
        threadId,
        commentId: "c-1",
        text: "taken",
      }),
    ).toMatchObject({ reason: "conflict" });
    expect(
      await owner.client.request({ type: "comment.delete", threadId, commentId: "c-1" }),
    ).toMatchObject({
      reason: "forbidden",
    });
    expect(
      await mate.client.request({ type: "comment.delete", threadId, commentId: "c-1" }),
    ).toMatchObject({
      type: "ack",
    });
    expect(await owner.client.nextOfType("comment.deleted")).toMatchObject({ commentId: "c-1" });

    // The owner's server gets a comment snapshot for its own threads on reconnect.
    await mate.client.request({ type: "comment.add", threadId, commentId: "c-2", text: "Second" });
    const back = await hub.connect(owner.link.credential);
    await back.hello();
    expect(
      (await back.nextOfType("comment.snapshot", (m) => m.threadId === threadId)).comments,
    ).toMatchObject([{ commentId: "c-2" }]);
  });

  it("brief updates need the current version", async () => {
    const { owner, mate, projectId } = await team();
    expect(
      await owner.client.request({
        type: "brief.update",
        projectId,
        text: "Ship v1",
        expectedVersion: null,
      }),
    ).toMatchObject({ type: "ack" });
    expect((await mate.client.nextOfType("team.brief")).brief).toMatchObject({
      version: 1,
      text: "Ship v1",
      authorId: owner.accountId,
    });
    expect(
      await mate.client.request({
        type: "brief.update",
        projectId,
        text: "Stale",
        expectedVersion: null,
      }),
    ).toMatchObject({ type: "reject", reason: "conflict", currentVersion: 1 });
    expect(
      await mate.client.request({
        type: "brief.update",
        projectId,
        text: "Ship v2",
        expectedVersion: 1,
      }),
    ).toMatchObject({ type: "ack" });
    expect(
      (await owner.client.nextOfType("team.activity", (m) => m.items[0]?.kind === "brief-updated"))
        .items[0],
    ).toMatchObject({
      actorId: owner.accountId,
    });

    expect(
      await mate.client.request({ type: "focus.set", projectId, focus: "Auth flow" }),
    ).toMatchObject({
      type: "ack",
    });
    expect((await owner.client.nextOfType("team.focus")).focus).toMatchObject({
      accountId: mate.accountId,
      focus: "Auth flow",
    });
  });
});

describe("invitations", () => {
  it("runs create, decline, cancel and the pending cap", async () => {
    const { owner, projectId } = await team();
    const declined = await hub.member(`${projectId}-decl`.slice(-30).replace(/[^a-z0-9-]/gi, "x"));
    const login = declined.welcome.account.githubLogin;
    await owner.client.request({ type: "invitation.create", projectId, githubLogin: login });
    expect(
      await owner.client.request({ type: "invitation.create", projectId, githubLogin: login }),
    ).toMatchObject({
      type: "ack",
    });
    const incoming = await declined.client.nextOfType(
      "invitations",
      (m) => m.invitations.length === 1,
    );
    const invitationId = incoming.invitations[0].invitationId;
    expect(await owner.client.request({ type: "invitation.accept", invitationId })).toMatchObject({
      reason: "forbidden",
    });
    expect(
      await declined.client.request({ type: "invitation.decline", invitationId }),
    ).toMatchObject({ type: "ack" });
    expect(
      await declined.client.nextOfType("invitations", (m) => m.invitations.length === 0),
    ).toBeTruthy();
    expect(
      await declined.client.request({ type: "invitation.accept", invitationId }),
    ).toMatchObject({
      reason: "conflict",
    });

    // Cancel: the inviter (or an admin) only.
    await owner.client.request({
      type: "invitation.create",
      projectId,
      githubLogin: "someone-else",
    });
    const listed = await owner.client.nextOfType("team.invitations", (m) =>
      m.invitations.some(
        (invitation: { inviteeLogin: string }) => invitation.inviteeLogin === "someone-else",
      ),
    );
    const cancelId = listed.invitations.find(
      (invitation: { inviteeLogin: string }) => invitation.inviteeLogin === "someone-else",
    ).invitationId;
    expect(
      await owner.client.request({ type: "invitation.cancel", invitationId: cancelId }),
    ).toMatchObject({
      type: "ack",
    });

    // Cap: 20 pending per inviter, across projects. Fill it directly (writes are rate-limited).
    const db = await hub.db();
    const { results } = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM invitations WHERE inviter_id = ? AND state = 'pending'",
      )
      .bind(owner.accountId)
      .all<{ count: number }>();
    for (let index = results[0]!.count; index < 20; index += 1) {
      await db
        .prepare(
          `INSERT INTO invitations (invitation_id, project_id, inviter_id, invitee_login, invitee_login_key, invitee_id, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'pending', '2026-10-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
        )
        .bind(
          `inv-fill-${teamCounter}-${index}`,
          projectId,
          owner.accountId,
          `fill-${index}`,
          `fill-${index}`,
        )
        .run();
    }
    expect(
      await owner.client.request({
        type: "invitation.create",
        projectId,
        githubLogin: `cap-${teamCounter}-x`,
      }),
    ).toMatchObject({ type: "reject", reason: "conflict" });

    // Expiry frees the cap.
    await db
      .prepare(
        "UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND state = 'pending'",
      )
      .bind(projectId)
      .run();
    expect(
      await owner.client.request({
        type: "invitation.create",
        projectId,
        githubLogin: `cap-${teamCounter}-y`,
      }),
    ).toMatchObject({ type: "ack" });
  });
});

describe("limits and protocol", () => {
  it("rejects oversized frames and events, and caps fields server-side", async () => {
    const { owner, projectId } = await team();
    const threadId = `${owner.linkId}:big`;
    owner.client.send("x".repeat(HUB_SYNC_LIMITS.frameMaxBytes + 1));
    expect(await owner.client.nextOfType("reject")).toMatchObject({
      reason: "invalid",
      requestId: null,
    });

    await publish(owner.client, projectId, threadId, [summaryEvent(1)]);
    // Too big even after redaction caps every field → dropped by the hub.
    const hugeActivity = {
      seq: 2,
      occurredAt: "2026-10-01T12:00:00.000Z",
      body: {
        type: "thread.turn-diff-completed",
        payload: {
          threadId: "big",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/1",
          status: "ready",
          files: Array.from({ length: 1000 }, (_, index) => ({
            path: `${"p".repeat(300)}/${index}.ts`,
            kind: "modified",
            additions: 1,
            deletions: 1,
          })),
          assistantMessageId: null,
          completedAt: "2026-10-01T12:00:00.000Z",
        },
      },
    };
    const tooBig = await publish(owner.client, projectId, threadId, [hugeActivity]);
    expect(tooBig).toMatchObject({ type: "reject", reason: "invalid" });
    expect(tooBig.message).toContain("HUB_SYNC_LIMITS");

    // A client that skipped redaction still can't store more than messageTextMaxBytes.
    const longText = "y".repeat(HUB_SYNC_LIMITS.messageTextMaxBytes + 5_000);
    expect(
      await publish(owner.client, projectId, threadId, [messageEvent(2, "big", longText)]),
    ).toMatchObject({
      type: "ack",
    });
    const reader = await hub.connect(owner.link.credential);
    await reader.hello([{ threadId, generation: 1, seq: 1 }]);
    const events = await reader.nextOfType("thread.events", (m) => m.threadId === threadId);
    expect(events.events[0].truncated).toBe(true);
    expect(
      new TextEncoder().encode(events.events[0].body.payload.text).byteLength,
    ).toBeLessThanOrEqual(HUB_SYNC_LIMITS.messageTextMaxBytes);
  });

  it("answers raw pings without the JSON protocol", async () => {
    const client = await hub.connect((await hub.member("pinger")).link.credential);
    await client.hello();
    client.send(HUB_PING);
    expect(await client.next((m) => m.type === ("raw" as never))).toMatchObject({ data: "pong" });
  });

  it("closes with 4426 on a protocol mismatch and 4400 without hello", async () => {
    const { link } = await hub.member("versioner");
    const old = await hub.connect(link.credential);
    old.send({ type: "hello", protocol: { min: 99, max: 100 }, subscriptions: [] });
    expect(await old.nextOfType("reject")).toMatchObject({
      reason: "version-mismatch",
      protocol: { min: 1, max: 1 },
    });
    expect((await old.waitClosed()).code).toBe(4426);

    const rude = await hub.connect(link.credential);
    rude.send({ type: "ack", cursors: [] });
    expect((await rude.waitClosed()).code).toBe(4400);
  });

  it("a newer socket for the same link replaces the older one with 4409", async () => {
    const member = await hub.member("replaced");
    const newer = await hub.connect(member.link.credential);
    expect((await member.client.waitClosed()).code).toBe(4409);
    const welcome = await newer.hello();
    expect(welcome.linkId).toBe(member.linkId);
  });

  it("rate-limits bursts of writes", async () => {
    const { owner, projectId } = await team();
    let limited: Record<string, unknown> | null = null;
    for (let index = 0; index < 40 && !limited; index += 1) {
      const reply = await owner.client.request({
        type: "focus.set",
        projectId,
        focus: `focus ${index}`,
      });
      if (reply.type === "reject") limited = reply;
    }
    expect(limited).toMatchObject({ reason: "rate-limited" });
    expect(limited?.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("hibernation-safe state", () => {
  it("keeps streaming after both Durable Objects are evicted with sockets hibernated", async () => {
    const { owner, mate, projectId } = await team();
    const threadId = `${owner.linkId}:h`;
    await publish(owner.client, projectId, threadId, [summaryEvent(1)]);
    mate.client.send({ type: "thread.subscribe", threadId });
    await mate.client.nextOfType("thread.events", (m) => m.threadId === threadId);

    for (const [className, name] of [
      ["ProjectHub", projectId],
      ["SyncSession", owner.linkId],
      ["SyncSession", mate.linkId],
    ] as const) {
      await hub.mf.unsafeEvictDurableObject(WORKER_NAME, className, {
        name,
        webSockets: "hibernate",
      });
    }

    expect(await publish(owner.client, projectId, threadId, [messageEvent(2, "h")])).toMatchObject({
      type: "ack",
      cursor: { generation: 1, seq: 2 },
    });
    const delta = await mate.client.nextOfType("thread.events", (m) => m.threadId === threadId);
    expect(delta.events.map((event: { seq: number }) => event.seq)).toEqual([2]);
    expect(await publish(owner.client, projectId, threadId, [messageEvent(4, "h")])).toMatchObject({
      expectedSeq: 3,
    });
  });

  it("rebuilds from storage after a full restart", async () => {
    const persistDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "puffcollab-hub-persist-"),
    );
    const first = await TestHub.start({ persistDir });
    const owner = await first.member("persist-owner");
    const project = (await first.linkProject(owner.link.credential, "github.com/acme/persist")).body
      .project;
    await owner.client.nextOfType("team.snapshot");
    const threadId = `${owner.linkId}:keep`;
    await owner.client.request({
      type: "publish",
      projectId: project.projectId,
      threadId,
      events: [summaryEvent(1, { title: "Persisted" }), messageEvent(2, "keep")],
    });
    await owner.client.request({
      type: "brief.update",
      projectId: project.projectId,
      text: "Kept",
      expectedVersion: null,
    });
    owner.client.close();
    await first.dispose();

    const second = await TestHub.start({ persistDir, migrate: false });
    try {
      const client = await second.connect(owner.link.credential);
      const welcome = await client.hello();
      expect(welcome.published).toEqual([{ threadId, generation: 1, seq: 2 }]);
      expect(welcome.projects[0]).toMatchObject({
        brief: { version: 1, text: "Kept" },
        threads: [{ threadId, title: "Persisted", lastSeq: 2 }],
      });
      expect(
        await client.request({
          type: "publish",
          projectId: project.projectId,
          threadId,
          events: [messageEvent(3, "keep")],
        }),
      ).toMatchObject({ type: "ack", cursor: { seq: 3 } });
    } finally {
      await second.dispose();
      NodeFS.rmSync(persistDir, { recursive: true, force: true });
    }
  });
});
