/** WebCrypto helpers shared by the Worker and the Durable Objects. */

const encoder = new TextEncoder();

export const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const randomToken = (byteLength = 32): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

export const randomId = (prefix: string): string => `${prefix}_${randomToken(16)}`;

/** Ids that must match `[A-Za-z0-9_-]` with no prefix separator issues (link ids). */
export const randomLinkId = (): string => randomToken(16);

export const sha256Base64Url = async (value: string): Promise<string> =>
  base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));

/** Constant-time string comparison. */
export const safeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.byteLength ^ b.byteLength;
  for (let index = 0; index < Math.max(a.byteLength, b.byteLength); index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);

export const hmacBase64Url = async (secret: string, value: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value))),
  );

/** Consonants only, like GitHub's device codes: no vowels, no 0/O or 1/I confusion. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const randomUserCode = (): string => {
  const chars: Array<string> = [];
  while (chars.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // Rejection sampling keeps every letter equally likely (240 = 12 * 20).
      if (byte < 240 && chars.length < 8) chars.push(USER_CODE_ALPHABET[byte % 20]!);
    }
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

/** Accepts `wdjbmjht`, `WDJB MJHT`, `wdjb-mjht`; returns `WDJB-MJHT` or null. */
export const normalizeUserCode = (input: string): string | null => {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
};
