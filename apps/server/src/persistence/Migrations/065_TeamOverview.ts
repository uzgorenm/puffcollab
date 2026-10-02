import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Puff Collab team overview projections: project brief versions, member
 * focus, and the per-project activity feed. Written by the
 * `projection.team-overview` projector (team/TeamOverviewProjection.ts).
 *
 * The projector starts at the current event head instead of replaying the
 * whole log on upgrade: the feed is "recent activity", and brief/focus events
 * cannot predate this migration. A database without events gets no cursor
 * row; the projector then starts from zero like the others.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_team_brief_versions (
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      author_id TEXT,
      created_at TEXT NOT NULL,
      sequence INTEGER NOT NULL UNIQUE,
      PRIMARY KEY (project_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_team_member_focus (
      project_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      focus TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, member_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_team_activity (
      activity_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      kind TEXT NOT NULL,
      actor_id TEXT,
      detail TEXT,
      occurred_at TEXT NOT NULL,
      sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_team_activity_project_sequence
    ON projection_team_activity(project_id, sequence DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_team_activity_thread
    ON projection_team_activity(thread_id)
  `;

  // The turn each thread is running, so the projector can emit one
  // completion item when the session leaves "running".
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_team_thread_runs (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT
      'projection.team-overview',
      COALESCE(MAX(sequence), 0),
      COALESCE(MAX(occurred_at), '1970-01-01T00:00:00.000Z')
    FROM orchestration_events
    HAVING COUNT(*) > 0
  `;
});
