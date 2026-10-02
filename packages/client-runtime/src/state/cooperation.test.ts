import {
  COOPERATION_AWARENESS_CONTEXT_KIND,
  type CooperationAwarenessItem,
  type CooperationSettings,
  EventId,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { awarenessNoteComposerContext, cooperationSettingsUpdate } from "./cooperation.ts";

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

describe("awarenessNoteComposerContext", () => {
  it("puts an admitted note into the next turn's provider context", () => {
    const { record, reference } = awarenessNoteComposerContext(item);
    const message = `${reference} keep going with refunds`;

    const providerText = projectComposerContextForProvider({ text: message, records: [record] });

    expect(record.kind).toBe(COOPERATION_AWARENESS_CONTEXT_KIND);
    expect(providerText).toContain("Thread A already moved invoices to the new table.");
    expect(providerText).toContain("keep going with refunds");
  });

  it("is not sent when the owner removes the reference before sending", () => {
    const { record } = awarenessNoteComposerContext(item);
    const providerText = projectComposerContextForProvider({
      text: "keep going with refunds",
      records: [record],
    });
    expect(providerText).toBe("keep going with refunds");
  });
});

describe("cooperationSettingsUpdate", () => {
  const settings: CooperationSettings = {
    threadId: ThreadId.make("thread-a"),
    version: 3,
    featureTopic: "billing",
    relationship: "unspecified",
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
      relationship: "unspecified",
      analysisEnabled: false,
      textEnabled: false,
      awarenessNotify: false,
    });
  });
});
