export interface Args {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** Small parser: --flag, --flag=value, --flag value, -short. */
export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    const name = a.replace(/^--?/, "");
    const eq = name.indexOf("=");
    if (eq >= 0) {
      flags[name.slice(0, eq)] = name.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }

  return { command: positional[0], flags, positional: positional.slice(1) };
}

export function flagString(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagList(args: Args, name: string): string[] | undefined {
  const v = flagString(args, name);
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export class UsageError extends Error {}

/** Flags every command accepts. */
export const GLOBAL_FLAGS = ["map", "json", "help", "h"] as const;

function nearest(name: string, known: string[]): string | undefined {
  // Cheap edit distance; only used to make an error message helpful.
  const score = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, () => []);
    for (let i = 0; i <= a.length; i++) d[i]![0] = i;
    for (let j = 0; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i]![j] = Math.min(
          d[i - 1]![j]! + 1,
          d[i]![j - 1]! + 1,
          d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return d[a.length]![b.length]!;
  };
  let best: string | undefined;
  let bestScore = Infinity;
  for (const k of known) {
    const s = score(name, k);
    if (s < bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return bestScore <= 3 ? best : undefined;
}

/**
 * Refuse a flag this command does not know.
 *
 * Silently ignoring one is the worst thing a tool can do to a caller that
 * cannot read its own output critically: `set x --statuss live` would report
 * success and change nothing, and an agent would believe it.
 */
export function checkFlags(args: Args, allowed: readonly string[]): void {
  const known = [...allowed, ...GLOBAL_FLAGS];
  const unknown = Object.keys(args.flags).filter((f) => !known.includes(f));
  if (!unknown.length) return;
  const first = unknown[0] as string;
  const guess = nearest(first, known);
  throw new UsageError(
    `Unknown option "--${first}"${guess ? `. Did you mean "--${guess}"?` : "."} ` +
      `This command takes: ${known.map((k) => `--${k}`).join(", ")}.`,
  );
}
