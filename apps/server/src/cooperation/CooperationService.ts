/**
 * CooperationService - Puff Collab cooperation analysis.
 *
 * Owns per-thread consent (owner only, everything off by default), the
 * bounded export of two consented shared threads, analyst runs and their
 * server-side validation, the latest summary per thread, and the awareness
 * inbox. Analyst output never reaches a provider on its own: a note enters a
 * turn only when its recipient admits it into a message they send, and a
 * proposal becomes a message only when its recipient approves it.
 *
 * With the team hub (Stage 7.4) a pair is one of this server's threads and
 * either another of its own or a teammate's mirror. Consent travels with each
 * thread's hub summary; a mirror is exported from its local copy under its
 * owner's published consent, and the analysis runs on this server's own
 * provider. Results for its own threads post to the hub (`analysis.post`);
 * notes for a teammate's thread go to the hub, which delivers them to that
 * owner. Notes the hub delivers for this server's threads land in the local
 * inbox, where admit/dismiss/approve/reject stay local.
 *
 * @module CooperationService
 */
import {
  CommandId,
  type CooperationAnalysisSummary,
  type CooperationAwarenessItem,
  CooperationCitation,
  CooperationError,
  HubCitation,
  type HubAwarenessItem,
  type HubAnalysisSummary,
  type CooperationInbox,
  type CooperationLastRun,
  type CooperationResolveInput,
  type CooperationSettings,
  type CooperationSettingsUpdateInput,
  type CooperationThreadState,
  isRemoteHubThread,
  isThreadShared,
  MessageId,
  OrchestrationEvent,
  OWNER_MEMBER_ID,
  parseHubThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as HubSync from "../hub/HubSync.ts";
import { mirrorThreadIdOf } from "../hub/hubThreads.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildCooperationAnalysisPrompt,
  type CooperationAnalystThreadRef,
} from "../textGeneration/CooperationAnalysisPrompt.ts";
import { CooperationAnalyst } from "./CooperationAnalyst.ts";
import {
  boundExport,
  EXPORT_MAX_SCANNED_EVENTS,
  EXPORTABLE_EVENT_TYPES,
  type ExportedEvent,
  type ExportGrant,
  pairRelationship,
  toAnalystEvents,
  validateAnalystOutput,
} from "./CooperationPolicy.ts";

/** Other threads one thread is analyzed against per trigger. */
const MAX_PARTNERS = 4;
const INBOX_LIMIT = 50;
/** Every recipient is the environment owner: each local server is single-user. */
const RECIPIENT = OWNER_MEMBER_ID;

export type CooperationTrigger = "manual" | "turn-completed";

export interface CooperationChange {
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Whether the inbox changed. */
  readonly inbox: boolean;
}

export class CooperationService extends Context.Service<
  CooperationService,
  {
    readonly getThreadState: (
      threadId: ThreadId,
    ) => Effect.Effect<CooperationThreadState, CooperationError>;
    /** The thread's state now and after every change, for `cooperation.subscribeThread`. */
    readonly streamThreadState: (
      threadId: ThreadId,
    ) => Stream.Stream<CooperationThreadState, CooperationError>;
    readonly updateSettings: (
      input: CooperationSettingsUpdateInput,
    ) => Effect.Effect<CooperationSettings, CooperationError>;
    /** On-demand run on one of this server's threads. Returns the number of pairs analyzed. */
    readonly requestAnalysis: (threadId: ThreadId) => Effect.Effect<number, CooperationError>;
    /** Analyze the thread against every matching consented thread. */
    readonly analyzeThread: (
      threadId: ThreadId,
      trigger: CooperationTrigger,
    ) => Effect.Effect<number, CooperationError>;
    /** Whether the thread is opted in; reactors use it to skip cheaply. */
    readonly isAnalysisEnabled: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly getInbox: Effect.Effect<CooperationInbox, CooperationError>;
    readonly streamInbox: Stream.Stream<CooperationInbox, CooperationError>;
    readonly resolveItem: (
      input: CooperationResolveInput,
    ) => Effect.Effect<CooperationAwarenessItem, CooperationError>;
    /**
     * Files awareness the team hub delivered for this server's threads into
     * the inbox. Idempotent by item id; a decided item stays decided.
     */
    readonly admitHubAwareness: (
      items: ReadonlyArray<HubAwarenessItem>,
    ) => Effect.Effect<void, CooperationError>;
    /**
     * Latest validated analysis summary for a thread, or null. This is what a
     * work card's optional `analysis` slot shows.
     */
    readonly latestSummaryForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<CooperationAnalysisSummary | null, CooperationError>;
    readonly changes: Stream.Stream<CooperationChange>;
  }
