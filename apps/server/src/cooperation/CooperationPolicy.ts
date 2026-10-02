/**
 * Pure rules for cooperation analysis: secret redaction, which orchestration
 * events may leave a thread and in what form, and what analyst output the
 * server accepts. Kept free of services so the rules are tested directly.
 *
 * @module CooperationPolicy
 */
import {
  COOPERATION_NOTE_MAX_CHARS,
  COOPERATION_SUMMARY_MAX_CHARS,
  type CooperationCitation,
  type MemberId,
  type OrchestrationEvent,
  type RelatedThreadRelationship,
  type ThreadId,
} from "@t3tools/contracts";

import { sanitizeAcpStderrExcerpt } from "../provider/acp/AcpStderr.ts";
import type {
  CooperationAnalystEvent,
  CooperationAnalystOutput,
  CooperationAnalystThreadRef,
} from "../textGeneration/CooperationAnalysisPrompt.ts";

/** How an analyzed pair relates, as the analyst is told. */
export type CooperationPairRelationship = RelatedThreadRelationship | "unspecified";

/**
 * The pair's relationship from its owners' related-thread links, in either
 * direction. Links that disagree, or no link at all, leave it unspecified.
 */
export function pairRelationship(
  links: ReadonlyArray<RelatedThreadRelationship>,
): CooperationPairRelationship {
  const [first] = links;
  return first !== undefined && links.every((link) => link === first) ? first : "unspecified";
}

/** Most recent eligible events exported per thread. */
export const EXPORT_MAX_EVENTS_PER_THREAD = 40;
/** Raw rows scanned per thread to find them; older history is never read. */
export const EXPORT_MAX_SCANNED_EVENTS = 600;
/** Exported text per event and per thread, after redaction. */
export const EXPORT_MAX_TEXT_CHARS = 1_500;
export const EXPORT_MAX_THREAD_CHARS = 24_000;

/** Event types that carry thread work; everything else never leaves the thread. */
export const EXPORTABLE_EVENT_TYPES = [
  "thread.message-sent",
  "thread.activity-appended",
  "thread.turn-diff-completed",
] as const satisfies ReadonlyArray<OrchestrationEvent["type"]>;

const EXTRA_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(api[_-]?key|password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|authorization)(\s*[=:]\s*)\S+/gi,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,
];

/**
 * Masks credentials and the home directory. Builds on the ACP stderr
 * sanitizer and adds key formats that show up in agent transcripts.
 */
export function redactSecrets(text: string): string {
  let result = sanitizeAcpStderrExcerpt(text);
  for (const pattern of EXTRA_SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, ...groups: Array<unknown>) => {
      const [first, second] = groups;
      if (typeof first === "string" && typeof second === "string") {
        return `${first}${second}[redacted]`;
      }
      if (typeof first === "string" && first.startsWith("http")) return `${first}[redacted]@`;
      return "[redacted]";
    });
  }
  // Strip control characters other than tab and newlines.
  // eslint-disable-next-line no-control-regex
  return result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

const SECRET_LIKE =
  /(bearer\s+\S+|sk-[a-z0-9_-]{8,}|\[redacted\]|(?:api[_-]?key|password|secret|access[_-]?token)\s*[=:])/i;
const DIRECTIVE_WORDS =
  /\b(stop|abandon|switch|must|should|please|instead|implement|replace|ignore|disregard|override|execute|delete)\b/i;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Bounded, redacted text, or undefined when nothing safe remains. */
export function exportText(value: string): string | undefined {
  const redacted = redactSecrets(value).trim();
  return redacted.length === 0 ? undefined : clamp(redacted, EXPORT_MAX_TEXT_CHARS);
}

/** Owner consent captured for one thread at export time. */
export interface ExportGrant {
  readonly threadId: ThreadId;
  readonly ownerMemberId: MemberId;
  readonly version: number;
  readonly featureTopic: string;
  readonly textEnabled: boolean;
}

export interface ExportedEvent {
  readonly citation: CooperationCitation;
  readonly kind: string;
  readonly occurredAt: string;
  readonly content: Readonly<Record<string, unknown>>;
}

/**
 * The exported form of one event, or null when it is not eligible. Without
 * text permission only metadata leaves the thread. With it, user messages
 * export their text only when the owner wrote them; messages other members
 * sent stay metadata, since their authors never consented.
 */
export function projectExportEvent(
  event: OrchestrationEvent,
  grant: ExportGrant,
): ExportedEvent | null {
  const citation = { threadId: grant.threadId, eventId: event.eventId, sequence: event.sequence };
  const base = { citation, occurredAt: event.occurredAt };
  switch (event.type) {
    case "thread.message-sent": {
      const { role, streaming, text } = event.payload;
      if (streaming || (role !== "user" && role !== "assistant")) return null;
      const author = event.metadata.actor ?? (role === "user" ? grant.ownerMemberId : undefined);
      const textAllowed =
        grant.textEnabled && (role === "assistant" || author === grant.ownerMemberId);
      const safe = textAllowed ? exportText(text) : undefined;
      return {
        ...base,
        kind: "message",
        content: safe !== undefined ? { role, text: safe } : { role, characters: text.length },
      };
    }
    case "thread.activity-appended": {
      const { activity } = event.payload;
      const summary = grant.textEnabled ? exportText(activity.summary) : undefined;
      return {
        ...base,
        kind: "activity",
        content: {
          activity: clamp(activity.kind, 80),
          tone: activity.tone,
          ...(summary !== undefined ? { summary: clamp(summary, 300) } : {}),
        },
      };
    }
    case "thread.turn-diff-completed":
      return {
        ...base,
        kind: "checkpoint",
        content: { status: event.payload.status, filesChanged: event.payload.files.length },
      };
    default:
      return null;
  }
}

