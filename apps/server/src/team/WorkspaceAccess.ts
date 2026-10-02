/**
 * WorkspaceAccess - which project checkouts a member may work in (Puff Collab).
 *
 * File, VCS, review, preview, and pull request RPCs name their target by a
 * working directory, a thread, or a project rather than by an orchestration
 * command, so ThreadAccess never sees them. This service maps those targets
 * onto the same team rules:
 *
 * - A path inside a thread's worktree belongs to that thread: anyone who can
 *   see the thread may read there, only its owner may change it.
 * - A path inside a project's workspace root needs project membership.
 * - A path outside every project and worktree is the host's own filesystem;
 *   only admins (including the environment owner) reach it.
 *
 * Admins pass every check, as they do for terminals. This is an organizational
 * boundary, not a sandbox: projects are not filesystem sandboxes (see
 * docs/internals/environment-auth.md), and agents a member runs can still
 * reach whatever the server account can.
 *
 * Paths resolve by their own ancestors against indexed columns, so a check
 * costs two small lookups and never loads a snapshot.
 *
 * @module WorkspaceAccess
 */
import {
  type MemberId,
  ProjectId,
  threadOwnerOf,
  ThreadId,
  type ThreadVisibility,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as TeamAccess from "./TeamAccess.ts";
import * as ThreadAccess from "./ThreadAccess.ts";

/** `read` lists, searches, diffs, and reads; `write` changes files, refs, or remote state. */
export type WorkspaceAccessMode = "read" | "write";

export class WorkspaceAccessDeniedError extends Schema.TaggedError<WorkspaceAccessDeniedError>()(
  "WorkspaceAccessDeniedError",
  {
    reason: Schema.Literals([
      "not-project-member",
      "not-thread-owner",
      "thread-not-visible",
      "outside-projects",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-project-member":
        return "You are not a member of that project.";
      case "not-thread-owner":
        return "Only the thread's owner can change its worktree.";
      case "thread-not-visible":
        return "That thread was not found.";
      case "outside-projects":
        return "Only an admin can use folders outside the team's projects.";
    }
  }
}

export type WorkspaceAccessError = WorkspaceAccessDeniedError | TeamAccess.TeamPersistenceError;

export class WorkspaceAccess extends Context.Service<
  WorkspaceAccess,
  {
    /** Allow the member to read or change `path` (usually an RPC's `cwd`). */
    readonly authorizePath: (
      memberId: MemberId,
      path: string,
      mode: WorkspaceAccessMode,
    ) => Effect.Effect<void, WorkspaceAccessError>;
    /** Allow the member to use a project-scoped feature (pull requests). */
    readonly authorizeProject: (
      memberId: MemberId,
      projectId: ProjectId,
    ) => Effect.Effect<void, WorkspaceAccessError>;
    /**
     * Allow a thread-scoped workspace feature (previews, worktree setup):
     * reading needs the thread to be visible, changing it needs ownership.
     * Unknown threads pass so callers keep their own not-found handling.
     */
    readonly authorizeThread: (
      memberId: MemberId,
      threadId: ThreadId,
      mode: WorkspaceAccessMode,
    ) => Effect.Effect<void, WorkspaceAccessError>;
    /**
     * The projects a listing may cover: the requested ones the member belongs
     * to, or all of theirs when none are named. `undefined` means every
     * project (admins).
     */
    readonly visibleProjectIds: (
      memberId: MemberId,
      requested: ReadonlyArray<ProjectId> | undefined,
    ) => Effect.Effect<ReadonlyArray<ProjectId> | undefined, TeamAccess.TeamPersistenceError>;
  }
>()("t3/team/WorkspaceAccess") {}

interface ThreadPathRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly createdBy: string | null;
  readonly visibility: string | null;
  readonly worktreePath: string;
}

interface ProjectPathRow {
  readonly projectId: string;
  readonly workspaceRoot: string;
}

/** `path` and each directory above it, most specific first. */
export const ancestorPaths = (path: Path.Path, target: string): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  let current = path.resolve(target);
  while (!paths.includes(current)) {
    paths.push(current);
    current = path.dirname(current);
  }
  return paths;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const teamAccess = yield* TeamAccess.TeamAccess;
  const threadAccess = yield* ThreadAccess.ThreadAccess;

  const persistence =
    (operation: string) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, TeamAccess.TeamPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new TeamAccess.TeamPersistenceError({ operation, cause })),
      );

  const deny = (reason: WorkspaceAccessDeniedError["reason"]) =>
    Effect.fail(new WorkspaceAccessDeniedError({ reason }));

  const authorizePath: WorkspaceAccess["Service"]["authorizePath"] = (memberId, target, mode) =>
    Effect.gen(function* () {
      const viewer = yield* threadAccess.viewer(memberId);
      if (viewer.projects.all) return;
      const candidates = ancestorPaths(path, target);
      const threads = yield* sql<ThreadPathRow>`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          created_by AS "createdBy",
          visibility,
          worktree_path AS "worktreePath"
        FROM projection_threads
        WHERE deleted_at IS NULL AND ${sql.in("worktree_path", candidates)}
      `.pipe(persistence("WorkspaceAccess.threadsAtPath"));
      const projects = yield* sql<ProjectPathRow>`
        SELECT project_id AS "projectId", workspace_root AS "workspaceRoot"
        FROM projection_projects
        WHERE deleted_at IS NULL AND ${sql.in("workspace_root", candidates)}
      `.pipe(persistence("WorkspaceAccess.projectsAtPath"));

      // The most specific match decides: a worktree inside a project root
      // belongs to its thread, not to the project.
      const depth = (root: string) => candidates.length - candidates.indexOf(path.resolve(root));
      const threadDepth = Math.max(0, ...threads.map((row) => depth(row.worktreePath)));
      const projectDepth = Math.max(0, ...projects.map((row) => depth(row.workspaceRoot)));

      if (threadDepth > 0 && threadDepth >= projectDepth) {
        const owners = threads
          .filter((row) => depth(row.worktreePath) === threadDepth)
          .map((row) => ({
            projectId: ProjectId.make(row.projectId),
            createdBy: row.createdBy as MemberId | null,
            ...(row.visibility === "shared" || row.visibility === "private"
              ? { visibility: row.visibility as ThreadVisibility }
              : {}),
          }));
        if (owners.some((thread) => threadOwnerOf(thread) === memberId)) return;
        if (!owners.some((thread) => ThreadAccess.canViewerSeeThread(viewer, thread))) {
          return yield* deny("thread-not-visible");
        }
        return mode === "read" ? undefined : yield* deny("not-thread-owner");
      }
      if (projectDepth > 0) {
        const member = projects
          .filter((row) => depth(row.workspaceRoot) === projectDepth)
          .some((row) => TeamAccess.canSeeProject(viewer.projects, ProjectId.make(row.projectId)));
        return member ? undefined : yield* deny("not-project-member");
      }
      return yield* deny("outside-projects");
    });

  const authorizeProject: WorkspaceAccess["Service"]["authorizeProject"] = (memberId, projectId) =>
    teamAccess
      .isProjectMember(memberId, projectId)
      .pipe(Effect.flatMap((member) => (member ? Effect.void : deny("not-project-member"))));

  const authorizeThread: WorkspaceAccess["Service"]["authorizeThread"] = (
    memberId,
    threadId,
    mode,
  ) =>
    Effect.gen(function* () {
      if (yield* teamAccess.isAdmin(memberId)) return;
      if (!(yield* teamAccess.canSeeThread(memberId, threadId))) {
        return yield* deny("thread-not-visible");
      }
      if (mode === "read") return;
      // Ownership only: an admin's housekeeping exception does not apply here.
      if (!(yield* threadAccess.canControlThread(memberId, threadId, "thread.turn.start"))) {
        return yield* deny("not-thread-owner");
      }
    });

  const visibleProjectIds: WorkspaceAccess["Service"]["visibleProjectIds"] = (
    memberId,
    requested,
  ) =>
    teamAccess.projectVisibility(memberId).pipe(
      Effect.map((visibility) => {
        if (visibility.all) return requested;
        return requested === undefined
          ? [...visibility.projectIds]
          : requested.filter((projectId) => visibility.projectIds.has(projectId));
      }),
    );

  return WorkspaceAccess.of({
    authorizePath,
    authorizeProject,
    authorizeThread,
    visibleProjectIds,
  });
});

export const layer = Layer.effect(WorkspaceAccess, make);
