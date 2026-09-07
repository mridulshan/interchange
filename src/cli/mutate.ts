import type { Decision, Feature, InterchangeMap, RepoRef, Status } from "../core/types.js";
import { STATUSES } from "../core/types.js";
import { slugify } from "../core/drift.js";
import { validate } from "../core/graph.js";
import { parsePrRefs } from "../core/prs.js";

export class WriteRefused extends Error {}

/**
 * A write must never leave the map worse than it found it. Errors that were
 * already there are not this command's fault; errors this command introduces
 * mean the write is refused and nothing is saved.
 */
export function guard(before: InterchangeMap, after: InterchangeMap): void {
  const was = new Set(validate(before).filter((i) => i.severity === "error").map((i) => i.message));
  const now = validate(after).filter((i) => i.severity === "error");
  const fresh = now.filter((i) => !was.has(i.message));
  if (fresh.length) {
    throw new WriteRefused(
      `That would break the map, so nothing was written:\n  ${fresh
        .map((i) => i.message)
        .join("\n  ")}`,
    );
  }
}

export function parseStatus(v: string | undefined, where: string): Status {
  if (v === undefined) return "live";
  if (!STATUSES.includes(v as Status)) {
    throw new WriteRefused(`${where} must be one of ${STATUSES.join(", ")} - got "${v}".`);
  }
  return v as Status;
}

export interface AddFeatureInput {
  name: string;
  id?: string;
  status?: string;
  repos?: string[];
  deps?: string[];
  prs?: string[];
  assumes?: string;
  exposes?: string;
  chose?: string;
  merge?: boolean;
  after?: string;
}

export function addFeature(
  map: InterchangeMap,
  input: AddFeatureInput,
): { map: InterchangeMap; feature: Feature } {
  const taken = new Set(map.features.map((f) => f.id));
  const id = input.id ?? slugify(input.name, taken);
  if (taken.has(id)) {
    throw new WriteRefused(
      `A feature called "${id}" is already on the map. Use "interchange set ${id}" to change it.`,
    );
  }

  const prs = parsePrRefs(input.prs ?? []);
  const feature: Feature = { id, name: input.name, status: parseStatus(input.status, "--status") };
  if (input.repos?.length) feature.repos = input.repos;
  if (input.deps?.length) feature.deps = input.deps;
  if (input.merge) feature.merge = true;
  if (prs.length) feature.prs = prs;
  if (input.assumes) feature.assumes = input.assumes;
  if (input.exposes) feature.exposes = input.exposes;
  if (input.chose) feature.chose = input.chose;

  if (!feature.repos?.length && !prs.length) {
    throw new WriteRefused("A feature has to touch at least one line. Pass --repos or --prs.");
  }

  const features = map.features.slice();
  // Default to the end of ship order; --after places it explicitly.
  let at = features.length;
  if (input.after) {
    const i = features.findIndex((f) => f.id === input.after);
    if (i < 0) throw new WriteRefused(`No feature "${input.after}" to place this after.`);
    at = i + 1;
  }
  features.splice(at, 0, feature);

  const next = { ...map, features };
  guard(map, next);
  return { map: next, feature };
}

export interface AddRepoInput {
  id: string;
  remote?: string;
  branch?: string;
  label?: string;
  color?: string;
}

/** Declare a line. Without this a cross-repo map cannot be built from a shell. */
export function addRepo(
  map: InterchangeMap,
  input: AddRepoInput,
): { map: InterchangeMap; repo: RepoRef } {
  if (map.repos.some((r) => r.id === input.id)) {
    throw new WriteRefused(`A line called "${input.id}" is already declared.`);
  }
  if (input.remote && !/^[^/\s]+\/[^/\s]+$/.test(input.remote)) {
    throw new WriteRefused(`--remote must look like "owner/name" - got "${input.remote}".`);
  }
  const repo: RepoRef = { id: input.id };
  if (input.label) repo.label = input.label;
  if (input.remote) repo.remote = input.remote;
  if (input.branch) repo.branch = input.branch;
  if (input.color) repo.color = input.color;

  const next = { ...map, repos: [...map.repos, repo] };
  guard(map, next);
  return { map: next, repo };
}

