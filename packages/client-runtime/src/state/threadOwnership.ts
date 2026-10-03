import {
  type HubThreadLink,
  isRemoteHubThread,
  isThreadShared,
  type Member,
  type MemberId,
  type OrchestrationThreadComment,
  threadOwnerOf,
  type ThreadVisibility,
} from "@t3tools/contracts";

import { type HubSyncIndicator, hubSyncIndicator, hubThreadOwnerName } from "./hub.ts";

export interface ThreadCollaboration {
  readonly ownerId: MemberId;
  /** True when the viewer owns the thread and so drives the agent. */
  readonly isOwner: boolean;
  /** The owner's display name, for "Following <name>'s thread". */
  readonly ownerName: string;
  readonly visibility: ThreadVisibility;
  readonly shared: boolean;
  /**
   * A teammate's thread mirrored from the team hub (Stage 7). Its agent runs
   * on the owner's machine, so the viewer only follows and comments.
   */
  readonly remote: boolean;
  /** Sync marker for the viewer's own hub-linked shared thread, else null. */
  readonly hubSync: HubSyncIndicator | null;
}

interface ThreadOwnershipFacts {
  readonly createdBy?: MemberId | null | undefined;
  readonly visibility?: ThreadVisibility | undefined;
  readonly hub?: HubThreadLink | undefined;
}

/**
 * Who drives a thread and how the viewer relates to it (Puff Collab). Only the
 * owner controls a thread; everyone who can see it may follow and comment.
 * With no known viewer (an older server, or the roster not loaded yet) the
 * viewer is treated as the owner so single-user environments look unchanged;
 * the server enforces ownership regardless.
 */
export function threadCollaboration(input: {
  readonly thread: ThreadOwnershipFacts;
  readonly currentMemberId: MemberId | null;
  readonly members: ReadonlyMap<MemberId, Member>;
}): ThreadCollaboration {
  const ownerId = threadOwnerOf(input.thread);
  const hub = input.thread.hub;
  // A remote mirror is always followed, whoever the local viewer is; its
  // owner is a hub account, not a member of this environment.
  if (hub !== undefined && isRemoteHubThread(input.thread)) {
    return {
      ownerId,
      isOwner: false,
      ownerName: hubThreadOwnerName(hub),
      visibility: "shared",
      shared: true,
      remote: true,
      hubSync: null,
    };
  }
  const shared = isThreadShared(input.thread);
  return {
    ownerId,
    isOwner: input.currentMemberId === null || input.currentMemberId === ownerId,
    ownerName: input.members.get(ownerId)?.displayName ?? "the owner",
    visibility: input.thread.visibility ?? "private",
    shared,
    remote: false,
    hubSync: shared ? hubSyncIndicator(input.thread) : null,
  };
}

/**
 * The collaboration facts every surface (web and mobile) renders from, plus
 * whether team controls apply at all. `teamEnabled` is false on single-user
 * environments whose project is not on the team hub, so sharing controls stay
 * out of the way.
 */
export interface ThreadCollaborationView extends ThreadCollaboration {
  readonly teamEnabled: boolean;
  /** May archive or delete threads they don't own. Never for remote mirrors. */
  readonly isAdmin: boolean;
}

export function threadCollaborationView(input: {
  readonly thread: ThreadOwnershipFacts;
  readonly currentMemberId: MemberId | null;
  readonly members: ReadonlyMap<MemberId, Member>;
  /** The thread's project is linked to the team hub. */
  readonly projectOnHub?: boolean;
}): ThreadCollaborationView {
  const base = threadCollaboration(input);
  return {
    ...base,
    teamEnabled:
      input.members.size > 1 ||
      base.remote ||
      input.thread.hub !== undefined ||
      input.projectOnHub === true,
    isAdmin:
      !base.remote &&
      (input.currentMemberId === null ||
        input.members.get(input.currentMemberId)?.role === "admin"),
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
