// @effect-diagnostics preferSchemaOverJson:off - outbound frames are typed HubServerMessage values; re-encoding each one through Schema on every fan-out would cost CPU for no extra safety.
import {
  type HubErrorReason,
  type HubProtocolRange,
  type HubRequestId,
  type HubServerMessage,
  HubClientFrame,
} from "@t3tools/contracts/hub";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const encoder = new TextEncoder();

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

/** True when `text` is over `maxBytes` UTF-8 bytes, without encoding short strings. */
export const exceedsBytes = (text: string, maxBytes: number): boolean =>
  text.length > maxBytes || (text.length * 3 > maxBytes && utf8Bytes(text) > maxBytes);

export const encodeServerMessage = (message: HubServerMessage): string => JSON.stringify(message);

const decodeClientFrame = Schema.decodeUnknownExit(HubClientFrame);

export const parseClientFrame = (raw: string) => {
  const exit = decodeClientFrame(raw);
  return Exit.isSuccess(exit) ? { ok: true as const, message: exit.value } : { ok: false as const };
};

/** Best effort: the `requestId` of a frame that failed to decode, so the reject correlates. */
export const requestIdOf = (raw: string): HubRequestId | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object" && "requestId" in value) {
      const requestId = value.requestId;
      if (typeof requestId === "string" && requestId.trim().length > 0 && requestId.length <= 128) {
        return requestId.trim();
      }
    }
  } catch {
    // Not JSON; nothing to correlate.
  }
  return null;
};

export interface RejectOptions {
  readonly expectedSeq?: number;
  readonly currentVersion?: number | null;
  readonly protocol?: HubProtocolRange;
  readonly retryAfterSeconds?: number;
}

export const reject = (
  requestId: HubRequestId | null,
  reason: HubErrorReason,
  message: string,
  options: RejectOptions = {},
): Extract<HubServerMessage, { type: "reject" }> => ({
  type: "reject",
  requestId,
  reason,
  message,
  ...options,
});

export const ack = (
  requestId: HubRequestId,
  cursor?: { threadId: string; generation: number; seq: number },
): Extract<HubServerMessage, { type: "ack" }> =>
  cursor
    ? {
        type: "ack",
        requestId,
        cursor: cursor as Extract<HubServerMessage, { type: "ack" }>["cursor"] & {},
      }
    : { type: "ack", requestId };

export type ReplyMessage = Extract<HubServerMessage, { type: "ack" | "reject" }>;
