import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Puff Collab shared threads: the thread's visibility (NULL = private) and
 * teammates' comments. Comments live in their own table so nothing that
 * builds provider input from thread messages can pick them up.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "visibility")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN visibility TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_comments (
      comment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_comments_thread
    ON projection_thread_comments(thread_id, created_at)
  `;
});
