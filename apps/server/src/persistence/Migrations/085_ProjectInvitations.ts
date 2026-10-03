import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Puff Collab project invitations. Invitations are the only way into a
 * project besides creating it, so membership always has the invitee's
 * consent. A new person invited to a project gets a pending member account
 * (`invite_link_id` set) until they redeem their sign-in link. Project
 * creators are recorded so they, besides admins, can remove members.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_project_invitations (
      invitation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      inviter_id TEXT NOT NULL,
      invitee_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_project_invitations_pending
    ON team_project_invitations(project_id, invitee_id)
    WHERE state = 'pending'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_project_invitations_invitee
    ON team_project_invitations(invitee_id, state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_project_invitations_inviter
    ON team_project_invitations(inviter_id, state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_team_project_invitations_project
    ON team_project_invitations(project_id, created_at)
  `;

  const memberColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(team_members)
  `;
  if (!memberColumns.some((column) => column.name === "invited_by")) {
    yield* sql`ALTER TABLE team_members ADD COLUMN invited_by TEXT`;
  }
  if (!memberColumns.some((column) => column.name === "invite_link_id")) {
    yield* sql`ALTER TABLE team_members ADD COLUMN invite_link_id TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS team_project_creators (
      project_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL
    )
  `;
  // Projects created before this migration: their creator is the actor on
  // the project.created event.
  yield* sql`
    INSERT OR IGNORE INTO team_project_creators (project_id, member_id)
    SELECT stream_id, json_extract(metadata_json, '$.actor')
    FROM orchestration_events
    WHERE aggregate_kind = 'project'
      AND event_type = 'project.created'
      AND json_valid(metadata_json)
      AND json_extract(metadata_json, '$.actor') IS NOT NULL
  `;
});
