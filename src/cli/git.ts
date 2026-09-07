import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Handles both "git@github.com:owner/name.git" and the https form. */
export function parseRemote(url: string): { id: string; remote: string } | undefined {
  const m = /github\.com[:/]([^/\s]+)\/(\S+?)\/?$/.exec(url);
  if (!m) return undefined;
  const owner = m[1] as string;
  // Strip the .git suffix only, so a repo genuinely called "my.app" survives.
  const name = (m[2] as string).replace(/\.git$/, "");
  if (!name) return undefined;
  return { id: name, remote: `${owner}/${name}` };
}

/** Best effort: the GitHub remote of the repo we are standing in. */
export async function detectRemote(
  cwd: string,
): Promise<{ id: string; remote: string } | undefined> {
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd });
    return parseRemote(stdout.trim());
  } catch {
    return undefined;
  }
}

/**
 * The branch that counts as shipped, which is the remote's default - never
 * whatever happens to be checked out. Running init on a feature branch must
 * not bake that branch into the map.
 */
export async function detectDefaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
    });
    const ref = stdout.trim().replace(/^origin\//, "");
    return ref || undefined;
  } catch {
    // Not cloned, or origin/HEAD was never set. The map reader defaults to
    // "main", and saying nothing is better than guessing wrong.
    return undefined;
  }
}
