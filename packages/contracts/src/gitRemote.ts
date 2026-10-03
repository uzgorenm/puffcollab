/**
 * Git remote normalization shared by the server (repository identity), the
 * clients (project grouping), and the Puff Collab hub (project keys). Pure and
 * dependency-free so every runtime, including the hub Worker, computes the
 * same key for the same repository.
 */

/**
 * The web spelling of an Azure DevOps repository reached over SSH, or null for anything else.
 *
 * Azure alone addresses one repository under two names that share no part: `ssh.dev.azure.com` and
 * `v3/{org}/{project}/{repo}` over SSH, against `dev.azure.com` and `{org}/{project}/_git/{repo}`
 * everywhere a person sees it. A project cloned over SSH would otherwise be a different repository
 * to every comparison made against a pull request URL, which arrives in the web spelling. So the
 * web spelling is the one both are keyed by.
 */
function azureDevOpsRepositoryKey(host: string, segments: ReadonlyArray<string>): string | null {
  if (host !== "ssh.dev.azure.com" && host !== "vs-ssh.visualstudio.com") return null;
  const [marker, organization, project, repository] = segments;
  if (segments.length !== 4 || marker !== "v3") return null;
  if (!organization || !project || !repository) return null;
  return host === "ssh.dev.azure.com"
    ? `dev.azure.com/${organization}/${project}/_git/${repository}`
    : `${organization}.visualstudio.com/${project}/_git/${repository}`;
}

/**
 * Normalize a git remote URL into a stable comparison key.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositorySegments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (url.hostname && repositorySegments.length > 1) {
        return (
          azureDevOpsRepositoryKey(url.hostname, repositorySegments) ??
          `${url.hostname}/${repositorySegments.join("/")}`
        );
      }
    } catch {
      return normalized;
    }
  }

  const scpStyleHostAndPath = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(
    normalized,
  );
  const scpHost = scpStyleHostAndPath?.[1];
  const scpPath = scpStyleHostAndPath?.[2];
  if (scpHost && scpPath) {
    return azureDevOpsRepositoryKey(scpHost, scpPath.split("/")) ?? `${scpHost}/${scpPath}`;
  }

  return normalized;
}