>()("t3/cooperation/CooperationService") {}

const fail = (reason: CooperationError["reason"], message: string) =>
  Effect.fail(new CooperationError({ reason, message }));

const internal =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CooperationError, R> =>
    effect.pipe(
      Effect.mapError(
        () =>
          new CooperationError({ reason: "internal", message: `Cooperation ${operation} failed.` }),
      ),
    );

interface SettingsRow {
  readonly threadId: string;
  readonly version: number;
  readonly featureTopic: string;
  readonly analysisEnabled: number;
  readonly textEnabled: number;
  readonly awarenessNotify: number;
  readonly updatedAt: string;
}

interface ItemRow {
  readonly itemId: string;
  readonly runId: string;
  readonly kind: string;
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly recipientMemberId: string;
  readonly text: string;
  readonly citationsJson: string;
  readonly state: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

const CitationsJson = Schema.fromJsonString(Schema.Array(CooperationCitation));
const encodeCitations = Schema.encodeSync(CitationsJson);
const decodeCitations = Schema.decodeUnknownSync(CitationsJson);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const isHubCitation = Schema.is(HubCitation);

const defaultSettings = (threadId: ThreadId): CooperationSettings => ({
  threadId,
  version: 0,
  featureTopic: "",
  analysisEnabled: false,
  textEnabled: false,
  awarenessNotify: false,
  updatedAt: null,
});

const toSettings = (threadId: ThreadId, row: SettingsRow | undefined): CooperationSettings =>
  row === undefined
    ? defaultSettings(threadId)
    : {
        threadId,
        version: row.version,
        featureTopic: row.featureTopic,
        analysisEnabled: row.analysisEnabled === 1,
        textEnabled: row.textEnabled === 1,
        awarenessNotify: row.awarenessNotify === 1,
        updatedAt: row.updatedAt,
      };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const hub = yield* HubSync.HubSync;
  const engine = yield* OrchestrationEngineService;
  const analyst = yield* CooperationAnalyst;
  const crypto = yield* Crypto.Crypto;
  const changesHub = yield* PubSub.unbounded<CooperationChange>();
  // Serializes consent writes with the final check-and-apply of analysis
  // results, so a revoked consent can never race a result being stored.
  const consentLock = yield* Semaphore.make(1);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}_${uuid}`),
      internal("id"),
    );
  const publish = (change: CooperationChange) =>
    PubSub.publish(changesHub, change).pipe(Effect.asVoid);

  const readSettings = (threadId: ThreadId) =>
    sql<SettingsRow>`
      SELECT
        thread_id AS "threadId",
        version,
        feature_topic AS "featureTopic",
        analysis_enabled AS "analysisEnabled",
        text_enabled AS "textEnabled",
        awareness_notify AS "awarenessNotify",
        updated_at AS "updatedAt"
      FROM cooperation_thread_settings
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => toSettings(threadId, rows[0])),
      internal("settings read"),
    );

  const readShell = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined), internal("thread read"));

  const requireShell = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      if (shell === undefined) return yield* fail("not-found", "Thread not found.");
      return shell;
    });

  /** A teammate's mirror: its consent is what its owner published to the hub. */
  const mirrorSettings = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const info = yield* hub.mirrorInfo(threadId);
      const consent = info?.cooperation ?? null;
      const settings: CooperationSettings =
        consent === null
          ? defaultSettings(threadId)
          : {
              threadId,
              version: 0,
              featureTopic: consent.featureTopic,
              analysisEnabled: consent.analysisEnabled,
              textEnabled: consent.textEnabled,
              awarenessNotify: consent.awarenessNotify,
              updatedAt: null,
            };
      return { info, settings };
    });

  const readSummary = (threadId: ThreadId) =>
    sql<{ readonly summary: string; readonly updatedAt: string }>`
      SELECT summary, updated_at AS "updatedAt"
      FROM cooperation_thread_summaries
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      internal("summary read"),
    );

  const readLastRun = (threadId: ThreadId) =>
    sql<{
      readonly state: CooperationLastRun["state"];
      readonly reason: string | null;
      readonly createdAt: string;
      readonly completedAt: string | null;
    }>`
      SELECT state, reason, created_at AS "createdAt", completed_at AS "completedAt"
      FROM cooperation_analysis_runs
      WHERE first_thread_id = ${threadId} OR second_thread_id = ${threadId}
      ORDER BY created_at DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      internal("run read"),
    );

  const getThreadState: CooperationService["Service"]["getThreadState"] = (threadId) =>
    Effect.gen(function* () {
      const shell = yield* requireShell(threadId);
      if (isRemoteHubThread(shell)) {
        const { info, settings } = yield* mirrorSettings(threadId);
        return {
          threadId,
          canEdit: false,
          settings,
          summary:
            info?.analysis == null
              ? null
              : { summary: info.analysis.summary, updatedAt: info.analysis.updatedAt },
          lastRun: yield* readLastRun(threadId),
        } satisfies CooperationThreadState;
      }
      return {
        threadId,
        canEdit: true,
        settings: yield* readSettings(threadId),
        summary: yield* readSummary(threadId),
        lastRun: yield* readLastRun(threadId),
      } satisfies CooperationThreadState;
    });

  const changes = Stream.fromPubSub(changesHub);

  const streamThreadState: CooperationService["Service"]["streamThreadState"] = (threadId) =>
    Stream.concat(
      Stream.make(undefined),
      changes.pipe(Stream.filter((change) => change.threadIds.includes(threadId))),
    ).pipe(Stream.mapEffect(() => getThreadState(threadId)));

  /** Drops what a thread contributed once its owner withdraws consent. */
  const withdrawThread = (threadId: ThreadId, resolvedAt: string) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE cooperation_awareness_items
        SET state = 'dismissed', resolved_at = ${resolvedAt}, resolved_by = 'consent-withdrawn'
        WHERE state = 'pending' AND (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
      `;
      yield* sql`DELETE FROM cooperation_thread_summaries WHERE thread_id = ${threadId}`;
    }).pipe(internal("consent withdrawal"));

  const updateSettings: CooperationService["Service"]["updateSettings"] = (input) =>
    consentLock.withPermit(
      Effect.gen(function* () {
        const shell = yield* requireShell(input.threadId);
        if (isRemoteHubThread(shell)) {
          return yield* fail("forbidden", "Only the thread owner can change cooperation settings.");
        }
        const featureTopic = input.featureTopic.trim();
        if (input.analysisEnabled && featureTopic.length === 0) {
          return yield* fail("invalid", "Analysis needs a feature topic.");
        }
        const current = yield* readSettings(input.threadId);
        if (current.version !== input.expectedVersion) {
          return yield* fail("conflict", "Cooperation settings changed. Reload and try again.");
        }
        // Text export and notifications only mean something while analysis is on.
        const next: CooperationSettings = {
          threadId: input.threadId,
          version: current.version + 1,
          featureTopic,
          analysisEnabled: input.analysisEnabled,
          textEnabled: input.analysisEnabled && input.textEnabled,
          awarenessNotify: input.analysisEnabled && input.awarenessNotify,
          updatedAt: yield* now,
        };
        yield* sql`
          INSERT INTO cooperation_thread_settings (
            thread_id, version, feature_topic, analysis_enabled,
            text_enabled, awareness_notify, updated_by, updated_at
          )
          VALUES (
            ${next.threadId}, ${next.version}, ${next.featureTopic},
            ${next.analysisEnabled ? 1 : 0}, ${next.textEnabled ? 1 : 0},
            ${next.awarenessNotify ? 1 : 0}, ${RECIPIENT}, ${next.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            version = excluded.version,
            feature_topic = excluded.feature_topic,
            analysis_enabled = excluded.analysis_enabled,
            text_enabled = excluded.text_enabled,
            awareness_notify = excluded.awareness_notify,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `.pipe(internal("settings write"));
        const withdrawn = current.analysisEnabled && !next.analysisEnabled;
        if (withdrawn) yield* withdrawThread(input.threadId, next.updatedAt!);
        // Teammates see consent on the thread's hub summary.
        yield* hub.refreshSummary(input.threadId);
        yield* publish({ threadIds: [input.threadId], inbox: withdrawn });
        return next;
      }),
    );

  type Grant =
    | { readonly ok: false; readonly reason: string }
    | {
        readonly ok: true;
        readonly shell: NonNullable<Effect.Success<ReturnType<typeof readShell>>>;
        readonly settings: CooperationSettings;
        readonly grant: ExportGrant;
        /** Set for a teammate's mirror. */
        readonly mirror: HubSync.HubMirrorInfo | null;
      };

  /** Current consent for a thread, or a reason it cannot take part. */
  const currentGrant = (threadId: ThreadId) =>
    Effect.gen(function* (): Effect.fn.Return<Grant, CooperationError> {
      const shell = yield* readShell(threadId);
      if (shell === undefined) return { ok: false, reason: "thread is gone" };
      if (!isThreadShared(shell)) return { ok: false, reason: "thread is not shared" };
      const remote = isRemoteHubThread(shell);
      const { info, settings } = remote
        ? yield* mirrorSettings(threadId)
        : { info: null, settings: yield* readSettings(threadId) };
      if (!settings.analysisEnabled || settings.featureTopic.length === 0) {
        return { ok: false, reason: "analysis consent is off" };
      }
      return {
        ok: true,
        shell,
        settings,
        // A mirror's messages were all written by its owner on their machine.
        grant: {
          threadId,
          ownerMemberId: RECIPIENT,
          version: settings.version,
          featureTopic: settings.featureTopic,
          textEnabled: settings.textEnabled,
        },
        mirror: remote ? info : null,
      };
    });

  // Related-thread links (owned by the related-work feature) are the one
  // record of how two threads relate; a mirror's links come from its owner.
  const readPairRelationship = (firstId: ThreadId, secondId: ThreadId) =>
    sql<{ readonly relationship: string }>`
      SELECT relationship
      FROM projection_thread_related_links
      WHERE (thread_id = ${firstId} AND related_thread_id = ${secondId})
        OR (thread_id = ${secondId} AND related_thread_id = ${firstId})
    `.pipe(
      Effect.map((rows) =>
        pairRelationship(
          rows.flatMap((row) =>
            row.relationship === "complementary" || row.relationship === "alternative"
              ? [row.relationship]
              : [],
          ),
        ),
      ),
      internal("relationship read"),
    );

  // A mirror's consent has no local version, so its topic and text switch
  // are compared too.
  const sameGrant = (left: ExportGrant, right: ExportGrant) =>
    left.threadId === right.threadId &&
    left.version === right.version &&
    left.featureTopic === right.featureTopic &&
    left.textEnabled === right.textEnabled;

  const readRecentEvents = (threadId: ThreadId) =>
    sql<{
      readonly sequence: number;
      readonly eventId: string;
      readonly type: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
      readonly occurredAt: string;
      readonly commandId: string | null;
      readonly causationEventId: string | null;
      readonly correlationId: string | null;
      readonly payload: string;
      readonly metadata: string;
    }>`
      SELECT
        sequence,
        event_id AS "eventId",
        event_type AS "type",
        aggregate_kind AS "aggregateKind",
        stream_id AS "aggregateId",
        occurred_at AS "occurredAt",
        command_id AS "commandId",
        causation_event_id AS "causationEventId",
        correlation_id AS "correlationId",
        payload_json AS "payload",
        metadata_json AS "metadata"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND ${sql.in("event_type", EXPORTABLE_EVENT_TYPES)}
      ORDER BY sequence DESC
      LIMIT ${EXPORT_MAX_SCANNED_EVENTS}
    `.pipe(
      internal("event export"),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.all({ payload: decodeJson(row.payload), metadata: decodeJson(row.metadata) }).pipe(
            Effect.flatMap((json) => decodeEvent({ ...row, ...json })),
            // An event this build cannot decode is simply not exported.
            Effect.option,
          ),
        ),
      ),
      Effect.map((events) =>
        events.flatMap((event) => (Option.isSome(event) ? [event.value] : [])),
      ),
    );

  /** Every cited event must still exist on its thread with the same id and sequence. */
  const citationsExist = (citations: ReadonlyArray<CooperationCitation>) =>
    Effect.forEach(citations, (citation) =>
      sql<{ readonly one: number }>`
        SELECT 1 AS "one" FROM orchestration_events
        WHERE sequence = ${citation.sequence}
          AND event_id = ${citation.eventId}
          AND aggregate_kind = 'thread'
          AND stream_id = ${citation.threadId}
      `.pipe(Effect.map((rows) => rows.length > 0)),
    ).pipe(
      Effect.map((found) => found.every(Boolean)),
      internal("citation check"),
    );

  /**
   * Hub citations for a run's evidence. Only a mirror's events know their
   * place in the hub stream (`metadata.hubOrigin`); evidence from this
   * server's own threads stays local provenance.
   */
  const toHubCitations = (
    citations: ReadonlyArray<CooperationCitation>,
    mirrors: ReadonlyMap<ThreadId, HubSync.HubMirrorInfo>,
  ) =>
    Effect.forEach(citations, (citation) =>
      Effect.gen(function* () {
        const mirror = mirrors.get(citation.threadId);
        if (mirror === undefined) return [];
        const rows = yield* sql<{ generation: number | null; seq: number | null }>`
          SELECT json_extract(metadata_json, '$.hubOrigin.generation') AS generation,
                 json_extract(metadata_json, '$.hubOrigin.seq') AS seq
          FROM orchestration_events
          WHERE sequence = ${citation.sequence} AND event_id = ${citation.eventId}
        `;
        const candidate = {
          threadId: mirror.hubThreadId,
          generation: rows[0]?.generation,
          seq: rows[0]?.seq,
        };
        return isHubCitation(candidate) ? [candidate] : [];
      }),
    ).pipe(
      Effect.map((lists) => lists.flat()),
      internal("citation mapping"),
    );

  /** Local provenance for hub citations into a mirror this server holds. */
  const fromHubCitations = (citations: ReadonlyArray<HubCitation>) =>
    Effect.forEach(citations, (citation) =>
      sql<{ sequence: number; eventId: string }>`
        SELECT sequence, event_id AS "eventId"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${mirrorThreadIdOf(citation.threadId)}
          AND json_extract(metadata_json, '$.hubOrigin.generation') = ${citation.generation}
          AND json_extract(metadata_json, '$.hubOrigin.seq') = ${citation.seq}
        ORDER BY sequence DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? []
            : [
                {
                  threadId: mirrorThreadIdOf(citation.threadId),
                  eventId: rows[0].eventId,
                  sequence: rows[0].sequence,
                } as CooperationCitation,
              ],
        ),
      ),
    ).pipe(
      Effect.map((lists) => lists.flat()),
      internal("citation mapping"),
    );

  const finishRun = (
    runId: string,
    state: "applied" | "rejected" | "failed",
    reason: string | null,
  ) =>
    Effect.gen(function* () {
      const completedAt = yield* now;
      yield* sql`
        UPDATE cooperation_analysis_runs
        SET state = ${state}, reason = ${reason}, completed_at = ${completedAt}
        WHERE run_id = ${runId}
      `.pipe(internal("run write"));
    });

  const insertItem = (item: {
    readonly itemId: string;
    readonly runId: string;
    readonly kind: "note" | "proposal";
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly text: string;
    readonly citations: ReadonlyArray<CooperationCitation>;
    readonly createdAt: string;
  }) =>
    sql`
      INSERT OR IGNORE INTO cooperation_awareness_items (
        item_id, run_id, kind, source_thread_id, target_thread_id, recipient_member_id,
        text, citations_json, state, created_at, resolved_at, resolved_by
      )
      VALUES (
        ${item.itemId}, ${item.runId}, ${item.kind}, ${item.sourceThreadId},
        ${item.targetThreadId}, ${RECIPIENT}, ${item.text},
        ${encodeCitations(item.citations)}, 'pending', ${item.createdAt}, NULL, NULL
      )
    `.pipe(internal("item write"));

  /**
   * One analyst run over a pair (the first is this server's own thread);
   * records its outcome and never throws on bad output.
   */
  const analyzePair = (firstId: ThreadId, secondId: ThreadId, trigger: CooperationTrigger) =>
    Effect.gen(function* () {
      const first = yield* currentGrant(firstId);
      const second = yield* currentGrant(secondId);
      if (!first.ok || !second.ok || first.mirror !== null) return false;
      if (
        first.shell.projectId !== second.shell.projectId ||
        first.grant.featureTopic !== second.grant.featureTopic
      ) {
        return false;
      }

      const runId = yield* newId("run");
      const pair = { A: first, B: second } as const;
      yield* sql`
        INSERT INTO cooperation_analysis_runs (
          run_id, first_thread_id, second_thread_id, trigger, state, reason, created_at, completed_at
        )
        VALUES (${runId}, ${firstId}, ${secondId}, ${trigger}, 'running', NULL, ${yield* now}, NULL)
      `.pipe(internal("run write"));
      yield* publish({ threadIds: [firstId, secondId], inbox: false });

      const exported: Record<CooperationAnalystThreadRef, ReadonlyArray<ExportedEvent>> = {
        A: boundExport(yield* readRecentEvents(firstId), first.grant),
        B: boundExport(yield* readRecentEvents(secondId), second.grant),
      };
      if (exported.A.length === 0 || exported.B.length === 0) {
        yield* finishRun(runId, "rejected", "a thread has no eligible events");
        return true;
      }
      const analystThread = (ref: CooperationAnalystThreadRef) => ({
        ref,
        title: pair[ref].shell.title,
        featureTopic: pair[ref].grant.featureTopic,
        events: toAnalystEvents(ref, exported[ref]),
      });
      const { prompt } = buildCooperationAnalysisPrompt({
        relationship: yield* readPairRelationship(firstId, secondId),
        threads: [analystThread("A"), analystThread("B")],
      });
      const output = yield* analyst.analyze({ prompt }).pipe(Effect.result);
      if (output._tag === "Failure") {
        yield* finishRun(runId, "failed", output.failure.detail);
        return true;
      }

      const toHub = yield* consentLock.withPermit(
        Effect.gen(function* () {
          const none = {
            summaries: [] as HubAnalysisSummary[],
            awareness: [] as HubAwarenessItem[],
          };
          // Consent is re-read at completion: a change during the run voids it.
          const firstNow = yield* currentGrant(firstId);
          const secondNow = yield* currentGrant(secondId);
          if (
            !firstNow.ok ||
            !secondNow.ok ||
            !sameGrant(firstNow.grant, first.grant) ||
            !sameGrant(secondNow.grant, second.grant)
          ) {
            yield* finishRun(runId, "rejected", "consent changed during analysis");
            return none;
          }
          const validation = validateAnalystOutput({
            output: output.success,
            threads: {
              A: { threadId: firstId, events: exported.A },
              B: { threadId: secondId, events: exported.B },
            },
          });
          if (!validation.ok) {
            yield* finishRun(runId, "rejected", validation.reason);
            return none;
          }
          const cited = [
            ...validation.summaries.flatMap((summary) => summary.citations),
            ...validation.notes.flatMap((note) => note.citations),
          ];
          if (!(yield* citationsExist(cited))) {
            yield* finishRun(runId, "rejected", "a cited event no longer exists");
            return none;
          }

          const byId = new Map([
            [firstId, firstNow],
            [secondId, secondNow],
          ]);
          const mirrors = new Map(
            [firstNow, secondNow].flatMap((grant) =>
              grant.mirror === null ? [] : [[grant.grant.threadId, grant.mirror] as const],
            ),
          );
          const appliedAt = yield* now;
          const hubSummaries: HubAnalysisSummary[] = [];
          const hubAwareness: HubAwarenessItem[] = [];
          for (const summary of validation.summaries) {
            // A teammate's thread gets its summary from its owner's own run.
            if (mirrors.has(summary.threadId)) continue;
            yield* sql`
              INSERT INTO cooperation_thread_summaries (thread_id, run_id, summary, citations_json, updated_at)
              VALUES (
                ${summary.threadId}, ${runId}, ${summary.summary},
                ${encodeCitations(summary.citations)}, ${appliedAt}
              )
              ON CONFLICT (thread_id) DO UPDATE SET
                run_id = excluded.run_id,
                summary = excluded.summary,
                citations_json = excluded.citations_json,
                updated_at = excluded.updated_at
            `.pipe(internal("summary write"));
            const hubThreadId = yield* hub.publishedThreadId(summary.threadId);
            if (hubThreadId !== null) {
              hubSummaries.push({
                threadId: hubThreadId,
                summary: summary.summary,
                updatedAt: appliedAt,
              });
            }
          }
          const discarded = [...validation.discarded];
          let delivered = false;
          for (const note of validation.notes) {
            const target = byId.get(note.targetThreadId)!;
            if (!target.ok || !target.settings.awarenessNotify) {
              discarded.push(`${note.kind} not delivered: recipient notifications are off`);
              continue;
            }
            const itemId = yield* newId("item");
            if (target.mirror === null) {
              yield* insertItem({ ...note, itemId, runId, createdAt: appliedAt });
              delivered = true;
              continue;
            }
            // For a teammate's thread: the hub delivers it to its owner.
            const sourceHubId = yield* hub.publishedThreadId(note.sourceThreadId);
            if (sourceHubId === null) {
              discarded.push(`${note.kind} not delivered: this thread is not on the team hub yet`);
              continue;
            }
            hubAwareness.push({
              itemId,
              kind: note.kind,
              sourceThreadId: sourceHubId,
              sourceThreadTitle: byId.get(note.sourceThreadId)?.ok
                ? (byId.get(note.sourceThreadId) as Extract<Grant, { ok: true }>).shell.title
                : "",
              targetThreadId: target.mirror.hubThreadId,
              text: note.text,
              citations: yield* toHubCitations(note.citations, mirrors),
              createdAt: appliedAt,
            });
          }
          yield* finishRun(runId, "applied", discarded.length > 0 ? discarded.join("; ") : null);
          yield* publish({ threadIds: [firstId, secondId], inbox: delivered });
          return { summaries: hubSummaries, awareness: hubAwareness };
        }),
      );
      yield* hub
        .postAnalysis({
          projectId: first.shell.projectId,
          summaries: toHub.summaries,
          awareness: toHub.awareness,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("cooperation results did not reach the team hub", {
              reason: error.reason,
            }),
          ),
        );
      return true;
    });

  const isAnalysisEnabled: CooperationService["Service"]["isAnalysisEnabled"] = (threadId) =>
    readSettings(threadId).pipe(
      Effect.map((settings) => settings.analysisEnabled),
      Effect.orElseSucceed(() => false),
    );

  const analyzeThread: CooperationService["Service"]["analyzeThread"] = (threadId, trigger) =>
    Effect.gen(function* () {
      const self = yield* currentGrant(threadId);
      // Only a thread's owner analyzes it; a mirror is analyzed on its owner's machine.
      if (!self.ok || self.mirror !== null) return 0;
      const own = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM cooperation_thread_settings
        WHERE analysis_enabled = 1
          AND feature_topic = ${self.grant.featureTopic}
          AND thread_id != ${threadId}
        ORDER BY updated_at DESC
        LIMIT ${MAX_PARTNERS}
      `.pipe(internal("partner lookup"));
      const mirrors = yield* hub.consentingMirrors(self.shell.projectId, self.grant.featureTopic);
      const partners = [...own.map((row) => ThreadId.make(row.threadId)), ...mirrors].slice(
        0,
        MAX_PARTNERS,
      );
      let runs = 0;
      for (const partner of partners) {
        if (yield* analyzePair(threadId, partner, trigger)) runs += 1;
      }
      return runs;
    });

  const requestAnalysis: CooperationService["Service"]["requestAnalysis"] = (threadId) =>
    Effect.gen(function* () {
      const shell = yield* requireShell(threadId);
      if (isRemoteHubThread(shell)) {
        return yield* fail("forbidden", "Only the thread owner can request analysis.");
      }
      if (!(yield* analyst.available)) {
        return yield* fail(
          "unavailable",
          "Choose a supported cooperation analysis model in Settings first.",
        );
      }
      const self = yield* currentGrant(threadId);
      if (!self.ok) return yield* fail("invalid", `Analysis cannot run: ${self.reason}.`);
      return yield* analyzeThread(threadId, "manual");
    });

  const titleOf = (threadId: string) =>
    readShell(ThreadId.make(threadId)).pipe(
      Effect.map((shell) => shell?.title ?? "Unavailable thread"),
    );

  const toItem = (row: ItemRow) =>
    Effect.gen(function* () {
      return {
        itemId: row.itemId,
        kind: row.kind === "proposal" ? "proposal" : "note",
        sourceThreadId: ThreadId.make(row.sourceThreadId),
        sourceThreadTitle: yield* titleOf(row.sourceThreadId),
        targetThreadId: ThreadId.make(row.targetThreadId),
        text: row.text,
        citations: decodeCitations(row.citationsJson),
        state: row.state as CooperationAwarenessItem["state"],
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
      } satisfies CooperationAwarenessItem;
    });

  const itemColumns = sql`
    item_id AS "itemId",
    run_id AS "runId",
    kind,
    source_thread_id AS "sourceThreadId",
    target_thread_id AS "targetThreadId",
    recipient_member_id AS "recipientMemberId",
    text,
    citations_json AS "citationsJson",
    state,
    created_at AS "createdAt",
    resolved_at AS "resolvedAt"
  `;

  const getInbox: CooperationService["Service"]["getInbox"] = sql<ItemRow>`
    SELECT ${itemColumns}
    FROM cooperation_awareness_items
    WHERE recipient_member_id = ${RECIPIENT} AND state = 'pending'
    ORDER BY created_at DESC
    LIMIT ${INBOX_LIMIT}
  `.pipe(
    internal("inbox read"),
    Effect.flatMap((rows) => Effect.forEach(rows, toItem)),
    Effect.map((items) => ({ items })),
  );

  const streamInbox: CooperationService["Service"]["streamInbox"] = Stream.concat(
    Stream.make(undefined),
    changes.pipe(Stream.filter((change) => change.inbox)),
  ).pipe(Stream.mapEffect(() => getInbox));

  const admitHubAwareness: CooperationService["Service"]["admitHubAwareness"] = (items) =>
    consentLock.withPermit(
      Effect.gen(function* () {
        const targets = new Set<ThreadId>();
        for (const item of items) {
          // Only this server's own shared threads receive notes.
          const targetId = parseHubThreadId(item.targetThreadId).threadId;
          if ((yield* hub.publishedThreadId(targetId)) !== item.targetThreadId) continue;
          const target = yield* currentGrant(targetId);
          if (!target.ok || target.mirror !== null || !target.settings.awarenessNotify) continue;
          yield* insertItem({
            itemId: `hub_${item.itemId}`,
            runId: "hub",
            kind: item.kind,
            sourceThreadId: mirrorThreadIdOf(item.sourceThreadId),
            targetThreadId: targetId,
            text: item.text,
            citations: yield* fromHubCitations(item.citations),
            createdAt: item.createdAt,
          });
          targets.add(targetId);
        }
        if (targets.size > 0) yield* publish({ threadIds: [...targets], inbox: true });
      }),
    );

  const resolveItem: CooperationService["Service"]["resolveItem"] = (input) =>
    consentLock.withPermit(
      Effect.gen(function* () {
        const rows = yield* sql<ItemRow>`
          SELECT ${itemColumns} FROM cooperation_awareness_items WHERE item_id = ${input.itemId}
        `.pipe(internal("item read"));
        const row = rows[0];
        if (row === undefined || row.recipientMemberId !== RECIPIENT) {
          return yield* fail("not-found", "Awareness item not found.");
        }
        const targetThreadId = ThreadId.make(row.targetThreadId);
        const target = yield* readShell(targetThreadId);
        // Re-checked at decision time: only this server's own thread can act on it.
        if (target === undefined || isRemoteHubThread(target)) {
          return yield* fail("forbidden", "Only the target thread's owner can act on this item.");
        }
        if (row.state !== "pending")
          return yield* fail("conflict", "This item was already handled.");
        const expectsProposal = input.action === "approve" || input.action === "reject";
        if (expectsProposal !== (row.kind === "proposal")) {
          return yield* fail("invalid", `Cannot ${input.action} a ${row.kind}.`);
        }
        const state = {
          admit: "admitted",
          dismiss: "dismissed",
          approve: "approved",
          reject: "rejected",
        }[input.action];
        const resolvedAt = yield* now;
        if (input.action === "approve") {
          // The approved proposal becomes an ordinary message from the owner.
          yield* engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`cooperation:proposal:${row.itemId}`),
              threadId: targetThreadId,
              message: {
                messageId: MessageId.make(yield* newId("msg")),
                role: "user",
                text: row.text,
                attachments: [],
              },
              runtimeMode: target.runtimeMode,
              interactionMode: target.interactionMode,
              createdAt: resolvedAt,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new CooperationError({
                    reason: "conflict",
                    message: "The thread cannot take a message now.",
                  }),
              ),
            );
        }
        yield* sql`
          UPDATE cooperation_awareness_items
          SET state = ${state}, resolved_at = ${resolvedAt}, resolved_by = ${RECIPIENT}
          WHERE item_id = ${row.itemId}
        `.pipe(internal("item write"));
        yield* publish({ threadIds: [targetThreadId], inbox: true });
        return yield* toItem({ ...row, state, resolvedAt });
      }),
    );

  const latestSummaryForThread: CooperationService["Service"]["latestSummaryForThread"] = (
    threadId,
  ) => readSummary(threadId);

  return CooperationService.of({
    getThreadState,
    streamThreadState,
    updateSettings,
    requestAnalysis,
    analyzeThread,
    isAnalysisEnabled,
    getInbox,
    streamInbox,
    resolveItem,
    admitHubAwareness,
    latestSummaryForThread,
    changes,
  });
});

export const layer = Layer.effect(CooperationService, make);
