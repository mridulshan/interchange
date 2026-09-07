import { describe, expect, it } from "vitest";
import { featureContext, renderFeatureContext, renderMapContext } from "../src/core/context.js";
import { sketchWithDecisions } from "./fixture.js";

describe("briefing an agent about one feature", () => {
  it("names what it sits on and what rests on it", () => {
    const ctx = featureContext(sketchWithDecisions(), "pending");
    expect(ctx.sitsOn.map((s) => s.id)).toEqual(["routes", "users", "merge"]);
    expect(ctx.breaksIfRemoved.map((s) => s.id)).toEqual(["e2e", "notify"]);
  });

  it("carries up the assumptions made below it", () => {
    const ctx = featureContext(sketchWithDecisions(), "pending");
    expect(ctx.inheritedAssumptions.map((a) => a.from)).toEqual(["routes", "users", "merge"]);
  });

  it("lists the standing decisions it must not break", () => {
    const ids = featureContext(sketchWithDecisions(), "pending").mustNotBreak.map((d) => d.id);
    expect(ids).toContain("fixed-delay");
    expect(ids).toContain("shared-route-table");
  });

  it("keeps superseded decisions out of what must not break", () => {
    const ids = featureContext(sketchWithDecisions(), "pending").mustNotBreak.map((d) => d.id);
    expect(ids).not.toContain("roles-on-user");
  });

  it("warns about a decision it inherits that already broke elsewhere", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.brokeAt = "payout";
    const ctx = featureContext(m, "pending");
    expect(ctx.brokenNearby.map((d) => d.id)).toEqual(["fixed-delay"]);
    expect(ctx.mustNotBreak.map((d) => d.id)).not.toContain("fixed-delay");
  });

  it("refuses a feature that is not on the map", () => {
    expect(() => featureContext(sketchWithDecisions(), "ghost")).toThrow(/No feature "ghost"/);
  });

  it("says plainly when nothing rests on it", () => {
    const text = renderFeatureContext(featureContext(sketchWithDecisions(), "notify"));
    expect(text).toContain("## Breaks if you pull this out\n- nothing");
  });
});

describe("rendering for a context window", () => {
  it("puts the feature, its lines and its constraints in the text", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.brokeAt = "payout";
    const text = renderFeatureContext(featureContext(m, "pending"));
    expect(text).toContain("# Application pending actions  [live]");
    expect(text).toContain("lines: web, be, rn");
    expect(text).toContain("Decisions already known to be broken here");
    expect(text).toContain("fixed-delay");
  });

  it("collapses newlines so one item stays one line", () => {
    const m = sketchWithDecisions();
    m.features[3]!.assumes = "line one\nline two";
    const text = renderFeatureContext(featureContext(m, "pending"));
    expect(text).toContain("line one line two");
  });

  it("gives a cold agent the whole map in ship order", () => {
    const text = renderMapContext(sketchWithDecisions());
    expect(text).toContain("7 features across 5 lines");
    expect(text.indexOf("1. routes")).toBeLessThan(text.indexOf("2. users"));
    expect(text).toContain("## Standing decisions - still holding");
  });

  it("separates broken decisions from standing ones in the map view", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.brokeAt = "payout";
    const text = renderMapContext(m);
    expect(text).toContain("## Broken decisions - these stopped holding");
    const broken = text.slice(text.indexOf("## Broken decisions"));
    expect(broken).toContain("fixed-delay");
  });
});
