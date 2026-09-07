import { describe, expect, it } from "vitest";
import { applyFinding, ignoreFinding, reconcile, slugify } from "../src/core/drift.js";
import type { RepoState } from "../src/core/drift.js";
import type { PrRef } from "../src/core/types.js";
import { sketch } from "./fixture.js";

function merged(repo: string, number: number, title?: string, mergedAt?: string): PrRef {
  return { repo, number, state: "merged", ...(title ? { title } : {}), ...(mergedAt ? { mergedAt } : {}) };
}

/** Repo state where every PR the map already claims merged as drawn. */
function asDrawn(): RepoState[] {
  return [
    { repo: "web", merged: [merged("web", 214), merged("web", 231), merged("web", 240), merged("web", 266)], open: [] },
    { repo: "be", merged: [merged("be", 661), merged("be", 690), merged("be", 722), merged("be", 730)], open: [] },
    { repo: "rn", merged: [merged("rn", 63)], open: [] },
    { repo: "admin", merged: [], open: [] },
    { repo: "kyc", merged: [], open: [] },
  ];
}

describe("reconcile", () => {
  it("says nothing when the repos match the map", () => {
    const m = sketch();
    // e2e is drawn in flight; make its PR still open so it stays honest.
    const states = asDrawn();
    states[0]!.merged = states[0]!.merged.filter((p) => p.number !== 266);
    states[0]!.open = [{ repo: "web", number: 266, state: "open" }];
    expect(reconcile(m, states)).toEqual([]);
  });

  it("catches work merged to main that was never drawn", () => {
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Offline queue", "2026-09-01T10:00:00Z"));
    const f = reconcile(sketch(), states).find((x) => x.kind === "unmapped-pr");
    expect(f).toBeDefined();
    expect(f!.source).toBe("rn/main");
    expect(f!.message).toContain("rn#78");
    expect(f!.severity).toBe("error");
  });

  it("proposes a row for unmapped work but never writes one", () => {
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Offline queue", "2026-09-01T10:00:00Z"));
    const before = sketch();
    const f = reconcile(before, states).find((x) => x.kind === "unmapped-pr")!;
    expect(f.suggestion).toMatchObject({
      id: "offline-queue",
      name: "Offline queue",
      status: "live",
      repos: ["rn"],
      drift: true,
    });
    expect(before.features.map((x) => x.id)).not.toContain("offline-queue");
  });

  it("guesses that unmapped work sits on the last thing drawn in that repo", () => {
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Offline queue"));
    const f = reconcile(sketch(), states).find((x) => x.kind === "unmapped-pr")!;
    // "notify" is planned and "payout" is reverted, so the guess skips them.
    expect(f.suggestion!.deps).toEqual(["pending"]);
  });

  it("stays quiet about a merged PR that was deliberately left undrawn", () => {
    const m = sketch();
    m.ignore = [{ repo: "rn", number: 78, reason: "dependency bump" }];
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Bump deps"));
    expect(reconcile(m, states).filter((f) => f.kind === "unmapped-pr")).toEqual([]);
  });

  it("notices a feature drawn as in flight whose work all merged", () => {
    const f = reconcile(sketch(), asDrawn()).find((x) => x.kind === "status-behind");
    expect(f?.featureId).toBe("e2e");
    expect(f?.suggestedStatus).toBe("live");
  });

  it("notices a feature drawn as live whose work is still open", () => {
    const states = asDrawn();
    states[1]!.merged = states[1]!.merged.filter((p) => p.number !== 722);
    states[1]!.open = [{ repo: "be", number: 722, state: "open" }];
    const f = reconcile(sketch(), states).find((x) => x.kind === "status-ahead");
    expect(f?.featureId).toBe("pending");
    expect(f?.suggestedStatus).toBe("flight");
  });

  it("notices work that was closed without merging", () => {
    const states = asDrawn();
    states[1]!.merged = states[1]!.merged.filter((p) => p.number !== 722);
    states[1]!.closed = [{ repo: "be", number: 722, state: "closed" }];
    const f = reconcile(sketch(), states).find((x) => x.kind === "pr-abandoned");
    expect(f?.featureId).toBe("pending");
  });

  it("does not read an unfetched pull request as evidence of anything", () => {
    // A window that returned nothing at all must produce no status findings.
    const empty: RepoState[] = sketch().repos.map((r) => ({ repo: r.id, merged: [], open: [] }));
    expect(reconcile(sketch(), empty)).toEqual([]);
  });

  it("leaves a reverted feature alone when its PR is merged", () => {
    // payout#730 is merged upstream and drawn as reverted: that is the
    // normal shape of a revert, not a finding.
    const found = reconcile(sketch(), asDrawn()).filter((f) => f.featureId === "payout");
    expect(found).toEqual([]);
  });
});

