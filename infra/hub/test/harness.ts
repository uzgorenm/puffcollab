// @effect-diagnostics globalFetch:off preferSchemaOverJson:off globalDate:off - test harness driving the real Worker in workerd over HTTP and WebSockets.
/**
 * Runs the bundled hub Worker in workerd through Miniflare, with D1, both
 * Durable Object classes and a fake GitHub. Tests talk to it exactly like a
 * browser or a local Puff Collab server would.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import {
  HUB_PROTOCOL_RANGE,
  HUB_SYNC_PATH,
  type HubServerMessage,
  type HubThreadEvent,
} from "@t3tools/contracts/hub";
import * as Esbuild from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const HUB_ROOT = NodePath.dirname(NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)));
export const HUB_URL = "http://hub.test";
export const WORKER_NAME = "puffcollab-hub";

let bundlePath: Promise<string> | null = null;

/** Bundles src/worker.ts once per test process, as wrangler would. */
const bundle = () =>
  (bundlePath ??= (async () => {
    const outdir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "puffcollab-hub-bundle-"));
    const outfile = NodePath.join(outdir, "worker.mjs");
    await Esbuild.build({
      entryPoints: [NodePath.join(HUB_ROOT, "src/worker.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      conditions: ["workerd", "worker", "browser", "import"],
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
      logLevel: "error",
    });
    return outfile;
  })());

export interface GithubUser {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
}

/** Fake github.com / api.github.com: OAuth code `<login>` signs in that user. */
const fakeGithub = (users: Map<string, GithubUser>) => async (request: Request) => {
  const url = new URL(request.url);
  if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
    const body = (await request.json()) as { code: string; client_secret: string };
    if (body.client_secret !== "test-secret" || !users.has(body.code)) {
      return Response.json({ error: "bad_verification_code" });
    }
    return Response.json({ access_token: `token-${body.code}` });
  }
  if (url.hostname === "api.github.com" && url.pathname === "/user") {
    const login = request.headers.get("Authorization")?.replace("Bearer token-", "") ?? "";
    const user = users.get(login);
    if (!user) return new Response("unauthorized", { status: 401 });
    return Response.json({
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      avatar_url: null,
    });
  }
  return new Response("unexpected outbound fetch", { status: 599 });
};

