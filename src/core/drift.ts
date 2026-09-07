import type { Feature, InterchangeMap, PrRef, Status } from "./types.js";
import { featureRepos } from "./types.js";

/** What a repo check actually learned about one repo. */
export interface RepoState {
  /** Repo id, not the remote. */
  repo: string;
  /** Pull requests merged into the shipped branch. */
  merged: PrRef[];
  /** Pull requests still open. */
  open: PrRef[];
  /** Pull requests closed without merging. */
  closed?: PrRef[];
  /** How far back the fetch reached, for reporting the window to a human. */
  window?: { since?: string; pages: number; truncated: boolean };
}

export type FindingKind =
  | "unmapped-pr"
  | "status-behind"
  | "status-ahead"
  | "pr-abandoned";

export interface Finding {
  kind: FindingKind;
  severity: "error" | "warning";
  /** Where it was found, for the "be/main" style source label. */
  source: string;
  /** One line, the way you would say it out loud. */
  message: string;
  featureId?: string;
  pr?: PrRef;
  /** For unmapped PRs: the row the map proposes. You accept or reject it. */
  suggestion?: Feature;
  /** For status findings: what the map should say instead. */
  suggestedStatus?: Status;
}

function prKey(p: { repo: string; number: number }): string {
  return `${p.repo}#${p.number}`;
}

function branchOf(map: InterchangeMap, repoId: string): string {
  return map.repos.find((r) => r.id === repoId)?.branch ?? "main";
}

export function slugify(s: string, taken: Set<string> = new Set()): string {
  // Trim to whole words: an id an agent has to type back should not end
  // mid-word, the way "...minor-units" became "...minor-uni".
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
  let base = "";
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 40) break;
    base = next;
  }
  if (!base) base = words[0]?.slice(0, 40) || "feature";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * The last thing drawn that touched the same repo. When a PR shows up
 * unmapped, this is the most likely thing it was built on — offered as a
 * guess, never written without a person saying yes.
 */
function guessDep(map: InterchangeMap, repoId: string): string[] {
  for (let i = map.features.length - 1; i >= 0; i--) {
    const f = map.features[i] as Feature;
    if (f.status === "planned" || f.status === "reverted") continue;
    if (featureRepos(f).includes(repoId)) return [f.id];
  }
  return [];
}

/**
 * Compare the map against what the repos actually did.
 *
 * This never edits the map. It reports, and a person decides — a map that
 * rewrites itself is a map you stop reading.
 */
