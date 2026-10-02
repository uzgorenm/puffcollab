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
import { OWNER_MEMBER_ID } from "./members.ts";
import {
  isThreadShared,
  ProjectBriefText,
  ProjectMemberFocusText,
  type ThreadVisibility,
} from "./orchestration.ts";

/**
 * Puff Collab team overview: one view per project of what everyone is working
 * on. The brief and member focus are event-sourced on the project aggregate
 * (`project.brief-updated`, `project.member-focus-set`); the activity feed is a
 * server projection of meaningful thread and project events; work cards are
 * derived on the client from the thread shells it already streams.
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

export const TEAM_ACTIVITY_PAGE_MAX = 100;
export const TEAM_ACTIVITY_SNAPSHOT_LIMIT = 30;

export const TeamOverviewSnapshot = Schema.Struct({
  projectId: ProjectId,
  brief: Schema.NullOr(ProjectBriefVersion),
  focuses: Schema.Array(ProjectMemberFocus),
  /** The most recent activity, newest first, at most TEAM_ACTIVITY_SNAPSHOT_LIMIT. */
  activity: Schema.Array(TeamActivityItem),
  /** Pass as `beforeSequence` to page older activity. Null when nothing older remains. */
  activityNextBeforeSequence: Schema.NullOr(NonNegativeInt),
});
export type TeamOverviewSnapshot = typeof TeamOverviewSnapshot.Type;

/**
 * The team overview stream: one snapshot, then small deltas. Activity deltas
 * carry only items newer than anything already sent, newest first.
 */
export const TeamOverviewStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: TeamOverviewSnapshot }),
  Schema.Struct({ kind: Schema.Literal("brief"), brief: ProjectBriefVersion }),
  Schema.Struct({
    kind: Schema.Literal("focus"),
    memberId: MemberId,
    /** Null when the member cleared their focus. */
    focus: Schema.NullOr(ProjectMemberFocus),
  }),
  Schema.Struct({ kind: Schema.Literal("activity"), items: Schema.Array(TeamActivityItem) }),
]);
export type TeamOverviewStreamItem = typeof TeamOverviewStreamItem.Type;

export const TeamOverviewSubscribeInput = Schema.Struct({ projectId: ProjectId });
export type TeamOverviewSubscribeInput = typeof TeamOverviewSubscribeInput.Type;

export const TeamActivityPageInput = Schema.Struct({
  projectId: ProjectId,
  /** Exclusive: return items older than this sequence. */
  beforeSequence: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(TEAM_ACTIVITY_PAGE_MAX)),
});
export type TeamActivityPageInput = typeof TeamActivityPageInput.Type;

export const TeamActivityPageResult = Schema.Struct({
  items: Schema.Array(TeamActivityItem),
  /**
   * Where the next page starts. It can be older than the last item: the
   * server skips rows the caller cannot see. Null when nothing older remains.
   */
  nextBeforeSequence: Schema.NullOr(NonNegativeInt),
});
export type TeamActivityPageResult = typeof TeamActivityPageResult.Type;

export const ProjectBriefHistoryInput = Schema.Struct({
  projectId: ProjectId,
  /** Exclusive: return versions older than this one. Omit for the newest. */
  beforeVersion: Schema.optional(PositiveInt),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
});
export type ProjectBriefHistoryInput = typeof ProjectBriefHistoryInput.Type;

export const ProjectBriefHistoryResult = Schema.Struct({
  versions: Schema.Array(ProjectBriefVersion),
  hasMore: Schema.Boolean,
});
export type ProjectBriefHistoryResult = typeof ProjectBriefHistoryResult.Type;

export const ProjectBriefUpdateInput = Schema.Struct({
  projectId: ProjectId,
  text: ProjectBriefText,
  /**
   * The version the editor started from (null for a project with no brief).
   * A save on top of a newer version fails with `conflict` instead of
   * silently overwriting a teammate's edit.
   */
  expectedVersion: Schema.NullOr(PositiveInt),
});
export type ProjectBriefUpdateInput = typeof ProjectBriefUpdateInput.Type;

export const ProjectMemberFocusSetInput = Schema.Struct({
  projectId: ProjectId,
  /** Null clears the caller's focus. Always the caller's own focus. */
  focus: Schema.NullOr(ProjectMemberFocusText),
});
export type ProjectMemberFocusSetInput = typeof ProjectMemberFocusSetInput.Type;

export const ProjectMemberFocusSetResult = Schema.Struct({
  focus: Schema.NullOr(ProjectMemberFocus),
});
export type ProjectMemberFocusSetResult = typeof ProjectMemberFocusSetResult.Type;

export class TeamOverviewError extends Schema.TaggedError<TeamOverviewError>()(
  "TeamOverviewError",
  {
    reason: Schema.Literals(["forbidden", "not-found", "conflict", "internal"]),
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * Whether a thread belongs on a member's team overview: shared threads, plus
 * the member's own (threads without a recorded creator belong to the
 * environment owner). Callers have already checked project membership.
 * Other members' private threads never appear, even for admins.
 */
export const isThreadOnTeamOverview = (
  thread: {
    readonly createdBy?: MemberId | null | undefined;
    readonly visibility?: ThreadVisibility | undefined;
  },
  memberId: MemberId,
): boolean => isThreadShared(thread) || (thread.createdBy ?? OWNER_MEMBER_ID) === memberId;

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