export function removeRepo(
  map: InterchangeMap,
  id: string,
): { map: InterchangeMap; repo: RepoRef } {
  const repo = map.repos.find((r) => r.id === id);
  if (!repo) throw new WriteRefused(`No line "${id}" on this map.`);

  const used = map.features.filter(
    (f) => (f.repos ?? []).includes(id) || (f.prs ?? []).some((p) => p.repo === id),
  );
  if (used.length) {
    throw new WriteRefused(
      `${used.map((f) => f.id).join(", ")} still touch${used.length === 1 ? "es" : ""} "${id}".`,
    );
  }
  const next = { ...map, repos: map.repos.filter((r) => r.id !== id) };
  guard(map, next);
  return { map: next, repo };
}

/**
 * Remove a feature. Refuses while other work sits on it, unless forced - in
 * which case the dependency is stripped from whatever was standing on it, so
 * the map never keeps a pointer to something that is gone.
 */
export function removeFeature(
  map: InterchangeMap,
  id: string,
  force = false,
): { map: InterchangeMap; feature: Feature; detached: string[] } {
  const feature = map.features.find((f) => f.id === id);
  if (!feature) throw new WriteRefused(`No feature "${id}" on this map.`);

  const dependents = map.features.filter((f) => (f.deps ?? []).includes(id));
  if (dependents.length && !force) {
    throw new WriteRefused(
      `${dependents.map((f) => f.id).join(", ")} sit${
        dependents.length === 1 ? "s" : ""
      } on "${id}". Pass --force to remove it and detach them.`,
    );
  }

  const features = map.features
    .filter((f) => f.id !== id)
    .map((f) =>
      (f.deps ?? []).includes(id) ? { ...f, deps: (f.deps ?? []).filter((d) => d !== id) } : f,
    );

  // Decisions must not be left pointing at a feature that no longer exists.
  const decisions = (map.decisions ?? []).map((d) => {
    const next = { ...d };
    if (next.feature === id) delete next.feature;
    if (next.brokeAt === id) delete next.brokeAt;
    if (next.affects?.includes(id)) next.affects = next.affects.filter((a) => a !== id);
    if (next.affects && !next.affects.length) delete next.affects;
    return next;
  });

  const out: InterchangeMap = { ...map, features };
  if (decisions.length) out.decisions = decisions;
  guard(map, out);
  return { map: out, feature, detached: dependents.map((f) => f.id) };
}

export function removeDecision(
  map: InterchangeMap,
  id: string,
): { map: InterchangeMap; decision: Decision } {
  const decision = (map.decisions ?? []).find((d) => d.id === id);
  if (!decision) throw new WriteRefused(`No decision "${id}" on this map.`);

  const decisions = (map.decisions ?? [])
    .filter((d) => d.id !== id)
    .map((d) => {
      if (d.supersededBy !== id) return d;
      const next = { ...d };
      delete next.supersededBy;
      return next;
    });

  const out: InterchangeMap = { ...map, features: map.features };
  if (decisions.length) out.decisions = decisions;
  else delete out.decisions;
  guard(map, out);
  return { map: out, decision };
}

export interface SetFeatureInput {
  status?: string;
  name?: string;
  assumes?: string;
  exposes?: string;
  chose?: string;
  addPrs?: string[];
  addDeps?: string[];
  removePrs?: string[];
  removeDeps?: string[];
}

