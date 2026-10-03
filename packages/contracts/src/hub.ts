/**
 * Puff Collab hub protocol. Trust model:
 * - The hub never runs agents, holds provider logins, or touches code; it stores and relays.
 * - Only shared threads sync. Private threads never leave the owner's machine.
 * - The owner's server is the source of truth for its threads: it alone assigns their `seq`,
 *   redacts them (`RedactForHub`), and may publish only under its own link (`hubThreadIdOf`).
 * - The hub is the source of truth for team data: accounts, membership, invitations,
 *   comments, brief, focus, activity and posted analysis.
 * - Comments travel hub → owner's server for display and never reach the agent.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadCommentId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  COOPERATION_NOTE_MAX_CHARS,
  COOPERATION_SUMMARY_MAX_CHARS,
  CooperationAwarenessItem,
  CooperationSettings,
} from "./cooperation.ts";
import type { RepositoryIdentity } from "./environment.ts";
import { normalizeGitRemoteUrl } from "./gitRemote.ts";
import {
  type OrchestrationEvent,
  type OrchestrationEventType,
  OrchestrationEventType as OrchestrationEventTypeSchema,
  ProjectBriefText,
  ProjectMemberFocusText,
  THREAD_COMMENT_MAX_LENGTH,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadUnarchivedPayload,
  ThreadVisibilitySetPayload,
} from "./orchestration.ts";
import { PROJECT_INVITATION_PENDING_LIMIT, ProjectInvitationState } from "./projectInvitations.ts";
import {
  ProjectBriefVersion,
  ProjectMemberFocus,
  TEAM_ACTIVITY_SNAPSHOT_LIMIT,
  TeamActivityItem,
  TeamWorkCard,
  TeamWorkCardStatus,
} from "./teamOverview.ts";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/** The sync protocol this build speaks. Bump on any breaking wire change. */
export const HUB_PROTOCOL_VERSION = 1;
/** The oldest protocol this build still accepts. */
export const HUB_PROTOCOL_MIN_VERSION = 1;

export const HubProtocolRange = Schema.Struct({ min: PositiveInt, max: PositiveInt });
export type HubProtocolRange = typeof HubProtocolRange.Type;

export const HUB_PROTOCOL_RANGE: HubProtocolRange = {
  min: HUB_PROTOCOL_MIN_VERSION,
  max: HUB_PROTOCOL_VERSION,
};

/**
 * Mismatch rule: the hub picks the highest version both sides support. When
 * the ranges do not overlap it sends `reject` (reason `version-mismatch`,
 * carrying its range) and closes with `HUB_CLOSE_CODES.versionMismatch`. The
 * local server then stops reconnecting until it is upgraded or restarted and
 * tells the user which side is out of date. Within one version, changes are
 * additive: new optional fields only. Clients ignore hub messages whose `type`
 * they cannot decode; the hub rejects client messages it cannot decode.
 */
export const negotiateHubProtocol = (
  client: HubProtocolRange,
  hub: HubProtocolRange = HUB_PROTOCOL_RANGE,
): number | null => {
  const version = Math.min(client.max, hub.max);
  return version >= Math.max(client.min, hub.min) ? version : null;
};

/** Which side must upgrade when `negotiateHubProtocol` returns null. */
export const hubProtocolMismatchSide = (
  client: HubProtocolRange,
  hub: HubProtocolRange = HUB_PROTOCOL_RANGE,
): "client-outdated" | "hub-outdated" | null =>
  negotiateHubProtocol(client, hub) !== null
    ? null
    : client.max < hub.min
      ? "client-outdated"
      : "hub-outdated";

/** WebSocket close codes the hub uses. 4000–4999 is the application range. */
export const HUB_CLOSE_CODES = {
  invalid: 4400,
  unauthorized: 4401,
  /** The link was revoked or the account no longer exists. Do not reconnect. */
  linkRevoked: 4403,
  /** A newer connection for the same link replaced this one. Do not reconnect. */
  replaced: 4409,
  versionMismatch: 4426,
  rateLimited: 4429,
} as const;

/**
 * Keepalive frames outside the JSON protocol, so the hub can answer them with
 * a Durable Object WebSocket auto-response without waking.
 */
export const HUB_PING = "ping";
export const HUB_PONG = "pong";

// ---------------------------------------------------------------------------
// Ids and identity
// ---------------------------------------------------------------------------

import {
  HubAccountId,
  HubProjectId,
  HubInvitationId,
  HubEnvironmentLinkId,
  HubThreadId,
  hubThreadIdOf,
  parseHubThreadId,
  HubRequestId,
  GithubLogin,
  normalizeGithubLogin,
  HubAccount,
} from "./hubIds.ts";

export {
  HubAccountId,
  HubProjectId,
  HubInvitationId,
  HubEnvironmentLinkId,
  HubThreadId,
  hubThreadIdOf,
  parseHubThreadId,
  HubRequestId,
  GithubLogin,
  normalizeGithubLogin,
  HubAccount,
};

// ---------------------------------------------------------------------------
// Sign-in and environment link (HTTP)
// ---------------------------------------------------------------------------

/**
 * Server-side configuration of a hub deployment. Values come from Worker
 * secrets/vars (or the workerd config when self-hosted), never from clients.
 */
export const HUB_CONFIG_KEYS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "HUB_PUBLIC_URL",
] as const;
export type HubConfigKey = (typeof HUB_CONFIG_KEYS)[number];

/** Opaque browser session cookie set by the GitHub callback; HttpOnly, SameSite=Lax. */
export const HUB_SESSION_COOKIE = "puffcollab_hub_session";
/** The sync WebSocket. Upgrade with `Authorization: Bearer <HubEnvironmentCredential>`. */
export const HUB_SYNC_PATH = "/v1/sync";
/** The hub-served page where a signed-in user confirms an environment link. */
export const HUB_LINK_PAGE_PATH = "/link";

/** Long-lived opaque bearer an environment holds after linking. Revocable. */
export const HubEnvironmentCredential = TrimmedNonEmptyString;
export type HubEnvironmentCredential = typeof HubEnvironmentCredential.Type;

/** Short code shown in the local client and confirmed on the hub, e.g. `WDJB-MJHT`. */
export const HubLinkUserCode = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
);
export type HubLinkUserCode = typeof HubLinkUserCode.Type;

