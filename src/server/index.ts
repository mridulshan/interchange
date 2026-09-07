import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { InterchangeMap } from "../core/types.js";
import { normalize as normalizeMap } from "../core/map.js";
import { validate } from "../core/graph.js";
import { loadMapFile, saveMapFile } from "../core/io.js";
import { runCheck } from "../core/check.js";
import type { CheckOptions } from "../core/check.js";

const WEB_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface ServerOptions {
  mapPath: string;
  port?: number;
  host?: string;
  check?: CheckOptions;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 4_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function revOf(path: string): Promise<number> {
  return Math.floor((await stat(path)).mtimeMs);
}

/**
 * The server holds a GitHub token and writes to disk, so it refuses anything
 * that did not come from this machine's own browser: loopback bind plus a
 * Host check, which is what stops a page on the internet from driving it.
 */
function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = resolve(WEB_ROOT, normalize(rel));
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

export function createInterchangeServer(opts: ServerOptions) {
  const { mapPath } = opts;

  return createServer((req, res) => {
    void (async () => {
      try {
        if (!hostAllowed(req)) {
          json(res, 403, { error: "Interchange only answers requests from this machine." });
          return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (path === "/api/map" && req.method === "GET") {
          const map = await loadMapFile(mapPath);
          json(res, 200, { map, path: mapPath, rev: await revOf(mapPath), issues: validate(map) });
          return;
        }

        if (path === "/api/map" && req.method === "PUT") {
          const body = (await readBody(req)) as { map?: unknown; rev?: number };
          const incoming = normalizeMap(body.map);
          const current = await revOf(mapPath);
          if (typeof body.rev === "number" && body.rev !== current) {
            json(res, 409, {
              error: "The map file changed on disk since this page loaded.",
              rev: current,
            });
            return;
          }
          await saveMapFile(mapPath, incoming);
          json(res, 200, { rev: await revOf(mapPath), issues: validate(incoming) });
          return;
        }

        if (path === "/api/check" && req.method === "POST") {
          const map = await loadMapFile(mapPath);
          const result = await runCheck(map, opts.check ?? {});
          // Record when we last looked, so a stale map says so on its face.
          const stamped: InterchangeMap = { ...map, checkedAt: result.checkedAt };
          await saveMapFile(mapPath, stamped);
          json(res, 200, result);
          return;
        }

        if (path.startsWith("/api/")) {
          json(res, 404, { error: `No such endpoint: ${path}` });
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405).end("Method not allowed");
          return;
        }

        await serveStatic(res, path);
      } catch (e) {
        const msg = (e as Error).message ?? "Something went wrong.";
        if (!res.headersSent) json(res, 400, { error: msg });
        else res.end();
      }
    })();
  });
}

export async function serve(opts: ServerOptions): Promise<{ url: string; close: () => void }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createInterchangeServer(opts);
  const port = await listen(server, opts.port ?? 4517, host);
  return { url: `http://${host}:${port}`, close: () => server.close() };
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((res, rej) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      // Busy port: step forward rather than making the user pick one.
      if (e.code === "EADDRINUSE" && port < 4530) {
        listen(server, port + 1, host).then(res, rej);
      } else rej(e);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      res(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
