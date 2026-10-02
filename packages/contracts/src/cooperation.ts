import * as Schema from "effect/Schema";

import {
  EventId,
  IsoDateTime,
  MemberId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Puff Collab cooperation analysis. A thread owner opts a thread in; when two
 * opted-in shared threads in a project carry the same feature topic, a
 * text-only analyst run summarizes both and may leave informational notes
 * (or redirection proposals) for the other owner. Every switch defaults off.
 */

export const COOPERATION_FEATURE_TOPIC_MAX_CHARS = 80;
export const COOPERATION_SUMMARY_MAX_CHARS = 600;
export const COOPERATION_NOTE_MAX_CHARS = 600;

export const CooperationFeatureTopic = Schema.String.check(
  Schema.isMaxLength(COOPERATION_FEATURE_TOPIC_MAX_CHARS),
  Schema.isPattern(/^(?:|[A-Za-z][A-Za-z0-9 _-]*)$/),
);

/** Owner-controlled consent for one thread. Version 0 means never configured. */
export const CooperationSettings = Schema.Struct({
  threadId: ThreadId,
  version: NonNegativeInt,
  featureTopic: Schema.String,
  /** The thread's events may be exported to the configured analyst. */
  analysisEnabled: Schema.Boolean,
  /** Message text may be exported (redacted, bounded); otherwise metadata only. */
  textEnabled: Schema.Boolean,
  /** Deliver awareness notes about other threads to this thread's owner. */
  awarenessNotify: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type CooperationSettings = typeof CooperationSettings.Type;

export const CooperationSettingsUpdateInput = Schema.Struct({
  threadId: ThreadId,
  /** Optimistic concurrency: the version the owner edited. */
  expectedVersion: NonNegativeInt,
  featureTopic: CooperationFeatureTopic,
  analysisEnabled: Schema.Boolean,
  textEnabled: Schema.Boolean,
  awarenessNotify: Schema.Boolean,
});
export type CooperationSettingsUpdateInput = typeof CooperationSettingsUpdateInput.Type;

/** What a work card shows for a thread: the latest validated analysis summary. */
export const CooperationAnalysisSummary = Schema.Struct({
  summary: Schema.String,
  updatedAt: IsoDateTime,
});
export type CooperationAnalysisSummary = typeof CooperationAnalysisSummary.Type;

export const CooperationRunState = Schema.Literals(["running", "applied", "rejected", "failed"]);
export type CooperationRunState = typeof CooperationRunState.Type;

export const CooperationLastRun = Schema.Struct({
  state: CooperationRunState,
  /** Why a run was rejected, failed, or applied with discarded output. */
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type CooperationLastRun = typeof CooperationLastRun.Type;

export const CooperationThreadState = Schema.Struct({
  threadId: ThreadId,
  /** Effective owner: the creator, or the environment owner for threads without one. */
  ownerMemberId: MemberId,
  /** Whether the viewing member may change the settings. */
  canEdit: Schema.Boolean,
  settings: CooperationSettings,
  summary: Schema.NullOr(CooperationAnalysisSummary),
  lastRun: Schema.NullOr(CooperationLastRun),
});
export type CooperationThreadState = typeof CooperationThreadState.Type;

/** Exact provenance of one exported orchestration event. */
export const CooperationCitation = Schema.Struct({
  threadId: ThreadId,
  eventId: EventId,
  sequence: NonNegativeInt,
});
export type CooperationCitation = typeof CooperationCitation.Type;

/** A note is informational; a proposal is a message the owner may choose to send. */
export const CooperationAwarenessKind = Schema.Literals(["note", "proposal"]);
export type CooperationAwarenessKind = typeof CooperationAwarenessKind.Type;

export const CooperationAwarenessState = Schema.Literals([
  "pending",
  "admitted",
  "dismissed",
  "approved",
  "rejected",
]);
export type CooperationAwarenessState = typeof CooperationAwarenessState.Type;

export const CooperationAwarenessItem = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  kind: CooperationAwarenessKind,
  /** The thread the finding came from. */
  sourceThreadId: ThreadId,
  sourceThreadTitle: Schema.String,
  /** The recipient's thread; only its owner sees the item. */
  targetThreadId: ThreadId,
  text: Schema.String,
  citations: Schema.Array(CooperationCitation),
  state: CooperationAwarenessState,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type CooperationAwarenessItem = typeof CooperationAwarenessItem.Type;

export const CooperationInbox = Schema.Struct({
  /** Pending items for the viewing member, newest first. */
  items: Schema.Array(CooperationAwarenessItem),
});
export type CooperationInbox = typeof CooperationInbox.Type;

/**
 * admit/dismiss apply to notes; approve/reject to proposals. Admitting only
 * records the decision: the client attaches the note to the owner's next
 * message as context. Approving a proposal sends it as the owner's message.
 */
export const CooperationAwarenessAction = Schema.Literals([
  "admit",
  "dismiss",
  "approve",
  "reject",
]);
export type CooperationAwarenessAction = typeof CooperationAwarenessAction.Type;

export const CooperationResolveInput = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  action: CooperationAwarenessAction,
});
export type CooperationResolveInput = typeof CooperationResolveInput.Type;

export const CooperationProjectSummariesInput = Schema.Struct({ projectId: ProjectId });
export type CooperationProjectSummariesInput = typeof CooperationProjectSummariesInput.Type;

/** Latest analysis summaries of a project's shared threads, for its work cards. */
export const CooperationProjectSummaries = Schema.Struct({
  summaries: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      summary: Schema.String,
      updatedAt: IsoDateTime,
    }),
  ),
});
export type CooperationProjectSummaries = typeof CooperationProjectSummaries.Type;

export const CooperationThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type CooperationThreadInput = typeof CooperationThreadInput.Type;

export const CooperationRunResult = Schema.Struct({
  /** Pairs analyzed by this request; zero when no other consented thread matches. */
  runs: NonNegativeInt,
});
export type CooperationRunResult = typeof CooperationRunResult.Type;

export class CooperationError extends Schema.TaggedError<CooperationError>()("CooperationError", {
  reason: Schema.Literals([
    "not-found",
    "forbidden",
    "conflict",
    "invalid",
    "unavailable",
    "internal",
  ]),
  message: TrimmedNonEmptyString,
}) {}

/**
 * Which provider drivers can run the analyst. Analysis input contains other
 * members' work, so it must run as pure text generation with no tools and no
 * workspace access; drivers whose helper can still execute tools are refused.
 */
export const COOPERATION_ANALYSIS_DRIVER_SUPPORT: Readonly<
  Record<string, { readonly supported: boolean; readonly reason: string }>
> = {
  claudeAgent: {
    supported: true,
    reason: "Runs `claude -p` with tools disabled in an empty directory.",
  },
  opencode: { supported: true, reason: "Runs a session whose permissions deny every tool." },
  antigravity: {
    supported: true,
    reason: "Runs in an empty directory and rejects any tool request.",
  },
  codex: {
    supported: false,
    reason: "`codex exec` keeps a read-only shell tool that could read files outside the input.",
  },
  cursor: { supported: false, reason: "Ask mode can still read workspace files." },
  grok: { supported: false, reason: "The ACP helper cannot guarantee a tool-free session." },
};

export const isCooperationAnalysisDriverSupported = (driverKind: string): boolean =>
  COOPERATION_ANALYSIS_DRIVER_SUPPORT[driverKind]?.supported === true;