export const HubLinkRequestId = TrimmedNonEmptyString.pipe(Schema.brand("HubLinkRequestId"));
export type HubLinkRequestId = typeof HubLinkRequestId.Type;

/** Link codes live this long; a local server must start over afterwards. */
export const HUB_LINK_CODE_TTL_SECONDS = 600;

/**
 * Step 1 (local server, unauthenticated): ask for a link code. PKCE-style: the
 * server keeps `codeVerifier` and sends `codeChallenge = base64url(sha256(verifier))`.
 */
export const HubLinkStartRequest = Schema.Struct({
  /** Shown on the confirmation page, e.g. "Mehmet's MacBook". */
  environmentLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  codeChallenge: TrimmedNonEmptyString.check(Schema.isMinLength(43), Schema.isMaxLength(128)),
  codeChallengeMethod: Schema.Literal("S256"),
});
export type HubLinkStartRequest = typeof HubLinkStartRequest.Type;

export const HubLinkStartResponse = Schema.Struct({
  requestId: HubLinkRequestId,
  userCode: HubLinkUserCode,
  /** `${HUB_PUBLIC_URL}${HUB_LINK_PAGE_PATH}?code=<userCode>`; the client opens it in a browser. */
  verificationUrl: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  /** Minimum seconds between `token` polls; polling faster is `rate-limited`. */
  intervalSeconds: PositiveInt,
});
export type HubLinkStartResponse = typeof HubLinkStartResponse.Type;

/** Step 2 (browser, hub session): what the confirmation page shows. */
export const HubLinkDescribeResponse = Schema.Struct({
  userCode: HubLinkUserCode,
  environmentLabel: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type HubLinkDescribeResponse = typeof HubLinkDescribeResponse.Type;

/** Step 2 (browser, hub session): the signed-in user approves or denies the link. */
export const HubLinkDecisionRequest = Schema.Struct({
  userCode: HubLinkUserCode,
  decision: Schema.Literals(["approve", "deny"]),
});
export type HubLinkDecisionRequest = typeof HubLinkDecisionRequest.Type;

/** Step 3 (local server, unauthenticated): poll until the user decides. */
export const HubLinkTokenRequest = Schema.Struct({
  requestId: HubLinkRequestId,
  codeVerifier: TrimmedNonEmptyString.check(Schema.isMinLength(43), Schema.isMaxLength(128)),
});
export type HubLinkTokenRequest = typeof HubLinkTokenRequest.Type;

/** The credential is returned exactly once; later polls for the request get `not-found`. */
export const HubLinkTokenResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("denied") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({
    status: Schema.Literal("linked"),
    linkId: HubEnvironmentLinkId,
    credential: HubEnvironmentCredential,
    account: HubAccount,
  }),
]);
export type HubLinkTokenResponse = typeof HubLinkTokenResponse.Type;

export const HubEnvironmentLink = Schema.Struct({
  linkId: HubEnvironmentLinkId,
  accountId: HubAccountId,
  environmentLabel: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type HubEnvironmentLink = typeof HubEnvironmentLink.Type;

/** `GET /v1/environment` (environment bearer). */
export const HubEnvironmentInfo = Schema.Struct({
  link: HubEnvironmentLink,
  account: HubAccount,
  protocol: HubProtocolRange,
});
export type HubEnvironmentInfo = typeof HubEnvironmentInfo.Type;

/** `GET /v1/auth/session` (browser session). */
export const HubBrowserSession = Schema.Struct({
  account: HubAccount,
  expiresAt: IsoDateTime,
});
export type HubBrowserSession = typeof HubBrowserSession.Type;

/** `GET /v1/auth/github/start`: where to land after sign-in. Must be a hub-relative path. */
export const HubGithubStartQuery = Schema.Struct({
  returnTo: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^\/(?!\/)/))),
});
export type HubGithubStartQuery = typeof HubGithubStartQuery.Type;

/**
 * `GET /v1/auth/github/callback`: GitHub's redirect. `state` must match the
 * hub's signed state cookie. The first sign-in creates the account and claims
 * every pending invitation addressed to that GitHub login.
 */
export const HubGithubCallbackQuery = Schema.Struct({
  code: Schema.optional(TrimmedNonEmptyString),
  state: TrimmedNonEmptyString,
  error: Schema.optional(TrimmedNonEmptyString),
});
export type HubGithubCallbackQuery = typeof HubGithubCallbackQuery.Type;

// ---------------------------------------------------------------------------
// Projects, membership, invitations
// ---------------------------------------------------------------------------

/** Lowercase `host/path` of a repository, e.g. `github.com/uzgorenm/puffcollab`. */
export const HubRepositoryKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9.-]+(?:\/[^/\sA-Z]+)+$/),
).pipe(Schema.brand("HubRepositoryKey"));
export type HubRepositoryKey = typeof HubRepositoryKey.Type;

/**
 * The hub key of a local project's repository, recomputed from the remote URL
 * (falling back to `canonicalKey`) so it does not depend on which build
 * produced the identity: ssh, https and scp spellings, `.git`, trailing
 * slashes, ports, credentials and case all collapse. Null when neither yields
 * a `host/path` key.
 */
const isHubRepositoryKey = Schema.is(HubRepositoryKey);

export const hubRepositoryKey = (
  identity: Pick<RepositoryIdentity, "canonicalKey" | "locator">,
): HubRepositoryKey | null => {
  for (const candidate of [identity.locator.remoteUrl, identity.canonicalKey]) {
    const key = normalizeGitRemoteUrl(candidate);
    if (isHubRepositoryKey(key)) return key;
  }
  return null;
};

/**
 * A team's project on the hub. `repositoryKey` is not unique: two teams may
 * work on the same repository. A link resolves among projects the account
 * belongs to, so it never reveals another team's project.
 */
export const HubProject = Schema.Struct({
  projectId: HubProjectId,
  repositoryKey: HubRepositoryKey,
  title: TrimmedNonEmptyString,
  createdBy: HubAccountId,
  createdAt: IsoDateTime,
});
export type HubProject = typeof HubProject.Type;

/** The creator is always `admin`. Admins can remove members; anyone can leave. */
export const HubProjectRole = Schema.Literals(["admin", "member"]);
export type HubProjectRole = typeof HubProjectRole.Type;

