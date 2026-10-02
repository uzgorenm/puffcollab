import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Related-thread links (Puff Collab related work), one row per linked pair. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_related_links (
      thread_id TEXT NOT NULL,
      related_thread_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, related_thread_id)
    )
  `;
});
