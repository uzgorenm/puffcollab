import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Puff Collab cooperation analysis: owner consent per thread, analyst runs
 * with their outcome, the latest validated summary per thread, and the
 * awareness notes and redirection proposals waiting on a recipient owner.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cooperation_thread_settings (
      thread_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      feature_topic TEXT NOT NULL,
      analysis_enabled INTEGER NOT NULL,
      text_enabled INTEGER NOT NULL,
      awareness_notify INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cooperation_analysis_runs (
      run_id TEXT PRIMARY KEY,
      first_thread_id TEXT NOT NULL,
      second_thread_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cooperation_runs_first
    ON cooperation_analysis_runs(first_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cooperation_runs_second
    ON cooperation_analysis_runs(second_thread_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cooperation_thread_summaries (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cooperation_awareness_items (
      item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      recipient_member_id TEXT NOT NULL,
      text TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cooperation_items_recipient
    ON cooperation_awareness_items(recipient_member_id, state, created_at)
  `;
});
