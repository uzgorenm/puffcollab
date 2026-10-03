/**
 * `HubApi` (packages/contracts/src/hub.ts) on Effect's HttpApiBuilder. Each
 * handler decodes input, calls the D1 helpers or a Durable Object, and maps
 * failures to the contract's errors. The sync WebSocket and the link page are
 * served outside this API by worker.ts.
 */
import {
  HUB_LINK_PAGE_PATH,
  HUB_PROTOCOL_RANGE,
  HUB_SESSION_COOKIE,
  HubAccountPrincipal,
  HubApi,
  HubBrowserSessionAuth,
  HubEnvironmentAuth,
  HubEnvironmentPrincipal,
  HubForbiddenError,
  HubInvalidError,
  HubNotFoundError,
  HubRateLimitedError,
  HubUnauthorizedError,
  type HubAccountId,
  type HubEnvironmentLinkId,
  type HubLinkUserCode,
  type HubProjectId,
} from "@t3tools/contracts/hub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { isoOf } from "../clock.ts";
import { safeEqual, sha256Base64Url } from "../crypto.ts";
import * as Db from "../db.ts";
import type { Env, HubConfig } from "../env.ts";
import { GITHUB_AUTHORIZE_URL, GithubSignInError, fetchGithubProfile } from "../github.ts";
import {
  GITHUB_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  completeSignIn,
  makeOauthState,
  safeReturnTo,
  verifyOauthState,
} from "../signIn.ts";

/** Bindings and config for the current isolate. */
export class HubRuntime extends Context.Service<
  HubRuntime,
  { readonly env: Env; readonly config: HubConfig }
>()("puffcollab-hub/http/api/HubRuntime") {}

/** D1 / Durable Object calls: failures are defects (500), not contract errors. */
const call = <A>(task: () => Promise<A>) => Effect.promise(task);

const unauthorized = (message: string) =>
  new HubUnauthorizedError({ reason: "unauthorized", message });
const invalid = (message: string) => new HubInvalidError({ reason: "invalid", message });
const notFound = (message: string) => new HubNotFoundError({ reason: "not-found", message });

export const sessionCookieOptions = (config: HubConfig, maxAgeMs: number) =>
  ({
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: `${Math.floor(maxAgeMs / 1000)} seconds`,
  }) as const;

/** Revokes a link: closes its socket (4403) and drops its threads from every project. */
export const revokeEnvironmentLink = async (
  env: Env,
  input: { readonly accountId: string; readonly linkId: string },
  nowMs: number,
): Promise<boolean> => {
  if (!(await Db.revokeLink(env.DB, input, nowMs))) return false;
  await env.SYNC_SESSION.get(env.SYNC_SESSION.idFromName(input.linkId))
    .revoke()
    .catch(() => undefined);
  const projectIds = await Db.projectsWithLinkThreads(env.DB, input.linkId);
  await Promise.all(
    projectIds.map((projectId) =>
      env.PROJECT_HUB.get(env.PROJECT_HUB.idFromName(projectId))
        .linkRevoked({ projectId, linkId: input.linkId as HubEnvironmentLinkId })
        .catch(() => undefined),
    ),
  );
  return true;
};

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export const browserSessionAuthLayer = Layer.effect(
  HubBrowserSessionAuth,
  Effect.gen(function* () {
    const runtime = yield* HubRuntime;
    const publicOrigin = new URL(runtime.config.publicUrl).origin;
    return {
      session: Effect.fn("hub.auth.session")(function* (httpEffect, { credential }) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Cookies ride along on cross-site navigations; refuse cross-origin writes.
        const origin = request.headers.origin;
        if (request.method !== "GET" && origin !== undefined && origin !== publicOrigin) {
          return yield* unauthorized("Cross-origin request refused.");
        }
        const token = Redacted.value(credential).trim();
        if (!token) return yield* unauthorized("Sign in first.");
        const now = yield* Clock.currentTimeMillis;
        const session = yield* call(() => Db.sessionAccount(runtime.env.DB, token, now));
        if (!session) return yield* unauthorized("Your hub session expired. Sign in again.");
        return yield* httpEffect.pipe(
          Effect.provideService(HubAccountPrincipal, { accountId: session.accountId }),
        );
      }),
    };
  }),
);