describe("accepting a finding", () => {
  it("inserts a proposed row directly under what it sits on", () => {
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Offline queue"));
    const m = sketch();
    const f = reconcile(m, states).find((x) => x.kind === "unmapped-pr")!;
    const next = applyFinding(m, f);
    const ids = next.features.map((x) => x.id);
    expect(ids.indexOf("offline-queue")).toBe(ids.indexOf("pending") + 1);
    expect(m.features).toHaveLength(7); // original untouched
  });

  it("corrects a status without touching anything else", () => {
    const m = sketch();
    const f = reconcile(m, asDrawn()).find((x) => x.kind === "status-behind")!;
    const next = applyFinding(m, f);
    expect(next.features.find((x) => x.id === "e2e")!.status).toBe("live");
    expect(m.features.find((x) => x.id === "e2e")!.status).toBe("flight");
  });

  it("records a rejection so the same PR is not raised twice", () => {
    const states = asDrawn();
    states[2]!.merged.push(merged("rn", 78, "Bump deps"));
    const m = sketch();
    const f = reconcile(m, states).find((x) => x.kind === "unmapped-pr")!;
    const next = ignoreFinding(m, f, "dependency bump");
    expect(next.ignore).toEqual([{ repo: "rn", number: 78, reason: "dependency bump" }]);
    expect(reconcile(next, states).filter((x) => x.kind === "unmapped-pr")).toEqual([]);
  });
});

describe("slugify", () => {
  it("makes a readable id from a pull request title", () => {
    expect(slugify("Offline queue for pending actions")).toBe("offline-queue-for-pending-actions");
  });

  it("does not collide with an id already on the map", () => {
    expect(slugify("Users tab", new Set(["users-tab"]))).toBe("users-tab-2");
    expect(slugify("Users tab", new Set(["users-tab", "users-tab-2"]))).toBe("users-tab-3");
  });

  it("falls back rather than producing an empty id", () => {
    expect(slugify("!!!")).toBe("feature");
  });
});

describe("staying honest about a partial window", () => {
  it("does not claim a feature shipped when only some of its work was seen", () => {
    // e2e references web#266 only in this fixture's shape; give the check a
    // feature whose second PR lives in a repo the fetch never reached.
    const m = sketch();
    m.features[5]!.prs = [
      { repo: "web", number: 266 },
      { repo: "admin", number: 95 },
    ];
    const states: RepoState[] = [
      { repo: "web", merged: [merged("web", 266)], open: [] },
      { repo: "admin", merged: [], open: [] },
    ];
    expect(reconcile(m, states).filter((f) => f.kind === "status-behind")).toEqual([]);
  });

  it("still reports it once the whole feature is in view", () => {
    const m = sketch();
    m.features[5]!.prs = [
      { repo: "web", number: 266 },
      { repo: "admin", number: 95 },
    ];
    const states: RepoState[] = [
      { repo: "web", merged: [merged("web", 266)], open: [] },
      { repo: "admin", merged: [merged("admin", 95)], open: [] },
    ];
    const f = reconcile(m, states).find((x) => x.kind === "status-behind");
    expect(f?.featureId).toBe("e2e");
  });
});

describe("ids derived from text", () => {
  it("cuts at a word boundary rather than mid-word", () => {
    // "...minor-uni" was the old behaviour and reads like a typo.
    expect(slugify("Store balance as an integer of minor units")).toBe(
      "store-balance-as-an-integer-of-minor",
    );
  });

  it("keeps a long single word usable rather than producing nothing", () => {
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });
});
