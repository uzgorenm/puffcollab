import type { RelatedThreadStatus } from "@t3tools/client-runtime/state/related-work";
import {
  hubTeamMemberName,
  teamActivityHasActor,
  teamActivityPhrase,
} from "@t3tools/client-runtime/state/team-overview";
import type {
  HubLocalActivityItem,
  HubLocalTeam,
  Member,
  MemberId,
  OrchestrationThreadComment,
  RelatedThreadRelationship,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

/**
 * Pure presentation rules for the Puff Collab team surfaces on mobile: names,
 * labels, comment placement in the thread feed, and which thread-row actions a
 * follower keeps.
 */

type Members = ReadonlyMap<MemberId, Member>;

/** "You", a teammate's name, or a neutral stand-in when the member is unknown. */
export function teamMemberName(
  members: Members,
  memberId: MemberId | null,
  currentMemberId: MemberId | null,
): string {
  if (memberId === null) return "Someone";
  if (memberId === currentMemberId) return "You";
  return members.get(memberId)?.displayName ?? "A former member";
}

/** "Ada started a thread", or "Agent finished a turn" for provider activity. */
export function teamActivityLine(
  item: Pick<HubLocalActivityItem, "kind" | "actorId">,
  team: Pick<HubLocalTeam, "viewerAccountId" | "members">,
): string {
  const phrase = teamActivityPhrase(item.kind);
  return teamActivityHasActor(item.kind)
    ? `${hubTeamMemberName(team, item.actorId)} ${phrase}`
    : phrase;
}

export const RELATED_THREAD_RELATIONSHIP_LABELS: Readonly<
  Record<RelatedThreadRelationship, string>
> = {
  complementary: "Complementary",
  alternative: "Alternative",
};

export const RELATED_THREAD_STATUS_LABELS: Readonly<Record<RelatedThreadStatus, string>> = {
  working: "Working",
  active: "Active",
  settled: "Settled",
  archived: "Archived",
};

export function followingThreadNotice(ownerName: string): string {
  return `Following ${ownerName}'s thread. Only ${ownerName} can instruct the agent; your comments are not sent to it.`;
}

// ── Brief editing ─────────────────────────────────────────────────────

/**
 * Whether a teammate saved the brief after this draft started from
 * `baseVersion`. The overview streams brief updates, so the editor can warn
 * before the server rejects the save.
 */
export function briefChangedSinceDraft(
  baseVersion: number | null,
  brief: { readonly version: number } | null,
): boolean {
  return (brief?.version ?? null) !== baseVersion;
}

/** True when a failed hub command was the hub's optimistic-concurrency conflict. */
export function isHubConflict(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "HubLocalError" &&
    "reason" in error &&
    error.reason === "conflict"
  );
}

// ── Comments in the thread feed ───────────────────────────────────────

export interface ThreadCommentFeedEntry {
  readonly type: "thread-comment";
  readonly id: string;
  readonly createdAt: string;
  readonly comment: OrchestrationThreadComment;
}

interface FeedEntryLike {
  readonly type: string;
  readonly createdAt: string;
  readonly pendingMessage?: unknown;
}

/** Live rows that always close the feed; comments never land after them. */
const isTailEntry = (entry: FeedEntryLike) =>
  entry.type === "thinking" || entry.pendingMessage !== undefined;

/**
 * Interleave teammates' comments with the presented feed by time. A comment
 * goes before the first entry that started after it, and never after the
 * live "thinking" row or messages still waiting in the outbox.
 */
export function insertThreadCommentEntries<T extends FeedEntryLike>(
  entries: ReadonlyArray<T>,
  comments: ReadonlyArray<OrchestrationThreadComment> | undefined,
): ReadonlyArray<T | ThreadCommentFeedEntry> {
  if (comments === undefined || comments.length === 0) return entries;
  const tailIndex = entries.findIndex(isTailEntry);
  const body = tailIndex === -1 ? entries : entries.slice(0, tailIndex);
  const tail = tailIndex === -1 ? [] : entries.slice(tailIndex);
  const sorted = [...comments].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const merged: Array<T | ThreadCommentFeedEntry> = [];
  let next = 0;
  for (const entry of body) {
    while (next < sorted.length && sorted[next]!.createdAt < entry.createdAt) {
      merged.push(commentEntry(sorted[next]!));
      next += 1;
    }
    merged.push(entry);
  }
  for (; next < sorted.length; next += 1) merged.push(commentEntry(sorted[next]!));
  return [...merged, ...tail];
}

function commentEntry(comment: OrchestrationThreadComment): ThreadCommentFeedEntry {
  return {
    type: "thread-comment",
    id: `thread-comment:${comment.id}`,
    createdAt: comment.createdAt,
    comment,
  };
}

// ── Thread-row menu for followers ─────────────────────────────────────

interface RowMenuAction {
  readonly id?: string;
  readonly subactions?: ReadonlyArray<RowMenuAction>;
}

// Only a thread's owner changes its lifecycle, title, or placement.
const OWNER_ONLY_ROW_ACTIONS = new Set([
  "settle",
  "unsettle",
  "snooze",
  "unsnooze",
  "pin",
  "unpin",
  "rename",
  "regenerate-title",
  "auto-settle",
  "arrange",
  "move-up",
  "move-down",
]);

/**
 * The thread-row menu a viewer may use. Owners keep everything; followers keep
 * read-only items, and admins may still archive or delete (matching web).
 */
export function threadRowMenuActionsForViewer<A extends RowMenuAction>(
  actions: ReadonlyArray<A>,
  viewer: { readonly isOwner: boolean; readonly isAdmin: boolean },
): A[] {
  return actions.filter((action) => {
    if (viewer.isOwner) return true;
    const id = action.id ?? "";
    if (OWNER_ONLY_ROW_ACTIONS.has(id) || id.startsWith("snooze:")) return false;
    if (id === "archive" || id === "delete") return viewer.isAdmin;
    return true;
  });
}