export const environmentAuthLayer = Layer.effect(
  HubEnvironmentAuth,
  Effect.gen(function* () {
    const runtime = yield* HubRuntime;
    return {
      environmentBearer: Effect.fn("hub.auth.environment")(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential).trim();
        if (!token) return yield* unauthorized("Missing environment credential.");
        const lookup = yield* call(() => Db.lookupCredential(runtime.env.DB, token));
        if (lookup.status !== "valid") {
          return yield* unauthorized(
            lookup.status === "revoked"
              ? "This environment link was revoked."
              : "Unknown credential.",
          );
        }
        return yield* httpEffect.pipe(
          Effect.provideService(HubEnvironmentPrincipal, {
            accountId: lookup.link.accountId,
            linkId: lookup.link.linkId,
          }),
        );
      }),
    };
  }),
);

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const publicApi = HttpApiBuilder.group(
  HubApi,
  "public",
  Effect.fnUntraced(function* (handlers) {
    const runtime = yield* HubRuntime;
    const { env, config } = runtime;
    return handlers
      .handle("health", () => Effect.succeed({ ok: true as const, protocol: HUB_PROTOCOL_RANGE }))
      .handle("githubStart", ({ query }) =>
        Effect.gen(function* () {
          if (!config.github)
            return yield* invalid("GitHub sign-in is not configured on this hub.");
          const now = yield* Clock.currentTimeMillis;
          const github = config.github;
          const { state, cookie } = yield* call(() =>
            makeOauthState(github.clientSecret, safeReturnTo(query.returnTo), now),
          );
          const authorize = new URL(GITHUB_AUTHORIZE_URL);
          authorize.searchParams.set("client_id", github.clientId);
          authorize.searchParams.set("redirect_uri", `${config.publicUrl}${GITHUB_CALLBACK_PATH}`);
          authorize.searchParams.set("scope", "read:user");
          authorize.searchParams.set("state", state);
          authorize.searchParams.set("allow_signup", "true");
          return HttpServerResponse.redirect(authorize.toString(), { status: 302 }).pipe(
            HttpServerResponse.setCookieUnsafe(OAUTH_STATE_COOKIE, cookie, {
              httpOnly: true,
              secure: config.secureCookies,
              sameSite: "lax",
              path: GITHUB_CALLBACK_PATH,
              maxAge: `${OAUTH_STATE_TTL_MS / 1000} seconds`,
            }),
          );
        }),
      )
      .handle("githubCallback", ({ query }) =>
        Effect.gen(function* () {
          if (!config.github)
            return yield* invalid("GitHub sign-in is not configured on this hub.");
          const github = config.github;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const now = yield* Clock.currentTimeMillis;
          const returnTo = yield* call(() =>
            verifyOauthState(
              github.clientSecret,
              request.cookies[OAUTH_STATE_COOKIE],
              query.state,
              now,
            ),
          );
          if (returnTo === null)
            return yield* invalid("Sign-in expired or was not started here. Try again.");
          if (query.error || !query.code) {
            return yield* unauthorized(
              `GitHub sign-in was not completed (${query.error ?? "no code"}).`,
            );
          }
          const code = query.code;
          const profile = yield* Effect.tryPromise({
            try: () =>
              fetchGithubProfile({
                clientId: github.clientId,
                clientSecret: github.clientSecret,
                code,
                redirectUri: `${config.publicUrl}${GITHUB_CALLBACK_PATH}`,
              }),
            catch: (cause) =>
              unauthorized(
                `GitHub sign-in failed: ${cause instanceof GithubSignInError ? cause.message : "network error"}.`,
              ),
          });
          const { account } = yield* call(() => Db.upsertGithubAccount(env.DB, profile, now));
          const session = yield* call(() => completeSignIn(env, account, now));
          return HttpServerResponse.redirect(returnTo, { status: 302 }).pipe(
            HttpServerResponse.setCookieUnsafe(
              HUB_SESSION_COOKIE,
              session.token,
              sessionCookieOptions(config, Db.SESSION_TTL_MS),
            ),
            HttpServerResponse.expireCookieUnsafe(OAUTH_STATE_COOKIE, {
              path: GITHUB_CALLBACK_PATH,
            }),
          );
        }),
      )
      .handle("linkStart", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const now = yield* Clock.currentTimeMillis;
          const ip = request.headers["cf-connecting-ip"] ?? "local";
          const limited = yield* call(() =>
            Db.hitRateLimit(
              env.DB,
              { bucket: `link-start:${ip}`, windowMs: 10 * 60 * 1000, max: 20 },
              now,
            ),
          );
          if (!limited.ok) {
            return yield* new HubRateLimitedError({
              reason: "rate-limited",
              message: "Too many link requests. Try again later.",
              retryAfterSeconds: limited.retryAfterSeconds,
            });
          }
          const created = yield* call(() =>
            Db.createLinkRequest(
              env.DB,
              { environmentLabel: payload.environmentLabel, codeChallenge: payload.codeChallenge },
              now,
            ),
          );
          return {
            requestId: created.requestId,
            userCode: created.userCode as HubLinkUserCode,
            verificationUrl: `${config.publicUrl}${HUB_LINK_PAGE_PATH}?code=${created.userCode}`,
            expiresAt: isoOf(created.expiresAtMs),
            intervalSeconds: Db.LINK_POLL_INTERVAL_SECONDS,
          };
        }),
      )
      .handle("linkToken", ({ payload }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const request = yield* call(() => Db.findLinkRequestById(env.DB, payload.requestId));
          if (!request) return yield* notFound("No such link request.");
          const challenge = yield* call(() => sha256Base64Url(payload.codeVerifier));
          if (!safeEqual(challenge, request.code_challenge)) {
            return yield* invalid("The code verifier does not match.");
          }
          const intervalMs = Db.LINK_POLL_INTERVAL_SECONDS * 1000;
          if (request.last_polled_at_ms !== null && now - request.last_polled_at_ms < intervalMs) {
            return yield* new HubRateLimitedError({
              reason: "rate-limited",
              message: "Polling too fast.",
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((request.last_polled_at_ms + intervalMs - now) / 1000),
              ),
            });
          }
          yield* call(() => Db.touchLinkRequestPoll(env.DB, request.request_id, now));
          if (request.expires_at_ms <= now) return { status: "expired" as const };
          if (request.status === "pending") return { status: "pending" as const };
          if (request.status === "denied") return { status: "denied" as const };
          const accountId = request.account_id;
          if (
            !accountId ||
            !(yield* call(() => Db.consumeApprovedLinkRequest(env.DB, request.request_id)))
          ) {
            return yield* notFound("No such link request.");
          }
          const account = yield* call(() => Db.getAccount(env.DB, accountId));
          if (!account) return yield* notFound("No such link request.");
          const { link, credential } = yield* call(() =>
            Db.createEnvironmentLink(
              env.DB,
              { accountId, environmentLabel: request.environment_label },
              now,
            ),
          );
          return { status: "linked" as const, linkId: link.linkId, credential, account };
        }),
      );
  }),
);