export const HubProjectMember = Schema.Struct({
  accountId: HubAccountId,
  role: HubProjectRole,
  joinedAt: IsoDateTime,
  invitedBy: Schema.NullOr(HubAccountId),
});
export type HubProjectMember = typeof HubProjectMember.Type;

/**
 * `POST /v1/projects/link` (environment bearer): map a local project to a hub
 * project. With `projectId`, joins that project's mapping (caller must be a
 * member). Without it, returns the caller's project for `repositoryKey`, or
 * creates one with the caller as creator.
 */
export const HubProjectLinkRequest = Schema.Struct({
  repositoryKey: HubRepositoryKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  projectId: Schema.optional(HubProjectId),
});
export type HubProjectLinkRequest = typeof HubProjectLinkRequest.Type;

export const HubProjectLinkResponse = Schema.Struct({
  project: HubProject,
  created: Schema.Boolean,
  /** Other projects of the caller with the same key, so a client can offer a choice. */
  alternatives: Schema.Array(HubProject),
});
export type HubProjectLinkResponse = typeof HubProjectLinkResponse.Type;

/** Same states and meaning as local project invitations (projectInvitations.ts). */
export const HubInvitationState = ProjectInvitationState;
export type HubInvitationState = typeof HubInvitationState.Type;

/** Same cap as local invitations, per inviter. */
export const HUB_INVITATION_PENDING_LIMIT = PROJECT_INVITATION_PENDING_LIMIT;
/** A pending invitation expires after this many days. */
export const HUB_INVITATION_TTL_DAYS = 14;

/**
 * Invitations address a GitHub login. When that login already has an account,
 * `inviteeId` is set at creation; otherwise it stays null until the person
 * first signs in, which claims every pending invitation for their login.
 * Any member can invite; the inviter (or a project admin) can cancel; only
 * the invitee accepts or declines. Accepting makes them a `member`.
 */
export const HubProjectInvitation = Schema.Struct({
  invitationId: HubInvitationId,
  projectId: HubProjectId,
  projectTitle: TrimmedNonEmptyString,
  inviterId: HubAccountId,
  inviteeLogin: GithubLogin,
  inviteeId: Schema.NullOr(HubAccountId),
  state: HubInvitationState,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type HubProjectInvitation = typeof HubProjectInvitation.Type;

// ---------------------------------------------------------------------------
// Team data (hub is the source of truth)
// ---------------------------------------------------------------------------

/** A comment on a shared thread. Only its author can delete it. Never sent to an agent. */
export const HubThreadComment = Schema.Struct({
  commentId: ThreadCommentId,
  threadId: HubThreadId,
  authorId: HubAccountId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_COMMENT_MAX_LENGTH)),
  createdAt: IsoDateTime,
});
export type HubThreadComment = typeof HubThreadComment.Type;

/** `ProjectBriefVersion` on hub ids. */
export const HubProjectBriefVersion = Schema.Struct({
  ...ProjectBriefVersion.fields,
  projectId: HubProjectId,
  authorId: Schema.NullOr(HubAccountId),
});
export type HubProjectBriefVersion = typeof HubProjectBriefVersion.Type;

/** `ProjectMemberFocus` on hub ids. */
export const HubProjectMemberFocus = Schema.Struct({
  ...Struct.omit(ProjectMemberFocus.fields, ["memberId"]),
  projectId: HubProjectId,
  accountId: HubAccountId,
});
export type HubProjectMemberFocus = typeof HubProjectMemberFocus.Type;

/** `TeamActivityItem` on hub ids. `sequence` is the hub's per-project activity sequence. */
export const HubTeamActivityItem = Schema.Struct({
  ...TeamActivityItem.fields,
  projectId: HubProjectId,
  threadId: Schema.NullOr(HubThreadId),
  actorId: Schema.NullOr(HubAccountId),
});
export type HubTeamActivityItem = typeof HubTeamActivityItem.Type;

/** The owner's cooperation consent for a thread, published with its summary. Absent = all off. */
export const HubThreadCooperation = Schema.Struct(
  Struct.pick(CooperationSettings.fields, [
    "featureTopic",
    "analysisEnabled",
    "textEnabled",
    "awarenessNotify",
  ]),
);
export type HubThreadCooperation = typeof HubThreadCooperation.Type;

/** What the owner publishes about a thread for lists and work cards (`thread.summary-set`). */
export const HubThreadSummaryFields = Schema.Struct({
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  status: TeamWorkCardStatus,
  updatedAt: IsoDateTime,
  cooperation: Schema.optional(HubThreadCooperation),
});
export type HubThreadSummaryFields = typeof HubThreadSummaryFields.Type;

/** A shared thread as every project member sees it in lists. */
export const HubThreadSummary = Schema.Struct({
  ...HubThreadSummaryFields.fields,
  threadId: HubThreadId,
  projectId: HubProjectId,
  ownerId: HubAccountId,
  /** Bumped each time the owner restarts the thread's stream (`publish.reset`). */
  generation: PositiveInt,
  /** Highest accepted `seq` in this generation. */
  lastSeq: NonNegativeInt,
});
export type HubThreadSummary = typeof HubThreadSummary.Type;

/** An analysis summary for one thread. Posted only by the thread's owner. */
export const HubAnalysisSummary = Schema.Struct({
  threadId: HubThreadId,
  summary: Schema.String.check(Schema.isMaxLength(COOPERATION_SUMMARY_MAX_CHARS)),
  updatedAt: IsoDateTime,
});
export type HubAnalysisSummary = typeof HubAnalysisSummary.Type;

/** `TeamWorkCard` on hub ids, without the owner's local `worktreePath`. Derived on clients. */
export const HubTeamWorkCard = Schema.Struct({
  ...Struct.omit(TeamWorkCard.fields, ["worktreePath"]),
  threadId: HubThreadId,
  projectId: HubProjectId,
  ownerId: HubAccountId,
});
export type HubTeamWorkCard = typeof HubTeamWorkCard.Type;

export const hubWorkCardOf = (
  summary: HubThreadSummary,
  analysis?: HubAnalysisSummary | null,
): HubTeamWorkCard => ({
  threadId: summary.threadId,
  projectId: summary.projectId,
  ownerId: summary.ownerId,
  title: summary.title,
  status: summary.status,
  lastActivityAt: summary.updatedAt,
  branch: summary.branch,
  analysis: analysis ? { summary: analysis.summary, updatedAt: analysis.updatedAt } : null,
});

