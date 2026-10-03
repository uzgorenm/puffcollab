import {
  HUB_SYNC_LIMITS,
  HUB_TRUNCATION_MARKER,
  HubThreadEvent,
  type HubThreadEventBody,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { redactForHub, redactSecretText, truncateUtf8, utf8ByteLength } from "./hubRedaction.ts";

const at = "2026-10-02T12:00:00.000Z";
const context = {
  workspaceRoots: ["/Users/alice/code/app", "/Users/alice/.t3/worktrees/app/feature"],
  homeDirs: ["/Users/alice"],
};
const decodeEvent = Schema.decodeUnknownSync(HubThreadEvent);
const decodeBody = (body: unknown) => decodeEvent({ seq: 1, occurredAt: at, body }).body;

const SECRETS = [
  "sk-ant-api03-abcdefghijklmnop",
  "ghp_abcdefghijklmnopqrstuvwxyz012345",
  "AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P",
  "hunter2-password-value",
];

const message = (text: string): HubThreadEventBody =>
  decodeBody({
    type: "thread.message-sent",
    payload: {
      threadId: "thread-1",
      messageId: "message-1",
      role: "assistant",
      text,
      attachments: [
        {
          type: "image",
          id: "att-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          source: {
            kind: "snap-shot",
            capturedAt: at,
            appName: "Mail",
            windowTitle: "Private inbox",
          },
        },
      ],
      context: { version: 1, records: [] },
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });

const activity = (payload: unknown): HubThreadEventBody =>
  decodeBody({
    type: "thread.activity-appended",
    payload: {
      threadId: "thread-1",
      activity: {
        id: "event-1",
        tone: "tool",
        kind: "tool.completed",
        summary: "Ran a command in /Users/alice/code/app",
        payload,
        turnId: null,
        createdAt: at,
      },
    },
  });

describe("redactSecretText", () => {
  it("masks sample secrets, paths and pairing links", () => {
    const input = [
      `ANTHROPIC_API_KEY=${SECRETS[0]}`,
      `token: ${SECRETS[1]}`,
      `aws ${SECRETS[2]}`,
      `Authorization: Bearer ${SECRETS[3]}`,
      `password=${SECRETS[4]}`,
      "https://bob:pa55word@example.com/repo.git",
      "open https://host.example/pair#token=abc",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      "edit /Users/alice/code/app/src/main.ts and /Users/alice/.ssh/config",
    ].join("\n");
    const output = redactSecretText(input, context);
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).not.toContain("pa55word");
    expect(output).not.toContain("MIIabc");
    expect(output).not.toContain("/Users/alice");
    expect(output).toContain("[pairing-url]");
    expect(output).toContain("./src/main.ts");
    expect(output).toContain("~/.ssh/config");
  });

  it("rewrites a worktree under a home directory as the workspace", () => {
    expect(redactSecretText("/Users/alice/.t3/worktrees/app/feature/a.ts", context)).toBe("./a.ts");
  });
});

describe("truncateUtf8", () => {
  it("cuts on a character boundary and appends the marker", () => {
    const cut = truncateUtf8("ééééééééééééééééééééééééééééééééééééééééé", 40);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith(HUB_TRUNCATION_MARKER)).toBe(true);
    expect(utf8ByteLength(cut.text)).toBeLessThanOrEqual(40);
    expect(cut.text).not.toContain("�");
    expect(truncateUtf8("short", 40)).toEqual({ text: "short", truncated: false });
  });
});

