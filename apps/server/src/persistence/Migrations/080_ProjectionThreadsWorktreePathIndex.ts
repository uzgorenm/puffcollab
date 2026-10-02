import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Lets WorkspaceAccess resolve a request's cwd to the thread whose worktree it is. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_worktree_path
    ON projection_threads(worktree_path)
  `;
});
