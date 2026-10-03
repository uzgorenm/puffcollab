/**
 * Secret redaction and the hub's `RedactForHub` step. Pure: the caller passes
 * home directories and workspace roots instead of reading the process, so the
 * same rules run in the server, tests, and any Worker.
 *
 * @module hubRedaction
 */
import {
  HUB_SYNC_DENYLIST,
  HUB_SYNC_LIMITS,
  HUB_TRUNCATION_MARKER,
  type HubRedactionContext,
  type HubRedactionResult,
  type HubThreadEventBody,
  isHubSyncedOrchestrationEventType,
  type RedactForHub,
} from "@t3tools/contracts";

const PAIRING_URL_PATTERN = /https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;
const BASIC_AUTH_PATTERN = /\bAuthorization:\s*Basic\s+\S+/gi;
const API_KEY_HEADER_PATTERN = /\bx-api-key:\s*\S+/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g;

const KEY_FORMAT_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(api[_-]?key|password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|authorization)(\s*[=:]\s*)\S+/gi,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,
];

export interface RedactSecretTextOptions {
  /** Home directories to mask as `~`. */
  readonly homeDirs?: ReadonlyArray<string>;
  /** Workspace roots to rewrite as `.`, applied before home directories. */
  readonly workspaceRoots?: ReadonlyArray<string>;
}

const replaceAllOf = (text: string, values: ReadonlyArray<string>, replacement: string) => {
  let result = text;
  // Longest first, so a worktree under a project root is rewritten as a whole.
  for (const value of [...new Set(values)]
    .filter((entry) => entry.length > 1)
    .sort((left, right) => right.length - left.length)) {
    result = result.split(value).join(replacement);
  }
  return result;
};

/**
 * Masks credentials, pairing links, and well-known key formats; rewrites
 * workspace roots and home directories; strips control characters. Shared by
 * cooperation analysis export and hub sync.
 */
