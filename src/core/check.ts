import type { InterchangeMap } from "./types.js";
import type { Finding, RepoState } from "./drift.js";
import { reconcile } from "./drift.js";
import { validate } from "./graph.js";
import type { Issue } from "./graph.js";
import { fetchRepoState } from "../github/client.js";
import type { FetchOptions } from "../github/client.js";

export interface CheckResult {
  /** Structural problems in the map itself. */
  issues: Issue[];
  /** Differences between the map and the repos. */
  findings: Finding[];
  states: RepoState[];
  /** Repos that were drawn but could not be read. */
  skipped: { repo: string; reason: string }[];
  checkedAt: string;
}

export interface CheckOptions extends FetchOptions {
  /** Limit the check to these repo ids. */
  only?: string[];
}

/** Default window: half a year back. Older than that and it isn't drift. */
export function defaultSince(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 180);
  return d.toISOString();
}

/**
 * Read every repo that has a remote and compare it against the map.
 * A repo without a remote is drawn but never reconciled, and says so.
 */
export async function runCheck(map: InterchangeMap, opts: CheckOptions = {}): Promise<CheckResult> {
  const states: RepoState[] = [];
  const skipped: { repo: string; reason: string }[] = [];
  const since = opts.since ?? defaultSince();

  const targets = map.repos.filter((r) => !opts.only || opts.only.includes(r.id));

  const results = await Promise.all(
    targets.map(async (r) => {
      if (!r.remote) {
        return { skip: { repo: r.id, reason: "no remote set, so it is drawn but never checked" } };
      }
      try {
        return { state: await fetchRepoState(r.id, r.remote, r.branch ?? "main", { ...opts, since }) };
      } catch (e) {
        return { skip: { repo: r.id, reason: (e as Error).message } };
      }
    }),
  );

  for (const r of results) {
    if ("state" in r && r.state) states.push(r.state);
    else if ("skip" in r && r.skip) skipped.push(r.skip);
  }

  return {
    issues: validate(map),
    findings: reconcile(map, states),
    states,
    skipped,
    checkedAt: new Date().toISOString(),
  };
}
