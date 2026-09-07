import { describe, expect, it } from "vitest";
import { MapFormatError, parseMap, serialize } from "../src/core/map.js";
import { sketch } from "./fixture.js";

describe("reading a map file", () => {
  it("round-trips without losing anything", () => {
    const m = sketch();
    expect(parseMap(serialize(m))).toEqual(m);
  });

  it("accepts the short pull request form", () => {
    const m = parseMap(
      JSON.stringify({
        version: 1,
        repos: ["web"],
        features: [{ id: "a", name: "A", status: "live", prs: ["web#12"] }],
      }),
    );
    expect(m.features[0]!.prs).toEqual([{ repo: "web", number: 12 }]);
    expect(m.repos[0]).toEqual({ id: "web" });
  });

  it("says where the problem is rather than just failing", () => {
    const bad = JSON.stringify({
      version: 1,
      repos: [{ id: "web" }],
      features: [{ id: "a", name: "A", status: "shipped" }],
    });
    expect(() => parseMap(bad)).toThrow(/features\[0\]\.status must be one of/);
  });

  it("rejects a remote that is not owner/name", () => {
    const bad = JSON.stringify({ version: 1, repos: [{ id: "web", remote: "web" }], features: [] });
    expect(() => parseMap(bad)).toThrow(/must look like "owner\/name"/);
  });

  it("refuses a version it cannot read", () => {
    expect(() => parseMap(JSON.stringify({ version: 99, repos: [], features: [] }))).toThrow(
      MapFormatError,
    );
  });

  it("reports invalid JSON as such", () => {
    expect(() => parseMap("{nope")).toThrow(/not valid JSON/);
  });

  it("treats an empty map as valid", () => {
    expect(parseMap('{"version":1}')).toEqual({ version: 1, repos: [], features: [] });
  });
});

describe("writing a map file", () => {
  it("keeps a fixed key order so diffs stay small", () => {
    const raw = JSON.parse(serialize(sketch()));
    expect(Object.keys(raw)).toEqual(["version", "repos", "features"]);
    expect(Object.keys(raw.features[0])).toEqual(["id", "name", "status", "repos", "prs"]);
    expect(Object.keys(raw.features[2])).toEqual(["id", "name", "status", "deps", "merge", "prs"]);
  });

  it("writes the same bytes for the same map", () => {
    expect(serialize(sketch())).toBe(serialize(sketch()));
  });

  it("drops empty arrays instead of writing noise", () => {
    const m = sketch();
    m.features[0]!.deps = [];
    expect(serialize(m)).not.toContain('"deps": []');
  });

  it("ends with a newline", () => {
    expect(serialize(sketch()).endsWith("}\n")).toBe(true);
  });
});
