/**
 * RelatedWork - possibly related shared threads for a draft (Puff Collab).
 *
 * Suggestions come from the projection tables only and never call a provider:
 * active shared threads in the same project, minus the caller's own, ranked
 * by word overlap (see relatedWorkRanking.ts).
 *
 * @module RelatedWork
 */
import {
  MemberId,
  OWNER_MEMBER_ID,
  type RelatedWorkSuggestInput,
  type RelatedWorkSuggestResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as TeamAccess from "../team/TeamAccess.ts";
import { rankRelatedWork, tokenize } from "./relatedWorkRanking.ts";

const DEFAULT_LIMIT = 3;
// Only the most recently updated shared threads are considered, which keeps
// one suggestion bounded however large the project grows.
const MAX_CANDIDATES = 500;
const FIRST_MESSAGE_CHARS = 1000;

export class RelatedWorkPersistenceError extends Schema.TaggedError<RelatedWorkPersistenceError>()(
  "RelatedWorkPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Related work lookup failed during ${this.operation}.`;
  }
}

export class RelatedWork extends Context.Service<
  RelatedWork,
  {
    /**
     * Shared threads in `input.projectId` that might overlap with the draft,
     * best match first. Empty when the member cannot see the project.
     */
    readonly suggest: (
      memberId: MemberId,
      input: RelatedWorkSuggestInput,
    ) => Effect.Effect<
      RelatedWorkSuggestResult,
      RelatedWorkPersistenceError | TeamAccess.TeamPersistenceError
    >;
  }
>()("t3/relatedWork/RelatedWork") {}

interface CandidateRow {
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly firstUserMessage: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const teamAccess = yield* TeamAccess.TeamAccess;

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RelatedWorkPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new RelatedWorkPersistenceError({ operation, cause })),
      );

  // Thread visibility is projected by the shared-threads feature. Until its
  // column exists every thread is private, so there is nothing to suggest.
  const hasVisibilityColumn = sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `.pipe(
    Effect.map((columns) => columns.some((column) => column.name === "visibility")),
    persistence("visibilityColumn"),
  );

  const listCandidates = (memberId: MemberId, input: RelatedWorkSuggestInput) =>
    sql<CandidateRow>`
      SELECT
        threads.thread_id AS "threadId",
        threads.title AS "title",
        threads.branch AS "branch",
        threads.created_by AS "createdBy",
        threads.updated_at AS "updatedAt",
        (
          SELECT substr(messages.text, 1, ${FIRST_MESSAGE_CHARS})
          FROM projection_thread_messages AS messages
          WHERE messages.thread_id = threads.thread_id
            AND messages.role = 'user'
          ORDER BY messages.created_at ASC, messages.message_id ASC
          LIMIT 1
        ) AS "firstUserMessage"
      FROM projection_threads AS threads
      WHERE threads.project_id = ${input.projectId}
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND threads.visibility = 'shared'
        AND COALESCE(threads.created_by, ${OWNER_MEMBER_ID}) <> ${memberId}
        AND threads.thread_id <> ${input.excludeThreadId ?? ""}
      ORDER BY threads.updated_at DESC, threads.thread_id ASC
      LIMIT ${MAX_CANDIDATES}
    `.pipe(persistence("listCandidates"));

  const suggest: RelatedWork["Service"]["suggest"] = (memberId, input) =>
    Effect.gen(function* () {
      const empty: RelatedWorkSuggestResult = { suggestions: [] };
      if (tokenize(input.text).size < 2) return empty;
      if (!(yield* teamAccess.isProjectMember(memberId, input.projectId))) return empty;
      if (!(yield* hasVisibilityColumn)) return empty;
      const candidates = yield* listCandidates(memberId, input);
      const ranked = rankRelatedWork(input.text, candidates, input.limit ?? DEFAULT_LIMIT);
      return {
        suggestions: ranked.map(({ candidate, matchedTerms }) => ({
          threadId: ThreadId.make(candidate.threadId),
          title: candidate.title,
          createdBy: candidate.createdBy === null ? null : MemberId.make(candidate.createdBy),
          branch: candidate.branch,
          matchedTerms,
        })),
      };
    });

  return RelatedWork.of({ suggest });
});

export const layer = Layer.effect(RelatedWork, make);
