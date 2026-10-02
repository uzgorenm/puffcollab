import {
  type ThreadCollaboration,
  threadCollaboration,
} from "@t3tools/client-runtime/state/thread-ownership";
import type { EnvironmentId, MemberId, ThreadVisibility } from "@t3tools/contracts";
import { useMemo } from "react";

import { type EnvironmentMembers, useEnvironmentMembers } from "./members";

/**
 * Puff Collab: how the viewer relates to a thread (owner or follower), plus
 * whether the environment has a team at all. Single-user environments report
 * `teamEnabled: false` so team controls stay out of the way.
 */
export interface ThreadCollaborationView extends ThreadCollaboration {
  readonly teamEnabled: boolean;
  readonly isAdmin: boolean;
}

interface ThreadOwnershipFacts {
  readonly createdBy?: MemberId | null | undefined;
  readonly visibility?: ThreadVisibility | undefined;
}

export function threadCollaborationView(
  thread: ThreadOwnershipFacts,
  roster: EnvironmentMembers,
): ThreadCollaborationView {
  return {
    ...threadCollaboration({ thread, ...roster }),
    teamEnabled: roster.members.size > 1,
    isAdmin:
      roster.currentMemberId === null ||
      roster.members.get(roster.currentMemberId)?.role === "admin",
  };
}

export function useThreadCollaboration(
  environmentId: EnvironmentId | null,
  thread: ThreadOwnershipFacts | null | undefined,
): ThreadCollaborationView {
  const roster = useEnvironmentMembers(environmentId);
  const createdBy = thread?.createdBy;
  const visibility = thread?.visibility;
  return useMemo(
    () => threadCollaborationView({ createdBy, visibility }, roster),
    [createdBy, visibility, roster],
  );
}