export function reconcile(map: InterchangeMap, states: RepoState[]): Finding[] {
  const findings: Finding[] = [];

  const claimed = new Map<string, Feature>();
  for (const f of map.features) {
    for (const p of f.prs ?? []) claimed.set(prKey(p), f);
  }
  const ignored = new Set((map.ignore ?? []).map(prKey));
  const takenIds = new Set(map.features.map((f) => f.id));

  const mergedByKey = new Map<string, PrRef>();
  const openByKey = new Map<string, PrRef>();
  const closedByKey = new Map<string, PrRef>();
  for (const st of states) {
    for (const p of st.merged) mergedByKey.set(prKey(p), p);
    for (const p of st.open) openByKey.set(prKey(p), p);
    for (const p of st.closed ?? []) closedByKey.set(prKey(p), p);
  }

  // 1. Shipped, never drawn.
  for (const st of states) {
    const source = `${st.repo}/${branchOf(map, st.repo)}`;
    for (const pr of st.merged) {
      const key = prKey(pr);
      if (claimed.has(key) || ignored.has(key)) continue;
      const id = slugify(pr.title ?? `${st.repo}-${pr.number}`, takenIds);
      takenIds.add(id);
      findings.push({
        kind: "unmapped-pr",
        severity: "error",
        source,
        message: `${key} merged${pr.mergedAt ? ` ${shortDate(pr.mergedAt)}` : ""} with no row on this map.`,
        pr,
        suggestion: {
          id,
          name: pr.title ?? `${st.repo} #${pr.number}`,
          status: "live",
          repos: [st.repo],
          deps: guessDep(map, st.repo),
          prs: [pr],
          drift: true,
          ...(pr.mergedAt ? { shippedAt: pr.mergedAt } : {}),
        },
      });
    }
  }

  // 2. Drawn as unfinished, actually shipped.
  for (const f of map.features) {
    const prs = f.prs ?? [];
    if (!prs.length) continue;
    const known = prs.filter((p) => coveredBy(states, p));
    if (!known.length) continue;

    // Only claim "all of it merged" when the check actually saw all of it.
    // A partial window makes this a guess, and a guess here is worse than
    // saying nothing.
    const fullyCovered = known.length === prs.length;
    const allMerged = fullyCovered && known.every((p) => mergedByKey.has(prKey(p)));
    if (allMerged && (f.status === "planned" || f.status === "flight")) {
      findings.push({
        kind: "status-behind",
        severity: "warning",
        source: known.map(prKey).join(" · "),
        message: `"${f.name}" is drawn as ${f.status === "flight" ? "in flight" : "planned"}, but every pull request merged.`,
        featureId: f.id,
        suggestedStatus: "live",
      });
    }

    // 3. Drawn as shipped, not actually merged.
    if (f.status === "live") {
      const notMerged = known.filter((p) => !mergedByKey.has(prKey(p)));
      const stillOpen = notMerged.filter((p) => openByKey.has(prKey(p)));
      if (stillOpen.length) {
        findings.push({
          kind: "status-ahead",
          severity: "warning",
          source: stillOpen.map(prKey).join(" · "),
          message: `"${f.name}" is drawn as live, but ${stillOpen.length === 1 ? "a pull request is" : `${stillOpen.length} pull requests are`} still open.`,
          featureId: f.id,
          ...(stillOpen[0] ? { pr: stillOpen[0] } : {}),
          suggestedStatus: "flight",
        });
      }
    }

    // 4. Referenced work that was closed without merging.
    const abandoned = prs.filter((p) => closedByKey.has(prKey(p)));
    if (abandoned.length && f.status !== "reverted" && f.status !== "planned") {
      findings.push({
        kind: "pr-abandoned",
        severity: "warning",
        source: abandoned.map(prKey).join(" · "),
        message: `"${f.name}" references ${abandoned.length === 1 ? "a pull request that was" : "pull requests that were"} closed without merging.`,
        featureId: f.id,
        ...(abandoned[0] ? { pr: abandoned[0] } : {}),
      });
    }
  }

  const rank: Record<FindingKind, number> = {
    "unmapped-pr": 0,
    "status-ahead": 1,
    "status-behind": 2,
    "pr-abandoned": 3,
  };
  return findings.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Was this PR inside the window the check actually looked at?
 *
 * Presence, not a number range: a PR the fetch never returned tells us
 * nothing, and silence must never be read as evidence.
 */
function coveredBy(states: RepoState[], pr: PrRef): boolean {
  const st = states.find((s) => s.repo === pr.repo);
  if (!st) return false;
  const key = prKey(pr);
  return (
    st.merged.some((p) => prKey(p) === key) ||
    st.open.some((p) => prKey(p) === key) ||
    (st.closed ?? []).some((p) => prKey(p) === key)
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Apply one accepted finding to a map, returning a new map. */
export function applyFinding(map: InterchangeMap, finding: Finding): InterchangeMap {
  const features = map.features.slice();

  if (finding.kind === "unmapped-pr" && finding.suggestion) {
    const s = finding.suggestion;
    // Sit it directly under whatever it was guessed to depend on, so ship
    // order stays readable without a re-sort.
    const depIdx = (s.deps ?? [])
      .map((d) => features.findIndex((f) => f.id === d))
      .filter((i) => i >= 0);
    const at = depIdx.length ? Math.max(...depIdx) + 1 : features.length;
    features.splice(at, 0, s);
    return { ...map, features };
  }

  if (finding.suggestedStatus && finding.featureId) {
    const i = features.findIndex((f) => f.id === finding.featureId);
    if (i >= 0) features[i] = { ...(features[i] as Feature), status: finding.suggestedStatus };
    return { ...map, features };
  }

  return map;
}

/** Record a merged PR as deliberately undrawn. */
export function ignoreFinding(map: InterchangeMap, finding: Finding, reason?: string): InterchangeMap {
  if (!finding.pr) return map;
  const ignore = (map.ignore ?? []).slice();
  const key = prKey(finding.pr);
  if (!ignore.some((i) => prKey(i) === key)) {
    ignore.push({
      repo: finding.pr.repo,
      number: finding.pr.number,
      ...(reason ? { reason } : {}),
    });
  }
  return { ...map, ignore };
}
