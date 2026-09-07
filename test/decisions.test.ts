import { describe, expect, it } from "vitest";
import {
  broken,
  decisionsAt,
  decisionsUnder,
  standing,
  summarize,
  supersessionChain,
} from "../src/core/decisions.js";
import { upstream, validate } from "../src/core/graph.js";
import { decisionStatus } from "../src/core/types.js";
import { sketchWithDecisions } from "./fixture.js";

describe("decision status", () => {
  it("is derived, so a record cannot contradict itself", () => {
    expect(decisionStatus({ id: "a", chose: "x" })).toBe("standing");
    expect(decisionStatus({ id: "a", chose: "x", supersededBy: "b" })).toBe("superseded");
    expect(decisionStatus({ id: "a", chose: "x", brokeAt: "f" })).toBe("broken");
  });

  it("counts breaking as louder than being superseded", () => {
    expect(decisionStatus({ id: "a", chose: "x", supersededBy: "b", brokeAt: "f" })).toBe("broken");
  });
});

describe("finding decisions", () => {
  it("lists what was decided at a feature", () => {
    expect(decisionsAt(sketchWithDecisions(), "routes").map((d) => d.id)).toEqual([
      "fixed-delay",
      "shared-route-table",
    ]);
  });

  it("separates what still holds from what does not", () => {
    const m = sketchWithDecisions();
    expect(standing(m).map((d) => d.id)).toEqual([
      "fixed-delay",
      "shared-route-table",
      "roles-service",
    ]);
    expect(broken(m)).toEqual([]);

    m.decisions![0]!.brokeAt = "payout";
    expect(broken(m).map((d) => d.id)).toEqual(["fixed-delay"]);
    expect(standing(m).map((d) => d.id)).not.toContain("fixed-delay");
  });

  it("inherits decisions from every layer below, not just the ones named", () => {
    const m = sketchWithDecisions();
    // "pending" is named on fixed-delay, and sits on routes/users/merge, so it
    // inherits their calls whether or not anyone listed it.
    const ids = decisionsUnder(m, "pending", upstream(m, "pending").map((f) => f.id)).map((d) => d.id);
    expect(ids).toContain("fixed-delay");
    expect(ids).toContain("shared-route-table");
    expect(ids).toContain("roles-on-user");
    expect(ids).toContain("roles-service");
  });

  it("does not hand a base layer the decisions made above it", () => {
    const m = sketchWithDecisions();
    const ids = decisionsUnder(m, "routes", []).map((d) => d.id);
    expect(ids).not.toContain("roles-on-user");
  });

  it("follows a supersession chain oldest first", () => {
    expect(supersessionChain(sketchWithDecisions(), "roles-on-user").map((d) => d.id)).toEqual([
      "roles-on-user",
      "roles-service",
    ]);
  });

  it("stops rather than looping if a chain points at itself", () => {
    const m = sketchWithDecisions();
    m.decisions![3]!.supersededBy = "roles-on-user";
    expect(supersessionChain(m, "roles-on-user")).toHaveLength(2);
  });
});

describe("summarising a decision", () => {
  it("names the alternative that lost", () => {
    expect(summarize(sketchWithDecisions().decisions![1]!)).toBe(
      "One shared route table over Per-provider tables",
    );
  });

  it("says where it stopped holding", () => {
    const d = { id: "a", chose: "X", brokeAt: "payout" };
    expect(summarize(d)).toBe("X - broke at payout");
  });
});

describe("validating decisions", () => {
  it("passes a well-formed decision log", () => {
    expect(validate(sketchWithDecisions())).toEqual([]);
  });

  it("warns when something still rests on a decision that broke", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.brokeAt = "payout";
    const warn = validate(m).find((i) => i.severity === "warning");
    // payout is where it broke and pending is still standing on it
    expect(warn?.message).toBe(
      'Decision "fixed-delay" broke at payout, but pending still rests on it.',
    );
  });

  it("stays quiet when everything resting on it was reverted too", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.affects = ["payout"];
    m.decisions![0]!.brokeAt = "payout";
    expect(validate(m).filter((i) => i.message.includes("still rests"))).toEqual([]);
  });

  it("rejects a decision pointing at a feature that is not on the map", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.feature = "ghost";
    expect(validate(m).some((i) => i.severity === "error" && i.message.includes('"ghost"'))).toBe(true);
  });

  it("rejects a successor that does not exist", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.supersededBy = "nope";
    expect(validate(m).some((i) => i.message.includes('superseded by "nope"'))).toBe(true);
  });

  it("rejects a decision that supersedes itself", () => {
    const m = sketchWithDecisions();
    m.decisions![0]!.supersededBy = "fixed-delay";
    expect(validate(m).some((i) => i.message.includes("supersedes itself"))).toBe(true);
  });

  it("rejects duplicate decision ids", () => {
    const m = sketchWithDecisions();
    m.decisions![1]!.id = "fixed-delay";
    expect(validate(m).some((i) => i.message.includes("Duplicate decision id"))).toBe(true);
  });
});