/** Provenance of an awareness finding: a hub thread event. */
export const HubCitation = Schema.Struct({
  threadId: HubThreadId,
  generation: PositiveInt,
  seq: PositiveInt,
});
export type HubCitation = typeof HubCitation.Type;

/**
 * `CooperationAwarenessItem` on hub ids. Posted by the source thread's owner,
 * delivered only to the target thread's owner, whose server then keeps the
 * item's state (admit/dismiss/approve/reject) locally.
 */
export const HubAwarenessItem = Schema.Struct({
  ...Struct.omit(CooperationAwarenessItem.fields, ["state", "resolvedAt"]),
  sourceThreadId: HubThreadId,
  targetThreadId: HubThreadId,
  text: Schema.String.check(Schema.isMaxLength(COOPERATION_NOTE_MAX_CHARS)),
  citations: Schema.Array(HubCitation),
});
export type HubAwarenessItem = typeof HubAwarenessItem.Type;

/** Everything a member needs about one project; sent on `welcome` and `team.snapshot`. */
export const HubProjectState = Schema.Struct({
  project: HubProject,
  members: Schema.Array(HubProjectMember),
  /** Members, inviters and comment authors, so names always render. */
  accounts: Schema.Array(HubAccount),
  brief: Schema.NullOr(HubProjectBriefVersion),
  focuses: Schema.Array(HubProjectMemberFocus),
  /** Newest first, at most `TEAM_ACTIVITY_SNAPSHOT_LIMIT`. */
  activity: Schema.Array(HubTeamActivityItem),
  threads: Schema.Array(HubThreadSummary),
  analyses: Schema.Array(HubAnalysisSummary),
  /** Awareness items addressed to this connection's account only. */
  awareness: Schema.Array(HubAwarenessItem),
  /** The project's pending invitations. */
  invitations: Schema.Array(HubProjectInvitation),
});
export type HubProjectState = typeof HubProjectState.Type;

// ---------------------------------------------------------------------------
// Thread mirror: what a shared thread may send
// ---------------------------------------------------------------------------

/**
 * The orchestration events a shared thread publishes, after `RedactForHub`.
 * This is the complete allowlist; every other orchestration event type is in
 * `HUB_DENIED_ORCHESTRATION_EVENT_TYPES` and never leaves the owner's machine.
 */
export const HUB_SYNCED_ORCHESTRATION_EVENT_TYPES = [
  "thread.created",
  "thread.meta-updated",
  "thread.message-sent",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.proposed-plan-upserted",
  "thread.session-set",
  "thread.reverted",
  "thread.archived",
  "thread.unarchived",
  "thread.visibility-set",
  "thread.deleted",
] as const satisfies ReadonlyArray<OrchestrationEventType>;
export type HubSyncedOrchestrationEventType = (typeof HUB_SYNCED_ORCHESTRATION_EVENT_TYPES)[number];

/** Hub-native thread events, produced by the owner's server (not orchestration events). */
export const HUB_NATIVE_THREAD_EVENT_TYPES = ["thread.turn-diff", "thread.summary-set"] as const;

export const HUB_THREAD_EVENT_TYPES = [
  ...HUB_SYNCED_ORCHESTRATION_EVENT_TYPES,
  ...HUB_NATIVE_THREAD_EVENT_TYPES,
] as const;
export type HubThreadEventType = (typeof HUB_THREAD_EVENT_TYPES)[number];

const syncedTypes: ReadonlySet<string> = new Set(HUB_SYNCED_ORCHESTRATION_EVENT_TYPES);

/**
 * Orchestration events that never sync: project events (the hub has its own
 * projects), command intents (turn start, interrupts, approval and user-input
 * answers, reverts, session stops), local organization (pin, snooze, settle,
 * auto-settle, runtime/interaction mode), pull-request and related-thread
 * links, and comments (the hub owns them).
 */
export const HUB_DENIED_ORCHESTRATION_EVENT_TYPES: ReadonlyArray<OrchestrationEventType> =
  OrchestrationEventTypeSchema.literals.filter((type) => !syncedTypes.has(type));

export const isHubSyncedOrchestrationEventType = (
  type: string,
): type is HubSyncedOrchestrationEventType => syncedTypes.has(type);

/**
 * What must never reach the hub, whatever the event. `RedactForHub`
 * implementations enforce every entry; the hub may re-check `eventTypes`.
 */
export const HUB_SYNC_DENYLIST = {
  eventTypes: HUB_DENIED_ORCHESTRATION_EVENT_TYPES,
  /** Fields removed from synced payloads. */
  fields: [
    "worktreePath",
    "message.context",
    "message.attachments[].source",
    "thread.meta-updated.{regenerateTitle,previousTitle,titleRegeneration,activeOrderKey,linkedPullRequest,branchPullRequest}",
  ],
  /** Object keys (any depth, case-insensitive) whose values are replaced in free-form payloads. */
  payloadKeys:
    /^(?:env|environment|headers?|cookies?|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|credentials?|private[_-]?key)$/i,
  /**
   * Text rules applied to every synced string: credentials and key formats
   * are masked, workspace roots become `.`, home directories become `~`. Never
   * synced at all: provider logins and credentials, settings, environment
   * variables, pairing links, attachment bytes, terminals, private threads.
   */
  text: ["secrets", "workspace-roots", "home-directories"],
} as const;

/** Appended where a payload was cut to fit `HUB_SYNC_LIMITS`. */
export const HUB_TRUNCATION_MARKER = "…[truncated for team sync]";

