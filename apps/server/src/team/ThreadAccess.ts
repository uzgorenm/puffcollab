/**
 * ThreadAccess - who may see and who may control a thread (Puff Collab).
 *
 * A thread's owner is the member who created it; threads without a recorded
 * creator belong to the environment owner. Visibility decides who follows:
 * the owner and admins always see a thread, project members see it once the
 * owner shares it.
 *
 * Control is owner-only: starting turns, answering approvals and questions,
 * interrupting, reverting, changing modes or visibility, and every other
 * thread mutation. Admins may additionally stop, interrupt, archive,
 * unarchive, or delete any thread (housekeeping), but never send the agent
 * instructions. Comments are open to everyone who can see the thread.
 *
 * Every client-dispatched orchestration command goes through
 * `authorizeCommand` before it reaches the engine (WebSocket and HTTP), so
 * transports and future controls share one rule.
 *
 * @module ThreadAccess
 */
import {
  isThreadShared,
  type MemberId,
  type OrchestrationCommand,
  OWNER_MEMBER_ID,
  ProjectId,
  ThreadId,
  type ThreadVisibility,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as TeamAccess from "./TeamAccess.ts";

/** The member that owns a thread: its creator, or the environment owner. */
export const threadOwnerOf = (thread: { readonly createdBy?: MemberId | null | undefined }) =>
  thread.createdBy ?? OWNER_MEMBER_ID;

/** What a member can see; `projects.all` holds exactly for admins. */
export interface ThreadViewer {
  readonly memberId: MemberId;
  readonly projects: TeamAccess.TeamProjectVisibility;
}

interface ThreadVisibilityFacts {
  readonly projectId: ProjectId;
  readonly createdBy?: MemberId | null | undefined;
  readonly visibility?: ThreadVisibility | undefined;
}

export const canViewerSeeThread = (viewer: ThreadViewer, thread: ThreadVisibilityFacts): boolean =>
  viewer.projects.all ||
  threadOwnerOf(thread) === viewer.memberId ||
  (isThreadShared(thread) && TeamAccess.canSeeProject(viewer.projects, thread.projectId));

/** Keep the projects a member belongs to and the threads they can see. */
export const filterSnapshotForViewer = <
  S extends {
    readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
    readonly threads: ReadonlyArray<ThreadVisibilityFacts>;
  },
>(
  snapshot: S,
  viewer: ThreadViewer,
): S =>
  viewer.projects.all
    ? snapshot
    : {
        ...snapshot,
        projects: snapshot.projects.filter((project) =>
          TeamAccess.canSeeProject(viewer.projects, project.id),
        ),
        threads: snapshot.threads.filter((thread) => canViewerSeeThread(viewer, thread)),
      };

/** Commands an admin may run on threads they do not own. */
const ADMIN_THREAD_COMMANDS: ReadonlySet<OrchestrationCommand["type"]> = new Set([
  "thread.session.stop",
  "thread.turn.interrupt",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
]);

export type ThreadAccessDeniedReason =
  | "not-thread-owner"
  | "thread-not-visible"
  | "not-project-member"
  | "not-comment-author"
  | "admin-only";

export class ThreadAccessDeniedError extends Schema.TaggedError<ThreadAccessDeniedError>()(
  "ThreadAccessDeniedError",
  {
    commandType: Schema.String,
    reason: Schema.Literals([
      "not-thread-owner",
      "thread-not-visible",
      "not-project-member",
      "not-comment-author",
      "admin-only",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-thread-owner":
        return "Only the thread's owner can do that. You can follow and comment on it.";
      case "thread-not-visible":
        return "That thread was not found.";
      case "not-project-member":
        return "You are not a member of that project.";
      case "not-comment-author":
        return "You can only delete your own comments.";
      case "admin-only":
        return "Only an admin can do that.";
    }
  }
}

export class ThreadAccess extends Context.Service<
  ThreadAccess,
  {
    /** The member's view, for filtering snapshots with `filterSnapshotForViewer`. */
    readonly viewer: (
      memberId: MemberId,
    ) => Effect.Effect<ThreadViewer, TeamAccess.TeamPersistenceError>;
    /**
     * Whether the member may control the thread: owner always, admins only for
     * stop/interrupt/archive/unarchive/delete (`commandType`). Unknown threads
     * report true so the decider keeps its own not-found handling.
     */
    readonly canControlThread: (
      memberId: MemberId,
      threadId: ThreadId,
      commandType?: OrchestrationCommand["type"],
    ) => Effect.Effect<boolean, TeamAccess.TeamPersistenceError>;
    /** The subset of `threadIds` the member can see. Unknown ids are dropped. */
    readonly visibleThreadIds: (
      memberId: MemberId,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlySet<ThreadId>, TeamAccess.TeamPersistenceError>;
    /**
     * Reject a client-dispatched command the member may not issue. Run it on
     * every command a client sends, before dispatch.
     */
    readonly authorizeCommand: (
      memberId: MemberId,
      command: OrchestrationCommand,
    ) => Effect.Effect<void, ThreadAccessDeniedError | TeamAccess.TeamPersistenceError>;
  }
>()("t3/team/ThreadAccess") {}

interface ThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly createdBy: string | null;
  readonly visibility: string | null;
}

const toFacts = (row: ThreadRow): ThreadVisibilityFacts & { readonly threadId: ThreadId } => ({
  threadId: ThreadId.make(row.threadId),
  projectId: ProjectId.make(row.projectId),
  createdBy: row.createdBy as MemberId | null,
  ...(row.visibility === "shared" || row.visibility === "private"
    ? { visibility: row.visibility }
    : {}),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const teamAccess = yield* TeamAccess.TeamAccess;

  const persistence =
    (operation: string) =>
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, TeamAccess.TeamPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new TeamAccess.TeamPersistenceError({ operation, cause })),
      );

  const findThread = (threadId: ThreadId) =>
    sql<ThreadRow>`
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        created_by AS "createdBy",
        visibility
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toFacts(rows[0]))),
      persistence("ThreadAccess.findThread"),
    );

  const viewer: ThreadAccess["Service"]["viewer"] = (memberId) =>
    teamAccess.projectVisibility(memberId).pipe(Effect.map((projects) => ({ memberId, projects })));

  const canControlThread: ThreadAccess["Service"]["canControlThread"] = (
    memberId,
    threadId,
    commandType,
  ) =>
    Effect.gen(function* () {
      const thread = yield* findThread(threadId);
      if (thread === undefined || threadOwnerOf(thread) === memberId) return true;
      if (commandType === undefined || !ADMIN_THREAD_COMMANDS.has(commandType)) return false;
      return yield* teamAccess.isAdmin(memberId);
    });

  const visibleThreadIds: ThreadAccess["Service"]["visibleThreadIds"] = (memberId, threadIds) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) return new Set<ThreadId>();
      const currentViewer = yield* viewer(memberId);
      if (currentViewer.projects.all) return new Set(threadIds);
      const rows = yield* sql<ThreadRow>`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          created_by AS "createdBy",
          visibility
        FROM projection_threads
        WHERE ${sql.in("thread_id", threadIds)}
      `.pipe(persistence("ThreadAccess.visibleThreadIds"));
      return new Set(
        rows
          .map(toFacts)
          .filter((thread) => canViewerSeeThread(currentViewer, thread))
          .map((thread) => thread.threadId),
      );
    });

  const deny = (command: OrchestrationCommand, reason: ThreadAccessDeniedReason) =>
    Effect.fail(new ThreadAccessDeniedError({ commandType: command.type, reason }));

  const requireProjectMember = (
    memberId: MemberId,
    projectId: ProjectId,
    command: OrchestrationCommand,
  ) =>
    teamAccess
      .isProjectMember(memberId, projectId)
      .pipe(
        Effect.flatMap((member) => (member ? Effect.void : deny(command, "not-project-member"))),
      );

  const requireVisible = (memberId: MemberId, threadId: ThreadId, command: OrchestrationCommand) =>
    teamAccess
      .canSeeThread(memberId, threadId)
      .pipe(
        Effect.flatMap((visible) => (visible ? Effect.void : deny(command, "thread-not-visible"))),
      );

  // Hidden threads answer "not found" rather than "not yours" so private
  // thread ids do not leak through command errors.
  const requireControl = (memberId: MemberId, threadId: ThreadId, command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (yield* canControlThread(memberId, threadId, command.type)) return;
      yield* requireVisible(memberId, threadId, command);
      return yield* deny(command, "not-thread-owner");
    });

  const authorizeCommand: ThreadAccess["Service"]["authorizeCommand"] = (memberId, command) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "project.create":
          // The creator joins the project; see ProjectionPipeline.
          return;
        case "project.meta.update":
          return yield* requireProjectMember(memberId, command.projectId, command);
        case "project.delete":
          // Deleting a project removes every teammate's threads in it.
          return (yield* teamAccess.isAdmin(memberId))
            ? undefined
            : yield* deny(command, "admin-only");
        case "thread.create":
          return yield* requireProjectMember(memberId, command.projectId, command);
        case "thread.turn.start": {
          const createThread = command.bootstrap?.createThread;
          if (createThread !== undefined && (yield* findThread(command.threadId)) === undefined) {
            yield* requireProjectMember(memberId, createThread.projectId, command);
          } else {
            yield* requireControl(memberId, command.threadId, command);
          }
          if (command.sourceProposedPlan !== undefined) {
            yield* requireVisible(memberId, command.sourceProposedPlan.threadId, command);
          }
          return;
        }
        case "thread.comment.add":
          return yield* requireVisible(memberId, command.threadId, command);
        case "thread.comment.delete": {
          yield* requireVisible(memberId, command.threadId, command);
          const authors = yield* sql<{ readonly authorId: string }>`
            SELECT author_id AS "authorId"
            FROM projection_thread_comments
            WHERE comment_id = ${command.commentId} AND thread_id = ${command.threadId}
          `.pipe(persistence("ThreadAccess.commentAuthor"));
          const authorId = authors[0]?.authorId;
          if (authorId === undefined || authorId === memberId) return;
          return (yield* teamAccess.isAdmin(memberId))
            ? undefined
            : yield* deny(command, "not-comment-author");
        }
        default:
          // Every other client command targets one thread and is owner-only.
          if ("threadId" in command) {
            return yield* requireControl(memberId, command.threadId, command);
          }
          return;
      }
    });

  return ThreadAccess.of({ viewer, canControlThread, visibleThreadIds, authorizeCommand });
});

export const layer = Layer.effect(ThreadAccess, make);
