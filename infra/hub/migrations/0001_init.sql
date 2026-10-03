-- Puff Collab hub: accounts, sign-in, environment links, projects, membership,
-- invitations and the shared-thread index. Per-project team data and thread
-- mirrors live in each project's Durable Object, not here.
-- Times are ISO-8601 UTC strings; *_ms columns are epoch milliseconds.

CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  -- Null only for dev "local accounts" (HUB_DEV_LOCAL_ACCOUNTS).
  github_id INTEGER UNIQUE,
  github_login TEXT NOT NULL,
  login_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX accounts_login_key ON accounts (login_key);

CREATE TABLE browser_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (account_id),
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX browser_sessions_account ON browser_sessions (account_id);

CREATE TABLE environment_links (
  link_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (account_id),
  environment_label TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  -- The sync connection currently attached to this link, if any.
  live_conn_id TEXT
);
CREATE INDEX environment_links_account ON environment_links (account_id);

CREATE TABLE link_requests (
  request_id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  environment_label TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  -- pending | approved | denied
  status TEXT NOT NULL,
  account_id TEXT REFERENCES accounts (account_id),
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_polled_at_ms INTEGER
);

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  -- Not unique: two teams may share a repository.
  repository_key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts (account_id),
  created_at TEXT NOT NULL
);
CREATE INDEX projects_repository_key ON projects (repository_key);

CREATE TABLE memberships (
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  account_id TEXT NOT NULL REFERENCES accounts (account_id),
  -- admin | member
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  invited_by TEXT,
  PRIMARY KEY (project_id, account_id)
);
CREATE INDEX memberships_account ON memberships (account_id);

CREATE TABLE invitations (
  invitation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  inviter_id TEXT NOT NULL REFERENCES accounts (account_id),
  invitee_login TEXT NOT NULL,
  invitee_login_key TEXT NOT NULL,
  invitee_id TEXT,
  -- pending | accepted | declined | cancelled | expired
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX invitations_project_state ON invitations (project_id, state);
CREATE INDEX invitations_inviter_state ON invitations (inviter_id, state);
CREATE INDEX invitations_login_state ON invitations (invitee_login_key, state);
CREATE INDEX invitations_invitee_state ON invitations (invitee_id, state);

-- Which project each shared thread belongs to. Rows stay as tombstones after
-- removal so a reconnecting subscriber learns why its mirror went away.
CREATE TABLE hub_threads (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  link_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  -- null while listed; private | deleted | access-lost once removed
  removed_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX hub_threads_link ON hub_threads (link_id);
CREATE INDEX hub_threads_project ON hub_threads (project_id);

-- Fixed-window counters for unauthenticated endpoints.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL
);
