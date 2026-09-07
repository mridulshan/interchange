import type { Feature, InterchangeMap } from "./types.js";
import { decisionStatus, featureRepos } from "./types.js";

export function byId(map: InterchangeMap): Map<string, Feature> {
  const m = new Map<string, Feature>();
  for (const f of map.features) m.set(f.id, f);
  return m;
}

export function indexOf(map: InterchangeMap): Map<string, number> {
  const m = new Map<string, number>();
  map.features.forEach((f, i) => m.set(f.id, i));
  return m;
}

/**
 * Everything that sits on `id`, transitively, in ship order.
 * This is the "what breaks if I pull this out" question — the one the paper
 * sketch could not answer, because its arrows only point forward.
 */
export function downstream(map: InterchangeMap, id: string): Feature[] {
  const seen = new Set<string>();
  const out: Feature[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const f of map.features) {
      if (seen.has(f.id)) continue;
      if (!(f.deps ?? []).includes(cur)) continue;
      seen.add(f.id);
      out.push(f);
      stack.push(f.id);
    }
  }
  const order = indexOf(map);
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Everything `id` sits on, transitively, in ship order. */
export function upstream(map: InterchangeMap, id: string): Feature[] {
  const index = byId(map);
  const seen = new Set<string>();
  const out: Feature[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const dep of index.get(cur)?.deps ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const f = index.get(dep);
      if (f) out.push(f);
      stack.push(dep);
    }
  }
  const order = indexOf(map);
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Lane index per repo, in declaration order. */
export function lanes(map: InterchangeMap): Map<string, number> {
  const m = new Map<string, number>();
  map.repos.forEach((r, i) => m.set(r.id, i));
  return m;
}

/**
 * The rows between which a repo's line is drawn: from its first station to
 * its last. Outside that range the line does not exist yet, or is done.
 */
export function laneSpans(map: InterchangeMap): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  map.features.forEach((f, i) => {
    for (const r of featureRepos(f)) {
      const cur = spans.get(r);
      if (!cur) spans.set(r, [i, i]);
      else cur[1] = i;
    }
  });
  return spans;
}

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  featureId?: string;
  message: string;
}

/**
 * Structural problems in the map itself, before any repo is consulted.
 * Errors mean the map cannot be drawn honestly; warnings mean it is drawn
 * but says something suspect.
 */
export function validate(map: InterchangeMap): Issue[] {
  const issues: Issue[] = [];
  const repoIds = new Set(map.repos.map((r) => r.id));
  const seenIds = new Set<string>();
  const order = indexOf(map);
  const prOwner = new Map<string, string>();

  for (const r of map.repos) {
    if (!r.id) issues.push({ severity: "error", message: "A repo has no id." });
  }

  for (const f of map.features) {
    if (!f.id) {
      issues.push({ severity: "error", message: `Feature "${f.name}" has no id.` });
      continue;
    }
    if (seenIds.has(f.id)) {
      issues.push({ severity: "error", featureId: f.id, message: `Duplicate feature id "${f.id}".` });
    }
    seenIds.add(f.id);

    for (const r of featureRepos(f)) {
      if (!repoIds.has(r)) {
        issues.push({
          severity: "error",
          featureId: f.id,
          message: `"${f.name}" touches repo "${r}", which is not declared.`,
        });
      }
    }

    for (const d of f.deps ?? []) {
      if (!order.has(d)) {
        issues.push({
          severity: "error",
          featureId: f.id,
          message: `"${f.name}" sits on "${d}", which is not on the map.`,
        });
        continue;
      }
      if ((order.get(d) as number) > (order.get(f.id) as number)) {
        issues.push({
          severity: "warning",
          featureId: f.id,
          message: `"${f.name}" sits on "${d}", which is drawn after it.`,
        });
      }
    }

    for (const p of f.prs ?? []) {
      const key = `${p.repo}#${p.number}`;
      const owner = prOwner.get(key);
      if (owner && owner !== f.id) {
        issues.push({
          severity: "warning",
          featureId: f.id,
          message: `${key} is claimed by both "${owner}" and "${f.id}".`,
        });
      }
      prOwner.set(key, f.id);
    }

    if (f.status === "live" && !(f.prs ?? []).length) {
      issues.push({
        severity: "warning",
        featureId: f.id,
        message: `"${f.name}" is live but references no pull request, so it can never be reconciled.`,
      });
    }
  }

  const decisionIds = new Set<string>();
  for (const d of map.decisions ?? []) {
    if (decisionIds.has(d.id)) {
      issues.push({ severity: "error", message: `Duplicate decision id "${d.id}".` });
    }
    decisionIds.add(d.id);

    for (const [field, ref] of [
      ["feature", d.feature],
      ["brokeAt", d.brokeAt],
    ] as const) {
      if (ref && !order.has(ref)) {
        issues.push({
          severity: "error",
          message: `Decision "${d.id}" names ${field} "${ref}", which is not on the map.`,
        });
      }
    }
    for (const a of d.affects ?? []) {
      if (!order.has(a)) {
        issues.push({
          severity: "error",
          message: `Decision "${d.id}" affects "${a}", which is not on the map.`,
        });
      }
    }
    // A broken decision that still holds things up is the shape that hurts:
    // it says the ground moved and names who was standing on it.
    if (decisionStatus(d) === "broken") {
      const stillResting = (d.affects ?? []).filter((a) => {
        const f = map.features.find((x) => x.id === a);
        return f && f.status !== "reverted" && a !== d.brokeAt;
      });
      if (stillResting.length) {
        issues.push({
          severity: "warning",
          message: `Decision "${d.id}" broke at ${d.brokeAt}, but ${stillResting.join(
            ", ",
          )} still rest${stillResting.length === 1 ? "s" : ""} on it.`,
        });
      }
    }
  }

  for (const d of map.decisions ?? []) {
    if (d.supersededBy && !decisionIds.has(d.supersededBy)) {
      issues.push({
        severity: "error",
        message: `Decision "${d.id}" is superseded by "${d.supersededBy}", which does not exist.`,
      });
    }
    if (d.supersededBy === d.id) {
      issues.push({ severity: "error", message: `Decision "${d.id}" supersedes itself.` });
    }
  }

  for (const cycle of findCycles(map)) {
    issues.push({
      severity: "error",
      featureId: cycle[0] as string,
      message: `Cycle: ${cycle.join(" → ")} → ${cycle[0]}.`,
    });
  }

  return issues;
}

/** Dependency cycles. A feature cannot sit on something that sits on it. */
export function findCycles(map: InterchangeMap): string[][] {
  const index = byId(map);
  const state = new Map<string, 0 | 1 | 2>();
  const cycles: string[][] = [];
  const path: string[] = [];

  const walk = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const at = path.indexOf(id);
      if (at >= 0) cycles.push(path.slice(at));
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    path.push(id);
    for (const d of index.get(id)?.deps ?? []) if (index.has(d)) walk(d);
    path.pop();
    state.set(id, 2);
  };

  for (const f of map.features) walk(f.id);
  return cycles;
}

/** Ship order that respects dependencies, for re-sorting a map by hand. */
export function topoOrder(map: InterchangeMap): Feature[] {
  const index = byId(map);
  const done = new Set<string>();
  const out: Feature[] = [];
  const visit = (id: string, seen: Set<string>): void => {
    if (done.has(id) || seen.has(id)) return;
    seen.add(id);
    const f = index.get(id);
    if (!f) return;
    for (const d of f.deps ?? []) visit(d, seen);
    done.add(id);
    out.push(f);
  };
  for (const f of map.features) visit(f.id, new Set());
  return out;
}
