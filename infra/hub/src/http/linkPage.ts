/**
 * The `/link` page: a signed-in user enters or confirms the code their local
 * Puff Collab shows, then approves or denies the link. Plain HTML and a few
 * lines of script; no framework.
 */
import { HUB_LINK_PAGE_PATH, type HubAccount } from "@t3tools/contracts/hub";

import { randomToken } from "../crypto.ts";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #5c5c5c; --line: #d4d4d4; --accent: #1f6feb; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #ededed; --muted: #a3a3a3; --line: #3a3a3a; --accent: #58a6ff; --danger: #ff7b72; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 28rem; margin: 0 auto; padding: 3rem 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); }
label { display: block; font-weight: 600; margin-bottom: .25rem; }
input { width: 100%; font: inherit; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; letter-spacing: .08em; text-transform: uppercase; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: .5rem; margin-top: 1rem; flex-wrap: wrap; }
button, .button { font: inherit; padding: .5rem 1rem; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--danger); }
#status { min-height: 1.5rem; margin-top: 1rem; }
[hidden] { display: none !important; }
`;

const page = (nonce: string, body: string, script = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Puff Collab</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body>
</html>`;

const SCRIPT = `
const form = document.getElementById("lookup");
const code = document.getElementById("code");
const confirmBox = document.getElementById("confirm");
const label = document.getElementById("label");
const status = document.getElementById("status");
let current = null;
const say = (text) => { status.textContent = text; };
const normalize = (value) => {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? compact.slice(0, 4) + "-" + compact.slice(4) : null;
};
async function lookup() {
  const userCode = normalize(code.value);
  confirmBox.hidden = true;
  if (!userCode) { say("Enter the 8-character code shown in Puff Collab."); return; }
  say("Looking up the code…");
  const response = await fetch("/v1/link/requests/" + encodeURIComponent(userCode), { credentials: "same-origin" });
  if (!response.ok) { say("That code is unknown or expired. Start linking again in Puff Collab."); return; }
  const info = await response.json();
  current = info.userCode;
  label.textContent = info.environmentLabel;
  confirmBox.hidden = false;
  say("");
  document.getElementById("approve").focus();
}
async function decide(decision) {
  if (!current) return;
  say(decision === "approve" ? "Linking…" : "Denying…");
  const response = await fetch("/v1/link/decision", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCode: current, decision }),
  });
  confirmBox.hidden = true;
  current = null;
  if (!response.ok) { say("That code is unknown, expired, or already used."); return; }
  say(decision === "approve"
    ? "Linked. You can close this tab and return to Puff Collab."
    : "Denied. Nothing was linked.");
}
form.addEventListener("submit", (event) => { event.preventDefault(); lookup(); });
document.getElementById("approve").addEventListener("click", () => decide("approve"));
document.getElementById("deny").addEventListener("click", () => decide("deny"));
if (code.value) lookup();
`;

export interface LinkPageInput {
  readonly account: HubAccount | null;
  readonly code: string | null;
  readonly githubEnabled: boolean;
  readonly devLocalAccounts: boolean;
}

export const renderLinkPage = (input: LinkPageInput): Response => {
  const nonce = randomToken(16);
  const code = input.code ? escapeHtml(input.code) : "";
  const returnTo = `${HUB_LINK_PAGE_PATH}${input.code ? `?code=${encodeURIComponent(input.code)}` : ""}`;
  let html: string;
  if (!input.account) {
    const github = input.githubEnabled
      ? `<p><a class="button primary" href="/v1/auth/github/start?returnTo=${encodeURIComponent(returnTo)}">Sign in with GitHub</a></p>`
      : `<p class="muted">GitHub sign-in is not configured on this hub.</p>`;
    const dev = input.devLocalAccounts
      ? `<form method="post" action="/v1/auth/dev/sign-in">
  <p><strong>Development only:</strong> local accounts are enabled on this hub. Anyone who can reach it can sign in as any login.</p>
  <label for="login">Login</label>
  <input id="login" name="login" autocomplete="username" required pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}">
  <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
  <div class="row"><button type="submit">Sign in locally</button></div>
</form>`
      : "";
    html = page(
      nonce,
      `<h1>Link Puff Collab to this hub</h1>
<p>Sign in to confirm the code your Puff Collab shows.</p>
${github}${dev}`,
    );
  } else {
    html = page(
      nonce,
      `<h1>Link Puff Collab to this hub</h1>
<p class="muted">Signed in as ${escapeHtml(input.account.displayName)} (@${escapeHtml(input.account.githubLogin)}).</p>
<form id="lookup" novalidate>
  <label for="code">Code shown in Puff Collab</label>
  <input id="code" name="code" value="${code}" autocomplete="one-time-code" inputmode="text" maxlength="9" aria-describedby="code-help" required>
  <p id="code-help" class="muted">Looks like WDJB-MJHT.</p>
  <div class="row"><button type="submit">Continue</button></div>
</form>
<section id="confirm" hidden aria-labelledby="confirm-title">
  <h2 id="confirm-title">Link <span id="label"></span>?</h2>
  <p>It will sync your shared threads to your projects on this hub and receive your teammates' shared threads. Only approve a code you started yourself.</p>
  <div class="row">
    <button id="approve" type="button" class="primary">Approve</button>
    <button id="deny" type="button" class="danger">Deny</button>
  </div>
</section>
<p id="status" role="status" aria-live="polite"></p>`,
      SCRIPT,
    );
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
