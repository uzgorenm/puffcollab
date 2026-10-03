/**
 * RelatedWork - possibly related shared threads for a draft (Puff Collab).
 *
 * Suggestions come from the projection tables only and never call a provider.
 * Candidates are the shared threads of a project linked to the team hub:
 * this server's own shared threads and teammates' mirrors, which live in the
 * same tables. Private threads and projects off the hub never match. Ranked
 * by word overlap (see relatedWorkRanking.ts).
 *
 * @module RelatedWork
 */
import {
  HubThreadLink,
  type RelatedWorkSuggestInput,
  type RelatedWorkSuggestResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
     * best match first. Empty when the project is not linked to the team hub.
     */
    readonly suggest: (
      input: RelatedWorkSuggestInput,
    ) => Effect.Effect<RelatedWorkSuggestResult, RelatedWorkPersistenceError>;
  }
>()("t3/relatedWork/RelatedWork") {}

interface CandidateRow {
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly hubLink: string | null;
  readonly updatedAt: string;
  readonly firstUserMessage: string | null;
}

const decodeHubLink = Schema.decodeUnknownOption(Schema.fromJsonString(HubThreadLink));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, RelatedWorkPersistenceError, R> =>
      effect.pipe(
        Effect.mapError((cause) => new RelatedWorkPersistenceError({ operation, cause })),
      );

  const listCandidates = (input: RelatedWorkSuggestInput) =>
    sql<CandidateRow>`
      SELECT
        threads.thread_id AS "threadId",
        threads.title AS "title",
        threads.branch AS "branch",
        threads.hub_link_json AS "hubLink",
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
        AND EXISTS (SELECT 1 FROM hub_project_links WHERE project_id = ${input.projectId})
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND threads.visibility = 'shared'
        AND threads.thread_id <> ${input.excludeThreadId ?? ""}
      ORDER BY threads.updated_at DESC, threads.thread_id ASC
      LIMIT ${MAX_CANDIDATES}
    `.pipe(persistence("listCandidates"));

  const suggest: RelatedWork["Service"]["suggest"] = (input) =>
    Effect.gen(function* () {
      if (tokenize(input.text).size < 2) return { suggestions: [] };
      const candidates = yield* listCandidates(input);
      const ranked = rankRelatedWork(input.text, candidates, input.limit ?? DEFAULT_LIMIT);
      return {
        suggestions: ranked.map(({ candidate, matchedTerms }) => {
          const hub =
            candidate.hubLink === null
              ? undefined
              : Option.getOrUndefined(decodeHubLink(candidate.hubLink));
          return {
            threadId: ThreadId.make(candidate.threadId),
            title: candidate.title,
            ...(hub !== undefined ? { hub } : {}),
            branch: candidate.branch,
            matchedTerms,
          };
        }),
      };
    });

  return RelatedWork.of({ suggest });
});

export const layer = Layer.effect(RelatedWork, make);
