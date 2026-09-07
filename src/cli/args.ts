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
