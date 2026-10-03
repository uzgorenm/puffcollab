import {
  type HubAccountId,
  type HubThreadLink,
  isRemoteHubThread,
  isThreadShared,
  type OrchestrationThreadComment,
  OWNER_MEMBER_ID,
  type ThreadVisibility,
} from "@t3tools/contracts";

import { type HubSyncIndicator, hubSyncIndicator, hubThreadOwnerName } from "./hub.ts";

export interface ThreadCollaboration {
  /** True when the viewer owns the thread and so drives the agent. */
  readonly isOwner: boolean;
  /** The owner's display name, for "Following <name>'s thread". */
  readonly ownerName: string;
  readonly visibility: ThreadVisibility;
  readonly shared: boolean;
  /**
   * A teammate's thread mirrored from the team hub. Its agent runs on the
   * owner's machine, so the viewer only follows, comments, and organizes
   * their own view of it.
   */
  readonly remote: boolean;
  /** Sync marker for the viewer's own hub-linked shared thread, else null. */
  readonly hubSync: HubSyncIndicator | null;
}

interface ThreadOwnershipFacts {
  readonly visibility?: ThreadVisibility | undefined;
  readonly hub?: HubThreadLink | undefined;
}

/**
 * Who drives a thread and how the viewer relates to it (Puff Collab). Each
 * local server is single-user: every local thread is the viewer's own, and
 * teammates' threads arrive as read-only mirrors from the team hub.
 */
export function threadCollaboration(input: {
  readonly thread: ThreadOwnershipFacts;
}): ThreadCollaboration {
  const hub = input.thread.hub;
  if (hub !== undefined && isRemoteHubThread(input.thread)) {
    return {
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
    isOwner: true,
    ownerName: "You",
    visibility: input.thread.visibility ?? "private",
    shared,
    remote: false,
    hubSync: shared ? hubSyncIndicator(input.thread) : null,
  };
}

/**
 * The collaboration facts every surface (web and mobile) renders from, plus
 * whether team controls apply at all. `teamEnabled` is false for a project
 * that is not on the team hub, so sharing controls stay out of the way.
 */
export interface ThreadCollaborationView extends ThreadCollaboration {
  readonly teamEnabled: boolean;
}

export function threadCollaborationView(input: {
  readonly thread: ThreadOwnershipFacts;
  /** The thread's project is linked to the team hub. */
  readonly projectOnHub?: boolean;
}): ThreadCollaborationView {
  const base = threadCollaboration(input);
  return {
    ...base,
    teamEnabled: base.remote || input.thread.hub !== undefined || input.projectOnHub === true,
  };
}

/**
 * Comments written on this computer are the viewer's own; hub comments
 * (`hub:<accountId>`) are deletable only by their author's account, whose
 * deletes route to the hub.
 */
export function canDeleteThreadComment(input: {
  readonly comment: Pick<OrchestrationThreadComment, "authorId">;
  readonly viewerHubAccountId: HubAccountId | null;
}): boolean {
  const authorId: string = input.comment.authorId;
  if (!authorId.startsWith("hub:")) return true;
  return input.viewerHubAccountId !== null && authorId === `hub:${input.viewerHubAccountId}`;
}

/**
 * "You" for the viewer's comments, the teammate's name for hub comments, and a
 * neutral label for comments left by shared-host members before Stage 7.4.
 */
export function threadCommentAuthorName(input: {
  readonly comment: Pick<OrchestrationThreadComment, "authorId" | "hubAuthor">;
  readonly viewerHubAccountId: HubAccountId | null;
}): string {
  const { hubAuthor, authorId } = input.comment;
  if (hubAuthor !== undefined) {
    return hubAuthor.accountId === input.viewerHubAccountId
      ? "You"
      : hubAuthor.displayName || hubAuthor.githubLogin;
  }
  return authorId === OWNER_MEMBER_ID ? "You" : "A former member";
}
