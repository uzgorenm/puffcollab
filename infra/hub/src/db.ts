/**
 * D1 access: accounts, sessions, environment links, link requests, projects,
 * memberships, invitations and the shared-thread index. Plain async functions
 * so the Effect HTTP layer and the Durable Objects share them.
 */
import {
  HUB_INVITATION_PENDING_LIMIT,
  HUB_INVITATION_TTL_DAYS,
  HUB_LINK_CODE_TTL_SECONDS,
  type HubAccount,
  type HubAccountId,
  type HubEnvironmentLink,
  type HubEnvironmentLinkId,
  type HubInvitationId,
  type HubInvitationState,
  type HubLinkRequestId,
  type HubProject,
  type HubProjectId,
  type HubProjectInvitation,
  type HubProjectMember,
  type HubProjectRole,
  type HubRepositoryKey,
  type HubThreadId,
  type GithubLogin,
  normalizeGithubLogin,
} from "@t3tools/contracts/hub";

import { isoOf } from "./clock.ts";
import { randomId, randomLinkId, randomToken, randomUserCode, sha256Base64Url } from "./crypto.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LINK_POLL_INTERVAL_SECONDS = 5;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface AccountRow {
  readonly account_id: string;
  readonly github_login: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
}

const accountOf = (row: AccountRow): HubAccount => ({
  accountId: row.account_id as HubAccountId,
  githubLogin: row.github_login as GithubLogin,
  displayName: row.display_name,
  ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
});

const ACCOUNT_COLUMNS = "account_id, github_login, display_name, avatar_url";

export const getAccount = async (db: D1Database, accountId: string): Promise<HubAccount | null> => {
  const row = await db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_id = ?`)
    .bind(accountId)
    .first<AccountRow>();
  return row ? accountOf(row) : null;
};

export const getAccounts = async (
  db: D1Database,
  accountIds: Iterable<string>,
): Promise<Array<HubAccount>> => {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<AccountRow>();
  return result.results.map(accountOf);
};

/** The account currently holding a GitHub login (logins can move after renames). */
export const getAccountByLogin = async (
  db: D1Database,
  login: string,
): Promise<HubAccount | null> => {
  const row = await db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE login_key = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(normalizeGithubLogin(login))
    .first<AccountRow>();
  return row ? accountOf(row) : null;
};

export interface GithubProfile {
  readonly githubId: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

/** Creates or refreshes the account for a GitHub user. */
export const upsertGithubAccount = async (
  db: D1Database,
  profile: GithubProfile,
  nowMs: number,
): Promise<{ readonly account: HubAccount; readonly created: boolean }> => {
  const now = isoOf(nowMs);
  const displayName = profile.name?.trim() || profile.login;
  const existing = await db
    .prepare("SELECT account_id FROM accounts WHERE github_id = ?")
    .bind(profile.githubId)
    .first<{ account_id: string }>();
  const accountId = existing?.account_id ?? randomId("acc");
  if (existing) {
    await db
      .prepare(
        `UPDATE accounts SET github_login = ?, login_key = ?, display_name = ?, avatar_url = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .bind(
        profile.login,
        normalizeGithubLogin(profile.login),
        displayName,
        profile.avatarUrl,
        now,
        accountId,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO accounts (account_id, github_id, github_login, login_key, display_name, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        accountId,
        profile.githubId,
        profile.login,
        normalizeGithubLogin(profile.login),
        displayName,
        profile.avatarUrl,
        now,
        now,
      )
      .run();
  }
  return {
    account: accountOf({
      account_id: accountId,
      github_login: profile.login,
      display_name: displayName,
      avatar_url: profile.avatarUrl,
    }),
    created: !existing,
  };
};

