import { describe, expect, it } from "vitest";
import { UsageError, checkFlags, parseArgs } from "../src/cli/args.js";

describe("parsing arguments", () => {
  it("reads --flag=value and --flag value alike", () => {
    expect(parseArgs(["set", "x", "--status=live", "--name", "A"]).flags).toEqual({
      status: "live",
      name: "A",
    });
  });

  it("treats a flag with no value as a boolean", () => {
    expect(parseArgs(["check", "--json"]).flags["json"]).toBe(true);
  });

  it("keeps the command separate from its positional arguments", () => {
    const a = parseArgs(["add", "Wallet", "top-up", "--id", "topup"]);
    expect(a.command).toBe("add");
    expect(a.positional).toEqual(["Wallet", "top-up"]);
  });
});

describe("rejecting unknown flags", () => {
  it("refuses a flag the command does not know", () => {
    const a = parseArgs(["set", "x", "--statuss", "live"]);
    expect(() => checkFlags(a, ["status"])).toThrow(UsageError);
  });

  it("suggests the flag that was probably meant", () => {
    const a = parseArgs(["set", "x", "--statuss", "live"]);
    expect(() => checkFlags(a, ["status"])).toThrow(/Did you mean "--status"\?/);
  });

  it("does not invent a suggestion for something unrelated", () => {
    const a = parseArgs(["set", "x", "--totally-unrelated"]);
    expect(() => checkFlags(a, ["status"])).toThrow(/Unknown option "--totally-unrelated"\./);
  });

  it("lists what the command does take", () => {
    const a = parseArgs(["set", "x", "--nope"]);
    expect(() => checkFlags(a, ["status", "name"])).toThrow(/--status, --name/);
  });

  it("always allows the global flags", () => {
    const a = parseArgs(["set", "x", "--map", "m.json", "--json"]);
    expect(() => checkFlags(a, ["status"])).not.toThrow();
  });

  it("passes a command called correctly", () => {
    const a = parseArgs(["set", "x", "--status", "live", "--add-pr", "web#1"]);
    expect(() => checkFlags(a, ["status", "add-pr"])).not.toThrow();
  });
});
