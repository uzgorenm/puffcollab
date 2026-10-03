import { isProjectInHubKey } from "@t3tools/client-runtime/state/hub";
import {
  type ThreadCollaborationView,
  threadCollaborationView as sharedThreadCollaborationView,
} from "@t3tools/client-runtime/state/thread-ownership";
import type {
  EnvironmentId,
  HubThreadLink,
  MemberId,
  ProjectId,
  ThreadVisibility,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useHubLinkedProjectsKey } from "./hub";
import { type EnvironmentMembers, useEnvironmentMembers } from "./members";

/**
 * Puff Collab: how the viewer relates to a thread (owner or follower), plus
 * whether team controls apply. Remote team hub threads are always followed.
 */
export type { ThreadCollaborationView };

interface ThreadOwnershipFacts {
  readonly createdBy?: MemberId | null | undefined;
  readonly visibility?: ThreadVisibility | undefined;
  readonly hub?: HubThreadLink | undefined;
  readonly projectId?: ProjectId | undefined;
}

export function threadCollaborationView(
  thread: ThreadOwnershipFacts,
  roster: EnvironmentMembers,
  hubProjectsKey = "",
): ThreadCollaborationView {
  return sharedThreadCollaborationView({
    thread,
    ...roster,
    projectOnHub:
      thread.projectId !== undefined && isProjectInHubKey(hubProjectsKey, thread.projectId),
  });
}

export function useThreadCollaboration(
  environmentId: EnvironmentId | null,
  thread: ThreadOwnershipFacts | null | undefined,
): ThreadCollaborationView {
  const roster = useEnvironmentMembers(environmentId);
  const hubProjectsKey = useHubLinkedProjectsKey(environmentId);
  const createdBy = thread?.createdBy;
  const visibility = thread?.visibility;
  const hub = thread?.hub;
  const projectId = thread?.projectId;
  return useMemo(
    () =>
      threadCollaborationView({ createdBy, visibility, hub, projectId }, roster, hubProjectsKey),
    [createdBy, visibility, hub, projectId, roster, hubProjectsKey],
  );
}
