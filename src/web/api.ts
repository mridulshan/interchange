import type { InterchangeMap } from "../core/types.js";
import type { Issue } from "../core/graph.js";
import type { CheckResult } from "../core/check.js";

export interface MapResponse {
  map: InterchangeMap;
  path: string;
  /** File mtime, so a save cannot clobber a hand edit made meanwhile. */
  rev: number;
  issues: Issue[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(text.slice(0, 200) || res.statusText, res.status);
  }
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? res.statusText;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const api = {
  getMap: (): Promise<MapResponse> => call<MapResponse>("/api/map"),

  putMap: (map: InterchangeMap, rev: number): Promise<{ rev: number; issues: Issue[] }> =>
    call("/api/map", { method: "PUT", body: JSON.stringify({ map, rev }) }),

  check: (): Promise<CheckResult> => call<CheckResult>("/api/check", { method: "POST" }),
};
