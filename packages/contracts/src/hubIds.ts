/**
 * Hub identifiers and the account shape, split from hub.ts so orchestration
 * contracts can reference them without an import cycle. Re-exported by hub.ts.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HubAccountId = TrimmedNonEmptyString.pipe(Schema.brand("HubAccountId"));
export type HubAccountId = typeof HubAccountId.Type;

export const HubProjectId = TrimmedNonEmptyString.pipe(Schema.brand("HubProjectId"));
export type HubProjectId = typeof HubProjectId.Type;

export const HubInvitationId = TrimmedNonEmptyString.pipe(Schema.brand("HubInvitationId"));
export type HubInvitationId = typeof HubInvitationId.Type;

/** Hub-minted id of one environment link. Never contains `:`. */
export const HubEnvironmentLinkId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/),
).pipe(Schema.brand("HubEnvironmentLinkId"));
export type HubEnvironmentLinkId = typeof HubEnvironmentLinkId.Type;

/**
 * A shared thread's id on the hub: `<linkId>:<local ThreadId>`.
 *
 * Derived, not minted, so the owner's server can name a thread (and queue its
 * events offline) before the hub has ever seen it, re-publishing is
 * idempotent, neither side keeps a mapping table, and the hub authorizes a
 * publish by checking the id's link prefix against the publishing link.
 */
export const HubThreadId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}:.+$/),
).pipe(Schema.brand("HubThreadId"));
export type HubThreadId = typeof HubThreadId.Type;

export const hubThreadIdOf = (linkId: HubEnvironmentLinkId, threadId: ThreadId): HubThreadId =>
  HubThreadId.make(`${linkId}:${threadId}`);

export const parseHubThreadId = (
  id: HubThreadId,
): { readonly linkId: HubEnvironmentLinkId; readonly threadId: ThreadId } => {
  const separator = id.indexOf(":");
  return {
    linkId: HubEnvironmentLinkId.make(id.slice(0, separator)),
    threadId: ThreadId.make(id.slice(separator + 1)),
  };
};

/** Client-chosen correlation id echoed by `ack` / `reject`. */
export const HubRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type HubRequestId = typeof HubRequestId.Type;

/** A GitHub login. Compare with `normalizeGithubLogin`; GitHub logins are case-insensitive. */
export const GithubLogin = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
);
export type GithubLogin = typeof GithubLogin.Type;

export const normalizeGithubLogin = (login: string): string => login.trim().toLowerCase();

export const HubAccount = Schema.Struct({
  accountId: HubAccountId,
  githubLogin: GithubLogin,
  displayName: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(TrimmedNonEmptyString),
});
export type HubAccount = typeof HubAccount.Type;
