/**
 * Persistence for related-thread links: the projector that keeps
 * `projection_thread_related_links` current, and the reads that attach links
 * to thread details and the command read model.
 *
 * @module relatedThreadLinkProjection
 */
import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  RelatedThreadLink,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

export const RELATED_THREAD_LINKS_PROJECTOR = "projection.thread-related-links";

const LinkRow = Schema.Struct({
  threadId: ThreadId,
  ...RelatedThreadLink.fields,
});
const decodeLinkRows = Schema.decodeUnknownEffect(Schema.Array(LinkRow));

const toLink = (row: typeof LinkRow.Type): RelatedThreadLink => ({
  relatedThreadId: row.relatedThreadId,
  relationship: row.relationship,
  linkedAt: row.linkedAt,
});

export const makeRelatedThreadLinkProjection = (sql: SqlClient.SqlClient) => {
  const sqlError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`relatedThreadLinks.${operation}`));

  /** Projector body; runs inside the pipeline's per-event transaction. */
  const apply = (event: OrchestrationEvent): Effect.Effect<void, ProjectionRepositoryError> => {
    switch (event.type) {
      case "thread.related-thread-linked": {
        const { threadId, link } = event.payload;
        return sql`
          INSERT INTO projection_thread_related_links (
            thread_id, related_thread_id, relationship, linked_at
          )
          VALUES (${threadId}, ${link.relatedThreadId}, ${link.relationship}, ${link.linkedAt})
          ON CONFLICT (thread_id, related_thread_id) DO UPDATE SET
            relationship = excluded.relationship,
            linked_at = excluded.linked_at
        `.pipe(Effect.asVoid, sqlError("link"));
      }
      case "thread.related-thread-unlinked":
        return sql`
          DELETE FROM projection_thread_related_links
          WHERE thread_id = ${event.payload.threadId}
            AND related_thread_id = ${event.payload.relatedThreadId}
        `.pipe(Effect.asVoid, sqlError("unlink"));
      // A recreated or deleted thread starts without links. Links from other
      // threads to it stay and render as unavailable.
      case "thread.created":
      case "thread.deleted":
        return sql`
          DELETE FROM projection_thread_related_links
          WHERE thread_id = ${event.payload.threadId}
        `.pipe(Effect.asVoid, sqlError("reset"));
      default:
        return Effect.void;
    }
  };

  const selectRows = (threadId: ThreadId | null) =>
    (threadId === null
      ? sql`
          SELECT thread_id AS "threadId", related_thread_id AS "relatedThreadId",
            relationship, linked_at AS "linkedAt"
          FROM projection_thread_related_links
          ORDER BY linked_at ASC, related_thread_id ASC
        `
      : sql`
          SELECT thread_id AS "threadId", related_thread_id AS "relatedThreadId",
            relationship, linked_at AS "linkedAt"
          FROM projection_thread_related_links
          WHERE thread_id = ${threadId}
          ORDER BY linked_at ASC, related_thread_id ASC
        `
    ).pipe(
      sqlError("list"),
      Effect.flatMap((rows) =>
        decodeLinkRows(rows).pipe(
          Effect.mapError(toPersistenceDecodeError("relatedThreadLinks.decode")),
        ),
      ),
    );

  const withLinks = <T extends OrchestrationThread>(
    thread: T,
    links: ReadonlyArray<RelatedThreadLink> | undefined,
  ): T =>
    links === undefined || links.length === 0 ? thread : { ...thread, relatedThreads: links };

  /** Attach every thread's links (command read model bootstrap, full snapshots). */
  const attachToReadModel = (readModel: OrchestrationReadModel) =>
    selectRows(null).pipe(
      Effect.map((rows) => {
        if (rows.length === 0) return readModel;
        const byThread = new Map<string, RelatedThreadLink[]>();
        for (const row of rows) {
          const links = byThread.get(row.threadId) ?? [];
          links.push(toLink(row));
          byThread.set(row.threadId, links);
        }
        return {
          ...readModel,
          threads: readModel.threads.map((thread) => withLinks(thread, byThread.get(thread.id))),
        };
      }),
    );

  /** Attach one thread's links to a thread detail read. */
  const attachToThread = <T extends OrchestrationThread>(thread: T) =>
    selectRows(thread.id).pipe(Effect.map((rows) => withLinks(thread, rows.map(toLink))));

  const attachToThreadOption = <T extends OrchestrationThread>(thread: Option.Option<T>) =>
    Option.isNone(thread)
      ? Effect.succeed(thread)
      : attachToThread(thread.value).pipe(Effect.map(Option.some));

  return { apply, attachToReadModel, attachToThread, attachToThreadOption };
};
