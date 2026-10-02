/**
 * The `projection.team-overview` projector: project brief versions, member
 * focus, and the per-project activity feed, derived from orchestration
 * events. Runs inside the projection pipeline's transaction like every other
 * projector, so reads after a dispatch see its rows.
 *
 * @module TeamOverviewProjection
 */
import type { OrchestrationEvent, TeamActivityKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export const TEAM_OVERVIEW_PROJECTOR_NAME = "projection.team-overview" as const;

/** Thread activities that put a person on the hook. */
const REQUEST_ACTIVITY_KINDS: Readonly<Record<string, TeamActivityKind>> = {
  "approval.requested": "approval-requested",
  "user-input.requested": "input-requested",
};

const MAX_DETAIL_LENGTH = 280;

const clip = (text: string | null): string | null =>
  text === null ? null : text.length > MAX_DETAIL_LENGTH ? text.slice(0, MAX_DETAIL_LENGTH) : text;

export const makeTeamOverviewProjector = (sql: SqlClient.SqlClient) => {
  const insertActivity = (row: {
    readonly activityId: string;
    readonly projectId: string;
    readonly threadId: string | null;
    readonly kind: TeamActivityKind;
    readonly actorId: string | null;
    readonly detail: string | null;
    readonly event: OrchestrationEvent;
  }) => sql`
    INSERT OR IGNORE INTO projection_team_activity (
      activity_id, project_id, thread_id, kind, actor_id, detail, occurred_at, sequence
    ) VALUES (
      ${row.activityId}, ${row.projectId}, ${row.threadId}, ${row.kind}, ${row.actorId},
      ${clip(row.detail)}, ${row.event.occurredAt}, ${row.event.sequence}
    )
  `;

  const projectIdOfThread = (threadId: string) =>
    sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.projectId ?? null));

  const insertThreadActivity = (
    event: OrchestrationEvent,
    threadId: string,
    activity: { readonly id: string; readonly kind: TeamActivityKind; readonly detail?: string },
  ) =>
    Effect.gen(function* () {
      const projectId = yield* projectIdOfThread(threadId);
      if (projectId === null) return;
      yield* insertActivity({
        activityId: activity.id,
        projectId,
        threadId,
        kind: activity.kind,
        actorId: event.metadata.actor ?? null,
        detail: activity.detail ?? null,
        event,
      });
    });

  const apply = (event: OrchestrationEvent): Effect.Effect<void, ProjectionRepositoryError> =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.brief-updated": {
          const { projectId, text, updatedAt } = event.payload;
          yield* sql`
            INSERT OR IGNORE INTO projection_team_brief_versions (
              project_id, version, text, author_id, created_at, sequence
            )
            SELECT
              ${projectId},
              COALESCE(MAX(version), 0) + 1,
              ${text},
              ${event.metadata.actor ?? null},
              ${updatedAt},
              ${event.sequence}
            FROM projection_team_brief_versions
            WHERE project_id = ${projectId}
          `;
          yield* insertActivity({
            activityId: event.eventId,
            projectId,
            threadId: null,
            kind: "brief-updated",
            actorId: event.metadata.actor ?? null,
            detail: null,
            event,
          });
          return;
        }

        case "project.member-focus-set": {
          const { projectId, memberId, focus, updatedAt } = event.payload;
          if (focus === null) {
            yield* sql`
              DELETE FROM projection_team_member_focus
              WHERE project_id = ${projectId} AND member_id = ${memberId}
            `;
          } else {
            yield* sql`
              INSERT INTO projection_team_member_focus (project_id, member_id, focus, updated_at)
              VALUES (${projectId}, ${memberId}, ${focus}, ${updatedAt})
              ON CONFLICT (project_id, member_id)
              DO UPDATE SET focus = excluded.focus, updated_at = excluded.updated_at
            `;
          }
          yield* insertActivity({
            activityId: event.eventId,
            projectId,
            threadId: null,
            kind: focus === null ? "focus-cleared" : "focus-set",
            actorId: memberId,
            detail: focus,
            event,
          });
          return;
        }

        case "thread.created":
          yield* insertActivity({
            activityId: event.eventId,
            projectId: event.payload.projectId,
            threadId: event.payload.threadId,
            kind: "thread-created",
            actorId: event.metadata.actor ?? null,
            detail: event.payload.title,
            event,
          });
          return;

        case "thread.turn-start-requested":
          yield* insertThreadActivity(event, event.payload.threadId, {
            id: event.eventId,
            kind: "turn-started",
          });
          return;

        case "thread.activity-appended": {
          const kind = REQUEST_ACTIVITY_KINDS[event.payload.activity.kind];
          if (kind === undefined) return;
          yield* insertThreadActivity(event, event.payload.threadId, {
            id: event.eventId,
            kind,
            detail: event.payload.activity.summary,
          });
          return;
        }

        case "thread.session-set": {
          const { threadId, session } = event.payload;
          if (session.status === "running" && session.activeTurnId !== null) {
            yield* sql`
              INSERT INTO projection_team_thread_runs (thread_id, turn_id)
              VALUES (${threadId}, ${session.activeTurnId})
              ON CONFLICT (thread_id) DO UPDATE SET turn_id = excluded.turn_id
            `;
            return;
          }
          const kind = turnEndKind(session.status);
          if (kind === null) return;
          const runs = yield* sql<{ readonly turnId: string }>`
            SELECT turn_id AS "turnId" FROM projection_team_thread_runs WHERE thread_id = ${threadId}
          `;
          const run = runs[0];
          if (run === undefined) return;
          yield* sql`DELETE FROM projection_team_thread_runs WHERE thread_id = ${threadId}`;
          yield* insertThreadActivity(event, threadId, {
            id: `turn-end:${threadId}:${run.turnId}`,
            kind,
            ...(kind === "turn-errored" && session.lastError !== null
              ? { detail: session.lastError }
              : {}),
          });
          return;
        }

        case "thread.deleted": {
          const { threadId } = event.payload;
          yield* sql`DELETE FROM projection_team_activity WHERE thread_id = ${threadId}`;
          yield* sql`DELETE FROM projection_team_thread_runs WHERE thread_id = ${threadId}`;
          return;
        }

        default:
          return;
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("TeamOverviewProjection.apply")));

  return { apply };
};

/** The feed item a session leaving "running" ends its turn with. */
function turnEndKind(
  status: Extract<
    OrchestrationEvent,
    { type: "thread.session-set" }
  >["payload"]["session"]["status"],
): TeamActivityKind | null {
  switch (status) {
    case "idle":
    case "ready":
      return "turn-completed";
    case "error":
      return "turn-errored";
    case "interrupted":
    case "stopped":
      return "turn-interrupted";
    case "starting":
    case "running":
      return null;
  }
}
