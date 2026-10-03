// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small CLI that starts wrangler; no Effect runtime needed.
/**
 * Self-hosts the hub on a LAN machine: the same Worker under workerd
 * (`wrangler dev --local`), reachable from other machines, with all D1 and
 * Durable Object state persisted in one directory.
 *
 *   node scripts/lan.ts --public-url http://192.168.1.20:8787 [--port 8787] [--dir ./.hub-data]
 *
 * Secrets (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, optionally
 * HUB_DEV_LOCAL_ACCOUNTS=1) go in `.dev.vars` next to wrangler.jsonc.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const hubRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const wrangler = NodePath.join(hubRoot, "node_modules", ".bin", "wrangler");

const { values } = NodeUtil.parseArgs({
  options: {
    "public-url": { type: "string" },
    port: { type: "string", default: "8787" },
    ip: { type: "string", default: "0.0.0.0" },
    dir: { type: "string", default: NodePath.join(hubRoot, ".hub-data") },
  },
});

const publicUrl = values["public-url"]?.replace(/\/+$/, "");
if (!publicUrl || !/^https?:\/\/[^/]+$/.test(publicUrl)) {
  console.error(
    "Pass --public-url with the address teammates will use, e.g. --public-url http://192.168.1.20:8787",
  );
  process.exit(2);
}
const persistDir = NodePath.resolve(values.dir);
NodeFS.mkdirSync(persistDir, { recursive: true });
if (!NodeFS.existsSync(NodePath.join(hubRoot, ".dev.vars"))) {
  console.warn(
    "No .dev.vars found: GitHub sign-in stays off until GITHUB_CLIENT_ID/SECRET are set there.",
  );
}

const run = (args: ReadonlyArray<string>, interactive = true) =>
  NodeChildProcess.spawnSync(wrangler, args, {
    cwd: hubRoot,
    // Migrations run unattended (no "continue?" prompt); dev keeps the terminal.
    stdio: interactive ? "inherit" : ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  }).status ?? 1;

const migrated = run(
  ["d1", "migrations", "apply", "puffcollab-hub", "--local", "--persist-to", persistDir],
  false,
);
if (migrated !== 0) process.exit(migrated);

console.log(`Hub state: ${persistDir}`);
console.log(`Teammates point Puff Collab at ${publicUrl}`);
process.exit(
  run([
    "dev",
    "--local",
    "--ip",
    values.ip,
    "--port",
    values.port,
    "--persist-to",
    persistDir,
    "--var",
    `HUB_PUBLIC_URL:${publicUrl}`,
    "--show-interactive-dev-session=false",
  ]),
);
