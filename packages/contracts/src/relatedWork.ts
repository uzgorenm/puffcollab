import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HubThreadLink } from "./hubLocal.ts";

/**
 * Related work (Puff Collab): a thread owner can record that their thread
 * complements, or is an alternative to, another thread in the same project.
 * A link only names the other thread. Clients resolve its title, owner, and
 * status from threads they can already see, so a link to a thread the viewer
 * cannot see reveals nothing about it. Links are shown to people, never sent
 * to the agent. A shared thread's links to other shared threads travel with
 * its hub summary, so teammates see them on its mirror.
 */
export const RelatedThreadRelationship = Schema.Literals(["complementary", "alternative"]);
export type RelatedThreadRelationship = typeof RelatedThreadRelationship.Type;

export const RelatedThreadLink = Schema.Struct({
  relatedThreadId: ThreadId,
  relationship: RelatedThreadRelationship,
  linkedAt: IsoDateTime,
});
export type RelatedThreadLink = typeof RelatedThreadLink.Type;

/** Link (or change the relationship of) a related thread. Owner only. */
export const ThreadRelatedThreadLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.related-thread.link"),
  commandId: CommandId,
  threadId: ThreadId,
  relatedThreadId: ThreadId,
  relationship: RelatedThreadRelationship,
});

/** Remove a related-thread link. Owner only. */
export const ThreadRelatedThreadUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.related-thread.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  relatedThreadId: ThreadId,
});

export const ThreadRelatedThreadLinkedPayload = Schema.Struct({
  threadId: ThreadId,
  link: RelatedThreadLink,
});
export type ThreadRelatedThreadLinkedPayload = typeof ThreadRelatedThreadLinkedPayload.Type;

export const ThreadRelatedThreadUnlinkedPayload = Schema.Struct({
  threadId: ThreadId,
  relatedThreadId: ThreadId,
});
export type ThreadRelatedThreadUnlinkedPayload = typeof ThreadRelatedThreadUnlinkedPayload.Type;

/** Keep one link per related thread; a re-link replaces the relationship. */
export const upsertRelatedThreadLink = (
  links: ReadonlyArray<RelatedThreadLink> | undefined,
  link: RelatedThreadLink,
): ReadonlyArray<RelatedThreadLink> => [
  ...(links ?? []).filter((entry) => entry.relatedThreadId !== link.relatedThreadId),
  link,
];

export const removeRelatedThreadLink = (
  links: ReadonlyArray<RelatedThreadLink> | undefined,
  relatedThreadId: ThreadId,
): ReadonlyArray<RelatedThreadLink> =>
  (links ?? []).filter((entry) => entry.relatedThreadId !== relatedThreadId);

// The draft is matched on the server against titles, first messages, and
// branch names; bound it so a pasted wall of text stays cheap.
export const RelatedWorkSuggestInput = Schema.Struct({
  projectId: ProjectId,
  text: Schema.String.check(Schema.isMaxLength(4000)),
  /** The thread being composed or shared, so it never suggests itself. */
  excludeThreadId: Schema.optionalKey(ThreadId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
});
export type RelatedWorkSuggestInput = typeof RelatedWorkSuggestInput.Type;

export const RelatedWorkSuggestion = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  /** Set for hub-linked threads; a remote one is a teammate's (see `hubThreadOwnerName`). */
  hub: Schema.optional(HubThreadLink),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** Draft words found in the thread, for a short "matched" hint. */
  matchedTerms: Schema.Array(Schema.String),
});
export type RelatedWorkSuggestion = typeof RelatedWorkSuggestion.Type;

export const RelatedWorkSuggestResult = Schema.Struct({
  suggestions: Schema.Array(RelatedWorkSuggestion),
});
export type RelatedWorkSuggestResult = typeof RelatedWorkSuggestResult.Type;

export class RelatedWorkError extends Schema.TaggedError<RelatedWorkError>()("RelatedWorkError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
