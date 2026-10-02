import {
  isThreadShared,
  type Member,
  type MemberId,
  type OrchestrationThreadComment,
  OWNER_MEMBER_ID,
  type ThreadVisibility,
} from "@t3tools/contracts";

/** The member that owns a thread: its creator, or the environment owner. */
export const threadOwnerId = (thread: { readonly createdBy?: MemberId | null | undefined }) =>
  thread.createdBy ?? OWNER_MEMBER_ID;

export interface ThreadCollaboration {
  readonly ownerId: MemberId;
  /** True when the viewer owns the thread and so drives the agent. */
  readonly isOwner: boolean;
  /** The owner's display name, for "Following <name>'s thread". */
  readonly ownerName: string;
  readonly visibility: ThreadVisibility;
  readonly shared: boolean;
}

/**
 * Who drives a thread and how the viewer relates to it (Puff Collab). Only the
 * owner controls a thread; everyone who can see it may follow and comment.
 * With no known viewer (an older server, or the roster not loaded yet) the
 * viewer is treated as the owner so single-user environments look unchanged;
 * the server enforces ownership regardless.
 */
export function threadCollaboration(input: {
  readonly thread: {
    readonly createdBy?: MemberId | null | undefined;
    readonly visibility?: ThreadVisibility | undefined;
  };
  readonly currentMemberId: MemberId | null;
  readonly members: ReadonlyMap<MemberId, Member>;
}): ThreadCollaboration {
  const ownerId = threadOwnerId(input.thread);
  return {
    ownerId,
    isOwner: input.currentMemberId === null || input.currentMemberId === ownerId,
    ownerName: input.members.get(ownerId)?.displayName ?? "the owner",
    visibility: input.thread.visibility ?? "private",
    shared: isThreadShared(input.thread),
  };
}

/** Authors delete their own comments; admins may delete any. */
export function canDeleteThreadComment(input: {
  readonly comment: Pick<OrchestrationThreadComment, "authorId">;
  readonly currentMemberId: MemberId | null;
  readonly members: ReadonlyMap<MemberId, Member>;
}): boolean {
  if (input.currentMemberId === null) return false;
  if (input.comment.authorId === input.currentMemberId) return true;
  return input.members.get(input.currentMemberId)?.role === "admin";
}
