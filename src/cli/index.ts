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
import { UsageError, checkFlags, flagBool, flagList, flagString, parseArgs } from "./args.js";
import { detectDefaultBranch, detectRemote } from "./git.js";
import {
  WriteRefused,
  addFeature,
  addRepo,
  breakDecision,
  decide,
  removeDecision,
  removeFeature,
  removeRepo,
  setFeature,
} from "./mutate.js";
import { featureContext, renderFeatureContext, renderMapContext } from "../core/context.js";
import { applyFinding, ignoreFinding } from "../core/drift.js";
import { parsePrRef } from "../core/prs.js";
import { broken, standing, summarize } from "../core/decisions.js";
import { decisionStatus } from "../core/types.js";
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

${bold("writing")} - for scripts and agents; every write is validated first
  interchange add <name>       --status --repos --deps --prs --after
                               --assumes --exposes --chose --merge --id
  interchange set <id>         --status --name --assumes --exposes --chose
                               --add-pr --add-dep --remove-pr --remove-dep
  interchange decide <text>    --over --because --cost --at --affects
                               --supersedes --id
  interchange broke <id>       --at <feature>   mark a decision as stopped holding
  interchange accept <pr>      take a drift finding onto the map  --id --name --deps
  interchange ignore <pr>      record that it was never a feature  --reason
  interchange rm <id>          remove a feature or decision  --force --kind
  interchange repo add <id>    --remote owner/name --branch --label --color
  interchange repo list        the lines on this map
  interchange repo rm <id>

${bold("reading")}
  interchange context [id]     what to know before changing something
  interchange decisions        the decision log  --standing --broken

${bold("common")}
  --map <path>                 use this map file instead of searching upward
  --json                       machine-readable output, on every command above

