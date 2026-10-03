/**
 * ProjectionThreadComments - teammates' comments on threads (Puff Collab).
 *
 * Comments are kept apart from `projection_thread_messages` on purpose:
 * everything that builds provider input reads messages, so a comment can never
 * reach the agent by accident.
 *
 * @module ProjectionThreadComments
 */
import {
  HubAccount,
  IsoDateTime,
  MemberId,
  OrchestrationThreadComment,
  ThreadCommentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionThreadComment = Schema.Struct({
  commentId: ThreadCommentId,
  threadId: ThreadId,
  authorId: MemberId,
  text: Schema.String,
  createdAt: IsoDateTime,
  // A teammate's comment from the team hub; stored as JSON.
  hubAuthor: Schema.optional(Schema.NullOr(Schema.fromJsonString(HubAccount))),
});
export type ProjectionThreadComment = typeof ProjectionThreadComment.Type;

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const CommentInput = Schema.Struct({ commentId: ThreadCommentId });

export const toOrchestrationThreadComment = (
  row: ProjectionThreadComment,
): OrchestrationThreadComment => ({
  id: row.commentId,
  authorId: row.authorId,
  text: row.text,
  createdAt: row.createdAt,
  ...(row.hubAuthor != null ? { hubAuthor: row.hubAuthor } : {}),
});

export class ProjectionThreadCommentRepository extends Context.Service<
  ProjectionThreadCommentRepository,
  {
    readonly insert: (
      row: ProjectionThreadComment,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getById: (input: {
      readonly commentId: ThreadCommentId;
    }) => Effect.Effect<Option.Option<ProjectionThreadComment>, ProjectionRepositoryError>;
    readonly listByThreadId: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<ProjectionThreadComment>, ProjectionRepositoryError>;
    readonly deleteById: (input: {
      readonly commentId: ThreadCommentId;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionThreadComments/ProjectionThreadCommentRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: ProjectionThreadComment,
    execute: (row) => sql`
      INSERT INTO projection_thread_comments
        (comment_id, thread_id, author_id, text, created_at, hub_author_json)
      VALUES (
        ${row.commentId}, ${row.threadId}, ${row.authorId}, ${row.text}, ${row.createdAt},
        ${row.hubAuthor ?? null}
      )
      ON CONFLICT (comment_id) DO NOTHING
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: CommentInput,
    Result: ProjectionThreadComment,
    execute: ({ commentId }) => sql`
      SELECT
        comment_id AS "commentId",
        thread_id AS "threadId",
        author_id AS "authorId",
        text,
        created_at AS "createdAt",
        hub_author_json AS "hubAuthor"
      FROM projection_thread_comments
      WHERE comment_id = ${commentId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: ThreadInput,
    Result: ProjectionThreadComment,
    execute: ({ threadId }) => sql`
      SELECT
        comment_id AS "commentId",
        thread_id AS "threadId",
        author_id AS "authorId",
        text,
        created_at AS "createdAt",
        hub_author_json AS "hubAuthor"
      FROM projection_thread_comments
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, comment_id ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: CommentInput,
    execute: ({ commentId }) => sql`
      DELETE FROM projection_thread_comments WHERE comment_id = ${commentId}
    `,
  });

  const deleteThreadRows = SqlSchema.void({
    Request: ThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_comments WHERE thread_id = ${threadId}
    `,
  });

  return ProjectionThreadCommentRepository.of({
    insert: (row) =>
      insertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadCommentRepository.insert:query")),
      ),
    getById: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadCommentRepository.getById:query")),
      ),
    listByThreadId: (input) =>
      listRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadCommentRepository.listByThreadId:query"),
        ),
      ),
    deleteById: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadCommentRepository.deleteById:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteThreadRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadCommentRepository.deleteByThreadId:query"),
        ),
      ),
  });
});

export const layer = Layer.effect(ProjectionThreadCommentRepository, make);
