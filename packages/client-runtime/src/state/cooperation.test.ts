import {
  type CooperationAwarenessItem,
  type CooperationSettings,
  EventId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendAwarenessNote,
  awarenessNoteComposerText,
  cooperationSettingsUpdate,
} from "./cooperation.ts";

const item: CooperationAwarenessItem = {
  itemId: "item_1234",
  kind: "note",
  sourceThreadId: ThreadId.make("thread-a"),
  sourceThreadTitle: "Invoice rework",
  targetThreadId: ThreadId.make("thread-b"),
  text: "Thread A already moved invoices to the new table.",
  citations: [
    { threadId: ThreadId.make("thread-a"), eventId: EventId.make("event-7"), sequence: 7 },
  ],
  state: "admitted",
  createdAt: "2026-10-01T00:00:00.000Z",
  resolvedAt: "2026-10-01T00:01:00.000Z",
};

describe("appendAwarenessNote", () => {
  it("adds an admitted note to the owner's next message, after what they typed", () => {
    const prompt = appendAwarenessNote("keep going with refunds", item);
    expect(prompt.startsWith("keep going with refunds\n\n")).toBe(true);
    expect(prompt).toContain('shared thread "Invoice rework"');
    expect(prompt).toContain("> Thread A already moved invoices to the new table.");
  });

  it("starts an empty composer with the note", () => {
    expect(appendAwarenessNote("  ", item)).toBe(`${awarenessNoteComposerText(item)}\n\n`);
  });
});

describe("cooperationSettingsUpdate", () => {
  const settings: CooperationSettings = {
    threadId: ThreadId.make("thread-a"),
    version: 3,
    featureTopic: "billing",
    analysisEnabled: true,
    textEnabled: true,
    awarenessNotify: true,
    updatedAt: null,
  };

  it("turns dependent switches off with analysis", () => {
    expect(cooperationSettingsUpdate(settings, { analysisEnabled: false })).toEqual({
      threadId: settings.threadId,
      expectedVersion: 3,
      featureTopic: "billing",
        analysisEnabled: false,
      textEnabled: false,
      awarenessNotify: false,
    });
  });
});
