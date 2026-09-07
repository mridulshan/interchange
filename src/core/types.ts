/**
 * The map file format. One committed JSON file per project is the whole
 * source of truth — there is deliberately no database and no second place
 * to keep it.
 */

export type Status = "planned" | "flight" | "live" | "reverted";

export const STATUSES: readonly Status[] = ["planned", "flight", "live", "reverted"];

/** A repo is a line on the map. */
export interface RepoRef {
  /** Short id used by features, e.g. "web". */
  id: string;
  /** Display name. Defaults to the id. */
  label?: string;
  /** GitHub "owner/name". Without it a repo is drawn but never reconciled. */
  remote?: string;
  /** Branch that counts as shipped. Defaults to "main". */
  branch?: string;
  /** Line colour. Assigned from the default palette when absent. */
  color?: string;
}

export interface PrRef {
  /** Repo id, not the remote. */
  repo: string;
  number: number;
  title?: string;
  url?: string;
  mergedAt?: string;
  state?: "open" | "merged" | "closed";
}

/** A feature is a station. It sits on every line it touched. */
export interface Feature {
  id: string;
  name: string;
  status: Status;
  /**
   * Repo ids this feature touched. May be omitted when it can be derived
   * from `prs` — a planned feature with no PRs yet needs it explicitly.
   */
  repos?: string[];
  /** Feature ids this one sits on. */
  deps?: string[];
  /** Draw as an interchange (a merge of independent lines), not a station. */
  merge?: boolean;
  prs?: PrRef[];
  /** What this takes as given from the layers below. */
  assumes?: string;
  /** What this hands up to the layers above. */
  exposes?: string;
  /** The call you made, and what you gave up making it. */
  chose?: string;
  /** Free text that isn't any of the above. */
  note?: string;
  shippedAt?: string;
  /** Row came from a repo check rather than being drawn at merge time. */
  drift?: boolean;
}

/** A merged PR you have decided does not deserve a row. */
export interface IgnoreRule {
  repo: string;
  number: number;
  reason?: string;
}

export interface InterchangeMap {
  version: 1;
  title?: string;
  repos: RepoRef[];
  /** Array order is ship order, top to bottom. */
  features: Feature[];
  ignore?: IgnoreRule[];
  /** ISO timestamp of the last reconcile. */
  checkedAt?: string;
}

export const DEFAULT_PALETTE = [
  "#0F6E8C",
  "#5B4A9E",
  "#C57E12",
  "#2E7D5B",
  "#A0407A",
  "#1F6F6F",
  "#8C4A2F",
  "#4A6FA5",
] as const;

export function repoColor(map: InterchangeMap, id: string): string {
  const i = map.repos.findIndex((r) => r.id === id);
  const explicit = i >= 0 ? map.repos[i]?.color : undefined;
  if (explicit) return explicit;
  const idx = i >= 0 ? i : 0;
  return DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length] as string;
}

export function repoLabel(map: InterchangeMap, id: string): string {
  return map.repos.find((r) => r.id === id)?.label ?? id;
}

/** Repos a feature touches: what was drawn, plus wherever its PRs landed. */
export function featureRepos(f: Feature): string[] {
  const out: string[] = [];
  for (const r of f.repos ?? []) if (!out.includes(r)) out.push(r);
  for (const p of f.prs ?? []) if (!out.includes(p.repo)) out.push(p.repo);
  return out;
}

export function emptyMap(title?: string): InterchangeMap {
  return { version: 1, ...(title ? { title } : {}), repos: [], features: [] };
}
