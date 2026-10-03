import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Team hub links on projected threads (`OrchestrationThread.hub`) and the hub
 * account of teammates' comments that arrived through the hub.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "hub_link_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN hub_link_json TEXT`;
  }
  const commentColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_comments)
  `;
  if (!commentColumns.some((column) => column.name === "hub_author_json")) {
    yield* sql`ALTER TABLE projection_thread_comments ADD COLUMN hub_author_json TEXT`;
  }
});
