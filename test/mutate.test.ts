import { describe, expect, it } from "vitest";
import { WriteRefused, addFeature, breakDecision, decide, setFeature } from "../src/cli/mutate.js";
import { validate } from "../src/core/graph.js";
import { sketch, sketchWithDecisions } from "./fixture.js";

describe("adding a feature from a script", () => {
  it("appends to ship order and derives an id from the name", () => {
    const { map, feature } = addFeature(sketch(), { name: "Refund reversal", prs: ["be#801"] });
    expect(feature.id).toBe("refund-reversal");
    expect(map.features.at(-1)!.id).toBe("refund-reversal");
    expect(feature.repos).toBeUndefined(); // derived from the PR
  });

  it("places a feature directly after another when asked", () => {
    const { map } = addFeature(sketch(), { name: "Hotfix", prs: ["be#800"], after: "pending" });
    const ids = map.features.map((f) => f.id);
    expect(ids.indexOf("hotfix")).toBe(ids.indexOf("pending") + 1);
  });

  it("refuses a feature that touches no line", () => {
    expect(() => addFeature(sketch(), { name: "Nothing" })).toThrow(/at least one line/);
  });

  it("refuses a duplicate id rather than overwriting", () => {
    expect(() => addFeature(sketch(), { id: "users", name: "Users again", prs: ["web#9"] })).toThrow(
      /already on the map/,
    );
  });

  it("refuses a dependency that is not on the map, and writes nothing", () => {
    const before = sketch();
    expect(() => addFeature(before, { name: "X", prs: ["web#9"], deps: ["ghost"] })).toThrow(
      WriteRefused,
    );
    expect(before.features).toHaveLength(7);
  });

  it("rejects a malformed pull request reference", () => {
    expect(() => addFeature(sketch(), { name: "X", prs: ["web-9"] })).toThrow(/look like "web#214"/);
  });
});

describe("updating a feature", () => {
  it("changes status without touching anything else", () => {
    const { feature } = setFeature(sketch(), "e2e", { status: "live" });
    expect(feature.status).toBe("live");
    expect(feature.name).toBe("End-to-end coverage");
    expect(feature.prs).toHaveLength(1);
  });

  it("appends pull requests without duplicating what is there", () => {
    const { feature } = setFeature(sketch(), "users", { addPrs: ["web#231", "admin#5"] });
    expect(feature.prs!.map((p) => `${p.repo}#${p.number}`)).toEqual([
      "web#231",
      "be#690",
      "admin#5",
    ]);
  });

  it("refuses an unknown status", () => {
    expect(() => setFeature(sketch(), "users", { status: "shipped" })).toThrow(/must be one of/);
  });

  it("refuses a feature that is not there", () => {
    expect(() => setFeature(sketch(), "ghost", { status: "live" })).toThrow(/No feature "ghost"/);
  });
});

describe("recording a decision", () => {
  it("derives an id and attaches it to a feature", () => {
    const { map, decision } = decide(sketch(), { chose: "Polling over push", at: "pending" });
    expect(decision.id).toBe("polling-over-push");
    expect(map.decisions).toHaveLength(1);
  });

  it("closes the decision it replaces in the same write", () => {
    const { map } = decide(sketchWithDecisions(), {
      chose: "Per-provider route tables",
      supersedes: "shared-route-table",
    });
    const old = map.decisions!.find((d) => d.id === "shared-route-table")!;
    expect(old.supersededBy).toBe("per-provider-route-tables");
  });

  it("refuses to supersede something that does not exist", () => {
    expect(() => decide(sketch(), { chose: "X", supersedes: "nope" })).toThrow(/No decision "nope"/);
  });

  it("refuses to attach a decision to a feature that is not on the map", () => {
    expect(() => decide(sketch(), { chose: "X", at: "ghost" })).toThrow(WriteRefused);
  });
});

describe("breaking a decision", () => {
  it("records where it stopped holding", () => {
    const { decision } = breakDecision(sketchWithDecisions(), "fixed-delay", "payout");
    expect(decision.brokeAt).toBe("payout");
  });

  it("leaves a warning for whatever still rests on it", () => {
    const { map } = breakDecision(sketchWithDecisions(), "fixed-delay", "payout");
    expect(validate(map).some((i) => i.message.includes("pending still rests on it"))).toBe(true);
  });

  it("refuses a decision that is not on the map", () => {
    expect(() => breakDecision(sketch(), "nope", "payout")).toThrow(/No decision "nope"/);
  });
});