Set GITHUB_TOKEN to read private repos and raise the rate limit.
`;

/**
 * Downstream closing the pipe is not an error. Without this, `interchange
 * context | head` dies with a stack trace, which is exactly what a script or
 * an agent would do first.
 */
function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(0);
      throw e;
    });
  }
}

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

async function cmdInit(args: ReturnType<typeof parseArgs>): Promise<void> {
  const cwd = process.cwd();
  const target = join(cwd, MAP_FILENAME);
  if (existsSync(target) && !flagBool(args, "force")) {
    die(`${MAP_FILENAME} already exists here. Pass --force to overwrite it.`);
  }

  const detected = await detectRemote(cwd);
  const branch = await detectDefaultBranch(cwd);
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
    if (!branch) {
      process.stdout.write(
        dim('  Could not read the default branch, so the map assumes "main". Set "branch" if not.\n'),
      );
    }
    process.stdout.write(
      dim("  Declare the other repos this work spans: interchange repo add <id> --remote owner/name\n"),
    );
  } else {
    process.stdout.write(
      dim("  No GitHub remote found here. Declare one: interchange repo add web --remote owner/name\n"),
    );
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

/** What each command accepts, so anything else is refused rather than ignored. */
const FLAGS: Record<string, readonly string[]> = {
  serve: ["port", "open", "since", "only", "max-pages", "api-base"],
  check: ["fail-on", "since", "only", "max-pages", "api-base", "no-stamp"],
  validate: [],
  init: ["force"],
  add: ["id", "status", "after", "assumes", "exposes", "chose", "repos", "deps", "prs", "merge"],
  set: ["status", "name", "assumes", "exposes", "chose", "add-pr", "add-dep", "remove-pr", "remove-dep"],
  decide: ["id", "over", "because", "cost", "at", "supersedes", "note", "made-at", "affects"],
  broke: ["at", "note"],
  rm: ["force", "kind"],
  accept: ["id", "name", "deps", "since", "max-pages", "api-base"],
  ignore: ["reason"],
  repo: ["remote", "branch", "label", "color"],
  context: [],
  decisions: ["standing", "broken"],
};

function out(args: ReturnType<typeof parseArgs>, human: string, machine: unknown): void {
  process.stdout.write(flagBool(args, "json") ? JSON.stringify(machine, null, 2) + "\n" : human);
}

async function withMap(
  args: ReturnType<typeof parseArgs>,
  fn: (map: InterchangeMap) => { map: InterchangeMap; [k: string]: unknown },
  describe: (r: { map: InterchangeMap; [k: string]: unknown }) => [string, unknown],
): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);
  const result = fn(map);
  await saveMapFile(mapPath, result.map);
  const [human, machine] = describe(result);
  out(args, human, machine);
}

async function cmdAdd(args: ReturnType<typeof parseArgs>): Promise<void> {
  const name = args.positional.join(" ").trim();
  if (!name) die('add needs a name: interchange add "Users tab" --prs web#231');
  await withMap(
    args,
    (map) =>
      addFeature(map, {
        name,
        ...opt(args, "id"),
        ...opt(args, "status"),
        ...opt(args, "after"),
        ...opt(args, "assumes"),
        ...opt(args, "exposes"),
        ...opt(args, "chose"),
        ...(flagList(args, "repos") ? { repos: flagList(args, "repos") as string[] } : {}),
        ...(flagList(args, "deps") ? { deps: flagList(args, "deps") as string[] } : {}),
        ...(flagList(args, "prs") ? { prs: flagList(args, "prs") as string[] } : {}),
        ...(flagBool(args, "merge") ? { merge: true } : {}),
      }),
    (r) => {
      const f = r["feature"] as { id: string; name: string; status: string };
      return [`${green("Drew")} ${f.id} - ${f.name} [${f.status}]\n`, f];
    },
  );
}

async function cmdSet(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.positional[0];
  if (!id) die("set needs a feature id: interchange set pending --status live");
  await withMap(
    args,
    (map) =>
      setFeature(map, id, {
        ...opt(args, "status"),
        ...opt(args, "name"),
        ...opt(args, "assumes"),
        ...opt(args, "exposes"),
        ...opt(args, "chose"),
        ...(flagList(args, "add-pr") ? { addPrs: flagList(args, "add-pr") as string[] } : {}),
        ...(flagList(args, "add-dep") ? { addDeps: flagList(args, "add-dep") as string[] } : {}),
        ...(flagList(args, "remove-pr") ? { removePrs: flagList(args, "remove-pr") as string[] } : {}),
        ...(flagList(args, "remove-dep") ? { removeDeps: flagList(args, "remove-dep") as string[] } : {}),
      }),
    (r) => {
      const f = r["feature"] as { id: string; name: string; status: string };
      return [`${green("Updated")} ${f.id} - ${f.name} [${f.status}]\n`, f];
    },
  );
}

async function cmdDecide(args: ReturnType<typeof parseArgs>): Promise<void> {
  const chose = args.positional.join(" ").trim();
  if (!chose) die('decide needs the call: interchange decide "Polling over push" --at pending');
  await withMap(
    args,
    (map) =>
      decide(map, {
        chose,
        ...opt(args, "id"),
        ...opt(args, "over"),
        ...opt(args, "because"),
        ...opt(args, "cost"),
        ...opt(args, "at"),
        ...opt(args, "supersedes"),
        ...opt(args, "note"),
        ...(flagString(args, "made-at") ? { madeAt: flagString(args, "made-at") as string } : {}),
        ...(flagList(args, "affects") ? { affects: flagList(args, "affects") as string[] } : {}),
      }),
    (r) => {
      const d = r["decision"] as { id: string; chose: string };
      return [`${green("Recorded")} ${d.id} - ${d.chose}\n`, d];
    },
  );
}

async function cmdBroke(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.positional[0];
  const at = flagString(args, "at");
  if (!id || !at) die("broke needs both: interchange broke fixed-delay --at payout");
  await withMap(
    args,
    (map) => breakDecision(map, id, at, flagString(args, "note")),
    (r) => {
      const d = r["decision"] as { id: string; brokeAt?: string };
      return [`${yellow("Broken")} ${d.id} - stopped holding at ${d.brokeAt}\n`, d];
    },
  );
}

/**
 * The two buttons the browser has, as commands: take a finding onto the map,
 * or record that it was never a feature. Without these an agent can read a
 * drift report and do nothing about it.
 */
async function cmdAccept(args: ReturnType<typeof parseArgs>): Promise<void> {
  const ref = args.positional[0];
  if (!ref) throw new UsageError("accept needs a pull request: interchange accept be#115");
  const pr = parsePrRef(ref);

  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);

  // Scope the check to the one line, so accepting is cheap.
  const result = await runCheck(map, { ...checkOptions(args), only: [pr.repo] });
  const finding = result.findings.find(
    (f) => f.kind === "unmapped-pr" && f.pr?.repo === pr.repo && f.pr?.number === pr.number,
  );
  if (!finding) {
    throw new WriteRefused(
      `${ref} is not an unmapped pull request. Either it already has a row, or the check could not see it.`,
    );
  }

  // Let the caller correct the guesses rather than accept them blindly.
  const suggestion = { ...finding.suggestion! };
  const id = flagString(args, "id");
  const name = flagString(args, "name");
  const deps = flagList(args, "deps");
  if (id) suggestion.id = id;
  if (name) suggestion.name = name;
  if (deps) suggestion.deps = deps;

  const next = applyFinding(map, { ...finding, suggestion });
  await saveMapFile(mapPath, next);
  out(args, `${green("Added")} ${suggestion.id} - ${suggestion.name} (from ${ref})\n`, suggestion);
}

async function cmdIgnore(args: ReturnType<typeof parseArgs>): Promise<void> {
  const ref = args.positional[0];
  if (!ref) throw new UsageError("ignore needs a pull request: interchange ignore be#115");
  const pr = parsePrRef(ref);

  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);

  if ((map.ignore ?? []).some((i) => i.repo === pr.repo && i.number === pr.number)) {
    out(args, `${dim("Already ignored")} ${ref}\n`, { repo: pr.repo, number: pr.number });
    return;
  }
  const claimed = map.features.find((f) =>
    (f.prs ?? []).some((p) => p.repo === pr.repo && p.number === pr.number),
  );
  if (claimed) {
    throw new WriteRefused(
      `${ref} already has a row ("${claimed.id}"). Remove it from that feature first.`,
    );
  }

  const next = ignoreFinding(
    map,
    { kind: "unmapped-pr", severity: "error", source: pr.repo, message: "", pr },
    flagString(args, "reason"),
  );
  await saveMapFile(mapPath, next);
  out(args, `${yellow("Left off the map")} ${ref}\n`, next.ignore?.at(-1));
}

async function cmdRm(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new UsageError("rm needs an id: interchange rm topup");
  const kind = flagString(args, "kind");
  if (kind && kind !== "feature" && kind !== "decision") {
    throw new UsageError('--kind must be "feature" or "decision".');
  }

  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);
  const isFeature = map.features.some((f) => f.id === id);
  const isDecision = (map.decisions ?? []).some((d) => d.id === id);

  if (!isFeature && !isDecision) throw new WriteRefused(`Nothing called "${id}" on this map.`);
  if (isFeature && isDecision && !kind) {
    throw new UsageError(
      `"${id}" is both a feature and a decision. Pass --kind feature or --kind decision.`,
    );
  }
  const target = kind ?? (isFeature ? "feature" : "decision");

  if (target === "decision") {
    const r = removeDecision(map, id);
    await saveMapFile(mapPath, r.map);
    out(args, `${yellow("Removed")} decision ${r.decision.id}\n`, r.decision);
    return;
  }

  const r = removeFeature(map, id, flagBool(args, "force"));
  await saveMapFile(mapPath, r.map);
  const note = r.detached.length ? ` (detached ${r.detached.join(", ")})` : "";
  out(args, `${yellow("Removed")} ${r.feature.id} - ${r.feature.name}${note}\n`, {
    feature: r.feature,
    detached: r.detached,
  });
}

async function cmdRepo(args: ReturnType<typeof parseArgs>): Promise<void> {
  const [action, id] = args.positional;
  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);

  if (!action || action === "list") {
    if (flagBool(args, "json")) {
      process.stdout.write(JSON.stringify(map.repos, null, 2) + "\n");
      return;
    }
    if (!map.repos.length) {
      process.stdout.write(dim("No lines declared yet. interchange repo add web --remote acme/web\n"));
      return;
    }
    for (const r of map.repos) {
      const remote = r.remote ? `${r.remote}@${r.branch ?? "main"}` : dim("no remote - never checked");
      process.stdout.write(`${bold(r.id)}${r.label && r.label !== r.id ? ` (${r.label})` : ""}  ${remote}\n`);
    }
    return;
  }

  if (!id) die(`repo ${action} needs a line id: interchange repo ${action} be`);

  if (action === "add") {
    const r = addRepo(map, {
      id,
      ...opt(args, "remote"),
      ...opt(args, "branch"),
      ...opt(args, "label"),
      ...opt(args, "color"),
    });
    await saveMapFile(mapPath, r.map);
    out(
      args,
      `${green("Declared")} ${r.repo.id}${r.repo.remote ? ` (${r.repo.remote})` : ""}\n`,
      r.repo,
    );
    return;
  }

  if (action === "rm" || action === "remove") {
    const r = removeRepo(map, id);
    await saveMapFile(mapPath, r.map);
    out(args, `${yellow("Removed")} line ${r.repo.id}\n`, r.repo);
    return;
  }

  die(`Unknown repo action "${action}". Try: add, rm, list.`);
}

async function cmdContext(args: ReturnType<typeof parseArgs>): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);
  const id = args.positional[0];

  if (!id) {
    out(args, renderMapContext(map), {
      title: map.title,
      repos: map.repos,
      features: map.features,
      decisions: map.decisions ?? [],
    });
    return;
  }

  let ctx;
  try {
    ctx = featureContext(map, id);
  } catch (e) {
    // The map said no, which is not the same as being called wrong.
    throw new WriteRefused((e as Error).message);
  }
  out(args, renderFeatureContext(ctx), ctx);
}

async function cmdDecisions(args: ReturnType<typeof parseArgs>): Promise<void> {
  const mapPath = locateMap(flagString(args, "map"));
  const map = await loadMapFile(mapPath);

  let list = map.decisions ?? [];
  if (flagBool(args, "standing")) list = standing(map);
  if (flagBool(args, "broken")) list = broken(map);

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return;
  }
  if (!list.length) {
    process.stdout.write(dim("No decisions recorded yet.\n"));
    return;
  }
  for (const d of list) {
    const st = decisionStatus(d);
    const tag = st === "standing" ? green("standing") : st === "broken" ? red("broken") : dim("superseded");
    process.stdout.write(`${tag}  ${bold(d.id)}\n  ${summarize(d)}\n`);
    if (d.feature) process.stdout.write(dim(`  decided at ${d.feature}\n`));
    if (d.cost) process.stdout.write(dim(`  cost: ${d.cost}\n`));
    process.stdout.write("\n");
  }
}

/** Pull an optional string flag into a spreadable object. */
function opt(args: ReturnType<typeof parseArgs>, name: string): Record<string, string> {
  const v = flagString(args, name);
  const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return v === undefined ? {} : { [key]: v };
}

async function main(): Promise<void> {
  ignoreBrokenPipe();
  const args = parseArgs(process.argv.slice(2));

  if (flagBool(args, "help") || flagBool(args, "h") || !args.command) {
    process.stdout.write(USAGE);
    return;
  }

  const allowed = FLAGS[args.command];
  if (allowed) checkFlags(args, allowed);

  switch (args.command) {
    case "serve":
      return cmdServe(args);
    case "check":
      return cmdCheck(args);
    case "validate":
      return cmdValidate(args);
    case "init":
      return cmdInit(args);
    case "add":
      return cmdAdd(args);
    case "set":
      return cmdSet(args);
    case "decide":
      return cmdDecide(args);
    case "broke":
      return cmdBroke(args);
    case "context":
      return cmdContext(args);
    case "decisions":
      return cmdDecisions(args);
    case "rm":
      return cmdRm(args);
    case "repo":
      return cmdRepo(args);
    case "accept":
      return cmdAccept(args);
    case "ignore":
      return cmdIgnore(args);
    default:
      die(`Unknown command "${args.command}". Try "interchange --help".`);
  }
}

main().catch((e: Error) => {
  process.stderr.write(`${red("interchange")} ${e.message}\n`);
  // 1: the map said no. 2: you called it wrong.
  process.exit(e instanceof UsageError ? 2 : e instanceof WriteRefused ? 1 : 2);
});
