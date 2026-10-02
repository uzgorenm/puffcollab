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
 * @module CooperationService
 */
import {
  CommandId,
  type CooperationAnalysisSummary,
  type CooperationAwarenessItem,
  CooperationCitation,
  CooperationError,
  type CooperationInbox,
  type CooperationLastRun,
  type CooperationResolveInput,
  type CooperationSettings,
  type CooperationSettingsUpdateInput,
  type CooperationThreadState,
  isThreadShared,
  type MemberId,
  MessageId,
  OrchestrationEvent,
  type OrchestrationThreadShell,
  threadOwnerOf,
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

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
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

export type CooperationTrigger = "manual" | "turn-completed";

export interface CooperationChange {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly memberIds: ReadonlyArray<MemberId>;
}

export class CooperationService extends Context.Service<
  CooperationService,
  {
    readonly getThreadState: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<CooperationThreadState, CooperationError>;
    /** The thread's state now and after every change, for `cooperation.subscribeThread`. */
    readonly streamThreadState: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Stream.Stream<CooperationThreadState, CooperationError>;
    readonly updateSettings: (
      memberId: MemberId,
      input: CooperationSettingsUpdateInput,
    ) => Effect.Effect<CooperationSettings, CooperationError>;
    /** On-demand run by the thread owner. Returns the number of pairs analyzed. */
    readonly requestAnalysis: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<number, CooperationError>;
    /** Analyze the thread against every matching consented thread. */
    readonly analyzeThread: (
      threadId: ThreadId,
      trigger: CooperationTrigger,
    ) => Effect.Effect<number, CooperationError>;
    /** Whether the thread is opted in; reactors use it to skip cheaply. */
    readonly isAnalysisEnabled: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly getInbox: (memberId: MemberId) => Effect.Effect<CooperationInbox, CooperationError>;
    readonly streamInbox: (memberId: MemberId) => Stream.Stream<CooperationInbox, CooperationError>;
    readonly resolveItem: (
      memberId: MemberId,
      input: CooperationResolveInput,
    ) => Effect.Effect<CooperationAwarenessItem, CooperationError>;
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

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const team = yield* TeamAccess.TeamAccess;
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

  const requireVisibleShell = (memberId: MemberId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      const visible = yield* team.canSeeThread(memberId, threadId).pipe(internal("access check"));
      if (shell === undefined || !visible) return yield* fail("not-found", "Thread not found.");
      return shell;
    });

  // Owner-only, the same rule ThreadAccess applies to thread commands.
  const isOwner = (memberId: MemberId, shell: OrchestrationThreadShell) =>
    threadOwnerOf(shell) === memberId;

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

  const getThreadState: CooperationService["Service"]["getThreadState"] = (memberId, threadId) =>
    Effect.gen(function* () {
      const shell = yield* requireVisibleShell(memberId, threadId);
      return {
        threadId,
        ownerMemberId: threadOwnerOf(shell),
        canEdit: isOwner(memberId, shell),
        settings: yield* readSettings(threadId),
        summary: yield* readSummary(threadId),
        lastRun: yield* readLastRun(threadId),
      } satisfies CooperationThreadState;
    });

  const changes = Stream.fromPubSub(changesHub);

  const streamThreadState: CooperationService["Service"]["streamThreadState"] = (
    memberId,
    threadId,
  ) =>
    Stream.concat(
      Stream.make(undefined),
      changes.pipe(Stream.filter((change) => change.threadIds.includes(threadId))),
    ).pipe(Stream.mapEffect(() => getThreadState(memberId, threadId)));

  /** Drops what a thread contributed once its owner withdraws consent. */
  const withdrawThread = (threadId: ThreadId, resolvedAt: string) =>
    Effect.gen(function* () {
      const recipients = yield* sql<{ readonly recipientMemberId: string }>`
        SELECT DISTINCT recipient_member_id AS "recipientMemberId"
        FROM cooperation_awareness_items
        WHERE state = 'pending' AND (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
      `;
      yield* sql`
        UPDATE cooperation_awareness_items
        SET state = 'dismissed', resolved_at = ${resolvedAt}, resolved_by = 'consent-withdrawn'
        WHERE state = 'pending' AND (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
      `;
      yield* sql`DELETE FROM cooperation_thread_summaries WHERE thread_id = ${threadId}`;
      return recipients.map((row) => row.recipientMemberId as MemberId);
    }).pipe(internal("consent withdrawal"));

  const updateSettings: CooperationService["Service"]["updateSettings"] = (memberId, input) =>
    consentLock.withPermit(
      Effect.gen(function* () {
        const shell = yield* requireVisibleShell(memberId, input.threadId);
        if (!isOwner(memberId, shell)) {
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
            ${next.awarenessNotify ? 1 : 0}, ${memberId}, ${next.updatedAt}
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
        const affected =
          current.analysisEnabled && !next.analysisEnabled
            ? yield* withdrawThread(input.threadId, next.updatedAt!)
            : [];
        yield* publish({ threadIds: [input.threadId], memberIds: affected });
        return next;
      }),
    );

  /** Current consent for a thread, or a reason it cannot take part. */
  const currentGrant = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      if (shell === undefined) return { ok: false as const, reason: "thread is gone" };
      if (!isThreadShared(shell)) return { ok: false as const, reason: "thread is not shared" };
      const settings = yield* readSettings(threadId);
      if (!settings.analysisEnabled || settings.featureTopic.length === 0) {
        return { ok: false as const, reason: "analysis consent is off" };
      }
      const grant: ExportGrant = {
        threadId,
        ownerMemberId: threadOwnerOf(shell),
        version: settings.version,
        featureTopic: settings.featureTopic,
        textEnabled: settings.textEnabled,
      };
      return { ok: true as const, shell, settings, grant };
    });

  // Related-thread links (owned by the related-work feature) are the one
  // record of how two threads relate.
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

  const sameGrant = (left: ExportGrant, right: ExportGrant) =>
    left.threadId === right.threadId &&
    left.ownerMemberId === right.ownerMemberId &&
    left.version === right.version;

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

  /** One analyst run over a pair; records its outcome and never throws on bad output. */
  const analyzePair = (firstId: ThreadId, secondId: ThreadId, trigger: CooperationTrigger) =>
    Effect.gen(function* () {
      const first = yield* currentGrant(firstId);
      const second = yield* currentGrant(secondId);
      if (!first.ok || !second.ok) return false;
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
      yield* publish({ threadIds: [firstId, secondId], memberIds: [] });

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

      yield* consentLock.withPermit(
        Effect.gen(function* () {
          // Consent is re-read at completion: a change during the run voids it.
          const firstNow = yield* currentGrant(firstId);
          const secondNow = yield* currentGrant(secondId);
          if (
            !firstNow.ok ||
            !secondNow.ok ||
            !sameGrant(firstNow.grant, first.grant) ||
            !sameGrant(secondNow.grant, second.grant)
          ) {
            return yield* finishRun(runId, "rejected", "consent changed during analysis");
          }
          const validation = validateAnalystOutput({
            output: output.success,
            threads: {
              A: { threadId: firstId, events: exported.A },
              B: { threadId: secondId, events: exported.B },
            },
          });
          if (!validation.ok) return yield* finishRun(runId, "rejected", validation.reason);
          const cited = [
            ...validation.summaries.flatMap((summary) => summary.citations),
            ...validation.notes.flatMap((note) => note.citations),
          ];
          if (!(yield* citationsExist(cited))) {
            return yield* finishRun(runId, "rejected", "a cited event no longer exists");
          }

          const appliedAt = yield* now;
          for (const summary of validation.summaries) {
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
          }
          const discarded = [...validation.discarded];
          const recipients: MemberId[] = [];
          for (const note of validation.notes) {
            const target = note.targetThreadId === firstId ? firstNow : secondNow;
            if (!target.settings.awarenessNotify) {
              discarded.push(`${note.kind} not delivered: recipient notifications are off`);
              continue;
            }
            const recipient = target.grant.ownerMemberId;
            yield* sql`
              INSERT INTO cooperation_awareness_items (
                item_id, run_id, kind, source_thread_id, target_thread_id, recipient_member_id,
                text, citations_json, state, created_at, resolved_at, resolved_by
              )
              VALUES (
                ${yield* newId("item")}, ${runId}, ${note.kind}, ${note.sourceThreadId},
                ${note.targetThreadId}, ${recipient}, ${note.text},
                ${encodeCitations(note.citations)}, 'pending', ${appliedAt}, NULL, NULL
              )
            `.pipe(internal("item write"));
            recipients.push(recipient);
          }
          yield* finishRun(runId, "applied", discarded.length > 0 ? discarded.join("; ") : null);
          yield* publish({ threadIds: [firstId, secondId], memberIds: recipients });
        }),
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
      if (!self.ok) return 0;
      const partners = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM cooperation_thread_settings
        WHERE analysis_enabled = 1
          AND feature_topic = ${self.grant.featureTopic}
          AND thread_id != ${threadId}
        ORDER BY updated_at DESC
        LIMIT ${MAX_PARTNERS}
      `.pipe(internal("partner lookup"));
      let runs = 0;
      for (const partner of partners) {
        if (yield* analyzePair(threadId, ThreadId.make(partner.threadId), trigger)) runs += 1;
      }
      return runs;
    });

  const requestAnalysis: CooperationService["Service"]["requestAnalysis"] = (memberId, threadId) =>
    Effect.gen(function* () {
      const shell = yield* requireVisibleShell(memberId, threadId);
      if (!isOwner(memberId, shell)) {
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

  const getInbox: CooperationService["Service"]["getInbox"] = (memberId) =>
    sql<ItemRow>`
      SELECT ${itemColumns}
      FROM cooperation_awareness_items
      WHERE recipient_member_id = ${memberId} AND state = 'pending'
      ORDER BY created_at DESC
      LIMIT ${INBOX_LIMIT}
    `.pipe(
      internal("inbox read"),
      Effect.flatMap((rows) => Effect.forEach(rows, toItem)),
      Effect.map((items) => ({ items })),
    );

  const streamInbox: CooperationService["Service"]["streamInbox"] = (memberId) =>
    Stream.concat(
      Stream.make(undefined),
      changes.pipe(Stream.filter((change) => change.memberIds.includes(memberId))),
    ).pipe(Stream.mapEffect(() => getInbox(memberId)));

  const resolveItem: CooperationService["Service"]["resolveItem"] = (memberId, input) =>
    consentLock.withPermit(
      Effect.gen(function* () {
        const rows = yield* sql<ItemRow>`
          SELECT ${itemColumns} FROM cooperation_awareness_items WHERE item_id = ${input.itemId}
        `.pipe(internal("item read"));
        const row = rows[0];
        if (row === undefined || row.recipientMemberId !== memberId) {
          return yield* fail("not-found", "Awareness item not found.");
        }
        const targetThreadId = ThreadId.make(row.targetThreadId);
        const target = yield* readShell(targetThreadId);
        // Ownership is re-checked at decision time; a retained recipient id is not authority.
        if (target === undefined || threadOwnerOf(target) !== memberId) {
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
            .dispatch(
              {
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
              },
              { actor: memberId },
            )
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
          SET state = ${state}, resolved_at = ${resolvedAt}, resolved_by = ${memberId}
          WHERE item_id = ${row.itemId}
        `.pipe(internal("item write"));
        yield* publish({ threadIds: [targetThreadId], memberIds: [memberId] });
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
    latestSummaryForThread,
    changes,
  });
});

export const layer = Layer.effect(CooperationService, make);