/**
 * Keeps the newest eligible events (input newest first) within the per-thread
 * count and size caps, returned oldest first.
 */
export function boundExport(
  newestFirst: ReadonlyArray<OrchestrationEvent>,
  grant: ExportGrant,
): ReadonlyArray<ExportedEvent> {
  const kept: ExportedEvent[] = [];
  let size = 0;
  for (const event of newestFirst) {
    if (kept.length >= EXPORT_MAX_EVENTS_PER_THREAD) break;
    if (event.aggregateKind !== "thread" || event.aggregateId !== grant.threadId) continue;
    const exported = projectExportEvent(event, grant);
    if (exported === null) continue;
    const cost = JSON.stringify(exported.content).length;
    if (size + cost > EXPORT_MAX_THREAD_CHARS) break;
    size += cost;
    kept.push(exported);
  }
  return kept.toReversed();
}

/** Analyst-facing events with short refs (A1, A2, ...) instead of event ids. */
export function toAnalystEvents(
  ref: CooperationAnalystThreadRef,
  events: ReadonlyArray<ExportedEvent>,
): ReadonlyArray<CooperationAnalystEvent> {
  return events.map((event, index) => ({
    ref: `${ref}${index + 1}`,
    kind: event.kind,
    occurredAt: event.occurredAt,
    content: event.content,
  }));
}

/** An informational note: bounded, free of secrets, and never a command. */
export function isInformationalNote(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COOPERATION_NOTE_MAX_CHARS &&
    !DIRECTIVE_WORDS.test(trimmed) &&
    !SECRET_LIKE.test(trimmed)
  );
}

function isSafeProposal(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 && trimmed.length <= COOPERATION_NOTE_MAX_CHARS && !SECRET_LIKE.test(trimmed)
  );
}

export interface ValidatedSummary {
  readonly threadId: ThreadId;
  readonly summary: string;
  readonly citations: ReadonlyArray<CooperationCitation>;
}

export interface ValidatedNote {
  readonly kind: "note" | "proposal";
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly text: string;
  readonly citations: ReadonlyArray<CooperationCitation>;
}

export type AnalystValidation =
  | {
      readonly ok: true;
      readonly summaries: ReadonlyArray<ValidatedSummary>;
      readonly notes: ReadonlyArray<ValidatedNote>;
      /** Notes dropped for being directive, unsafe, or uncited. */
      readonly discarded: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Maps analyst refs back to exact provenance. Any citation that is not an
 * exported event rejects the whole run: a model inventing evidence is not
 * trusted for the rest of its answer either. Unsafe notes are dropped alone.
 */
export function validateAnalystOutput(input: {
  readonly output: CooperationAnalystOutput;
  readonly threads: Readonly<
    Record<
      CooperationAnalystThreadRef,
      { readonly threadId: ThreadId; readonly events: ReadonlyArray<ExportedEvent> }
    >
  >;
}): AnalystValidation {
  const refs = new Map<
    string,
    { thread: CooperationAnalystThreadRef; citation: CooperationCitation }
  >();
  for (const thread of ["A", "B"] as const) {
    input.threads[thread].events.forEach((event, index) => {
      refs.set(`${thread}${index + 1}`, { thread, citation: event.citation });
    });
  }
  const resolve = (evidence: ReadonlyArray<string>) => {
    const citations: Array<{ thread: CooperationAnalystThreadRef; citation: CooperationCitation }> =
      [];
    for (const ref of new Set(evidence)) {
      const found = refs.get(ref.trim());
      if (found === undefined) return null;
      citations.push(found);
    }
    return citations;
  };

  const summaries: ValidatedSummary[] = [];
  for (const thread of ["A", "B"] as const) {
    const entries = input.output.summaries.filter((entry) => entry.thread === thread);
    if (entries.length !== 1) return { ok: false, reason: `expected one summary for ${thread}` };
    const entry = entries[0]!;
    const cited = resolve(entry.evidence);
    if (cited === null)
      return { ok: false, reason: "summary cites an event that was not exported" };
    if (cited.some((item) => item.thread !== thread)) {
      return { ok: false, reason: "summary cites another thread" };
    }
    const summary = redactSecrets(entry.summary).trim();
    if (summary.length === 0) return { ok: false, reason: `empty summary for ${thread}` };
    summaries.push({
      threadId: input.threads[thread].threadId,
      summary: clamp(summary, COOPERATION_SUMMARY_MAX_CHARS),
      citations: cited.map((item) => item.citation),
    });
  }

  const notes: ValidatedNote[] = [];
  const discarded: string[] = [];
  for (const note of input.output.notes) {
    const source = note.to === "A" ? "B" : "A";
    const cited = resolve(note.evidence);
    if (cited === null) return { ok: false, reason: "note cites an event that was not exported" };
    if (!cited.some((item) => item.thread === source)) {
      discarded.push(`${note.kind} without source evidence`);
      continue;
    }
    const safe = note.kind === "note" ? isInformationalNote(note.text) : isSafeProposal(note.text);
    if (!safe) {
      discarded.push(note.kind === "note" ? "directive or unsafe note" : "unsafe proposal");
      continue;
    }
    notes.push({
      kind: note.kind,
      sourceThreadId: input.threads[source].threadId,
      targetThreadId: input.threads[note.to].threadId,
      text: note.text.trim(),
      citations: cited.map((item) => item.citation),
    });
  }
  return { ok: true, summaries, notes, discarded };
}
