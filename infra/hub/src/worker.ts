/**
 * Puff Collab hub Worker entry. Routes the sync WebSocket to the link's
 * `SyncSession`, serves the `/link` page and the dev-only local sign-in, and
 * hands everything else to the Effect `HubApi`.
 */
import {
  GithubLogin,
  HUB_CLOSE_CODES,
  HUB_LINK_PAGE_PATH,
  HUB_SESSION_COOKIE,
  HUB_SYNC_PATH,
  HubApi,
} from "@t3tools/contracts/hub";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { nowMs } from "./clock.ts";
import * as Db from "./db.ts";
import { type Env, readConfig } from "./env.ts";
import {
  HubRuntime,
  browserApi,
  browserSessionAuthLayer,
  environmentApi,
  environmentAuthLayer,
  publicApi,
} from "./http/api.ts";
import { renderLinkPage } from "./http/linkPage.ts";
import { completeSignIn, safeReturnTo } from "./signIn.ts";
import { SYNC_ACCOUNT_HEADER, SYNC_LINK_HEADER } from "./sync/SyncSession.ts";

export { ProjectHub } from "./project/ProjectHub.ts";
export { SyncSession } from "./sync/SyncSession.ts";

const httpPlatformLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("The hub does not serve files"),
  fileWebResponse: () => Effect.die("The hub does not serve files"),
});

type ApiHandler = (request: Request) => Promise<Response>;
let cachedApi: { readonly env: Env; readonly handler: ApiHandler } | null = null;

const apiHandlerFor = (env: Env): ApiHandler => {
  if (cachedApi?.env === env) return cachedApi.handler;
  const runtimeLayer = Layer.succeed(HubRuntime, { env, config: readConfig(env) });
  const appLayer = HttpApiBuilder.layer(HubApi).pipe(
    Layer.provide([publicApi, browserApi, environmentApi]),
    Layer.provide([browserSessionAuthLayer, environmentAuthLayer]),
    Layer.provide([
      runtimeLayer,
      Etag.layerWeak,
      httpPlatformLayer,
      FileSystem.layerNoop({}),
      Path.layer,
    ]),
  );
  const { handler } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
  cachedApi = { env, handler: (request) => handler(request) };
  return cachedApi.handler;
};

const cookieOf = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

/** Accepts the upgrade only to close it with an application code the client can act on. */
const closedSocket = (code: number, reason: string): Response => {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
};

const handleSync = async (request: Request, env: Env): Promise<Response> => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const credential = /^Bearer\s+(.+)$/i
    .exec(request.headers.get("Authorization") ?? "")?.[1]
    ?.trim();
  if (!credential) return closedSocket(HUB_CLOSE_CODES.unauthorized, "Missing credential");
  const lookup = await Db.lookupCredential(env.DB, credential);
  if (lookup.status === "unknown")
    return closedSocket(HUB_CLOSE_CODES.unauthorized, "Unknown credential");
  if (lookup.status === "revoked") {
    return closedSocket(HUB_CLOSE_CODES.linkRevoked, "This environment link was revoked");
  }
  const session = env.SYNC_SESSION.get(env.SYNC_SESSION.idFromName(lookup.link.linkId));
  return session.fetch(
    new Request(request.url, {
      headers: {
        Upgrade: "websocket",
        [SYNC_LINK_HEADER]: lookup.link.linkId,
        [SYNC_ACCOUNT_HEADER]: lookup.link.accountId,
      },
    }),
  );
};

const handleLinkPage = async (request: Request, env: Env): Promise<Response> => {
  const config = readConfig(env);
  const token = cookieOf(request, HUB_SESSION_COOKIE);
  const session = token ? await Db.sessionAccount(env.DB, token, nowMs()) : null;
  const account = session ? await Db.getAccount(env.DB, session.accountId) : null;
  return renderLinkPage({
    account,
    code: new URL(request.url).searchParams.get("code"),
    githubEnabled: config.github !== null,
    devLocalAccounts: config.devLocalAccounts,
  });
};

const isGithubLogin = Schema.is(GithubLogin);

/** DEV ONLY: sign in by login, without GitHub. 404 unless HUB_DEV_LOCAL_ACCOUNTS is on (http hubs only). */
const handleDevSignIn = async (request: Request, env: Env): Promise<Response> => {
  const config = readConfig(env);
  if (!config.devLocalAccounts || request.method !== "POST")
    return new Response(null, { status: 404 });
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(config.publicUrl).origin) {
    return new Response("Cross-origin request refused", { status: 403 });
  }
  const form = await request.formData();
  const login = String(form.get("login") ?? "").trim();
  if (!isGithubLogin(login)) return new Response("Invalid login", { status: 400 });
  const now = nowMs();
  const account = await Db.upsertLocalAccount(env.DB, login, now);
  const session = await completeSignIn(env, account, now);
  const cookie = [
    `${HUB_SESSION_COOKIE}=${session.token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(Db.SESSION_TTL_MS / 1000)}`,
  ].join("; ");
  return new Response(null, {
    status: 303,
    headers: { Location: safeReturnTo(String(form.get("returnTo") ?? "")), "Set-Cookie": cookie },
  });
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === HUB_SYNC_PATH) return handleSync(request, env);
    if (pathname === "/" && request.method === "GET") {
      return new Response(null, { status: 302, headers: { Location: HUB_LINK_PAGE_PATH } });
    }
    if (pathname === HUB_LINK_PAGE_PATH && request.method === "GET")
      return handleLinkPage(request, env);
    if (pathname === "/v1/auth/dev/sign-in") return handleDevSignIn(request, env);
    return apiHandlerFor(env)(request);
  },
} satisfies ExportedHandler<Env>;
