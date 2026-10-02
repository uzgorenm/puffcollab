import {
  CommandId,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationEvent,
  OWNER_MEMBER_ID,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundExport,
  EXPORT_MAX_EVENTS_PER_THREAD,
  EXPORT_MAX_TEXT_CHARS,
  type ExportGrant,
  isInformationalNote,
  pairRelationship,
  projectExportEvent,
  redactSecrets,
  validateAnalystOutput,
} from "./CooperationPolicy.ts";

const THREAD = ThreadId.make("thread-a");
const OTHER = ThreadId.make("thread-b");
const ADA = MemberId.make("ada");

const grant = (overrides: Partial<ExportGrant> = {}): ExportGrant => ({
  threadId: THREAD,
  ownerMemberId: OWNER_MEMBER_ID,
  version: 1,
  featureTopic: "billing",
  textEnabled: false,
  ...overrides,
});

function message(
  sequence: number,
  input: {
    readonly role?: "user" | "assistant";
    readonly text?: string;
    readonly actor?: MemberId;
    readonly streaming?: boolean;
    readonly threadId?: ThreadId;
  } = {},
): OrchestrationEvent {
  const threadId = input.threadId ?? THREAD;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    occurredAt: "2026-10-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: input.actor === undefined ? {} : { actor: input.actor },
    payload: {
      threadId,
      messageId: MessageId.make(`message-${sequence}`),
      role: input.role ?? "user",
      text: input.text ?? `message ${sequence}`,
      turnId: null,
      streaming: input.streaming ?? false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

describe("redactSecrets", () => {
  it("masks credentials in transcript text", () => {
    const text = [
      "export OPENAI_API_KEY=sk-abcdefghijklmnop1234",
      "password: hunter22",
      "curl -H 'Authorization: Bearer abc.def.ghi'",
      "aws AKIAABCDEFGHIJKLMNOP",
      "clone https://user:pa55@github.com/acme/repo",
    ].join("\n");
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("sk-abcdefghijklmnop1234");
    expect(redacted).not.toContain("hunter22");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(redacted).not.toContain("pa55");
  });
});

describe("projectExportEvent", () => {
  it("exports only metadata without text permission", () => {
    const exported = projectExportEvent(message(1, { text: "secret plan" }), grant());
    expect(exported?.content).toEqual({ role: "user", characters: "secret plan".length });
    expect(exported?.citation).toEqual({
      threadId: THREAD,
      eventId: "event-1",
      sequence: 1,
    });
  });

  it("exports redacted, bounded text with text permission", () => {
    const long = `token=abc123 ${"x".repeat(5_000)}`;
    const exported = projectExportEvent(
      message(2, { role: "assistant", text: long }),
      grant({ textEnabled: true }),
    );
    const text = exported?.content.text;
    expect(typeof text).toBe("string");
    expect(text as string).not.toContain("abc123");
    expect((text as string).length).toBeLessThanOrEqual(EXPORT_MAX_TEXT_CHARS);
  });

  it("keeps other members' messages as metadata even with text permission", () => {
    const exported = projectExportEvent(
      message(3, { text: "ada's words", actor: ADA }),
      grant({ textEnabled: true }),
    );
    expect(exported?.content).toEqual({ role: "user", characters: "ada's words".length });
  });

  it("skips streaming deltas", () => {
    expect(projectExportEvent(message(4, { streaming: true }), grant())).toBeNull();
  });
});

describe("boundExport", () => {
  it("keeps only the newest eligible events of the granted thread, oldest first", () => {
    const newestFirst = Array.from({ length: 100 }, (_, index) => message(100 - index)).concat(
      message(500, { threadId: OTHER }),
    );
    const exported = boundExport(newestFirst, grant());
    expect(exported).toHaveLength(EXPORT_MAX_EVENTS_PER_THREAD);
    expect(exported.at(-1)?.citation.sequence).toBe(100);
    expect(exported[0]?.citation.sequence).toBe(100 - EXPORT_MAX_EVENTS_PER_THREAD + 1);
    expect(exported.every((event) => event.citation.threadId === THREAD)).toBe(true);
  });
});

describe("validateAnalystOutput", () => {
  const threads = {
    A: { threadId: THREAD, events: boundExport([message(2), message(1)], grant()) },
    B: {
      threadId: OTHER,
      events: boundExport([message(3, { threadId: OTHER })], grant({ threadId: OTHER })),
    },
  };
  const summaries = [
    { thread: "A" as const, summary: "Working on invoices.", evidence: ["A1", "A2"] },
    { thread: "B" as const, summary: "Working on refunds.", evidence: ["B1"] },
  ];

  it("maps refs back to exact event provenance", () => {
    const result = validateAnalystOutput({
      output: {
        summaries,
        notes: [
          {
            to: "B",
            kind: "note",
            text: "Thread A changed the invoice schema.",
            evidence: ["A2", "B1"],
          },
        ],
      },
      threads,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summaries[0]?.citations.map((citation) => citation.eventId)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(result.notes).toEqual([
      {
        kind: "note",
        sourceThreadId: THREAD,
        targetThreadId: OTHER,
        text: "Thread A changed the invoice schema.",
        citations: [
          { threadId: THREAD, eventId: "event-2", sequence: 2 },
          { threadId: OTHER, eventId: "event-3", sequence: 3 },
        ],
      },
    ]);
  });

  it("rejects citations to events that were never exported", () => {
    const result = validateAnalystOutput({
      output: {
        summaries: [summaries[0]!, { ...summaries[1]!, evidence: ["B7"] }],
        notes: [],
      },
      threads,
    });
    expect(result).toEqual({ ok: false, reason: "summary cites an event that was not exported" });
  });

  it("drops directive notes but keeps the rest of the run", () => {
    const result = validateAnalystOutput({
      output: {
        summaries,
        notes: [
          { to: "B", kind: "note", text: "You should stop and use A.", evidence: ["A1"] },
          { to: "B", kind: "note", text: "No source evidence here.", evidence: ["B1"] },
        ],
      },
      threads,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toEqual([]);
    expect(result.discarded).toHaveLength(2);
  });

  it("treats directive wording and secrets as non-informational", () => {
    expect(isInformationalNote("Thread A already added a retry helper.")).toBe(true);
    expect(isInformationalNote("Please implement the retry helper.")).toBe(false);
    expect(isInformationalNote("Uses api_key=xyz from env.")).toBe(false);
  });
});

describe("pairRelationship", () => {
  it("takes the owners' links in either direction and leaves disagreement unspecified", () => {
    expect(pairRelationship([])).toBe("unspecified");
    expect(pairRelationship(["complementary"])).toBe("complementary");
    expect(pairRelationship(["alternative", "alternative"])).toBe("alternative");
    expect(pairRelationship(["alternative", "complementary"])).toBe("unspecified");
  });
});
