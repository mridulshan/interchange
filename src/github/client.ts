import type { PrRef } from "../core/types.js";
import type { RepoState } from "../core/drift.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  /** Only consider pull requests updated on or after this ISO date. */
  since?: string;
  /** Hard cap on pages of 100, so one huge repo cannot stall a check. */
  maxPages?: number;
  token?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["GITHUB_TOKEN"] || env["GH_TOKEN"] || undefined;
}

interface ApiPr {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  state: string;
  updated_at: string;
  base?: { ref?: string };
}

/**
 * Pull requests for one repo, newest activity first, stopping once a whole
 * page falls outside the window.
 */
export async function fetchRepoState(
  repoId: string,
  remote: string,
  branch: string,
  opts: FetchOptions = {},
): Promise<RepoState> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  const maxPages = opts.maxPages ?? 5;
  const sinceMs = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "interchange",
  };
  const token = opts.token ?? tokenFromEnv();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const merged: PrRef[] = [];
  const open: PrRef[] = [];
  const closed: PrRef[] = [];
  let truncated = false;
  let page = 1;

  for (; page <= maxPages; page++) {
    const url =
      `${base}/repos/${remote}/pulls?state=all&base=${encodeURIComponent(branch)}` +
      `&sort=updated&direction=desc&per_page=100&page=${page}`;

    const res = await doFetch(url, { headers });
    if (!res.ok) throw await describe(res, remote);

    const body = (await res.json()) as ApiPr[];
    if (!Array.isArray(body) || body.length === 0) break;

    let anyInWindow = false;
    for (const pr of body) {
      if (Date.parse(pr.updated_at) < sinceMs) continue;
      anyInWindow = true;
      // The API filters by base branch, but a redirected/renamed base can
      // still slip through; trust the response and record what it says.
      const ref: PrRef = { repo: repoId, number: pr.number, title: pr.title, url: pr.html_url };
      if (pr.merged_at) {
        ref.state = "merged";
        ref.mergedAt = pr.merged_at;
        merged.push(ref);
      } else if (pr.state === "open") {
        ref.state = "open";
        open.push(ref);
      } else {
        ref.state = "closed";
        closed.push(ref);
      }
    }

    if (!anyInWindow) break;
    if (body.length < 100) break;
    if (page === maxPages) truncated = true;
  }

  merged.sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""));

  const state: RepoState = { repo: repoId, merged, open, closed };
  state.window = { pages: Math.min(page, maxPages), truncated };
  if (opts.since) state.window.since = opts.since;
  return state;
}

async function describe(res: Response, remote: string): Promise<GitHubError> {
  const text = await res.text().catch(() => "");
  if (res.status === 401) {
    return new GitHubError(`GitHub rejected the token (401). Check GITHUB_TOKEN.`, 401);
  }
  if (res.status === 404) {
    return new GitHubError(
      `Cannot see ${remote} (404). It may not exist, or the token may not cover it.`,
      404,
    );
  }
  if (res.status === 403 && /rate limit/i.test(text)) {
    return new GitHubError(
      `GitHub rate limit hit while reading ${remote}. Set GITHUB_TOKEN to raise it.`,
      403,
    );
  }
  return new GitHubError(`GitHub returned ${res.status} for ${remote}. ${text.slice(0, 200)}`, res.status);
}
