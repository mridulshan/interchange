import type { PrRef } from "./types.js";

export class PrFormatError extends Error {}

/** "web#214" into a reference. The one shorthand humans and agents both type. */
export function parsePrRef(s: string): PrRef {
  const m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(s.trim());
  if (!m) throw new PrFormatError(`Pull requests look like "web#214" - got "${s}".`);
  return { repo: m[1] as string, number: Number(m[2]) };
}

export function parsePrRefs(list: string[]): PrRef[] {
  return list.filter(Boolean).map(parsePrRef);
}
