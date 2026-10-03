// @effect-diagnostics preferSchemaOverJson:off - the OAuth state cookie is this module's own signed JSON.
import { HUB_LINK_PAGE_PATH, type HubAccount } from "@t3tools/contracts/hub";

import { base64Url, hmacBase64Url, randomToken, safeEqual } from "./crypto.ts";
import * as Db from "./db.ts";
import type { Env } from "./env.ts";

/** Short-lived, HMAC-signed cookie carrying the OAuth `state` and where to land. */
export const OAUTH_STATE_COOKIE = "puffcollab_hub_oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const GITHUB_CALLBACK_PATH = "/v1/auth/github/callback";

/** A hub-relative path, or the link page. Rejects `//host` and `/\host` (both leave the hub). */
export const safeReturnTo = (value: string | null | undefined): string => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return HUB_LINK_PAGE_PATH;
  // oxlint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return HUB_LINK_PAGE_PATH;
  return value;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fromBase64Url = (value: string): string => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return decoder.decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
};

export const makeOauthState = async (
  secret: string,
  returnTo: string,
  nowMs: number,
): Promise<{ readonly state: string; readonly cookie: string }> => {
  const state = randomToken();
  const payload = base64Url(
    encoder.encode(JSON.stringify({ s: state, r: returnTo, e: nowMs + OAUTH_STATE_TTL_MS })),
  );
  return { state, cookie: `${payload}.${await hmacBase64Url(secret, payload)}` };
};

/** The `returnTo` of a valid, unexpired state cookie whose state matches; null otherwise. */
export const verifyOauthState = async (
  secret: string,
  cookie: string | undefined,
  state: string,
  nowMs: number,
): Promise<string | null> => {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(signature, await hmacBase64Url(secret, payload))) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(payload)) as { s?: unknown; r?: unknown; e?: unknown };
    if (typeof decoded.s !== "string" || typeof decoded.e !== "number" || decoded.e < nowMs)
      return null;
    if (!safeEqual(decoded.s, state)) return null;
    return safeReturnTo(typeof decoded.r === "string" ? decoded.r : null);
  } catch {
    return null;
  }
};

/**
 * Finishes any sign-in: claims pending invitations addressed to the login,
 * tells the affected projects, and opens a browser session.
 */
export const completeSignIn = async (
  env: Env,
  account: HubAccount,
  nowMs: number,
): Promise<{ readonly token: string; readonly expiresAtMs: number }> => {
  const claimed = await Db.claimInvitations(env.DB, account);
  await Promise.all(
    claimed.map((projectId) =>
      env.PROJECT_HUB.get(env.PROJECT_HUB.idFromName(projectId))
        .invitationsChanged({ projectId })
        .catch(() => undefined),
    ),
  );
  return Db.createSession(env.DB, account.accountId, nowMs);
};