const migrationStatements = () =>
  NodeFs.readdirSync(NodePath.join(HUB_ROOT, "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) =>
      NodeFs.readFileSync(NodePath.join(HUB_ROOT, "migrations", file), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean),
    );

export interface HubOptions {
  readonly persistDir?: string;
  readonly vars?: Record<string, string>;
  readonly migrate?: boolean;
}

export class TestHub {
  private nextGithubId = 1000;

  private constructor(
    readonly mf: Miniflare,
    readonly users: Map<string, GithubUser>,
  ) {}

  static async start(options: HubOptions = {}): Promise<TestHub> {
    const users = new Map<string, GithubUser>();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: WORKER_NAME,
        modules: [
          {
            type: "ESModule",
            path: "worker.mjs",
            contents: NodeFs.readFileSync(await bundle(), "utf8"),
          },
        ],
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          HUB_PUBLIC_URL: HUB_URL,
          GITHUB_CLIENT_ID: "test-client",
          GITHUB_CLIENT_SECRET: "test-secret",
          ...options.vars,
        },
        d1Databases: { DB: "puffcollab-hub" },
        durableObjects: {
          PROJECT_HUB: { className: "ProjectHub", useSQLite: true },
          SYNC_SESSION: { className: "SyncSession", useSQLite: true },
        },
        outboundService: fakeGithub(users),
        ...(options.persistDir ? { resourcePersistencePath: options.persistDir } : {}),
      } as Parameters<typeof convertV4MiniflareOptions>[0]),
    );
    const hub = new TestHub(mf, users);
    if (options.migrate !== false) {
      const db = await mf.getD1Database("DB");
      await db.batch(migrationStatements().map((statement) => db.prepare(statement)));
    }
    return hub;
  }

  dispose() {
    return this.mf.dispose();
  }

  db() {
    return this.mf.getD1Database("DB");
  }

  fetch(path: string, init: RequestInit = {}) {
    return this.mf.dispatchFetch(
      `${HUB_URL}${path}`,
      init as never,
    ) as unknown as Promise<Response>;
  }

  json(path: string, body: unknown, init: RequestInit = {}) {
    return this.fetch(path, {
      ...init,
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
      body: JSON.stringify(body),
    });
  }

  /** Signs in through the real GitHub OAuth endpoints; returns the session cookie header. */
  async signIn(login: string, returnTo = "/link"): Promise<{ cookie: string; location: string }> {
    if (!this.users.has(login)) this.users.set(login, { id: this.nextGithubId++, login });
    const start = await this.fetch(
      `/v1/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`,
      {
        redirect: "manual",
      },
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const stateCookie = cookiesOf(start).find((cookie) =>
      cookie.startsWith("puffcollab_hub_oauth="),
    );
    const state = authorize.searchParams.get("state") ?? "";
    const callback = await this.fetch(
      `/v1/auth/github/callback?code=${encodeURIComponent(login)}&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: stateCookie?.split(";")[0] ?? "" } },
    );
    if (callback.status !== 302)
      throw new Error(`sign-in failed: ${callback.status} ${await callback.text()}`);
    const session = cookiesOf(callback).find((cookie) =>
      cookie.startsWith("puffcollab_hub_session="),
    );
    return {
      cookie: session?.split(";")[0] ?? "",
      location: callback.headers.get("location") ?? "",
    };
  }

  /** Runs the whole device-code link flow; returns the environment credential. */
  async link(cookie: string, environmentLabel = "Test laptop") {
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
    const started = (await (
      await this.json("/v1/link/requests", {
        environmentLabel,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      })
    ).json()) as { requestId: string; userCode: string };
    const decided = await this.json(
      "/v1/link/decision",
      { userCode: started.userCode, decision: "approve" },
      { headers: { Cookie: cookie } },
    );
    if (decided.status !== 204) throw new Error(`decision failed: ${decided.status}`);
    const token = (await (
      await this.json("/v1/link/token", { requestId: started.requestId, codeVerifier: verifier })
    ).json()) as {
      status: string;
      linkId: string;
      credential: string;
      account: { accountId: string };
    };
    if (token.status !== "linked") throw new Error(`link failed: ${JSON.stringify(token)}`);
    return token;
  }

  async linkProject(credential: string, repositoryKey: string, projectId?: string) {
    const response = await this.json(
      "/v1/projects/link",
      { repositoryKey, title: repositoryKey.split("/").pop(), ...(projectId ? { projectId } : {}) },
      { headers: { Authorization: `Bearer ${credential}` } },
    );
    return { status: response.status, body: (await response.json()) as any };
  }

  async connect(credential: string): Promise<SyncClient> {
    const response = await this.mf.dispatchFetch(`${HUB_URL}${HUB_SYNC_PATH}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` },
    });
    const ws = response.webSocket;
    if (!ws) throw new Error(`no websocket: ${response.status}`);
    return new SyncClient(ws as unknown as WebSocket);
  }

  /** A member with a linked environment and an open, welcomed socket. */
  async member(login: string, subscriptions: ReadonlyArray<unknown> = []) {
    const { cookie } = await this.signIn(login);
    const link = await this.link(cookie, `${login}'s laptop`);
    const client = await this.connect(link.credential);
    const welcome = await client.hello(subscriptions);
    return {
      cookie,
      link,
      client,
      welcome,
      accountId: link.account.accountId,
      linkId: link.linkId,
    };
  }
}

const cookiesOf = (response: Response): Array<string> =>
  (response.headers as unknown as { getSetCookie(): Array<string> }).getSetCookie();

type ServerMessage = HubServerMessage & Record<string, any>;

/** A sync socket that records frames and lets tests await the next matching one. */
export class SyncClient {
  readonly received: Array<ServerMessage> = [];
  closed: { code: number; reason: string } | null = null;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private requestCounter = 0;

  constructor(readonly ws: WebSocket) {
    (ws as unknown as { accept(): void }).accept();
    ws.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data === "string" && data.startsWith("{")) this.received.push(JSON.parse(data));
      else this.received.push({ type: "raw", data } as never);
      this.wake();
    });
    ws.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      this.closed = { code: close.code, reason: close.reason };
      this.wake();
    });
  }

  private wake() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private waitForChange(timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a hub frame")),
        timeoutMs,
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  requestId() {
    this.requestCounter += 1;
    return `r${this.requestCounter}`;
  }

  /** The next unread frame matching `predicate`; frames before it are skipped. */
  async next<T extends ServerMessage = ServerMessage>(
    predicate: (message: ServerMessage) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<T> {
    for (;;) {
      while (this.cursor < this.received.length) {
        const message = this.received[this.cursor++]!;
        if (predicate(message)) return message as T;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      await this.waitForChange(timeoutMs);
    }
  }

  async nextOfType<Type extends ServerMessage["type"]>(
    type: Type,
    extra: (m: ServerMessage) => boolean = () => true,
  ) {
    return this.next((message) => message.type === type && extra(message));
  }

  /** Sends a request and waits for its ack or reject. */
  async request(message: Record<string, unknown>): Promise<ServerMessage> {
    const requestId = (message.requestId as string | undefined) ?? this.requestId();
    this.send({ ...message, requestId });
    return this.next(
      (reply) => (reply.type === "ack" || reply.type === "reject") && reply.requestId === requestId,
    );
  }

  async hello(subscriptions: ReadonlyArray<unknown> = [], protocol = HUB_PROTOCOL_RANGE) {
    this.send({ type: "hello", protocol, subscriptions });
    return this.next((message) => message.type === "welcome");
  }

  async waitClosed(timeoutMs = 10_000) {
    while (!this.closed) await this.waitForChange(timeoutMs);
    return this.closed;
  }

  close() {
    try {
      this.ws.close(1000, "done");
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export const at = (n = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString();

export const summaryEvent = (
  seq: number,
  fields: Partial<{ title: string; status: string; cooperation: Record<string, unknown> }> = {},
): HubThreadEvent =>
  ({
    seq,
    occurredAt: at(seq),
    body: {
      type: "thread.summary-set",
      payload: {
        title: fields.title ?? "Fix login",
        branch: "main",
        status: fields.status ?? "working",
        updatedAt: at(seq),
        ...(fields.cooperation ? { cooperation: fields.cooperation } : {}),
      },
    },
  }) as HubThreadEvent;

export const messageEvent = (
  seq: number,
  localThreadId: string,
  text = `message ${seq}`,
): HubThreadEvent =>
  ({
    seq,
    occurredAt: at(seq),
    body: {
      type: "thread.message-sent",
      payload: {
        threadId: localThreadId,
        messageId: `m${seq}`,
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: at(seq),
        updatedAt: at(seq),
      },
    },
  }) as HubThreadEvent;

export const visibilityEvent = (
  seq: number,
  localThreadId: string,
  visibility: "private" | "shared",
) =>
  ({
    seq,
    occurredAt: at(seq),
    body: {
      type: "thread.visibility-set",
      payload: { threadId: localThreadId, visibility, updatedAt: at(seq) },
    },
  }) as HubThreadEvent;

export const deletedEvent = (seq: number, localThreadId: string) =>
  ({
    seq,
    occurredAt: at(seq),
    body: { type: "thread.deleted", payload: { threadId: localThreadId, deletedAt: at(seq) } },
  }) as HubThreadEvent;
