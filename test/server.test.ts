import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import type { AddressInfo as _AddressInfo } from "node:net";
import { createInterchangeServer } from "../src/server/index.js";
import { serialize } from "../src/core/map.js";
import { sketch } from "./fixture.js";

let dir: string;
let mapPath: string;
let base: string;
let server: ReturnType<typeof createInterchangeServer>;

/** GET with a Host header of our choosing. */
function rawGet(path: string, host: string): Promise<number> {
  const port = (server.address() as _AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function start(check?: Record<string, unknown>): Promise<void> {
  server = createInterchangeServer({ mapPath, ...(check ? { check } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "interchange-"));
  mapPath = join(dir, "interchange.json");
  await writeFile(mapPath, serialize(sketch()), "utf8");
  await start();
});

afterEach(() => {
  server.close();
});

describe("GET /api/map", () => {
  it("returns the map with its revision and any issues", async () => {
    const res = await fetch(`${base}/api/map`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map.features).toHaveLength(7);
    expect(body.path).toBe(mapPath);
    expect(typeof body.rev).toBe("number");
    expect(body.issues).toEqual([]);
  });
});

describe("PUT /api/map", () => {
  it("writes the map to disk", async () => {
    const { map, rev } = await (await fetch(`${base}/api/map`)).json();
    map.features[0].name = "Payment routes v2";

    const res = await fetch(`${base}/api/map`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map, rev }),
    });
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(await readFile(mapPath, "utf8"));
    expect(onDisk.features[0].name).toBe("Payment routes v2");
  });

  it("refuses to clobber a file that changed underneath it", async () => {
    const { map, rev } = await (await fetch(`${base}/api/map`)).json();

    // Somebody edits the JSON by hand while the page is open.
    const edited = sketch();
    edited.features[0]!.name = "Edited by hand";
    await new Promise((r) => setTimeout(r, 12));
    await writeFile(mapPath, serialize(edited), "utf8");

    const res = await fetch(`${base}/api/map`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map, rev }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(await readFile(mapPath, "utf8")).features[0].name).toBe("Edited by hand");
  });

  it("rejects a malformed map instead of writing it", async () => {
    const res = await fetch(`${base}/api/map`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map: { version: 1, repos: [], features: [{ id: "a" }] } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/features\[0\]\.name/);
    expect(JSON.parse(await readFile(mapPath, "utf8")).features).toHaveLength(7);
  });
});

describe("POST /api/check", () => {
  it("reconciles against the repos and stamps the map", async () => {
    server.close();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify([
          {
            number: 999,
            title: "Snuck in",
            html_url: "https://github.com/acme/web/pull/999",
            merged_at: "2026-09-01T00:00:00Z",
            state: "closed",
            updated_at: "2026-09-01T00:00:00Z",
          },
        ]),
        { status: 200 },
      );
    await start({ fetchImpl });

    const res = await fetch(`${base}/api/check`, { method: "POST" });
    const body = await res.json();
    expect(body.findings.some((f: { kind: string }) => f.kind === "unmapped-pr")).toBe(true);
    expect(JSON.parse(await readFile(mapPath, "utf8")).checkedAt).toBeTruthy();
  });
});

describe("guards", () => {
  it("answers only to this machine", async () => {
    // fetch() will not let a caller forge Host, so ask over a raw socket -
    // which is exactly what a DNS-rebinding attack would do.
    const status = await rawGet("/api/map", "evil.example.com");
    expect(status).toBe(403);
    expect(await rawGet("/api/map", "localhost")).toBe(200);
  });

  it("does not serve files outside the web root", async () => {
    const res = await fetch(`${base}/../../package.json`, { redirect: "manual" });
    expect(res.status).not.toBe(200);
  });

  it("says so plainly for an unknown endpoint", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("/api/nope");
  });
});
