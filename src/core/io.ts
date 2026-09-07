import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InterchangeMap } from "./types.js";
import { parseMap, serialize } from "./map.js";

export const MAP_FILENAME = "interchange.json";

/** Walk up from `from` looking for the map file, the way git finds a repo. */
export function findMapFile(from: string = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, MAP_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadMapFile(path: string): Promise<InterchangeMap> {
  return parseMap(await readFile(path, "utf8"));
}

/**
 * Write through a temp file so an interrupted save cannot leave a truncated
 * map behind. This file is the only copy of the thing.
 */
export async function saveMapFile(path: string, map: InterchangeMap): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, serialize(map), "utf8");
  await rename(tmp, path);
}
