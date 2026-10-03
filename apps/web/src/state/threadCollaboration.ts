import { hubLinkedProjectsKey, isProjectInHubKey } from "@t3tools/client-runtime/state/hub";
import { indexMembers } from "@t3tools/client-runtime/state/members";
import {
  type ThreadCollaborationView,
  threadCollaborationView,
} from "@t3tools/client-runtime/state/thread-ownership";
import type {
  EnvironmentId,
  HubThreadLink,
  MemberId,
  ProjectId,
  ThreadVisibility,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readHubStatus, useHubLinkedProjectsKey } from "./hub";
import { type EnvironmentMembers, memberEnvironment, useEnvironmentMembers } from "./members";

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

const EMPTY_MEMBERS: EnvironmentMembers = { members: new Map(), currentMemberId: null };

function toView(
  thread: ThreadOwnershipFacts,
  roster: EnvironmentMembers,
  hubProjectsKey: string,
): ThreadCollaborationView {
  return threadCollaborationView({
    thread,
    ...roster,
    projectOnHub:
      thread.projectId !== undefined && isProjectInHubKey(hubProjectsKey, thread.projectId),
  });
}

/** The roster as last loaded, read outside React (menus snapshot at open). */
function readEnvironmentMembers(environmentId: EnvironmentId): EnvironmentMembers {
  const roster = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(memberEnvironment.list({ environmentId, input: {} }))),
  );
  return roster === null
    ? EMPTY_MEMBERS
    : { members: indexMembers(roster), currentMemberId: roster.currentMemberId };
}

export function readThreadCollaboration(
  environmentId: EnvironmentId,
  thread: ThreadOwnershipFacts,
): ThreadCollaborationView {
  return toView(
    thread,
    readEnvironmentMembers(environmentId),
    hubLinkedProjectsKey(readHubStatus(environmentId)),
  );
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
    () => toView({ createdBy, visibility, hub, projectId }, roster, hubProjectsKey),
    [createdBy, visibility, hub, projectId, roster, hubProjectsKey],
  );
}
