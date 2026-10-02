import type { OrchestrationThreadComment } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Live rows that always close the timeline; comments never land after them. */
const TAIL_ROW_KINDS: ReadonlySet<MessagesTimelineRow["kind"]> = new Set([
  "working",
  "thinking",
  "queued-message",
]);

/**
 * Interleave teammates' comments (Puff Collab) with the conversation by time.
 * A comment goes before the first row that started after it, and never after
 * the live working/thinking/queued rows at the end.
 */
export function insertThreadCommentRows(
  rows: MessagesTimelineRow[],
  comments: ReadonlyArray<OrchestrationThreadComment> | undefined,
): MessagesTimelineRow[] {
  if (comments === undefined || comments.length === 0) return rows;
  const tailIndex = rows.findIndex((row) => TAIL_ROW_KINDS.has(row.kind));
  const body = tailIndex === -1 ? rows : rows.slice(0, tailIndex);
  const tail = tailIndex === -1 ? [] : rows.slice(tailIndex);
  const sorted = comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const merged: MessagesTimelineRow[] = [];
  let next = 0;
  for (const row of body) {
    while (
      next < sorted.length &&
      row.createdAt !== null &&
      sorted[next]!.createdAt < row.createdAt
    ) {
      merged.push(commentRow(sorted[next]!));
      next += 1;
    }
    merged.push(row);
  }
  for (; next < sorted.length; next += 1) merged.push(commentRow(sorted[next]!));
  return [...merged, ...tail];
}

function commentRow(comment: OrchestrationThreadComment): MessagesTimelineRow {
  return {
    kind: "thread-comment",
    id: `thread-comment:${comment.id}`,
    createdAt: comment.createdAt,
    comment,
  };
}