export function setFeature(
  map: InterchangeMap,
  id: string,
  input: SetFeatureInput,
): { map: InterchangeMap; feature: Feature } {
  const i = map.features.findIndex((f) => f.id === id);
  if (i < 0) throw new WriteRefused(`No feature "${id}" on this map.`);

  const cur = map.features[i] as Feature;
  const next: Feature = { ...cur };
  if (input.status !== undefined) next.status = parseStatus(input.status, "--status");
  if (input.name) next.name = input.name;
  if (input.assumes !== undefined) next.assumes = input.assumes || undefined;
  if (input.exposes !== undefined) next.exposes = input.exposes || undefined;
  if (input.chose !== undefined) next.chose = input.chose || undefined;

  if (input.addPrs?.length) {
    const add = parsePrRefs(input.addPrs);
    const have = new Set((cur.prs ?? []).map((p) => `${p.repo}#${p.number}`));
    next.prs = [...(cur.prs ?? []), ...add.filter((p) => !have.has(`${p.repo}#${p.number}`))];
  }
  if (input.addDeps?.length) {
    const have = new Set(cur.deps ?? []);
    next.deps = [...(cur.deps ?? []), ...input.addDeps.filter((d) => !have.has(d))];
  }
  if (input.removePrs?.length) {
    const drop = new Set(parsePrRefs(input.removePrs).map((p) => `${p.repo}#${p.number}`));
    const before = next.prs ?? [];
    const kept = before.filter((p) => !drop.has(`${p.repo}#${p.number}`));
    if (kept.length === before.length) {
      throw new WriteRefused(`"${id}" does not reference ${input.removePrs.join(", ")}.`);
    }
    if (kept.length) next.prs = kept;
    else delete next.prs;
  }
  if (input.removeDeps?.length) {
    const before = next.deps ?? [];
    const kept = before.filter((d) => !input.removeDeps!.includes(d));
    if (kept.length === before.length) {
      throw new WriteRefused(`"${id}" does not sit on ${input.removeDeps.join(", ")}.`);
    }
    if (kept.length) next.deps = kept;
    else delete next.deps;
  }

  const features = map.features.slice();
  features[i] = next;
  const out = { ...map, features };
  guard(map, out);
  return { map: out, feature: next };
}

export interface DecideInput {
  chose: string;
  id?: string;
  over?: string;
  because?: string;
  cost?: string;
  at?: string;
  affects?: string[];
  brokeAt?: string;
  supersedes?: string;
  madeAt?: string;
  note?: string;
}

export function decide(
  map: InterchangeMap,
  input: DecideInput,
): { map: InterchangeMap; decision: Decision } {
  const decisions = (map.decisions ?? []).slice();
  const taken = new Set(decisions.map((d) => d.id));
  const id = input.id ?? slugify(input.chose, taken);
  if (taken.has(id)) throw new WriteRefused(`A decision called "${id}" is already recorded.`);

  const decision: Decision = { id, chose: input.chose };
  if (input.over) decision.over = input.over;
  if (input.because) decision.because = input.because;
  if (input.cost) decision.cost = input.cost;
  if (input.at) decision.feature = input.at;
  if (input.affects?.length) decision.affects = input.affects;
  if (input.brokeAt) decision.brokeAt = input.brokeAt;
  if (input.madeAt) decision.madeAt = input.madeAt;
  if (input.note) decision.note = input.note;

  decisions.push(decision);

  // Recording a replacement closes the one it replaces, in the same write.
  if (input.supersedes) {
    const j = decisions.findIndex((d) => d.id === input.supersedes);
    if (j < 0) throw new WriteRefused(`No decision "${input.supersedes}" to supersede.`);
    decisions[j] = { ...(decisions[j] as Decision), supersededBy: id };
  }

  const next = { ...map, decisions };
  guard(map, next);
  return { map: next, decision };
}

/** Mark a standing decision as having stopped holding, at a named feature. */
export function breakDecision(
  map: InterchangeMap,
  id: string,
  at: string,
  note?: string,
): { map: InterchangeMap; decision: Decision } {
  const decisions = (map.decisions ?? []).slice();
  const i = decisions.findIndex((d) => d.id === id);
  if (i < 0) throw new WriteRefused(`No decision "${id}" on this map.`);

  const decision: Decision = { ...(decisions[i] as Decision), brokeAt: at };
  if (note) decision.note = note;
  decisions[i] = decision;

  const next = { ...map, decisions };
  guard(map, next);
  return { map: next, decision };
}