/** Per-event and per-frame size caps, in UTF-8 bytes unless named otherwise. */
export const HUB_SYNC_LIMITS = {
  /** One WebSocket frame. Cloudflare caps messages at 1 MiB. */
  frameMaxBytes: 1_000_000,
  /** One encoded `HubThreadEvent`, after redaction. Larger events are dropped. */
  eventMaxBytes: 256_000,
  /** Events in one `publish` and in one `thread.events`. */
  eventsPerBatchMax: 100,
  messageTextMaxBytes: 64_000,
  /** A tool call's whole `activity.payload`; over this it becomes a truncated preview. */
  activityPayloadMaxBytes: 32_000,
  /** Any single string inside an activity payload (tool output). */
  activityStringMaxBytes: 16_000,
  /** A full turn patch in `thread.turn-diff`. */
  diffMaxBytes: 200_000,
  checkpointFilesMax: 1_000,
  planMarkdownMaxBytes: 64_000,
  sessionErrorMaxBytes: 2_000,
  /** Delivered-but-unacked events per connection before the hub pauses `thread.events`. */
  unackedEventsMax: 1_000,
  subscriptionsMax: 500,
  /** Newest comments per thread in a `comment.snapshot`. */
  commentSnapshotMax: 200,
  activitySnapshotMax: TEAM_ACTIVITY_SNAPSHOT_LIMIT,
} as const;

/** Full patch of one turn's changes (the checkpoint file list is `thread.turn-diff-completed`). */
export const HubTurnDiffPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: ThreadTurnDiffCompletedPayload.fields.turnId,
  checkpointTurnCount: NonNegativeInt,
  diff: Schema.String,
});
export type HubTurnDiffPayload = typeof HubTurnDiffPayload.Type;

const thread = <Type extends HubThreadEventType, Payload extends Schema.Top>(
  type: Type,
  payload: Payload,
) => Schema.Struct({ type: Schema.Literal(type), payload });

/** The `{ type, payload }` part of a hub thread event. Payloads are the orchestration ones. */
export const HubThreadEventBody = Schema.Union([
  thread("thread.created", ThreadCreatedPayload),
  thread("thread.meta-updated", ThreadMetaUpdatedPayload),
  thread("thread.message-sent", ThreadMessageSentPayload),
  thread("thread.activity-appended", ThreadActivityAppendedPayload),
  thread("thread.turn-diff-completed", ThreadTurnDiffCompletedPayload),
  thread("thread.proposed-plan-upserted", ThreadProposedPlanUpsertedPayload),
  thread("thread.session-set", ThreadSessionSetPayload),
  thread("thread.reverted", ThreadRevertedPayload),
  thread("thread.archived", ThreadArchivedPayload),
  thread("thread.unarchived", ThreadUnarchivedPayload),
  thread("thread.visibility-set", ThreadVisibilitySetPayload),
  thread("thread.deleted", ThreadDeletedPayload),
  thread("thread.turn-diff", HubTurnDiffPayload),
  thread("thread.summary-set", HubThreadSummaryFields),
]);
export type HubThreadEventBody = typeof HubThreadEventBody.Type;

/**
 * One event in a shared thread's stream. `seq` is assigned by the owner's
 * server: 1, 2, 3… with no gaps within a generation. `truncated` marks events
 * `RedactForHub` cut to fit `HUB_SYNC_LIMITS`.
 */
export const HubThreadEvent = Schema.Struct({
  seq: PositiveInt,
  occurredAt: IsoDateTime,
  truncated: Schema.optional(Schema.Literal(true)),
  body: HubThreadEventBody,
});
export type HubThreadEvent = typeof HubThreadEvent.Type;

/** The body of an orchestration event when its type may sync; null otherwise. Not yet redacted. */
export const toHubThreadEventBody = (event: OrchestrationEvent): HubThreadEventBody | null =>
  isHubSyncedOrchestrationEventType(event.type)
    ? ({ type: event.type, payload: event.payload } as HubThreadEventBody)
    : null;

/** Owner-machine facts the redaction needs. */
export interface HubRedactionContext {
  /** The project root and the thread's worktree; occurrences become `.`. */
  readonly workspaceRoots: ReadonlyArray<string>;
  /** Home directories; occurrences become `~`. */
  readonly homeDirs: ReadonlyArray<string>;
}

export interface HubRedactionResult {
  readonly body: HubThreadEventBody;
  readonly truncated: boolean;
}

/**
 * The one step between a local event and the hub. Enforces
 * `HUB_SYNC_DENYLIST` and `HUB_SYNC_LIMITS`; returns null when nothing may be
 * sent (denied type, nothing left after stripping, or still over
 * `eventMaxBytes`). Pure; implemented as `redactForHub` in
 * `@t3tools/shared/hubRedaction`.
 */
export type RedactForHub = (
  body: HubThreadEventBody,
  context: HubRedactionContext,
) => HubRedactionResult | null;

/** Where a reader is in one thread's stream. */
export const HubThreadCursor = Schema.Struct({
  threadId: HubThreadId,
  generation: PositiveInt,
  seq: NonNegativeInt,
});
export type HubThreadCursor = typeof HubThreadCursor.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const HubErrorReason = Schema.Literals([
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "invalid",
  "rate-limited",
  "version-mismatch",
]);
export type HubErrorReason = typeof HubErrorReason.Type;

export const HUB_ERROR_STATUS: Readonly<Record<HubErrorReason, number>> = {
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  invalid: 400,
  "rate-limited": 429,
  "version-mismatch": 426,
};

const hubErrorFields = {
  message: TrimmedNonEmptyString,
} as const;

export class HubUnauthorizedError extends Schema.TaggedError<HubUnauthorizedError>()(
  "HubUnauthorizedError",
  { reason: Schema.Literal("unauthorized"), ...hubErrorFields },
  { httpApiStatus: 401 },
) {}

export class HubForbiddenError extends Schema.TaggedError<HubForbiddenError>()(
  "HubForbiddenError",
  { reason: Schema.Literal("forbidden"), ...hubErrorFields },
  { httpApiStatus: 403 },
) {}

export class HubNotFoundError extends Schema.TaggedError<HubNotFoundError>()(
  "HubNotFoundError",
  { reason: Schema.Literal("not-found"), ...hubErrorFields },
  { httpApiStatus: 404 },
) {}

export class HubConflictError extends Schema.TaggedError<HubConflictError>()(
  "HubConflictError",
  { reason: Schema.Literal("conflict"), ...hubErrorFields },
  { httpApiStatus: 409 },
) {}

export class HubInvalidError extends Schema.TaggedError<HubInvalidError>()(
  "HubInvalidError",
  { reason: Schema.Literal("invalid"), ...hubErrorFields },
  { httpApiStatus: 400 },
) {}

export class HubRateLimitedError extends Schema.TaggedError<HubRateLimitedError>()(
  "HubRateLimitedError",
  {
    reason: Schema.Literal("rate-limited"),
    ...hubErrorFields,
    retryAfterSeconds: PositiveInt,
  },
  { httpApiStatus: 429 },
) {}