export const browserApi = HttpApiBuilder.group(
  HubApi,
  "browser",
  Effect.fnUntraced(function* (handlers) {
    const { env } = yield* HubRuntime;
    return handlers
      .handle("session", () =>
        Effect.gen(function* () {
          const { accountId } = yield* HubAccountPrincipal;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const now = yield* Clock.currentTimeMillis;
          const token = request.cookies[HUB_SESSION_COOKIE] ?? "";
          const [account, session] = yield* call(() =>
            Promise.all([Db.getAccount(env.DB, accountId), Db.sessionAccount(env.DB, token, now)]),
          );
          if (!account || !session) return yield* unauthorized("Sign in first.");
          return { account, expiresAt: isoOf(session.expiresAtMs) };
        }),
      )
      .handle("signOut", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const token = request.cookies[HUB_SESSION_COOKIE];
          if (token) yield* call(() => Db.deleteSession(env.DB, token));
          return HttpServerResponse.empty({ status: 204 }).pipe(
            HttpServerResponse.expireCookieUnsafe(HUB_SESSION_COOKIE, { path: "/" }),
          );
        }),
      )
      .handle("linkDescribe", ({ params }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const request = yield* call(() => Db.findLinkRequestByCode(env.DB, params.userCode));
          if (!request || request.status !== "pending" || request.expires_at_ms <= now) {
            return yield* notFound("That code is unknown or expired. Start linking again.");
          }
          return {
            userCode: request.user_code as HubLinkUserCode,
            environmentLabel: request.environment_label,
            expiresAt: isoOf(request.expires_at_ms),
          };
        }),
      )
      .handle("linkDecide", ({ payload }) =>
        Effect.gen(function* () {
          const { accountId } = yield* HubAccountPrincipal;
          const now = yield* Clock.currentTimeMillis;
          const decided = yield* call(() =>
            Db.decideLinkRequest(
              env.DB,
              { userCode: payload.userCode, accountId, approve: payload.decision === "approve" },
              now,
            ),
          );
          if (!decided) return yield* notFound("That code is unknown, expired, or already used.");
        }),
      )
      .handle("listLinks", () =>
        Effect.gen(function* () {
          const { accountId } = yield* HubAccountPrincipal;
          return { links: yield* call(() => Db.listLinks(env.DB, accountId)) };
        }),
      )
      .handle("revokeLink", ({ params }) =>
        Effect.gen(function* () {
          const { accountId } = yield* HubAccountPrincipal;
          const now = yield* Clock.currentTimeMillis;
          const revoked = yield* call(() =>
            revokeEnvironmentLink(env, { accountId, linkId: params.linkId }, now),
          );
          if (!revoked) return yield* notFound("No such link.");
        }),
      );
  }),
);

