import { isProjectInHubKey } from "@t3tools/client-runtime/state/hub";
import {
  type ThreadCollaborationView,
  threadCollaborationView as sharedThreadCollaborationView,
} from "@t3tools/client-runtime/state/thread-ownership";
import type { EnvironmentId, HubThreadLink, ProjectId, ThreadVisibility } from "@t3tools/contracts";
import { useMemo } from "react";

import { useHubLinkedProjectsKey } from "./hub";

/**
 * Puff Collab: how the viewer relates to a thread (owner or follower), plus
 * whether team controls apply. Teammates' hub mirrors are always followed.
 */
export type { ThreadCollaborationView };

interface ThreadOwnershipFacts {
  readonly visibility?: ThreadVisibility | undefined;
  readonly hub?: HubThreadLink | undefined;
  readonly projectId?: ProjectId | undefined;
}

export function threadCollaborationView(
  thread: ThreadOwnershipFacts,
  hubProjectsKey = "",
): ThreadCollaborationView {
  return sharedThreadCollaborationView({
    thread,
    projectOnHub:
      thread.projectId !== undefined && isProjectInHubKey(hubProjectsKey, thread.projectId),
  });
}

export function useThreadCollaboration(
  environmentId: EnvironmentId | null,
  thread: ThreadOwnershipFacts | null | undefined,
): ThreadCollaborationView {
  const hubProjectsKey = useHubLinkedProjectsKey(environmentId);
  const visibility = thread?.visibility;
  const hub = thread?.hub;
  const projectId = thread?.projectId;
  return useMemo(
    () => threadCollaborationView({ visibility, hub, projectId }, hubProjectsKey),
    [visibility, hub, projectId, hubProjectsKey],
  );
}