export function redactSecretText(text: string, options: RedactSecretTextOptions = {}): string {
  let result = text.replaceAll("\0", "");
  result = replaceAllOf(result, options.workspaceRoots ?? [], ".");
  result = replaceAllOf(result, options.homeDirs ?? [], "~");
  result = result
    .replace(PAIRING_URL_PATTERN, "[pairing-url]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(BASIC_AUTH_PATTERN, "Authorization: Basic [redacted]")
    .replace(API_KEY_HEADER_PATTERN, "x-api-key: [redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]")
    .trim();
  for (const pattern of KEY_FORMAT_PATTERNS) {
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8ByteLength = (text: string): number => encoder.encode(text).byteLength;

/** Cuts `text` to at most `maxBytes` UTF-8 bytes, marker included. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const keep = Math.max(0, maxBytes - utf8ByteLength(HUB_TRUNCATION_MARKER));
  // A cut inside a multi-byte character decodes as U+FFFD; drop it.
  const head = decoder.decode(bytes.subarray(0, keep)).replace(/�+$/, "");
  return { text: `${head}${HUB_TRUNCATION_MARKER}`, truncated: true };
}

const jsonByteLength = (value: unknown): number => utf8ByteLength(JSON.stringify(value) ?? "");

interface Pass {
  readonly context: HubRedactionContext;
  truncated: boolean;
}

const text = (pass: Pass, value: string, maxBytes: number): string => {
  const cut = truncateUtf8(redactSecretText(value, pass.context), maxBytes);
  if (cut.truncated) pass.truncated = true;
  return cut.text;
};

/** Free-form JSON (tool input/output): deny keys, redact and cap every string. */
const redactJson = (pass: Pass, value: unknown): unknown => {
  if (typeof value === "string") return text(pass, value, HUB_SYNC_LIMITS.activityStringMaxBytes);
  if (Array.isArray(value)) return value.map((entry) => redactJson(pass, entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        HUB_SYNC_DENYLIST.payloadKeys.test(key) ? "[redacted]" : redactJson(pass, entry),
      ]),
    );
  }
  return value;
};

const title = (pass: Pass, value: string): string =>
  redactSecretText(value, pass.context) || "[redacted]";

const META_SYNCED_KEYS: ReadonlySet<string> = new Set([
  "threadId",
  "title",
  "branch",
  "modelSelection",
  "titleState",
  "updatedAt",
]);

const redactBody = (pass: Pass, body: HubThreadEventBody): HubThreadEventBody | null => {
  switch (body.type) {
    case "thread.created":
      return {
        type: body.type,
        payload: { ...body.payload, title: title(pass, body.payload.title), worktreePath: null },
      };
    case "thread.meta-updated": {
      let payload = Object.fromEntries(
        Object.entries(body.payload).filter(([key]) => META_SYNCED_KEYS.has(key)),
      ) as typeof body.payload;
      if (payload.title !== undefined) payload = { ...payload, title: title(pass, payload.title) };
      const changed = Object.keys(payload).some((key) => key !== "threadId" && key !== "updatedAt");
      return changed ? { type: body.type, payload } : null;
    }
    case "thread.message-sent": {
      const { context: _context, attachments, ...rest } = body.payload;
      return {
        type: body.type,
        payload: {
          ...rest,
          text: text(pass, rest.text, HUB_SYNC_LIMITS.messageTextMaxBytes),
          ...(attachments === undefined
            ? {}
            : {
                attachments: attachments.map((attachment) => {
                  if (!("source" in attachment)) return attachment;
                  const { source: _source, ...kept } = attachment;
                  return kept;
                }),
              }),
        },
      };
    }
    case "thread.activity-appended": {
      const activity = body.payload.activity;
      let payload = redactJson(pass, activity.payload);
      if (jsonByteLength(payload) > HUB_SYNC_LIMITS.activityPayloadMaxBytes) {
        pass.truncated = true;
        payload = {
          hubTruncated: true,
          preview: truncateUtf8(
            JSON.stringify(payload),
            Math.floor(HUB_SYNC_LIMITS.activityPayloadMaxBytes / 2),
          ).text,
        };
      }
      return {
        type: body.type,
        payload: {
          ...body.payload,
          activity: {
            ...activity,
            summary: text(pass, activity.summary, HUB_SYNC_LIMITS.activityStringMaxBytes),
            payload,
          },
        },
      };
    }
    case "thread.turn-diff-completed": {
      const files = body.payload.files.slice(0, HUB_SYNC_LIMITS.checkpointFilesMax);
      if (files.length < body.payload.files.length) pass.truncated = true;
      return {
        type: body.type,
        payload: {
          ...body.payload,
          files: files.map((file) => ({
            ...file,
            path: redactSecretText(file.path, pass.context),
          })),
        },
      };
    }
    case "thread.turn-diff":
      return {
        type: body.type,
        payload: {
          ...body.payload,
          diff: text(pass, body.payload.diff, HUB_SYNC_LIMITS.diffMaxBytes),
        },
      };
    case "thread.proposed-plan-upserted": {
      const plan = body.payload.proposedPlan;
      return {
        type: body.type,
        payload: {
          ...body.payload,
          proposedPlan: {
            ...plan,
            planMarkdown: text(pass, plan.planMarkdown, HUB_SYNC_LIMITS.planMarkdownMaxBytes),
          },
        },
      };
    }
    case "thread.session-set": {
      const session = body.payload.session;
      return {
        type: body.type,
        payload: {
          ...body.payload,
          session: {
            ...session,
            lastError:
              session.lastError === null
                ? null
                : text(pass, session.lastError, HUB_SYNC_LIMITS.sessionErrorMaxBytes),
          },
        },
      };
    }
    case "thread.summary-set":
      return {
        type: body.type,
        payload: {
          ...body.payload,
          title: title(pass, body.payload.title),
        },
      };
    case "thread.reverted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.visibility-set":
    case "thread.deleted":
      return body;
  }
};

/** See `RedactForHub` in contracts. */
export const redactForHub: RedactForHub = (body, context): HubRedactionResult | null => {
  if (
    !isHubSyncedOrchestrationEventType(body.type) &&
    body.type !== "thread.turn-diff" &&
    body.type !== "thread.summary-set"
  ) {
    return null;
  }
  const pass: Pass = { context, truncated: false };
  const redacted = redactBody(pass, body);
  if (redacted === null) return null;
  // Room for the event envelope (seq, occurredAt, truncated).
  if (jsonByteLength(redacted) > HUB_SYNC_LIMITS.eventMaxBytes - 256) return null;
  return { body: redacted, truncated: pass.truncated };
};
