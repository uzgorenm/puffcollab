import { indexMembers } from "@t3tools/client-runtime/state/members";
import {
  type ThreadCollaboration,
  threadCollaboration,
} from "@t3tools/client-runtime/state/thread-ownership";
import type { EnvironmentId, MemberId, ThreadVisibility } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { type EnvironmentMembers, memberEnvironment, useEnvironmentMembers } from "./members";

/**
 * Puff Collab: how the viewer relates to a thread (owner or follower), plus
 * whether the environment has a team at all. Single-user environments report
 * `teamEnabled: false` so sharing controls stay out of the way.
 */
export interface ThreadCollaborationView extends ThreadCollaboration {
  readonly teamEnabled: boolean;
  readonly isAdmin: boolean;
}

interface ThreadOwnershipFacts {
  readonly createdBy?: MemberId | null | undefined;
  readonly visibility?: ThreadVisibility | undefined;
}

const EMPTY_MEMBERS: EnvironmentMembers = { members: new Map(), currentMemberId: null };

function toView(thread: ThreadOwnershipFacts, roster: EnvironmentMembers): ThreadCollaborationView {
  const base = threadCollaboration({ thread, ...roster });
  return {
    ...base,
    teamEnabled: roster.members.size > 1,
    isAdmin:
      roster.currentMemberId === null ||
      roster.members.get(roster.currentMemberId)?.role === "admin",
  };
}

/** The roster as last loaded, read outside React (menus snapshot at open). */
export function readEnvironmentMembers(environmentId: EnvironmentId): EnvironmentMembers {
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
  return toView(thread, readEnvironmentMembers(environmentId));
}

export function useThreadCollaboration(
  environmentId: EnvironmentId | null,
  thread: ThreadOwnershipFacts | null | undefined,
): ThreadCollaborationView {
  const roster = useEnvironmentMembers(environmentId);
  const createdBy = thread?.createdBy;
  const visibility = thread?.visibility;
  return useMemo(() => toView({ createdBy, visibility }, roster), [createdBy, visibility, roster]);
}