describe("redactForHub", () => {
  it("redacts message text and strips context and attachment sources", () => {
    const result = redactForHub(
      message(`use ${SECRETS[0]} from /Users/alice/code/app/.env`),
      context,
    );
    if (result?.body.type !== "thread.message-sent") throw new Error("expected a message");
    expect(result.body.payload.text).toBe("use [redacted] from ./.env");
    expect(result.body.payload.context).toBeUndefined();
    expect(result.body.payload.attachments?.[0]).not.toHaveProperty("source");
    expect(result.truncated).toBe(false);
  });

  it("caps message text with the truncation marker", () => {
    const result = redactForHub(
      message("x".repeat(HUB_SYNC_LIMITS.messageTextMaxBytes + 10)),
      context,
    );
    if (result?.body.type !== "thread.message-sent") throw new Error("expected a message");
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.body.payload.text)).toBeLessThanOrEqual(
      HUB_SYNC_LIMITS.messageTextMaxBytes,
    );
    expect(result.body.payload.text.endsWith(HUB_TRUNCATION_MARKER)).toBe(true);
  });

  it("denies secret keys and redacts strings in tool payloads", () => {
    const result = redactForHub(
      activity({
        command: `curl -H "Authorization: Bearer ${SECRETS[3]}" https://api.example.com`,
        env: { OPENAI_API_KEY: SECRETS[0] },
        nested: [{ apiKey: SECRETS[1], output: "ok" }],
      }),
      context,
    );
    if (result?.body.type !== "thread.activity-appended") throw new Error("expected activity");
    const serialized = JSON.stringify(result.body);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(result.body.payload.activity.payload).toEqual({
      command: 'curl -H "Authorization: [redacted] [redacted]" https://api.example.com',
      env: "[redacted]",
      nested: [{ apiKey: "[redacted]", output: "ok" }],
    });
    expect(result.body.payload.activity.summary).toBe("Ran a command in .");
  });

  it("replaces an oversized tool payload with a truncated preview", () => {
    const result = redactForHub(
      activity({ chunks: Array.from({ length: 10 }, () => "y".repeat(10_000)) }),
      context,
    );
    if (result?.body.type !== "thread.activity-appended") throw new Error("expected activity");
    expect(result.truncated).toBe(true);
    expect(result.body.payload.activity.payload).toMatchObject({ hubTruncated: true });
    expect(
      utf8ByteLength(JSON.stringify(result.body.payload.activity.payload)),
    ).toBeLessThanOrEqual(HUB_SYNC_LIMITS.activityPayloadMaxBytes);
  });

  it("caps full turn diffs and redacts secrets in them", () => {
    const result = redactForHub(
      decodeBody({
        type: "thread.turn-diff",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          diff: `+API_KEY=${SECRETS[0]}\n${"+line\n".repeat(50_000)}`,
        },
      }),
      context,
    );
    if (result?.body.type !== "thread.turn-diff") throw new Error("expected a diff");
    expect(result.truncated).toBe(true);
    expect(result.body.payload.diff).not.toContain(SECRETS[0]);
    expect(utf8ByteLength(result.body.payload.diff)).toBeLessThanOrEqual(
      HUB_SYNC_LIMITS.diffMaxBytes,
    );
  });

  it("removes worktree paths and drops meta updates with nothing shareable", () => {
    const created = redactForHub(
      decodeBody({
        type: "thread.created",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "Feature",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          branch: "feature",
          worktreePath: "/Users/alice/.t3/worktrees/app/feature",
          createdAt: at,
          updatedAt: at,
        },
      }),
      context,
    );
    if (created?.body.type !== "thread.created") throw new Error("expected thread.created");
    expect(created.body.payload.worktreePath).toBeNull();

    const orderOnly = decodeBody({
      type: "thread.meta-updated",
      payload: {
        threadId: "thread-1",
        activeOrderKey: "a0",
        worktreePath: "/tmp/x",
        updatedAt: at,
      },
    });
    expect(redactForHub(orderOnly, context)).toBeNull();

    const renamed = redactForHub(
      decodeBody({
        type: "thread.meta-updated",
        payload: {
          threadId: "thread-1",
          title: "Renamed",
          previousTitle: "Feature",
          worktreePath: "/tmp/x",
          updatedAt: at,
        },
      }),
      context,
    );
    expect(renamed?.body.payload).toEqual({
      threadId: "thread-1",
      title: "Renamed",
      updatedAt: at,
    });
  });

  it("refuses bodies outside the allowlist", () => {
    const denied = {
      type: "thread.comment-added",
      payload: { threadId: "thread-1" },
    } as unknown as HubThreadEventBody;
    expect(redactForHub(denied, context)).toBeNull();
  });
});