export const environmentApi = HttpApiBuilder.group(
  HubApi,
  "environment",
  Effect.fnUntraced(function* (handlers) {
    const { env } = yield* HubRuntime;
    return handlers
      .handle("environmentInfo", () =>
        Effect.gen(function* () {
          const principal = yield* HubEnvironmentPrincipal;
          const [link, account] = yield* call(() =>
            Promise.all([
              Db.getLink(env.DB, principal.linkId),
              Db.getAccount(env.DB, principal.accountId),
            ]),
          );
          if (!link || link.revoked || !account) return yield* unauthorized("Unknown credential.");
          return { link: link.link, account, protocol: HUB_PROTOCOL_RANGE };
        }),
      )
      .handle("unlink", () =>
        Effect.gen(function* () {
          const principal = yield* HubEnvironmentPrincipal;
          const now = yield* Clock.currentTimeMillis;
          yield* call(() =>
            revokeEnvironmentLink(
              env,
              { accountId: principal.accountId, linkId: principal.linkId },
              now,
            ),
          );
        }),
      )
      .handle("linkProject", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* HubEnvironmentPrincipal;
          const now = yield* Clock.currentTimeMillis;
          const mine = yield* call(() =>
            Db.projectsByKeyForAccount(env.DB, principal.accountId, payload.repositoryKey),
          );
          if (payload.projectId !== undefined) {
            const requested = payload.projectId;
            const project = yield* call(() => Db.getProject(env.DB, requested));
            if (!project) return yield* notFound("No such project.");
            if (!(yield* call(() => Db.isMember(env.DB, requested, principal.accountId)))) {
              return yield* new HubForbiddenError({
                reason: "forbidden",
                message: "Join the project first (accept its invitation).",
              });
            }
            return {
              project,
              created: false,
              alternatives: mine.filter((entry) => entry.projectId !== project.projectId),
            };
          }
          const [existing, ...alternatives] = mine;
          if (existing) return { project: existing, created: false, alternatives };
          const project = yield* call(() =>
            Db.createProject(
              env.DB,
              {
                accountId: principal.accountId,
                repositoryKey: payload.repositoryKey,
                title: payload.title,
              },
              now,
            ),
          );
          // The creator's live sessions learn about the project right away.
          yield* call(() =>
            env.PROJECT_HUB.get(env.PROJECT_HUB.idFromName(project.projectId)).accountJoined({
              projectId: project.projectId as HubProjectId,
              accountId: principal.accountId as HubAccountId,
            }),
          );
          return { project, created: true, alternatives: [] };
        }),
      );
  }),
);