export class HubVersionMismatchError extends Schema.TaggedError<HubVersionMismatchError>()(
  "HubVersionMismatchError",
  { reason: Schema.Literal("version-mismatch"), ...hubErrorFields, protocol: HubProtocolRange },
  { httpApiStatus: 426 },
) {}

export const HubError = Schema.Union([
  HubUnauthorizedError,
  HubForbiddenError,
  HubNotFoundError,
  HubConflictError,
  HubInvalidError,
  HubRateLimitedError,
  HubVersionMismatchError,
]);
export type HubError = typeof HubError.Type;

// ---------------------------------------------------------------------------
// Sync protocol: client (local server) → hub
// ---------------------------------------------------------------------------

/**
 * First frame on the socket. `subscriptions` are teammates' threads to stream
 * (the hub resumes each after its cursor). The hub answers `welcome` or
 * `reject` + close. Any other frame before `welcome` is `invalid`.
 */
export const HubHelloMessage = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: HubProtocolRange,
  /** Puff Collab version, for diagnostics only. */
  appVersion: Schema.optional(TrimmedNonEmptyString),
  subscriptions: Schema.Array(HubThreadCursor),
});

/**
 * Append events to one of this link's threads. Events are ascending and
 * contiguous. The hub ignores (and acks) events at or below its last `seq`,
 * and rejects a gap with `conflict` + `expectedSeq`. `reset` restarts the
 * stream (first event must be seq 1): the hub drops the old events, bumps the
 * generation and tells subscribers to rebuild. A thread's first publish, and
 * the first after it was removed, starts at seq 1 and includes a
 * `thread.summary-set`; the hub lists a thread only once it has a summary.
 * Publishing `thread.visibility-set` private or `thread.deleted` removes the
 * mirror.
 */
export const HubPublishMessage = Schema.Struct({
  type: Schema.Literal("publish"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  threadId: HubThreadId,
  reset: Schema.optional(Schema.Literal(true)),
  events: Schema.Array(HubThreadEvent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HUB_SYNC_LIMITS.eventsPerBatchMax),
  ),
});

/** Teammates' thread events this server has durably applied (flow control). */
export const HubClientAckMessage = Schema.Struct({
  type: Schema.Literal("ack"),
  cursors: Schema.Array(HubThreadCursor),
});

/** Start streaming a teammate's thread; without a cursor, from the beginning. */
export const HubThreadSubscribeMessage = Schema.Struct({
  type: Schema.Literal("thread.subscribe"),
  threadId: HubThreadId,
  cursor: Schema.optional(HubThreadCursor),
});

export const HubThreadUnsubscribeMessage = Schema.Struct({
  type: Schema.Literal("thread.unsubscribe"),
  threadId: HubThreadId,
});

/** `commentId` is client-minted so a retried add is idempotent. */
export const HubCommentAddMessage = Schema.Struct({
  type: Schema.Literal("comment.add"),
  requestId: HubRequestId,
  threadId: HubThreadId,
  commentId: ThreadCommentId,
  text: HubThreadComment.fields.text,
});

export const HubCommentDeleteMessage = Schema.Struct({
  type: Schema.Literal("comment.delete"),
  requestId: HubRequestId,
  threadId: HubThreadId,
  commentId: ThreadCommentId,
});

