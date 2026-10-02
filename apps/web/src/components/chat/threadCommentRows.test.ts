import { MemberId, ThreadCommentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { insertThreadCommentRows } from "./threadCommentRows";

const turnFold = (id: string, createdAt: string): MessagesTimelineRow => ({
  kind: "context-compaction",
  id,
  createdAt,
  label: id,
});
const comment = (id: string, createdAt: string) => ({
  id: ThreadCommentId.make(id),
  authorId: MemberId.make("bob"),
  text: id,
  createdAt,
});

describe("insertThreadCommentRows", () => {
  it("orders comments by time and keeps them ahead of the live tail", () => {
    const rows: MessagesTimelineRow[] = [
      turnFold("a", "2026-01-01T00:00:01.000Z"),
      turnFold("b", "2026-01-01T00:00:03.000Z"),
      { kind: "working", id: "working", createdAt: null },
    ];
    const result = insertThreadCommentRows(rows, [
      comment("late", "2026-01-01T00:00:09.000Z"),
      comment("middle", "2026-01-01T00:00:02.000Z"),
    ]);
    expect(result.map((row) => row.id)).toEqual([
      "a",
      "thread-comment:middle",
      "b",
      "thread-comment:late",
      "working",
    ]);
  });

  it("returns the rows untouched without comments", () => {
    const rows = [turnFold("a", "2026-01-01T00:00:01.000Z")];
    expect(insertThreadCommentRows(rows, undefined)).toBe(rows);
  });
});
