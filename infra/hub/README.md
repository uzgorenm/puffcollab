# Puff Collab hub

The hub syncs team data between teammates' own Puff Collab servers: accounts and GitHub sign-in,
environment links, projects, membership, invitations, comments, the brief, focus, activity,
analysis results, and a mirror of every **shared** thread. It never runs agents or sees code;
private threads never reach it. The wire protocol is
[`packages/contracts/src/hub.ts`](../../packages/contracts/src/hub.ts), whose header describes the
trust model.

The same Worker runs on Cloudflare (our hosted hub) or self-hosted on a LAN under workerd. It uses
only Workers, D1 and SQLite-backed Durable Objects, all of which run locally.

## Architecture

- **Worker** ([`src/worker.ts`](./src/worker.ts)): the `HubApi` HTTP routes on Effect's
  HttpApiBuilder ([`src/http/api.ts`](./src/http/api.ts)), the `/link` page, and the sync
  WebSocket at `/v1/sync`, which it authenticates and hands to the link's `SyncSession`.
- **D1** ([`migrations/`](./migrations)): accounts, browser sessions, environment links (hashed
  credentials), link requests, projects, memberships, invitations, and an index of which project
  each shared thread belongs to.
- **`ProjectHub` Durable Object, one per project** ([`src/project/ProjectHub.ts`](./src/project/ProjectHub.ts)):
  the ordered thread mirrors (seq, generation, reset), comments, versioned brief, focus,
  activity, analyses and awareness, in its own SQLite. Mutations are serialized, so seq checks
  can't race. It fans changes out to connected members' sync sessions.
- **`SyncSession` Durable Object, one per environment link** ([`src/sync/SyncSession.ts`](./src/sync/SyncSession.ts)):
  holds the link's socket with the hibernation API (raw `ping` → `pong` auto-response), handles
  frames in order, enforces frame limits and rate limits, and routes each message to the right
  `ProjectHub`. A socket belongs to exactly one Durable Object and one socket spans many projects,
  so the socket lives here; keying by link makes "a newer socket replaces the older one" (close 4409) a local decision.

Both objects keep durable state in storage and socket attachments only, so they survive eviction
and hibernation (covered by tests that evict them mid-session and restart the runtime).

## Connecting a local server

1. **Link** (once): `POST /v1/link/requests` with `{ environmentLabel, codeChallenge, codeChallengeMethod: "S256" }`,
   where `codeChallenge = base64url(sha256(codeVerifier))`. Open `verificationUrl` in a browser;
   the user signs in with GitHub and approves the code. Poll `POST /v1/link/token` with
   `{ requestId, codeVerifier }` no faster than `intervalSeconds` until it returns
   `{ status: "linked", linkId, credential, account }`. The credential is returned once; store it.
2. **Projects**: `POST /v1/projects/link` with `Authorization: Bearer <credential>` and
   `{ repositoryKey: hubRepositoryKey(identity), title }`.
