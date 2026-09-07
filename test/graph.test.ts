import { describe, expect, it } from "vitest";
import { downstream, laneSpans, lanes, topoOrder, upstream, validate } from "../src/core/graph.js";
import { featureRepos } from "../src/core/types.js";
import { sketch } from "./fixture.js";

describe("blast radius", () => {
  it("finds everything sitting on a base layer, transitively", () => {
    const ids = downstream(sketch(), "routes").map((f) => f.id);
    expect(ids).toEqual(["users", "merge", "pending", "payout", "e2e", "notify"]);
  });

  it("returns downstream work in ship order, not discovery order", () => {
    const ids = downstream(sketch(), "merge").map((f) => f.id);
    expect(ids).toEqual(["pending", "e2e", "notify"]);
  });

  it("reports nothing for a leaf", () => {
    expect(downstream(sketch(), "notify")).toEqual([]);
  });

  it("walks the other way for what a feature stands on", () => {
    const ids = upstream(sketch(), "e2e").map((f) => f.id);
    expect(ids).toEqual(["routes", "users", "merge", "pending"]);
  });

  it("treats a base layer as standing on nothing", () => {
    expect(upstream(sketch(), "routes")).toEqual([]);
  });
});

describe("lines", () => {
  it("derives the repos a feature touched from both drawn repos and PRs", () => {
    const routes = sketch().features[0]!;
    expect(featureRepos(routes)).toEqual(["admin", "kyc", "web", "be"]);
  });

  it("puts repos in declaration order", () => {
    expect([...lanes(sketch()).entries()]).toEqual([
      ["web", 0],
      ["be", 1],
      ["rn", 2],
      ["admin", 3],
      ["kyc", 4],
    ]);
  });

  it("runs a line from its first station to its last, and no further", () => {
    const spans = laneSpans(sketch());
    // rn first appears at "pending" (row 3) and last at "notify" (row 6)
    expect(spans.get("rn")).toEqual([3, 6]);
    // kyc is only touched by the base layer
    expect(spans.get("kyc")).toEqual([0, 0]);
  });
});

describe("validation", () => {
  it("passes a well-formed map", () => {
    expect(validate(sketch())).toEqual([]);
  });

  it("rejects a dependency on a feature that is not on the map", () => {
    const m = sketch();
    m.features[1]!.deps = ["ghost"];
    const errs = validate(m).filter((i) => i.severity === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('sits on "ghost"');
  });

  it("rejects a repo that was never declared", () => {
    const m = sketch();
    m.features[1]!.repos = ["ios"];
    expect(validate(m).some((i) => i.severity === "error" && i.message.includes('"ios"'))).toBe(true);
  });

  it("rejects duplicate feature ids", () => {
    const m = sketch();
    m.features[2]!.id = "users";
    expect(validate(m).some((i) => i.message.includes("Duplicate feature id"))).toBe(true);
  });

  it("warns when a feature sits on something drawn after it", () => {
    const m = sketch();
    m.features[0]!.deps = ["e2e"];
    const warn = validate(m).find((i) => i.severity === "warning");
    expect(warn?.message).toContain("drawn after it");
  });

  it("catches a dependency cycle rather than looping forever", () => {
    const m = sketch();
    m.features[0]!.deps = ["pending"];
    expect(validate(m).some((i) => i.message.startsWith("Cycle:"))).toBe(true);
  });

  it("warns when two features claim the same pull request", () => {
    const m = sketch();
    m.features[3]!.prs = [{ repo: "web", number: 214 }];
    expect(validate(m).some((i) => i.message.includes("web#214 is claimed by both"))).toBe(true);
  });

  it("warns about a live feature with no pull request to reconcile against", () => {
    const m = sketch();
    delete m.features[1]!.prs;
    expect(validate(m).some((i) => i.message.includes("can never be reconciled"))).toBe(true);
  });
});

describe("topological order", () => {
  it("puts every dependency before the thing that sits on it", () => {
    const order = topoOrder(sketch()).map((f) => f.id);
    for (const f of sketch().features) {
      for (const d of f.deps ?? []) {
        expect(order.indexOf(d)).toBeLessThan(order.indexOf(f.id));
      }
    }
  });
});
