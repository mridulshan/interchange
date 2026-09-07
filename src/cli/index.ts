import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { InterchangeMap } from "../core/types.js";
import { serialize } from "../core/map.js";
import { MAP_FILENAME, findMapFile, loadMapFile, saveMapFile } from "../core/io.js";
import { runCheck } from "../core/check.js";
import { validate } from "../core/graph.js";
import { serve } from "../server/index.js";
import { flagBool, flagList, flagString, parseArgs } from "./args.js";
import type { FailOn } from "./report.js";
import { bold, dim, formatCheck, green, red, shouldFail, yellow } from "./report.js";

const exec = promisify(execFile);

const USAGE = `
${bold("interchange")} - a cross-repo map of what you shipped

  interchange serve            open the map in a browser
  interchange check            compare the map against the repos
  interchange init             create ${MAP_FILENAME} here

${bold("serve")}
  --port <n>                   port to listen on (default 4517)
  --open                       open a browser window

${bold("check")}
  --json                       machine-readable output
  --fail-on <none|warning|error>   exit non-zero at this level (default error)
  --since <iso-date>           how far back to look (default 180 days)
  --only <repo,repo>           check only these lines
  --max-pages <n>              pages of 100 pull requests per repo (default 5)
  --api-base <url>             GitHub Enterprise API root (or set GITHUB_API_URL)

${bold("common")}
  --map <path>                 use this map file instead of searching upward

Set GITHUB_TOKEN to read private repos and raise the rate limit.
`;

function die(msg: string): never {
  process.stderr.write(`${red("interchange")} ${msg}\n`);
  process.exit(2);
}

function locateMap(explicit: string | undefined): string {
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) die(`No map file at ${p}`);
    return p;
  }
  const found = findMapFile();
  if (!found) {
    die(`No ${MAP_FILENAME} here or in any parent directory. Run "interchange init" to start one.`);
  }
  return found;
}

/** Best effort: the GitHub remote of the repo we are standing in. */
async function detectRemote(cwd: string): Promise<{ id: string; remote: string } | undefined> {
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd });
    const m = /github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/.exec(stdout.trim());
    if (!m) return undefined;
    return { id: m[2] as string, remote: `${m[1]}/${m[2]}` };
  } catch {
    return undefined;
  }
}

async function detectBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function cmdInit(args: ReturnType<typeof parseArgs>): Promise<void> {
  const cwd = process.cwd();
  const target = join(cwd, MAP_FILENAME);
  if (existsSync(target) && !flagBool(args, "force")) {
    die(`${MAP_FILENAME} already exists here. Pass --force to overwrite it.`);
  }

  const detected = await detectRemote(cwd);
  const branch = await detectBranch(cwd);
  const map: InterchangeMap = {
    version: 1,
    title: "What we shipped, and what each thing holds up.",
    repos: detected
      ? [{ id: detected.id, remote: detected.remote, ...(branch ? { branch } : {}) }]
      : [],
    features: [],
  };

  await writeFile(target, serialize(map), "utf8");

  process.stdout.write(`${green("Created")} ${relative(cwd, target)}\n`);
  if (detected) {
    process.stdout.write(dim(`  Found one line: ${detected.id} (${detected.remote})\n`));
    process.stdout.write(dim("  Add the other repos this work spans, then draw your first feature.\n"));
  } else {
    process.stdout.write(dim("  No GitHub remote found here. Add your repos under \"repos\".\n"));
  }
  process.stdout.write(`\n  ${bold("interchange serve")}  to draw on it\n`);
  process.stdout.write(`  ${bold("interchange check")}  to compare it against the repos\n\n`);
}

async function cmdServe(args: ReturnType<typeof parseArgs>): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  // Fail fast on an unreadable map rather than serving a blank page.
  await loadMapFile(mapPath);

  const portFlag = flagString(args, "port");
  const { url } = await serve({
    mapPath,
    ...(portFlag ? { port: Number(portFlag) } : {}),
    check: checkOptions(args),
  });

  process.stdout.write(`\n  ${bold("Interchange")} ${url}\n`);
  process.stdout.write(`  ${dim(mapPath)}\n\n`);

  if (flagBool(args, "open")) {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(opener, [url]).catch(() => {
      /* opening a browser is a convenience, never a failure */
    });
  }
}

function checkOptions(args: ReturnType<typeof parseArgs>) {
  const since = flagString(args, "since");
  const only = flagList(args, "only");
  const maxPages = flagString(args, "max-pages");
  // GITHUB_API_URL is what Actions already sets on Enterprise runners.
  const apiBase = flagString(args, "api-base") ?? process.env["GITHUB_API_URL"];
  return {
    ...(since ? { since: new Date(since).toISOString() } : {}),
    ...(only ? { only } : {}),
    ...(maxPages ? { maxPages: Number(maxPages) } : {}),
    ...(apiBase ? { baseUrl: apiBase.replace(/\/+$/, "") } : {}),
  };
}

async function cmdCheck(args: ReturnType<typeof parseArgs>): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);

  const failOn = (flagString(args, "fail-on") ?? "error") as FailOn;
  if (!["none", "warning", "error"].includes(failOn)) {
    die(`--fail-on must be none, warning or error.`);
  }

  const result = await runCheck(map, checkOptions(args));

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write("\n" + formatCheck(result, mapPath) + "\n");
  }

  // Only record the check when it actually reached every repo, so a network
  // failure cannot make a stale map look freshly verified.
  if (!result.skipped.length && !flagBool(args, "no-stamp")) {
    await saveMapFile(mapPath, { ...map, checkedAt: result.checkedAt });
  }

  if (shouldFail(result, failOn)) process.exit(1);
}

async function cmdValidate(args: ReturnType<typeof parseArgs>): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  const issues = validate(await loadMapFile(mapPath));
  if (!issues.length) {
    process.stdout.write(`${green("ok")} ${mapPath}\n`);
    return;
  }
  for (const i of issues) {
    const tag = i.severity === "error" ? red("error") : yellow("check");
    process.stderr.write(`${tag} ${i.message}\n`);
  }
  if (issues.some((i) => i.severity === "error")) process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (flagBool(args, "help") || flagBool(args, "h") || !args.command) {
    process.stdout.write(USAGE);
    return;
  }

  switch (args.command) {
    case "serve":
      return cmdServe(args);
    case "check":
      return cmdCheck(args);
    case "validate":
      return cmdValidate(args);
    case "init":
      return cmdInit(args);
    default:
      die(`Unknown command "${args.command}". Try "interchange --help".`);
  }
}

main().catch((e: Error) => {
  process.stderr.write(`${red("interchange")} ${e.message}\n`);
  process.exit(2);
});