3. **Sync**: open a WebSocket to `/v1/sync` (`ws://` for an http hub, `wss://` for https) with
   `Authorization: Bearer <credential>`. Send `hello` first; the hub replies `welcome`, then
   `comment.snapshot`s and `thread.events` after your cursors. Publish your shared threads as
   `<linkId>:<threadId>` (`hubThreadIdOf`), resuming after `welcome.published`. Send `ping` as a
   raw text frame for keepalive. Close codes: 4401 unknown credential, 4403 revoked (don't
   reconnect), 4409 replaced (don't reconnect), 4426 version mismatch, 4400 bad first frame, 4429
   rate-limited.

## Local development

From the repository root run `vp install`, then from `infra/hub`:

```sh
cp .dev.vars.example .dev.vars   # fill in a GitHub OAuth app, or enable dev local accounts
vp run db:migrate:local
vp run dev                      # wrangler dev --local on http://localhost:8787
```

## Tests

Tests run the bundled Worker in workerd through Miniflare (D1, both Durable Objects, a fake
GitHub). `@cloudflare/vitest-pool-workers` needs vitest 4 and this repo uses vitest 5, so the
harness drives Miniflare directly ([`test/harness.ts`](./test/harness.ts)).

```sh
vp test run --config ../../vite.config.ts --dir .
vp run --filter puffcollab-hub typecheck
```

## Deploy to Cloudflare

Run from `infra/hub` with a Cloudflare account that has Workers and D1. Nothing here touches other
Workers or databases in the account.

1. `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. `npx wrangler d1 create puffcollab-hub`, then copy the printed `database_id` into
   `wrangler.jsonc` (replacing the zero placeholder).
3. Use the Worker's URL, `https://puffcollab-hub.<subdomain>.workers.dev`, as
   `HUB_PUBLIC_URL` when deploying. Keep the committed localhost default for local development.
4. Create a GitHub OAuth app with callback URL `<HUB_PUBLIC_URL>/v1/auth/github/callback`.
5. `npx wrangler secret put GITHUB_CLIENT_ID` and `npx wrangler secret put GITHUB_CLIENT_SECRET`.
6. `npx wrangler d1 migrations apply puffcollab-hub --remote`.
7. `npx wrangler deploy --var HUB_PUBLIC_URL:https://puffcollab-hub.<subdomain>.workers.dev`.
   Durable Object classes are created by the `migrations` block in
   `wrangler.jsonc`.
8. Check `curl <HUB_PUBLIC_URL>/v1/health`.

## Rollback and secret rotation

Run `npx wrangler deployments list` to identify the previous working version, then
`npx wrangler rollback <version-id>`. Check `/v1/health` and complete a computer-link
flow afterwards. A Worker rollback does not undo D1 migrations or Durable Object data
changes; confirm that the earlier code can read the current data before rolling back.

The operator enters OAuth secrets directly with `npx wrangler secret put GITHUB_CLIENT_ID`
and `npx wrangler secret put GITHUB_CLIENT_SECRET`; never put them in issue comments,
commands, or committed files. When rotating the GitHub app's client secret, add the new
secret in GitHub, update the Worker secret, verify a new GitHub sign-in, then revoke the
old secret in GitHub. In-flight sign-ins may need to restart because the client secret
also signs OAuth state. `npx wrangler secret list` lists names without revealing values.

## Self-hosting on a LAN

Any machine on the team's network with Node 24 and this repository can host the hub. All state
lives in one directory; back it up to keep the hub's data.

```sh
cd infra/hub
cp .dev.vars.example .dev.vars
node scripts/lan.ts --public-url http://192.168.1.20:8787 --port 8787 --dir ~/puffcollab-hub-data
```

The script applies D1 migrations to that directory and runs the same Worker with
`wrangler dev --local --ip 0.0.0.0`. Teammates point their Puff Collab servers at
`http://<lan-ip>:<port>`. Use a fixed IP or hostname, because links and OAuth depend on it.

- **GitHub sign-in on a LAN** still needs a GitHub OAuth app whose callback is
  `http://<lan-ip>:<port>/v1/auth/github/callback`, and each browser needs internet access to reach
  GitHub during sign-in.
- **No internet at all:** set `HUB_DEV_LOCAL_ACCOUNTS=1` in `.dev.vars`. The `/link` page then
  offers "Sign in locally" by typing a login. **This is for development and trusted networks
  only.** Anyone who can reach the hub can sign in as any login, including logins that have
  pending invitations. The hub ignores the flag when `HUB_PUBLIC_URL` is https.
- The hub speaks plain http on a LAN. Session cookies are `Secure` only on https hubs; put a TLS
  reverse proxy in front if the network isn't trusted.

## Configuration

| Key                      | Where                            | Purpose                                             |
| ------------------------ | -------------------------------- | --------------------------------------------------- |
| `HUB_PUBLIC_URL`         | `vars` / `--var`                 | Public origin (OAuth callback, link URLs)           |
| `GITHUB_CLIENT_ID`       | secret / `.dev.vars`             | GitHub OAuth app                                    |
| `GITHUB_CLIENT_SECRET`   | secret / `.dev.vars`             | GitHub OAuth app; also signs the OAuth state cookie |
| `HUB_DEV_LOCAL_ACCOUNTS` | `.dev.vars` only, off by default | DEV ONLY local sign-in, http hubs only              |