/** Rejected with `conflict` when `expectedVersion` is not the current version. */
export const HubBriefUpdateMessage = Schema.Struct({
  type: Schema.Literal("brief.update"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  text: ProjectBriefText,
  /** Null for a project with no brief yet. */
  expectedVersion: Schema.NullOr(PositiveInt),
});

/** Always the caller's own focus. Null clears it. */
export const HubFocusSetMessage = Schema.Struct({
  type: Schema.Literal("focus.set"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  focus: Schema.NullOr(ProjectMemberFocusText),
});

export const HubInvitationCreateMessage = Schema.Struct({
  type: Schema.Literal("invitation.create"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  githubLogin: GithubLogin,
});

const invitationAction = <Type extends string>(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    requestId: HubRequestId,
    invitationId: HubInvitationId,
  });

export const HubInvitationAcceptMessage = invitationAction("invitation.accept");
export const HubInvitationDeclineMessage = invitationAction("invitation.decline");
export const HubInvitationCancelMessage = invitationAction("invitation.cancel");

export const HubMemberLeaveMessage = Schema.Struct({
  type: Schema.Literal("member.leave"),
  requestId: HubRequestId,
  projectId: HubProjectId,
});

/** Project admins (the creator included) only. The creator cannot be removed. */
export const HubMemberRemoveMessage = Schema.Struct({
  type: Schema.Literal("member.remove"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  accountId: HubAccountId,
});

/**
 * Results of an analysis the caller's server ran with its owner's provider.
 * `summaries[].threadId` and `awareness[].sourceThreadId` must be the caller's
 * own threads, and every referenced thread must have analysis consent.
 */
export const HubAnalysisPostMessage = Schema.Struct({
  type: Schema.Literal("analysis.post"),
  requestId: HubRequestId,
  projectId: HubProjectId,
  summaries: Schema.Array(HubAnalysisSummary),
  awareness: Schema.Array(HubAwarenessItem),
});

export const HubClientMessage = Schema.Union([
  HubHelloMessage,
  HubPublishMessage,
  HubClientAckMessage,
  HubThreadSubscribeMessage,
  HubThreadUnsubscribeMessage,
  HubCommentAddMessage,
  HubCommentDeleteMessage,
  HubBriefUpdateMessage,
  HubFocusSetMessage,
  HubInvitationCreateMessage,
  HubInvitationAcceptMessage,
  HubInvitationDeclineMessage,
  HubInvitationCancelMessage,
  HubMemberLeaveMessage,
  HubMemberRemoveMessage,
  HubAnalysisPostMessage,
]);
export type HubClientMessage = typeof HubClientMessage.Type;
export type HubClientMessageType = HubClientMessage["type"];

// ---------------------------------------------------------------------------
// Sync protocol: hub → client
// ---------------------------------------------------------------------------

/**
 * Reply to `hello`. Team data always arrives as a full snapshot here (it is
 * small and bounded), followed by deltas; only thread events resume by cursor.
 * After `welcome` the hub sends a `comment.snapshot` for each of this link's
 * threads and each subscription, then `thread.events` after each cursor.
 */
export const HubWelcomeMessage = Schema.Struct({
  type: Schema.Literal("welcome"),
  protocolVersion: PositiveInt,
  account: HubAccount,
  linkId: HubEnvironmentLinkId,
  projects: Schema.Array(HubProjectState),
  /** Last accepted cursor of each of this link's threads; resume publishing after it. */
  published: Schema.Array(HubThreadCursor),
  /** This account's pending incoming invitations. */
  invitations: Schema.Array(HubProjectInvitation),
  serverTime: IsoDateTime,
});

/** Success for a request. For `publish`, `cursor` is the stream position now accepted. */
export const HubServerAckMessage = Schema.Struct({
  type: Schema.Literal("ack"),
  requestId: HubRequestId,
  cursor: Schema.optional(HubThreadCursor),
});

/** A refused request (or, with `requestId` null, a refused connection / frame). */
export const HubRejectMessage = Schema.Struct({
  type: Schema.Literal("reject"),
  requestId: Schema.NullOr(HubRequestId),
  reason: HubErrorReason,
  message: TrimmedNonEmptyString,
  /** `conflict` on `publish`: the seq the hub expects next. */
  expectedSeq: Schema.optional(PositiveInt),
  /** `conflict` on `brief.update`: the current version. */
  currentVersion: Schema.optional(Schema.NullOr(PositiveInt)),
  /** `version-mismatch`: what the hub supports. */
  protocol: Schema.optional(HubProtocolRange),
  /** `rate-limited`. */
  retryAfterSeconds: Schema.optional(PositiveInt),
});

/** Events of a subscribed teammate thread. `reset`: discard the local mirror first. */
export const HubThreadEventsMessage = Schema.Struct({
  type: Schema.Literal("thread.events"),
  projectId: HubProjectId,
  threadId: HubThreadId,
  generation: PositiveInt,
  reset: Schema.optional(Schema.Literal(true)),
  events: Schema.Array(HubThreadEvent).check(Schema.isMaxLength(HUB_SYNC_LIMITS.eventsPerBatchMax)),
});

/** Drop the mirror and cursor of a thread. */
export const HubThreadRemovedMessage = Schema.Struct({
  type: Schema.Literal("thread.removed"),
  projectId: HubProjectId,
  threadId: HubThreadId,
  reason: Schema.Literals(["private", "deleted", "access-lost"]),
});

export const HubCommentSnapshotMessage = Schema.Struct({
  type: Schema.Literal("comment.snapshot"),
  projectId: HubProjectId,
  threadId: HubThreadId,
  /** Oldest first, the newest `HUB_SYNC_LIMITS.commentSnapshotMax`. */
  comments: Schema.Array(HubThreadComment),
});

export const HubCommentAddedMessage = Schema.Struct({
  type: Schema.Literal("comment.added"),
  projectId: HubProjectId,
  comment: HubThreadComment,
});

export const HubCommentDeletedMessage = Schema.Struct({
  type: Schema.Literal("comment.deleted"),
  projectId: HubProjectId,
  threadId: HubThreadId,
  commentId: ThreadCommentId,
});

/** Full state of a project the account just joined, or a resync. */
export const HubTeamSnapshotMessage = Schema.Struct({
  type: Schema.Literal("team.snapshot"),
  state: HubProjectState,
});

/** The account lost access to a project. Drop it and its teammates' thread mirrors. */
export const HubTeamRemovedMessage = Schema.Struct({
  type: Schema.Literal("team.removed"),
  projectId: HubProjectId,
  reason: Schema.Literals(["left", "removed"]),
});

/** A shared thread's summary changed (or appeared). */
export const HubTeamThreadMessage = Schema.Struct({
  type: Schema.Literal("team.thread"),
  summary: HubThreadSummary,
});

export const HubTeamBriefMessage = Schema.Struct({
  type: Schema.Literal("team.brief"),
  brief: HubProjectBriefVersion,
});

export const HubTeamFocusMessage = Schema.Struct({
  type: Schema.Literal("team.focus"),
  projectId: HubProjectId,
  accountId: HubAccountId,
  /** Null when cleared. */
  focus: Schema.NullOr(HubProjectMemberFocus),
});

/** New activity items, newest first. */
export const HubTeamActivityMessage = Schema.Struct({
  type: Schema.Literal("team.activity"),
  projectId: HubProjectId,
  items: Schema.Array(HubTeamActivityItem),
});

/** Full member list after any change. */
export const HubTeamMembersMessage = Schema.Struct({
  type: Schema.Literal("team.members"),
  projectId: HubProjectId,
  members: Schema.Array(HubProjectMember),
  accounts: Schema.Array(HubAccount),
});

/** Full list of the project's pending invitations after any change. */
export const HubTeamInvitationsMessage = Schema.Struct({
  type: Schema.Literal("team.invitations"),
  projectId: HubProjectId,
  invitations: Schema.Array(HubProjectInvitation),
});

export const HubTeamAnalysisMessage = Schema.Struct({
  type: Schema.Literal("team.analysis"),
  projectId: HubProjectId,
  summaries: Schema.Array(HubAnalysisSummary),
});

/** Awareness items for this account's threads only. */
export const HubTeamAwarenessMessage = Schema.Struct({
  type: Schema.Literal("team.awareness"),
  projectId: HubProjectId,
  items: Schema.Array(HubAwarenessItem),
});

/** Full list of this account's pending incoming invitations after any change. */
export const HubInvitationsMessage = Schema.Struct({
  type: Schema.Literal("invitations"),
  invitations: Schema.Array(HubProjectInvitation),
});

export const HubServerMessage = Schema.Union([
  HubWelcomeMessage,
  HubServerAckMessage,
  HubRejectMessage,
  HubThreadEventsMessage,
  HubThreadRemovedMessage,
  HubCommentSnapshotMessage,
  HubCommentAddedMessage,
  HubCommentDeletedMessage,
  HubTeamSnapshotMessage,
  HubTeamRemovedMessage,
  HubTeamThreadMessage,
  HubTeamBriefMessage,
  HubTeamFocusMessage,
  HubTeamActivityMessage,
  HubTeamMembersMessage,
  HubTeamInvitationsMessage,
  HubTeamAnalysisMessage,
  HubTeamAwarenessMessage,
  HubInvitationsMessage,
]);
export type HubServerMessage = typeof HubServerMessage.Type;
export type HubServerMessageType = HubServerMessage["type"];

/** Frames are JSON text: `JSON.stringify(Schema.encodeSync(HubClientMessage)(message))`. */
export const HubClientFrame = Schema.fromJsonString(HubClientMessage);
export const HubServerFrame = Schema.fromJsonString(HubServerMessage);

// ---------------------------------------------------------------------------
// HTTP API (Worker routes; WebSocket upgrade at HUB_SYNC_PATH is outside it)
// ---------------------------------------------------------------------------

export class HubAccountPrincipal extends Context.Service<
  HubAccountPrincipal,
  { readonly accountId: HubAccountId }
>()("@t3tools/contracts/hub/HubAccountPrincipal") {}

export class HubEnvironmentPrincipal extends Context.Service<
  HubEnvironmentPrincipal,
  { readonly accountId: HubAccountId; readonly linkId: HubEnvironmentLinkId }
>()("@t3tools/contracts/hub/HubEnvironmentPrincipal") {}

export class HubBrowserSessionAuth extends HttpApiMiddleware.Service<
  HubBrowserSessionAuth,
  { provides: HubAccountPrincipal }
>()("HubBrowserSessionAuth", {
  error: HubUnauthorizedError,
  security: {
    session: HttpApiSecurity.apiKey({ key: HUB_SESSION_COOKIE, in: "cookie" }).pipe(
      HttpApiSecurity.annotate(OpenApi.Description, "Hub browser session from GitHub sign-in."),
    ),
  },
}) {}

export class HubEnvironmentAuth extends HttpApiMiddleware.Service<
  HubEnvironmentAuth,
  { provides: HubEnvironmentPrincipal }
>()("HubEnvironmentAuth", {
  error: HubUnauthorizedError,
  security: {
    environmentBearer: HttpApiSecurity.http({ scheme: "bearer" }).pipe(
      HttpApiSecurity.annotate(OpenApi.Description, "Environment credential from linking."),
    ),
  },
}) {}

export const HubHealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  protocol: HubProtocolRange,
});
export type HubHealthResponse = typeof HubHealthResponse.Type;

const HubPublicGroup = HttpApiGroup.make("public")
  .add(
    HttpApiEndpoint.get("health", "/v1/health", { success: HubHealthResponse }),
    HttpApiEndpoint.get("githubStart", "/v1/auth/github/start", {
      query: HubGithubStartQuery,
      success: HttpApiSchema.Empty(302),
      error: HubInvalidError,
    }).annotate(OpenApi.Summary, "Redirect to GitHub sign-in"),
    HttpApiEndpoint.get("githubCallback", "/v1/auth/github/callback", {
      query: HubGithubCallbackQuery,
      success: HttpApiSchema.Empty(302),
      error: [HubInvalidError, HubUnauthorizedError],
    }).annotate(OpenApi.Summary, "GitHub OAuth callback; sets the session cookie"),
    HttpApiEndpoint.post("linkStart", "/v1/link/requests", {
      payload: HubLinkStartRequest,
      success: HubLinkStartResponse,
      error: [HubInvalidError, HubRateLimitedError],
    }).annotate(OpenApi.Summary, "Start linking an environment"),
    HttpApiEndpoint.post("linkToken", "/v1/link/token", {
      payload: HubLinkTokenRequest,
      success: HubLinkTokenResponse,
      error: [HubInvalidError, HubNotFoundError, HubRateLimitedError],
    }).annotate(OpenApi.Summary, "Poll for the environment credential"),
  )
  .annotate(OpenApi.Description, "Unauthenticated: health, sign-in redirects, link codes.");

const HubBrowserGroup = HttpApiGroup.make("browser")
  .add(
    HttpApiEndpoint.get("session", "/v1/auth/session", { success: HubBrowserSession }),
    HttpApiEndpoint.post("signOut", "/v1/auth/sign-out", { success: HttpApiSchema.NoContent }),
    HttpApiEndpoint.get("linkDescribe", "/v1/link/requests/:userCode", {
      params: Schema.Struct({ userCode: HubLinkUserCode }),
      success: HubLinkDescribeResponse,
      error: HubNotFoundError,
    }),
    HttpApiEndpoint.post("linkDecide", "/v1/link/decision", {
      payload: HubLinkDecisionRequest,
      success: HttpApiSchema.NoContent,
      error: [HubNotFoundError, HubInvalidError],
    }).annotate(OpenApi.Summary, "Approve or deny an environment link"),
    HttpApiEndpoint.get("listLinks", "/v1/account/links", {
      success: Schema.Struct({ links: Schema.Array(HubEnvironmentLink) }),
    }),
    HttpApiEndpoint.delete("revokeLink", "/v1/account/links/:linkId", {
      params: Schema.Struct({ linkId: HubEnvironmentLinkId }),
      success: HttpApiSchema.NoContent,
      error: HubNotFoundError,
    }),
  )
  .annotate(OpenApi.Description, "Signed-in browser: session, link confirmation, link list.")
  .middleware(HubBrowserSessionAuth);

const HubEnvironmentGroup = HttpApiGroup.make("environment")
  .add(
    HttpApiEndpoint.get("environmentInfo", "/v1/environment", { success: HubEnvironmentInfo }),
    HttpApiEndpoint.delete("unlink", "/v1/environment", { success: HttpApiSchema.NoContent }),
    HttpApiEndpoint.post("linkProject", "/v1/projects/link", {
      payload: HubProjectLinkRequest,
      success: HubProjectLinkResponse,
      error: [HubForbiddenError, HubNotFoundError, HubInvalidError],
    }).annotate(OpenApi.Summary, "Map a local project to a hub project"),
  )
  .annotate(OpenApi.Description, "Linked environment (local Puff Collab server).")
  .middleware(HubEnvironmentAuth);

export const HubApi = HttpApi.make("HubApi")
  .add(HubPublicGroup, HubBrowserGroup, HubEnvironmentGroup)
  .annotate(OpenApi.Title, "Puff Collab Hub API")
  .annotate(OpenApi.Version, `${HUB_PROTOCOL_VERSION}.0.0`);
export type HubApi = typeof HubApi;
