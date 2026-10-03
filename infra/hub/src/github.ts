// @effect-diagnostics globalFetch:off - the GitHub OAuth boundary; the Worker's fetch is the HTTP client.
import type { GithubProfile } from "./db.ts";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

export class GithubSignInError extends Error {}

/** Exchanges an OAuth code for the signed-in user's profile. */
export const fetchGithubProfile = async (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<GithubProfile> => {
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  const token = (await tokenResponse.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  if (!tokenResponse.ok || typeof token?.access_token !== "string") {
    throw new GithubSignInError(
      typeof token?.error === "string"
        ? token.error
        : `token exchange failed (${tokenResponse.status})`,
    );
  }
  const userResponse = await fetch(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "puffcollab-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const user = (await userResponse.json().catch(() => null)) as {
    id?: unknown;
    login?: unknown;
    name?: unknown;
    avatar_url?: unknown;
  } | null;
  if (!userResponse.ok || typeof user?.id !== "number" || typeof user.login !== "string") {
    throw new GithubSignInError(`user lookup failed (${userResponse.status})`);
  }
  return {
    githubId: user.id,
    login: user.login,
    name: typeof user.name === "string" ? user.name : null,
    avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
  };
};
