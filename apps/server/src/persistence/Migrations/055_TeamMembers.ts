import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Puff Collab team identity: environment members, project membership, and
 * the creator columns that record which member created a thread or message.
 * The implicit owner row backs every non-member session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_members (
      member_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_active_username
    ON team_members(username)
    WHERE removed_at IS NULL
  `;
  yield* sql`
    INSERT OR IGNORE INTO team_members (member_id, username, display_name, role, created_at, removed_at)
    VALUES ('owner', 'owner', 'Owner', 'admin', ${now}, NULL)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_project_members (
      project_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, member_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_project_members_member
    ON team_project_members(member_id, project_id)
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "created_by")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN created_by TEXT`;
  }
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "created_by")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN created_by TEXT`;
  }
});
