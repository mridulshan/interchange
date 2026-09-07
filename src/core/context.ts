import type { Decision, Feature, InterchangeMap } from "./types.js";
import { decisionStatus, featureRepos } from "./types.js";
import { downstream, upstream } from "./graph.js";
import { broken, decisionsAt, decisionsUnder, standing, summarize } from "./decisions.js";

/**
 * A briefing for whoever is about to change something - increasingly an
 * agent rather than a person.
 *
 * The map already knows what rests on what and which calls are still holding.
 * This is that knowledge in the shape a context window wants: the constraints
 * first, the blast radius named, and nothing else.
 */
export interface FeatureContext {
  feature: Feature;
  repos: string[];
  sitsOn: { id: string; name: string; status: string; exposes?: string }[];
  breaksIfRemoved: { id: string; name: string; status: string }[];
  inheritedAssumptions: { from: string; assumes: string }[];
  mustNotBreak: Decision[];
  brokenNearby: Decision[];
}

export function featureContext(map: InterchangeMap, featureId: string): FeatureContext {
  const feature = map.features.find((f) => f.id === featureId);
  if (!feature) throw new Error(`No feature "${featureId}" on this map.`);

  const up = upstream(map, featureId);
  const upIds = up.map((f) => f.id);
  const under = decisionsUnder(map, featureId, upIds);

  return {
    feature,
    repos: featureRepos(feature),
    sitsOn: up.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      ...(f.exposes ? { exposes: f.exposes } : {}),
    })),
    breaksIfRemoved: downstream(map, featureId).map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
    })),
    inheritedAssumptions: up
      .filter((f) => f.assumes)
      .map((f) => ({ from: f.id, assumes: f.assumes as string })),
    mustNotBreak: [...decisionsAt(map, featureId), ...under].filter(
      (d) => decisionStatus(d) === "standing",
    ),
    brokenNearby: [...decisionsAt(map, featureId), ...under].filter(
      (d) => decisionStatus(d) === "broken",
    ),
  };
}

function line(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function decisionLine(d: Decision): string {
  const bits = [`${d.id}: ${line(summarize(d))}`];
  if (d.feature) bits.push(`(decided at ${d.feature})`);
  const out = bits.join(" ");
  return d.cost ? `${out}\n    cost: ${line(d.cost)}` : out;
}

/** One feature, as text to paste into a prompt. */
export function renderFeatureContext(ctx: FeatureContext): string {
  const f = ctx.feature;
  const out: string[] = [];

  out.push(`# ${f.name}  [${f.status}]`);
  out.push(`id: ${f.id}   lines: ${ctx.repos.join(", ") || "none"}`);
  if (f.prs?.length) {
    out.push(`pull requests: ${f.prs.map((p) => `${p.repo}#${p.number}`).join(", ")}`);
  }

  if (f.assumes) {
    out.push("", "## Assumes", line(f.assumes));
  }
  if (f.exposes) {
    out.push("", "## Hands up", line(f.exposes));
  }
  if (f.chose) {
    out.push("", "## Chose", line(f.chose));
  }

  if (ctx.sitsOn.length) {
    out.push("", "## Sits on");
    for (const s of ctx.sitsOn) {
      out.push(`- ${s.id} (${s.status}) ${s.name}${s.exposes ? ` - hands up: ${line(s.exposes)}` : ""}`);
    }
  }

  if (ctx.inheritedAssumptions.length) {
    out.push("", "## Assumptions inherited from below");
    for (const a of ctx.inheritedAssumptions) out.push(`- from ${a.from}: ${line(a.assumes)}`);
  }

  if (ctx.mustNotBreak.length) {
    out.push("", "## Standing decisions this rests on - do not break without saying so");
    for (const d of ctx.mustNotBreak) out.push(`- ${decisionLine(d)}`);
  }

  if (ctx.brokenNearby.length) {
    out.push("", "## Decisions already known to be broken here");
    for (const d of ctx.brokenNearby) out.push(`- ${decisionLine(d)}`);
  }

  out.push("", "## Breaks if you pull this out");
  out.push(
    ctx.breaksIfRemoved.length
      ? ctx.breaksIfRemoved.map((d) => `- ${d.id} (${d.status}) ${d.name}`).join("\n")
      : "- nothing",
  );

  return out.join("\n") + "\n";
}

/** The whole map, compact, for an agent starting cold. */
export function renderMapContext(map: InterchangeMap): string {
  const out: string[] = [];
  out.push(`# Interchange map${map.title ? ` - ${line(map.title)}` : ""}`);
  out.push(
    `${map.features.length} features across ${map.repos.length} lines, in ship order (earliest first).`,
  );
  out.push(`Lines: ${map.repos.map((r) => r.label ?? r.id).join(", ") || "none"}`);

  out.push("", "## Features");
  map.features.forEach((f, i) => {
    const deps = f.deps?.length ? ` sits-on:${f.deps.join(",")}` : " sits-on:-";
    out.push(`${i + 1}. ${f.id} [${f.status}] ${f.name}${deps} lines:${featureRepos(f).join(",")}`);
    if (f.assumes) out.push(`   assumes: ${line(f.assumes)}`);
    if (f.exposes) out.push(`   hands up: ${line(f.exposes)}`);
  });

  const live = standing(map);
  if (live.length) {
    out.push("", "## Standing decisions - still holding");
    for (const d of live) out.push(`- ${decisionLine(d)}`);
  }

  const dead = broken(map);
  if (dead.length) {
    out.push("", "## Broken decisions - these stopped holding");
    for (const d of dead) out.push(`- ${decisionLine(d)}`);
  }

  return out.join("\n") + "\n";
}
