import type { HubConfigKey } from "@t3tools/contracts/hub";

import type { ProjectHub } from "./project/ProjectHub.ts";
import type { SyncSession } from "./sync/SyncSession.ts";

/**
 * Worker bindings. `HUB_CONFIG_KEYS` come from vars/secrets; the rest are
 * declared in wrangler.jsonc.
 */
export type Env = { readonly [Key in HubConfigKey]?: string } & {
  readonly DB: D1Database;
  readonly PROJECT_HUB: DurableObjectNamespace<ProjectHub>;
  readonly SYNC_SESSION: DurableObjectNamespace<SyncSession>;
  /**
   * DEV ONLY. "1" enables sign-in by typing a login, without GitHub, for a LAN
   * hub that has no internet. Refused unless HUB_PUBLIC_URL is plain http.
   */
  readonly HUB_DEV_LOCAL_ACCOUNTS?: string;
};

export interface HubConfig {
  /** Origin without a trailing slash. */
  readonly publicUrl: string;
  readonly secureCookies: boolean;
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly devLocalAccounts: boolean;
}

export const readConfig = (env: Env): HubConfig => {
  const publicUrl = (env.HUB_PUBLIC_URL ?? "http://localhost:8787").trim().replace(/\/+$/, "");
  const secureCookies = publicUrl.startsWith("https://");
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const devFlag = env.HUB_DEV_LOCAL_ACCOUNTS?.trim().toLowerCase();
  return {
    publicUrl,
    secureCookies,
    github: clientId && clientSecret ? { clientId, clientSecret } : null,
    // Never on an https (internet-facing) hub, whatever the flag says.
    devLocalAccounts: (devFlag === "1" || devFlag === "true") && !secureCookies,
  };
};
