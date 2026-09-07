import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const built = existsSync(CLI);

let dir: string;
let mapPath: string;
let stub: Server;
let api: string;

/** Run the built CLI the way an agent would, and report exit code and output. */
async function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [CLI, ...args, "--map", mapPath],
      { cwd: dir },
      (err, stdout, stderr) => {
        res({
          code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

const PRS: Record<string, { number: number; title: string; merged_at: string | null }[]> = {
  "acme/web": [{ number: 412, title: "Wallets web", merged_at: "2026-09-01T00:00:00Z" }],
  "acme/backend": [
    { number: 101, title: "Wallet balance", merged_at: "2026-09-01T00:00:00Z" },
    { number: 115, title: "Wallet audit log", merged_at: "2026-09-06T00:00:00Z" },
    { number: 120, title: "Bump lodash", merged_at: "2026-09-07T00:00:00Z" },
  ],
};

beforeAll(async () => {
  if (!built) return;
  stub = createServer((req, res) => {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls/.exec(req.url ?? "");
    const page = Number(new URL(req.url ?? "/", "http://x").searchParams.get("page") ?? 1);
    const list = page === 1 && m ? (PRS[`${m[1]}/${m[2]}`] ?? []) : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        list.map((p) => ({
          ...p,
          state: "closed",
          html_url: `https://x/${p.number}`,
          updated_at: p.merged_at,
        })),
      ),
    );
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  dir = await mkdtemp(join(tmpdir(), "ic-e2e-"));
  mapPath = join(dir, "interchange.json");
  await writeFile(
    mapPath,
    JSON.stringify({ version: 1, repos: [{ id: "web", remote: "acme/web" }], features: [] }),
  );
});

afterAll(() => stub?.close());

const maybe = built ? describe : describe.skip;

/**
 * The question this file answers: can something that cannot read its own
 * output critically drive this CLI without corrupting the map?
 */
maybe("an agent delivering a feature end to end", () => {
  it("declares a line the feature needs", async () => {
    const r = await run("repo", "add", "be", "--remote", "acme/backend");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Declared be");
  });

  it("draws the feature before building it", async () => {
    const r = await run("add", "Wallets", "--id", "wallets", "--repos", "web,be", "--status", "planned");
    expect(r.code).toBe(0);
  });

  it("records the design call", async () => {
    const r = await run("decide", "Store balance in minor units", "--id", "minor-units", "--at", "wallets");
    expect(r.code).toBe(0);
  });

  it("moves it to live as the work lands", async () => {
    expect((await run("set", "wallets", "--status", "flight", "--add-pr", "be#101")).code).toBe(0);
    expect((await run("set", "wallets", "--status", "live", "--add-pr", "web#412")).code).toBe(0);
  });

  it("finds work that shipped without a row", async () => {
    const r = await run("check", "--api-base", api, "--no-stamp");
    expect(r.code).toBe(1);
    expect(r.out).toContain("be#115");
  });

  it("takes the proposed row onto the map", async () => {
    const r = await run("accept", "be#115", "--api-base", api);
    expect(r.code).toBe(0);
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    expect(map.features.some((f: { id: string }) => f.id === "wallet-audit-log")).toBe(true);
  });

  it("records a chore as never having been a feature", async () => {
    expect((await run("ignore", "be#120", "--reason", "dependency bump")).code).toBe(0);
    const r = await run("check", "--api-base", api, "--no-stamp");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing shipped that isn't drawn");
  });

  it("marks the call as broken when the revert proves it wrong", async () => {
    expect((await run("set", "wallet-audit-log", "--status", "reverted")).code).toBe(0);
    expect((await run("broke", "minor-units", "--at", "wallet-audit-log")).code).toBe(0);
  });

  it("leaves a valid map at the end", async () => {
    const r = await run("validate");
    expect(r.code).toBe(0);
  });
});

maybe("guarantees an agent depends on", () => {
  it("refuses an unknown flag rather than ignoring it", async () => {
    const before = await readFile(mapPath, "utf8");
    const r = await run("set", "wallets", "--statuss", "live");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Unknown option "--statuss"/);
    expect(await readFile(mapPath, "utf8")).toBe(before);
  });

  it("suggests the flag that was meant", async () => {
    expect((await run("add", "X", "--repos", "web", "--stat", "live")).out).toMatch(
      /Did you mean "--status"\?/,
    );
  });

  it("separates a refusal from being called wrong", async () => {
    expect((await run("context", "no-such-feature")).code).toBe(1);
    expect((await run("frobnicate")).code).toBe(2);
  });

  it("writes nothing when a write would break the map", async () => {
    const before = await readFile(mapPath, "utf8");
    const r = await run("add", "Bad", "--repos", "web", "--deps", "ghost");
    expect(r.code).toBe(1);
    expect(await readFile(mapPath, "utf8")).toBe(before);
  });

  it("refuses to remove something other work sits on", async () => {
    const r = await run("rm", "wallets");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--force/);
  });

  it("reports a correction that would be a no-op instead of claiming success", async () => {
    const r = await run("set", "wallets", "--remove-pr", "be#777");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not reference/);
  });

  it("emits parseable json for every read", async () => {
    for (const cmd of [["context"], ["context", "wallets"], ["decisions"], ["repo", "list"]]) {
      const r = await run(...cmd, "--json");
      expect(r.code, cmd.join(" ")).toBe(0);
      expect(() => JSON.parse(r.out), cmd.join(" ")).not.toThrow();
    }
  });
});
