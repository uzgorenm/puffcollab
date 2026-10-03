import { hubLinkedProjectsKey, isProjectInHubKey } from "@t3tools/client-runtime/state/hub";
import {
  type ThreadCollaborationView,
  threadCollaborationView,
} from "@t3tools/client-runtime/state/thread-ownership";
import type { EnvironmentId, HubThreadLink, ProjectId, ThreadVisibility } from "@t3tools/contracts";
import { useMemo } from "react";

import { readHubStatus, useHubLinkedProjectsKey } from "./hub";

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

function toView(thread: ThreadOwnershipFacts, hubProjectsKey: string): ThreadCollaborationView {
  return threadCollaborationView({
    thread,
    projectOnHub:
      thread.projectId !== undefined && isProjectInHubKey(hubProjectsKey, thread.projectId),
  });
}

/** The view as of the last hub status, read outside React (menus snapshot at open). */
export function readThreadCollaboration(
  environmentId: EnvironmentId,
  thread: ThreadOwnershipFacts,
): ThreadCollaborationView {
  return toView(thread, hubLinkedProjectsKey(readHubStatus(environmentId)));
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
    () => toView({ visibility, hub, projectId }, hubProjectsKey),
    [visibility, hub, projectId, hubProjectsKey],
  );
}
