import type { Decision, InterchangeMap } from "./types.js";
import { decisionStatus } from "./types.js";

/** Decisions made at a given feature. */
export function decisionsAt(map: InterchangeMap, featureId: string): Decision[] {
  return (map.decisions ?? []).filter((d) => d.feature === featureId);
}

/**
 * Decisions this feature rests on: the ones it was explicitly listed under,
 * plus every decision made at anything it sits on, transitively.
 *
 * That second half is the point. A feature inherits the calls made beneath it
 * whether or not anyone remembered to write it down, which is exactly how the
 * payout revert happened.
 */
export function decisionsUnder(
  map: InterchangeMap,
  featureId: string,
  upstreamIds: string[],
): Decision[] {
  const below = new Set(upstreamIds);
  const out: Decision[] = [];
  for (const d of map.decisions ?? []) {
    const named = (d.affects ?? []).includes(featureId);
    const inherited = d.feature !== undefined && below.has(d.feature);
    if (named || inherited) out.push(d);
  }
  return out;
}

export function standing(map: InterchangeMap): Decision[] {
  return (map.decisions ?? []).filter((d) => decisionStatus(d) === "standing");
}

export function broken(map: InterchangeMap): Decision[] {
  return (map.decisions ?? []).filter((d) => decisionStatus(d) === "broken");
}

export function decisionById(map: InterchangeMap, id: string): Decision | undefined {
  return (map.decisions ?? []).find((d) => d.id === id);
}

/**
 * A decision and everything that replaced it, oldest first. Stops rather than
 * loops if the chain points back at itself.
 */
export function supersessionChain(map: InterchangeMap, id: string): Decision[] {
  const out: Decision[] = [];
  const seen = new Set<string>();
  let cur = decisionById(map, id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.supersededBy ? decisionById(map, cur.supersededBy) : undefined;
  }
  return out;
}

/** One line, for a terminal or an agent's context window. */
export function summarize(d: Decision): string {
  const status = decisionStatus(d);
  const parts = [d.chose];
  if (d.over) parts.push(`over ${d.over}`);
  const head = parts.join(" ");
  if (status === "broken") return `${head} - broke at ${d.brokeAt}`;
  if (status === "superseded") return `${head} - superseded by ${d.supersededBy}`;
  return head;
}
