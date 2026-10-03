/**
 * Contracts between a client and its own local server for the team hub
 * (Stage 7). The hub protocol itself lives in hub.ts; these RPCs let the
 * user see the local server's hub connection, link it to their hub account,
 * link local projects to hub projects, and answer invitations. The local
 * server forwards to the hub; clients never talk to the hub directly.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  GithubLogin,
  HubAccount,
  HubAccountId,
  HubEnvironmentLinkId,
  HubInvitationId,
  HubProjectId,
  HubThreadId,
} from "./hubIds.ts";

/** Where the local server's hub connection stands. */
export const HubConnectionState = Schema.Literals([
  // No hub URL configured, or the environment was unlinked.
  "unlinked",
  // A link code is waiting for the user to approve it on the hub.
  "linking",
  "connecting",
  "online",
  // Linked but the hub is unreachable; outbound events queue locally.
  "offline",
  // The hub or this server must be upgraded; reconnecting is paused.
  "version-mismatch",
  // Link revoked or another unrecoverable error; see `lastError`.
  "error",
]);
export type HubConnectionState = typeof HubConnectionState.Type;

export const HubPendingLink = Schema.Struct({
  userCode: TrimmedNonEmptyString,
  verificationUrl: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type HubPendingLink = typeof HubPendingLink.Type;

/** One local project's hub link, if any. */
export const HubLocalProjectLink = Schema.Struct({
  projectId: ProjectId,
  hubProjectId: HubProjectId,
  hubProjectTitle: TrimmedNonEmptyString,
});
export type HubLocalProjectLink = typeof HubLocalProjectLink.Type;

export const HubLocalStatus = Schema.Struct({
  state: HubConnectionState,
  hubUrl: Schema.NullOr(TrimmedNonEmptyString),
  account: Schema.NullOr(HubAccount),
  linkId: Schema.NullOr(HubEnvironmentLinkId),
  pendingLink: Schema.NullOr(HubPendingLink),
  projects: Schema.Array(HubLocalProjectLink),
  // Outbound thread events not yet acknowledged by the hub.
  queuedEvents: NonNegativeInt,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type HubLocalStatus = typeof HubLocalStatus.Type;

export const HubConfigureInput = Schema.Struct({
  // Null clears the hub URL (and unlinks).
  hubUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type HubConfigureInput = typeof HubConfigureInput.Type;

export const HubLinkProjectInput = Schema.Struct({
  projectId: ProjectId,
  // Join an existing hub project (e.g. one a teammate created for the same
  // repository); omitted creates or reuses the caller's own.
  hubProjectId: Schema.optional(HubProjectId),
});
export type HubLinkProjectInput = typeof HubLinkProjectInput.Type;

export const HubLinkProjectResult = Schema.Struct({
  link: HubLocalProjectLink,
  // Other hub projects for the same repository the caller can join instead.
  alternatives: Schema.Array(
    Schema.Struct({ hubProjectId: HubProjectId, title: TrimmedNonEmptyString }),
  ),
});
export type HubLinkProjectResult = typeof HubLinkProjectResult.Type;

export const HubUnlinkProjectInput = Schema.Struct({ projectId: ProjectId });
export type HubUnlinkProjectInput = typeof HubUnlinkProjectInput.Type;

/** An invitation as the local user sees it (incoming or sent from their projects). */
export const HubLocalInvitation = Schema.Struct({
  invitationId: HubInvitationId,
  hubProjectId: HubProjectId,
  projectTitle: TrimmedNonEmptyString,
  inviterLogin: GithubLogin,
  inviteeLogin: GithubLogin,
  direction: Schema.Literals(["incoming", "outgoing"]),
  state: Schema.Literals(["pending", "accepted", "declined", "cancelled", "expired"]),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type HubLocalInvitation = typeof HubLocalInvitation.Type;

export const HubLocalInvitationsResult = Schema.Struct({
  invitations: Schema.Array(HubLocalInvitation),
});
export type HubLocalInvitationsResult = typeof HubLocalInvitationsResult.Type;

export const HubInviteInput = Schema.Struct({
  projectId: ProjectId,
  githubLogin: GithubLogin,
});
export type HubInviteInput = typeof HubInviteInput.Type;

export const HubInvitationRespondInput = Schema.Struct({
  invitationId: HubInvitationId,
  decision: Schema.Literals(["accept", "decline"]),
});
export type HubInvitationRespondInput = typeof HubInvitationRespondInput.Type;

export const HubInvitationCancelInput = Schema.Struct({ invitationId: HubInvitationId });
export type HubInvitationCancelInput = typeof HubInvitationCancelInput.Type;

/**
 * Present on thread shells/threads that are linked to the hub. `remote` threads
 * belong to a teammate: they are read-only mirrors on this server (follow and
 * comment only). Local threads carry it once shared, so the UI can show sync
 * state.
 */
export const HubThreadLink = Schema.Struct({
  threadId: HubThreadId,
  ownerId: HubAccountId,
  ownerLogin: GithubLogin,
  ownerDisplayName: TrimmedNonEmptyString,
  remote: Schema.Boolean,
  // For local shared threads: whether every event has reached the hub.
  syncState: Schema.Literals(["synced", "pending", "offline"]),
});
export type HubThreadLink = typeof HubThreadLink.Type;

/** A thread is a teammate's read-only mirror when its hub link says remote. */
export const isRemoteHubThread = (thread: { readonly hub?: HubThreadLink | undefined }) =>
  thread.hub?.remote === true;

export class HubLocalError extends Schema.TaggedError<HubLocalError>()("HubLocalError", {
  reason: Schema.Literals([
    "not-configured",
    "not-linked",
    "offline",
    "not-found",
    "forbidden",
    "conflict",
    "invalid",
    "unavailable",
  ]),
  message: TrimmedNonEmptyString,
}) {}