/** DEV ONLY (`HUB_DEV_LOCAL_ACCOUNTS`): an account identified by login alone. */
export const upsertLocalAccount = async (
  db: D1Database,
  login: string,
  nowMs: number,
): Promise<HubAccount> => {
  const loginKey = normalizeGithubLogin(login);
  const existing = await db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE login_key = ? AND github_id IS NULL LIMIT 1`,
    )
    .bind(loginKey)
    .first<AccountRow>();
  if (existing) return accountOf(existing);
  const now = isoOf(nowMs);
  const accountId = randomId("acc");
  await db
    .prepare(
      `INSERT INTO accounts (account_id, github_id, github_login, login_key, display_name, avatar_url, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(accountId, login, loginKey, login, now, now)
    .run();
  return accountOf({
    account_id: accountId,
    github_login: login,
    display_name: login,
    avatar_url: null,
  });
};

// ---------------------------------------------------------------------------
// Browser sessions
// ---------------------------------------------------------------------------

export const createSession = async (
  db: D1Database,
  accountId: string,
  nowMs: number,
): Promise<{ readonly token: string; readonly expiresAtMs: number }> => {
  const token = randomToken();
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  await db
    .prepare(
      "INSERT INTO browser_sessions (token_hash, account_id, created_at, expires_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256Base64Url(token), accountId, isoOf(nowMs), expiresAtMs)
    .run();
  return { token, expiresAtMs };
};

export const sessionAccount = async (
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<{ readonly accountId: HubAccountId; readonly expiresAtMs: number } | null> => {
  const row = await db
    .prepare(
      "SELECT account_id, expires_at_ms FROM browser_sessions WHERE token_hash = ? AND expires_at_ms > ?",
    )
    .bind(await sha256Base64Url(token), nowMs)
    .first<{ account_id: string; expires_at_ms: number }>();
  return row ? { accountId: row.account_id as HubAccountId, expiresAtMs: row.expires_at_ms } : null;
};

export const deleteSession = async (db: D1Database, token: string): Promise<void> => {
  await db
    .prepare("DELETE FROM browser_sessions WHERE token_hash = ?")
    .bind(await sha256Base64Url(token))
    .run();
};

// ---------------------------------------------------------------------------
// Link requests (device-code style, PKCE S256)
// ---------------------------------------------------------------------------

export interface LinkRequestRow {
  readonly request_id: string;
  readonly user_code: string;
  readonly environment_label: string;
  readonly code_challenge: string;
  readonly status: "pending" | "approved" | "denied";
  readonly account_id: string | null;
  readonly expires_at_ms: number;
  readonly last_polled_at_ms: number | null;
}

export const createLinkRequest = async (
  db: D1Database,
  input: { readonly environmentLabel: string; readonly codeChallenge: string },
  nowMs: number,
): Promise<{ requestId: HubLinkRequestId; userCode: string; expiresAtMs: number }> => {
  // Expired requests only block their user code; clear them out first.
  await db
    .prepare("DELETE FROM link_requests WHERE expires_at_ms < ?")
    .bind(nowMs - 60_000)
    .run();
  const expiresAtMs = nowMs + HUB_LINK_CODE_TTL_SECONDS * 1000;
  for (let attempt = 0; ; attempt += 1) {
    const requestId = randomId("lrq") as HubLinkRequestId;
    const userCode = randomUserCode();
    const result = await db
      .prepare(
        `INSERT INTO link_requests (request_id, user_code, environment_label, code_challenge, status, created_at, expires_at_ms)
         VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (user_code) DO NOTHING`,
      )
      .bind(
        requestId,
        userCode,
        input.environmentLabel,
        input.codeChallenge,
        isoOf(nowMs),
        expiresAtMs,
      )
      .run();
    if (result.meta.changes === 1) return { requestId, userCode, expiresAtMs };
    if (attempt >= 5) throw new Error("Could not allocate a link code");
  }
};

const LINK_REQUEST_COLUMNS =
  "request_id, user_code, environment_label, code_challenge, status, account_id, expires_at_ms, last_polled_at_ms";

export const findLinkRequestByCode = (db: D1Database, userCode: string) =>
  db
    .prepare(`SELECT ${LINK_REQUEST_COLUMNS} FROM link_requests WHERE user_code = ?`)
    .bind(userCode)
    .first<LinkRequestRow>();

export const findLinkRequestById = (db: D1Database, requestId: string) =>
  db
    .prepare(`SELECT ${LINK_REQUEST_COLUMNS} FROM link_requests WHERE request_id = ?`)
    .bind(requestId)
    .first<LinkRequestRow>();

/** Approves or denies a pending, unexpired request. False when there is none. */
export const decideLinkRequest = async (
  db: D1Database,
  input: { readonly userCode: string; readonly accountId: string; readonly approve: boolean },
  nowMs: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE link_requests SET status = ?, account_id = ?
       WHERE user_code = ? AND status = 'pending' AND expires_at_ms > ?`,
    )
    .bind(input.approve ? "approved" : "denied", input.accountId, input.userCode, nowMs)
    .run();
  return result.meta.changes === 1;
};

export const touchLinkRequestPoll = async (db: D1Database, requestId: string, nowMs: number) => {
  await db
    .prepare("UPDATE link_requests SET last_polled_at_ms = ? WHERE request_id = ?")
    .bind(nowMs, requestId)
    .run();
};

/** Deletes an approved request; true for exactly one caller, so the credential is minted once. */
export const consumeApprovedLinkRequest = async (
  db: D1Database,
  requestId: string,
): Promise<boolean> => {
  const result = await db
    .prepare("DELETE FROM link_requests WHERE request_id = ? AND status = 'approved'")
    .bind(requestId)
    .run();
  return result.meta.changes === 1;
};

// ---------------------------------------------------------------------------
// Environment links
// ---------------------------------------------------------------------------

interface LinkRow {
  readonly link_id: string;
  readonly account_id: string;
  readonly environment_label: string;
  readonly linked_at: string;
  readonly last_seen_at: string | null;
  readonly revoked_at: string | null;
}

const LINK_COLUMNS = "link_id, account_id, environment_label, linked_at, last_seen_at, revoked_at";

export const linkOf = (row: LinkRow): HubEnvironmentLink => ({
  linkId: row.link_id as HubEnvironmentLinkId,
  accountId: row.account_id as HubAccountId,
  environmentLabel: row.environment_label,
  linkedAt: row.linked_at,
  lastSeenAt: row.last_seen_at,
});

export const createEnvironmentLink = async (
  db: D1Database,
  input: { readonly accountId: string; readonly environmentLabel: string },
  nowMs: number,
): Promise<{ readonly link: HubEnvironmentLink; readonly credential: string }> => {
  const linkId = randomLinkId();
  const credential = `phc_${randomToken(32)}`;
  const linkedAt = isoOf(nowMs);
  await db
    .prepare(
      `INSERT INTO environment_links (link_id, account_id, environment_label, credential_hash, linked_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      linkId,
      input.accountId,
      input.environmentLabel,
      await sha256Base64Url(credential),
      linkedAt,
    )
    .run();
  return {
    link: linkOf({
      link_id: linkId,
      account_id: input.accountId,
      environment_label: input.environmentLabel,
      linked_at: linkedAt,
      last_seen_at: null,
      revoked_at: null,
    }),
    credential,
  };
};

export type CredentialLookup =
  | { readonly status: "valid"; readonly link: HubEnvironmentLink }
  | { readonly status: "revoked" }
  | { readonly status: "unknown" };

export const lookupCredential = async (
  db: D1Database,
  credential: string,
): Promise<CredentialLookup> => {
  const row = await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM environment_links WHERE credential_hash = ?`)
    .bind(await sha256Base64Url(credential))
    .first<LinkRow>();
  if (!row) return { status: "unknown" };
  if (row.revoked_at) return { status: "revoked" };
  return { status: "valid", link: linkOf(row) };
};

export const getLink = async (db: D1Database, linkId: string) => {
  const row = await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM environment_links WHERE link_id = ?`)
    .bind(linkId)
    .first<LinkRow>();
  return row ? { link: linkOf(row), revoked: row.revoked_at !== null } : null;
};

export const listLinks = async (db: D1Database, accountId: string) => {
  const result = await db
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM environment_links WHERE account_id = ? AND revoked_at IS NULL ORDER BY linked_at`,
    )
    .bind(accountId)
    .all<LinkRow>();
  return result.results.map(linkOf);
};

export const revokeLink = async (
  db: D1Database,
  input: { readonly accountId: string; readonly linkId: string },
  nowMs: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE environment_links SET revoked_at = ?, live_conn_id = NULL
       WHERE link_id = ? AND account_id = ? AND revoked_at IS NULL`,
    )
    .bind(isoOf(nowMs), input.linkId, input.accountId)
    .run();
  return result.meta.changes === 1;
};

export const setLiveConnection = async (
  db: D1Database,
  linkId: string,
  connId: string,
  nowMs: number,
): Promise<void> => {
  await db
    .prepare(
      "UPDATE environment_links SET live_conn_id = ?, last_seen_at = ? WHERE link_id = ? AND revoked_at IS NULL",
    )
    .bind(connId, isoOf(nowMs), linkId)
    .run();
};

/** Clears the live connection only if it is still `connId` (a newer socket may own it). */
export const clearLiveConnection = async (
  db: D1Database,
  linkId: string,
  connId: string,
): Promise<void> => {
  await db
    .prepare(
      "UPDATE environment_links SET live_conn_id = NULL WHERE link_id = ? AND live_conn_id = ?",
    )
    .bind(linkId, connId)
    .run();
};

export interface LiveConnection {
  readonly linkId: HubEnvironmentLinkId;
  readonly accountId: HubAccountId;
  readonly connId: string;
}

export const liveConnectionsOf = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Array<LiveConnection>> => {
  if (accountIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT link_id, account_id, live_conn_id FROM environment_links
       WHERE account_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL AND live_conn_id IS NOT NULL`,
    )
    .bind(JSON.stringify([...new Set(accountIds)]))
    .all<{ link_id: string; account_id: string; live_conn_id: string }>();
  return result.results.map((row) => ({
    linkId: row.link_id as HubEnvironmentLinkId,
    accountId: row.account_id as HubAccountId,
    connId: row.live_conn_id,
  }));
};

// ---------------------------------------------------------------------------
// Projects and membership
// ---------------------------------------------------------------------------

interface ProjectRow {
  readonly project_id: string;
  readonly repository_key: string;
  readonly title: string;
  readonly created_by: string;
  readonly created_at: string;
}

const projectOf = (row: ProjectRow): HubProject => ({
  projectId: row.project_id as HubProjectId,
  repositoryKey: row.repository_key as HubRepositoryKey,
  title: row.title,
  createdBy: row.created_by as HubAccountId,
  createdAt: row.created_at,
});

const PROJECT_COLUMNS = "p.project_id, p.repository_key, p.title, p.created_by, p.created_at";

export const getProject = async (db: D1Database, projectId: string): Promise<HubProject | null> => {
  const row = await db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.project_id = ?`)
    .bind(projectId)
    .first<ProjectRow>();
  return row ? projectOf(row) : null;
};

export const projectIdsForAccount = async (
  db: D1Database,
  accountId: string,
): Promise<Array<HubProjectId>> => {
  const result = await db
    .prepare("SELECT project_id FROM memberships WHERE account_id = ? ORDER BY joined_at")
    .bind(accountId)
    .all<{ project_id: string }>();
  return result.results.map((row) => row.project_id as HubProjectId);
};

/** The caller's projects for a repository, oldest first. */
export const projectsByKeyForAccount = async (
  db: D1Database,
  accountId: string,
  repositoryKey: string,
): Promise<Array<HubProject>> => {
  const result = await db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects p
       JOIN memberships m ON m.project_id = p.project_id
       WHERE m.account_id = ? AND p.repository_key = ? ORDER BY p.created_at, p.project_id`,
    )
    .bind(accountId, repositoryKey)
    .all<ProjectRow>();
  return result.results.map(projectOf);
};

/** Creates a project with its creator as admin. */
export const createProject = async (
  db: D1Database,
  input: { readonly accountId: string; readonly repositoryKey: string; readonly title: string },
  nowMs: number,
): Promise<HubProject> => {
  const projectId = randomId("prj");
  const createdAt = isoOf(nowMs);
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects (project_id, repository_key, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(projectId, input.repositoryKey, input.title, input.accountId, createdAt),
    db
      .prepare(
        "INSERT INTO memberships (project_id, account_id, role, joined_at, invited_by) VALUES (?, ?, 'admin', ?, NULL)",
      )
      .bind(projectId, input.accountId, createdAt),
  ]);
  return projectOf({
    project_id: projectId,
    repository_key: input.repositoryKey,
    title: input.title,
    created_by: input.accountId,
    created_at: createdAt,
  });
};

export const listMembers = async (
  db: D1Database,
  projectId: string,
): Promise<Array<HubProjectMember>> => {
  const result = await db
    .prepare(
      "SELECT account_id, role, joined_at, invited_by FROM memberships WHERE project_id = ? ORDER BY joined_at, account_id",
    )
    .bind(projectId)
    .all<{ account_id: string; role: string; joined_at: string; invited_by: string | null }>();
  return result.results.map((row) => ({
    accountId: row.account_id as HubAccountId,
    role: row.role as HubProjectRole,
    joinedAt: row.joined_at,
    invitedBy: row.invited_by as HubAccountId | null,
  }));
};

export const isMember = async (db: D1Database, projectId: string, accountId: string) =>
  (await db
    .prepare("SELECT 1 AS ok FROM memberships WHERE project_id = ? AND account_id = ?")
    .bind(projectId, accountId)
    .first<{ ok: number }>()) !== null;

export const removeMember = async (db: D1Database, projectId: string, accountId: string) => {
  await db
    .prepare("DELETE FROM memberships WHERE project_id = ? AND account_id = ?")
    .bind(projectId, accountId)
    .run();
};

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

interface InvitationRow {
  readonly invitation_id: string;
  readonly project_id: string;
  readonly project_title: string;
  readonly inviter_id: string;
  readonly invitee_login: string;
  readonly invitee_id: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly resolved_at: string | null;
}

const invitationOf = (row: InvitationRow): HubProjectInvitation => ({
  invitationId: row.invitation_id as HubInvitationId,
  projectId: row.project_id as HubProjectId,
  projectTitle: row.project_title,
  inviterId: row.inviter_id as HubAccountId,
  inviteeLogin: row.invitee_login as GithubLogin,
  inviteeId: row.invitee_id as HubAccountId | null,
  state: row.state as HubInvitationState,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  resolvedAt: row.resolved_at,
});

const INVITATION_SELECT = `SELECT i.invitation_id, i.project_id, p.title AS project_title, i.inviter_id,
  i.invitee_login, i.invitee_id, i.state, i.created_at, i.expires_at, i.resolved_at
  FROM invitations i JOIN projects p ON p.project_id = i.project_id`;

/** Marks overdue pending invitations expired. Cheap; called before invitation reads. */
export const expireInvitations = async (db: D1Database, nowMs: number): Promise<void> => {
  const now = isoOf(nowMs);
  await db
    .prepare(
      "UPDATE invitations SET state = 'expired', resolved_at = ? WHERE state = 'pending' AND expires_at <= ?",
    )
    .bind(now, now)
    .run();
};

export const getInvitation = async (db: D1Database, invitationId: string) => {
  const row = await db
    .prepare(`${INVITATION_SELECT} WHERE i.invitation_id = ?`)
    .bind(invitationId)
    .first<InvitationRow>();
  return row ? invitationOf(row) : null;
};

export const pendingInvitationsForProject = async (db: D1Database, projectId: string) => {
  const result = await db
    .prepare(
      `${INVITATION_SELECT} WHERE i.project_id = ? AND i.state = 'pending' ORDER BY i.created_at`,
    )
    .bind(projectId)
    .all<InvitationRow>();
  return result.results.map(invitationOf);
};

/** Pending invitations addressed to this account, by id or (unclaimed) by login. */
export const pendingInvitationsForAccount = async (db: D1Database, account: HubAccount) => {
  const result = await db
    .prepare(
      `${INVITATION_SELECT} WHERE i.state = 'pending'
       AND (i.invitee_id = ? OR (i.invitee_id IS NULL AND i.invitee_login_key = ?)) ORDER BY i.created_at`,
    )
    .bind(account.accountId, normalizeGithubLogin(account.githubLogin))
    .all<InvitationRow>();
  return result.results.map(invitationOf);
};

export const countPendingByInviter = async (db: D1Database, inviterId: string) =>
  (
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM invitations WHERE inviter_id = ? AND state = 'pending'",
      )
      .bind(inviterId)
      .first<{ count: number }>()
  )?.count ?? 0;

export const findPendingInvitation = async (
  db: D1Database,
  projectId: string,
  login: string,
): Promise<HubProjectInvitation | null> => {
  const row = await db
    .prepare(
      `${INVITATION_SELECT} WHERE i.project_id = ? AND i.invitee_login_key = ? AND i.state = 'pending' LIMIT 1`,
    )
    .bind(projectId, normalizeGithubLogin(login))
    .first<InvitationRow>();
  return row ? invitationOf(row) : null;
};

export const createInvitation = async (
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly inviterId: string;
    readonly login: string;
    readonly inviteeId: string | null;
  },
  nowMs: number,
): Promise<HubInvitationId> => {
  const invitationId = randomId("inv") as HubInvitationId;
  await db
    .prepare(
      `INSERT INTO invitations (invitation_id, project_id, inviter_id, invitee_login, invitee_login_key, invitee_id, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      invitationId,
      input.projectId,
      input.inviterId,
      input.login,
      normalizeGithubLogin(input.login),
      input.inviteeId,
      isoOf(nowMs),
      isoOf(nowMs + HUB_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    )
    .run();
  return invitationId;
};

/** Moves a pending invitation to `state`; false when it was no longer pending. */
export const resolveInvitation = async (
  db: D1Database,
  input: {
    readonly invitationId: string;
    readonly state: Exclude<HubInvitationState, "pending">;
    readonly inviteeId?: string;
  },
  nowMs: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE invitations SET state = ?, resolved_at = ?, invitee_id = COALESCE(?, invitee_id)
       WHERE invitation_id = ? AND state = 'pending'`,
    )
    .bind(input.state, isoOf(nowMs), input.inviteeId ?? null, input.invitationId)
    .run();
  return result.meta.changes === 1;
};

/** Accepts a pending invitation and adds the membership. False when it was no longer pending. */
export const acceptInvitation = async (
  db: D1Database,
  invitation: HubProjectInvitation,
  accountId: string,
  nowMs: number,
): Promise<boolean> => {
  if (
    !(await resolveInvitation(
      db,
      { invitationId: invitation.invitationId, state: "accepted", inviteeId: accountId },
      nowMs,
    ))
  ) {
    return false;
  }
  await db
    .prepare(
      `INSERT INTO memberships (project_id, account_id, role, joined_at, invited_by)
       VALUES (?, ?, 'member', ?, ?) ON CONFLICT (project_id, account_id) DO NOTHING`,
    )
    .bind(invitation.projectId, accountId, isoOf(nowMs), invitation.inviterId)
    .run();
  return true;
};

/** Claims unclaimed pending invitations for a login; returns the affected projects. */
export const claimInvitations = async (
  db: D1Database,
  account: HubAccount,
): Promise<Array<HubProjectId>> => {
  const result = await db
    .prepare(
      `UPDATE invitations SET invitee_id = ?
       WHERE invitee_id IS NULL AND invitee_login_key = ? AND state = 'pending'
       RETURNING project_id`,
    )
    .bind(account.accountId, normalizeGithubLogin(account.githubLogin))
    .all<{ project_id: string }>();
  return [...new Set(result.results.map((row) => row.project_id as HubProjectId))];
};

export const PENDING_INVITATION_LIMIT = HUB_INVITATION_PENDING_LIMIT;

// ---------------------------------------------------------------------------
// Shared-thread index
// ---------------------------------------------------------------------------

export interface ThreadIndexRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly link_id: string;
  readonly owner_account_id: string;
  readonly removed_reason: "private" | "deleted" | "access-lost" | null;
}

export const getThreadIndex = (db: D1Database, threadId: string) =>
  db
    .prepare(
      "SELECT thread_id, project_id, link_id, owner_account_id, removed_reason FROM hub_threads WHERE thread_id = ?",
    )
    .bind(threadId)
    .first<ThreadIndexRow>();

export const getThreadIndexes = async (db: D1Database, threadIds: ReadonlyArray<string>) => {
  if (threadIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT thread_id, project_id, link_id, owner_account_id, removed_reason FROM hub_threads
       WHERE thread_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify([...new Set(threadIds)]))
    .all<ThreadIndexRow>();
  return result.results;
};

/**
 * Lists a thread under a project. Returns false when the id already belongs
 * to another project, so one thread can never be mirrored twice.
 */
export const claimThreadIndex = async (
  db: D1Database,
  input: {
    readonly threadId: HubThreadId;
    readonly projectId: string;
    readonly linkId: string;
    readonly ownerAccountId: string;
  },
  nowMs: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `INSERT INTO hub_threads (thread_id, project_id, link_id, owner_account_id, removed_reason, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (thread_id) DO UPDATE SET removed_reason = NULL, updated_at = excluded.updated_at
       WHERE hub_threads.project_id = excluded.project_id
       RETURNING project_id`,
    )
    .bind(input.threadId, input.projectId, input.linkId, input.ownerAccountId, isoOf(nowMs))
    .first<{ project_id: string }>();
  return result?.project_id === input.projectId;
};

export const markThreadsRemoved = async (
  db: D1Database,
  threadIds: ReadonlyArray<string>,
  reason: "private" | "deleted" | "access-lost",
  nowMs: number,
): Promise<void> => {
  if (threadIds.length === 0) return;
  await db
    .prepare(
      `UPDATE hub_threads SET removed_reason = ?, updated_at = ?
       WHERE thread_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(reason, isoOf(nowMs), JSON.stringify(threadIds))
    .run();
};

/** Projects holding listed threads of a link (to drop them when the link is revoked). */
export const projectsWithLinkThreads = async (db: D1Database, linkId: string) => {
  const result = await db
    .prepare(
      "SELECT DISTINCT project_id FROM hub_threads WHERE link_id = ? AND removed_reason IS NULL",
    )
    .bind(linkId)
    .all<{ project_id: string }>();
  return result.results.map((row) => row.project_id as HubProjectId);
};

// ---------------------------------------------------------------------------
// Fixed-window rate limits (unauthenticated endpoints)
// ---------------------------------------------------------------------------

export const hitRateLimit = async (
  db: D1Database,
  input: { readonly bucket: string; readonly windowMs: number; readonly max: number },
  nowMs: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number }> => {
  const windowStart = nowMs - (nowMs % input.windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start_ms, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start_ms = excluded.window_start_ms THEN rate_limits.count + 1 ELSE 1 END,
         window_start_ms = excluded.window_start_ms
       RETURNING count`,
    )
    .bind(input.bucket, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) <= input.max) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + input.windowMs - nowMs) / 1000)),
  };
};
