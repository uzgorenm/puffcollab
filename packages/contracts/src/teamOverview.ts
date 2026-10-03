import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MemberId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Puff Collab team overview shapes. The team hub owns the brief, focus,
 * activity and work cards (hub.ts re-keys these on hub ids); a client reads
 * them through its local server as `HubLocalTeam` (hubTeam.ts).
 */

/** One saved version of a project's brief. Every edit appends a version. */
export const ProjectBriefVersion = Schema.Struct({
  projectId: ProjectId,
  version: PositiveInt,
  text: Schema.String,
  /** The member who saved this version. Null when no member was recorded. */
  authorId: Schema.NullOr(MemberId),
  createdAt: IsoDateTime,
});
export type ProjectBriefVersion = typeof ProjectBriefVersion.Type;

/** A member's self-authored current focus in a project. */
export const ProjectMemberFocus = Schema.Struct({
  projectId: ProjectId,
  memberId: MemberId,
  focus: Schema.String,
  updatedAt: IsoDateTime,
});
export type ProjectMemberFocus = typeof ProjectMemberFocus.Type;

export const TeamActivityKind = Schema.Literals([
  "thread-created",
  "turn-started",
  "turn-completed",
  "turn-errored",
  "turn-interrupted",
  "approval-requested",
  "input-requested",
  "brief-updated",
  "focus-set",
  "focus-cleared",
]);
export type TeamActivityKind = typeof TeamActivityKind.Type;

export const TeamActivityItem = Schema.Struct({
  /** Stable id; also the dedupe key when live items overlap a page. */
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  kind: TeamActivityKind,
  /** The thread the activity happened in. Null for project-level activity. */
  threadId: Schema.NullOr(ThreadId),
  /** The member who caused it. Null for provider/server-originated activity. */
  actorId: Schema.NullOr(MemberId),
  /** Short context: the thread title on creation, the focus text on focus-set. */
  detail: Schema.NullOr(Schema.String),
  occurredAt: IsoDateTime,
  /** Event sequence. Newest first; pages continue from the oldest seen. */
  sequence: NonNegativeInt,
});
export type TeamActivityItem = typeof TeamActivityItem.Type;

export const TEAM_ACTIVITY_SNAPSHOT_LIMIT = 30;

/**
 * Deterministic work-card status from turn/session state. Precedence: what
 * blocks on a person first, then live work, then failure, then rest.
 */
export const TeamWorkCardStatus = Schema.Literals([
  "waiting-approval",
  "waiting-input",
  "working",
  "errored",
  "settled",
  "idle",
]);
export type TeamWorkCardStatus = typeof TeamWorkCardStatus.Type;

/**
 * Work-card status from a thread shell, for servers that publish it (the team
 * hub summary).
 */
export const teamWorkCardStatusOf = (thread: {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
  readonly latestTurn: { readonly state: string } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly settledAt: string | null;
}): TeamWorkCardStatus => {
  if (thread.hasPendingApprovals) return "waiting-approval";
  if (thread.hasPendingUserInput) return "waiting-input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "errored";
  }
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return "working";
  }
  if (thread.settledAt != null) return "settled";
  return "idle";
};

/** An agent-written summary of the work. Filled by the analysis feature. */
export const TeamWorkCardAnalysis = Schema.Struct({
  summary: Schema.String,
  updatedAt: IsoDateTime,
});
export type TeamWorkCardAnalysis = typeof TeamWorkCardAnalysis.Type;

/** One card per thread on a member's team overview. */
export const TeamWorkCard = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /** The thread's owner. Null when no creator was recorded (environment owner). */
  ownerId: Schema.NullOr(MemberId),
  title: TrimmedNonEmptyString,
  status: TeamWorkCardStatus,
  lastActivityAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** Optional so producers without analysis omit it; null means none yet. */
  analysis: Schema.optional(Schema.NullOr(TeamWorkCardAnalysis)),
});
export type TeamWorkCard = typeof TeamWorkCard.Type;
