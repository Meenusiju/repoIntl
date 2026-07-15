import fetch from "node-fetch";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. It's required to create branches/PRs via the GitHub API."
    );
  }
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "RepoIntel",
  };
}

async function githubRequest<T>(
  urlPath: string,
  options: { method?: string; body?: object } = {}
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${urlPath}`, {
    method: options.method || "GET",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error [${res.status} ${urlPath}]: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface RepoInfo {
  default_branch: string;
}

export async function getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
  return githubRequest<RepoInfo>(`/repos/${owner}/${repo}`);
}

/**
 * Returns the commit SHA that a branch currently points to.
 */
export async function getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
  const ref = await githubRequest<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  );
  return ref.object.sha;
}

/**
 * Creates a new branch pointing at `fromSha`. If the branch already exists,
 * this is a no-op (idempotent — useful if a webhook redelivers).
 */
export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string
): Promise<void> {
  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branchName}`, sha: fromSha },
    });
  } catch (err: any) {
    if (/already exists/i.test(err.message)) {
      return; // idempotent
    }
    throw err;
  }
}

/**
 * Fetches the blob SHA of an existing file on a given branch, or undefined
 * if the file doesn't exist yet (needed by the Contents API to distinguish
 * create vs. update).
 */
export async function getFileSha(
  owner: string,
  repo: string,
  filePath: string,
  branch: string
): Promise<string | undefined> {
  try {
    const data = await githubRequest<{ sha: string }>(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`
    );
    return data.sha;
  } catch {
    return undefined;
  }
}

/**
 * Creates or updates a file on a branch via the Contents API (a proper git
 * commit is made server-side by GitHub — no local git binary needed, same
 * approach as the zipball-based cloneRepo()).
 */
export async function upsertFile(
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  branch: string,
  message: string
): Promise<void> {
  const existingSha = await getFileSha(owner, repo, filePath, branch);
  await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: {
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
  });
}

export interface CreatePullRequestParams {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

/**
 * Opens a PR. If one already exists for the same head/base (e.g. webhook
 * redelivery), returns the existing PR instead of erroring.
 */
export async function createPullRequest(
  owner: string,
  repo: string,
  params: CreatePullRequestParams
): Promise<PullRequestResult> {
  try {
    const pr = await githubRequest<{ html_url: string; number: number }>(
      `/repos/${owner}/${repo}/pulls`,
      { method: "POST", body: params }
    );
    return { url: pr.html_url, number: pr.number };
  } catch (err: any) {
    if (/already exists/i.test(err.message)) {
      const existing = await githubRequest<Array<{ html_url: string; number: number }>>(
        `/repos/${owner}/${repo}/pulls?head=${owner}:${params.head}&base=${params.base}&state=open`
      );
      if (existing.length > 0) {
        return { url: existing[0].html_url, number: existing[0].number };
      }
    }
    throw err;
  }
}

export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) {
    throw new Error(`Invalid GitHub URL: "${repoUrl}"`);
  }
  return { owner: match[1], repo: match[2] };
}
