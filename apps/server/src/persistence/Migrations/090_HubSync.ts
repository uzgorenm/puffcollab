import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Team hub sync (Stage 7). The environment credential lives in the server
 * secret store, never here. Shared threads publish through a durable outbound
 * queue (`hub_outbound_events`) that the hub acknowledges by per-thread `seq`.
 * Teammates' threads are mirrored into the ordinary projection tables;
 * `hub_remote_threads` maps them to hub ids and holds each mirror's stream
 * position, which the projection pipeline advances with the mirrored events.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_link (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hub_url TEXT,
      link_id TEXT,
      account_json TEXT,
      linked_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_project_links (
      project_id TEXT PRIMARY KEY,
      hub_project_id TEXT NOT NULL,
      hub_project_title TEXT NOT NULL,
      linked_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_hub_project_links_hub
    ON hub_project_links(hub_project_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_published_threads (
      thread_id TEXT PRIMARY KEY,
      hub_project_id TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      acked_seq INTEGER NOT NULL,
      generation INTEGER,
      source_sequence INTEGER NOT NULL,
      summary_json TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_outbound_events (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      hub_project_id TEXT NOT NULL,
      reset INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      body_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, seq)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_remote_threads (
      hub_thread_id TEXT PRIMARY KEY,
      local_thread_id TEXT NOT NULL UNIQUE,
      local_project_id TEXT NOT NULL,
      hub_project_id TEXT NOT NULL,
      link_json TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_remote_turn_diffs (
      thread_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      diff TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_turn_count)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hub_comment_outbox (
      comment_id TEXT PRIMARY KEY,
      op TEXT NOT NULL,
      hub_thread_id TEXT NOT NULL,
      text TEXT,
      queued_at TEXT NOT NULL
    )
  `;
});
