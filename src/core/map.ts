import type { Feature, IgnoreRule, InterchangeMap, PrRef, RepoRef, Status } from "./types.js";
import { STATUSES } from "./types.js";

export class MapFormatError extends Error {}

function fail(msg: string): never {
  throw new MapFormatError(msg);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || !v.trim()) fail(`${where} must be a non-empty string.`);
  return (v as string).trim();
}

function optStr(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") fail(`${where} must be a string.`);
  return (v as string).trim() || undefined;
}

function strArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${where} must be an array of strings.`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

function parsePr(v: unknown, where: string): PrRef {
  if (typeof v === "string") {
    // Shorthand: "web#214"
    const m = /^([A-Za-z0-9._-]+)\s*#\s*(\d+)$/.exec(v.trim());
    if (!m) fail(`${where} should look like "web#214".`);
    return { repo: m[1] as string, number: Number(m[2]) };
  }
  if (typeof v !== "object" || v === null) fail(`${where} must be an object or "repo#number".`);
  const o = v as Record<string, unknown>;
  if (typeof o["number"] !== "number") fail(`${where}.number must be a number.`);
  const pr: PrRef = { repo: str(o["repo"], `${where}.repo`), number: o["number"] as number };
  const title = optStr(o["title"], `${where}.title`);
  const url = optStr(o["url"], `${where}.url`);
  const mergedAt = optStr(o["mergedAt"], `${where}.mergedAt`);
  const state = optStr(o["state"], `${where}.state`);
  if (title) pr.title = title;
  if (url) pr.url = url;
  if (mergedAt) pr.mergedAt = mergedAt;
  if (state === "open" || state === "merged" || state === "closed") pr.state = state;
  return pr;
}

function parseStatus(v: unknown, where: string): Status {
  const s = typeof v === "string" ? v.trim() : "";
  if (!STATUSES.includes(s as Status)) {
    fail(`${where} must be one of ${STATUSES.join(", ")} — got ${JSON.stringify(v)}.`);
  }
  return s as Status;
}

function parseRepo(v: unknown, where: string): RepoRef {
  if (typeof v === "string") return { id: str(v, where) };
  if (typeof v !== "object" || v === null) fail(`${where} must be an object or a string id.`);
  const o = v as Record<string, unknown>;
  const r: RepoRef = { id: str(o["id"], `${where}.id`) };
  const label = optStr(o["label"], `${where}.label`);
  const remote = optStr(o["remote"], `${where}.remote`);
  const branch = optStr(o["branch"], `${where}.branch`);
  const color = optStr(o["color"], `${where}.color`);
  if (label) r.label = label;
  if (remote) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(remote)) fail(`${where}.remote must look like "owner/name".`);
    r.remote = remote;
  }
  if (branch) r.branch = branch;
  if (color) r.color = color;
  return r;
}

function parseFeature(v: unknown, where: string): Feature {
  if (typeof v !== "object" || v === null) fail(`${where} must be an object.`);
  const o = v as Record<string, unknown>;
  const f: Feature = {
    id: str(o["id"], `${where}.id`),
    name: str(o["name"], `${where}.name`),
    status: parseStatus(o["status"], `${where}.status`),
  };
  const repos = strArray(o["repos"], `${where}.repos`);
  const deps = strArray(o["deps"], `${where}.deps`);
  if (repos.length) f.repos = repos;
  if (deps.length) f.deps = deps;
  if (o["merge"] === true) f.merge = true;
  if (o["drift"] === true) f.drift = true;
  if (o["prs"] !== undefined && o["prs"] !== null) {
    if (!Array.isArray(o["prs"])) fail(`${where}.prs must be an array.`);
    const prs = (o["prs"] as unknown[]).map((p, i) => parsePr(p, `${where}.prs[${i}]`));
    if (prs.length) f.prs = prs;
  }
  for (const k of ["assumes", "exposes", "chose", "note", "shippedAt"] as const) {
    const val = optStr(o[k], `${where}.${k}`);
    if (val) f[k] = val;
  }
  return f;
}

function parseIgnore(v: unknown, where: string): IgnoreRule {
  if (typeof v === "string") {
    const pr = parsePr(v, where);
    return { repo: pr.repo, number: pr.number };
  }
  if (typeof v !== "object" || v === null) fail(`${where} must be an object or "repo#number".`);
  const o = v as Record<string, unknown>;
  if (typeof o["number"] !== "number") fail(`${where}.number must be a number.`);
  const rule: IgnoreRule = { repo: str(o["repo"], `${where}.repo`), number: o["number"] as number };
  const reason = optStr(o["reason"], `${where}.reason`);
  if (reason) rule.reason = reason;
  return rule;
}

/** Turn parsed JSON into a map, with errors that say where the problem is. */
export function normalize(raw: unknown): InterchangeMap {
  if (typeof raw !== "object" || raw === null) fail("The map file must contain a JSON object.");
  const o = raw as Record<string, unknown>;

  const version = o["version"];
  if (version !== undefined && version !== 1) {
    fail(`Unsupported map version ${JSON.stringify(version)}. This build reads version 1.`);
  }

  if (o["repos"] !== undefined && !Array.isArray(o["repos"])) fail("repos must be an array.");
  if (o["features"] !== undefined && !Array.isArray(o["features"])) fail("features must be an array.");

  const map: InterchangeMap = {
    version: 1,
    repos: ((o["repos"] as unknown[]) ?? []).map((r, i) => parseRepo(r, `repos[${i}]`)),
    features: ((o["features"] as unknown[]) ?? []).map((f, i) => parseFeature(f, `features[${i}]`)),
  };
  const title = optStr(o["title"], "title");
  const checkedAt = optStr(o["checkedAt"], "checkedAt");
  if (title) map.title = title;
  if (checkedAt) map.checkedAt = checkedAt;
  if (Array.isArray(o["ignore"])) {
    const ignore = (o["ignore"] as unknown[]).map((r, i) => parseIgnore(r, `ignore[${i}]`));
    if (ignore.length) map.ignore = ignore;
  }
  return map;
}

export function parseMap(text: string): InterchangeMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(`The map file is not valid JSON: ${(e as Error).message}`);
  }
  return normalize(raw);
}

function pick<T extends object>(src: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k as string] = v;
  }
  return out;
}

const REPO_KEYS = ["id", "label", "remote", "branch", "color"] as const;
const PR_KEYS = ["repo", "number", "title", "url", "mergedAt", "state"] as const;
const FEATURE_KEYS = [
  "id",
  "name",
  "status",
  "repos",
  "deps",
  "merge",
  "prs",
  "assumes",
  "exposes",
  "chose",
  "note",
  "shippedAt",
  "drift",
] as const;

/**
 * Fixed key order so the committed file produces small, readable diffs.
 * A map you dread reviewing is a map that rots.
 */
export function serialize(map: InterchangeMap): string {
  const out: Record<string, unknown> = { version: 1 };
  if (map.title) out["title"] = map.title;
  if (map.checkedAt) out["checkedAt"] = map.checkedAt;
  out["repos"] = map.repos.map((r) => pick(r, REPO_KEYS));
  out["features"] = map.features.map((f) => {
    const o = pick(f, FEATURE_KEYS);
    if (Array.isArray(o["prs"])) {
      o["prs"] = (o["prs"] as PrRef[]).map((p) => pick(p, PR_KEYS));
    }
    return o;
  });
  if (map.ignore?.length) out["ignore"] = map.ignore.map((i) => pick(i, ["repo", "number", "reason"] as const));
  return JSON.stringify(out, null, 2) + "\n";
}
