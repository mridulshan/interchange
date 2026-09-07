import type { Feature, InterchangeMap } from "../core/types.js";
import { featureRepos, repoColor } from "../core/types.js";
import { lanes } from "../core/graph.js";

export const LANE = 24;
export const PAD = 22;
export const ROW = 78;
export const MID = 39;
export const R = 6.5;

export function graphWidth(map: InterchangeMap): number {
  return PAD * 2 + Math.max(0, map.repos.length - 1) * LANE;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Everything written into the map is escaped; `backticks` are the one bit of
 * markup, because identifiers read badly without them.
 */
export function prose(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const x = (lane: number): number => PAD + lane * LANE;

export interface DrawContext {
  map: InterchangeMap;
  spans: Map<string, [number, number]>;
  lane: Map<string, number>;
}

export function drawContext(map: InterchangeMap, spans: Map<string, [number, number]>): DrawContext {
  return { map, spans, lane: lanes(map) };
}

/**
 * The repo lines that pass through the gap an opened inspector makes.
 * Without this the lines stop dead at the panel, which reads as the repo
 * ending rather than the row being open.
 */
export function detailRails(ctx: DrawContext, row: number): string {
  const { map, spans, lane } = ctx;
  const parts: string[] = [
    `<svg class="detail-rails" width="${graphWidth(map)}" aria-hidden="true">`,
  ];
  for (const repo of map.repos) {
    const span = spans.get(repo.id);
    const l = lane.get(repo.id);
    if (!span || l === undefined) continue;
    // Only lines that carry on below this row.
    if (row < span[0] || row >= span[1]) continue;
    parts.push(
      `<line x1="${x(l)}" y1="0" x2="${x(l)}" y2="100%" stroke="${esc(
        repoColor(map, repo.id),
      )}" stroke-width="3.4" opacity=".9"/>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

/**
 * One row of the map: the repo lines running through it, the bar joining the
 * lines this feature touched, and a station on each of them.
 */
export function rowSVG(ctx: DrawContext, f: Feature, row: number, delay: number): string {
  const { map, spans, lane } = ctx;
  const w = graphWidth(map);
  const parts: string[] = [
    `<svg class="svg" width="${w}" height="${ROW}" viewBox="0 0 ${w} ${ROW}" aria-hidden="true">`,
  ];

  // Repo lines, drawn only between a repo's first and last station.
  for (const repo of map.repos) {
    const span = spans.get(repo.id);
    const l = lane.get(repo.id);
    if (!span || l === undefined) continue;
    if (row < span[0] || row > span[1]) continue;
    const y1 = row === span[0] ? MID : 0;
    const y2 = row === span[1] ? MID : ROW;
    if (y1 === y2) continue;
    parts.push(
      `<line class="rail" x1="${x(l)}" y1="${y1}" x2="${x(l)}" y2="${y2}" stroke="${esc(
        repoColor(map, repo.id),
      )}" stroke-width="3.4" opacity=".9" style="--len:${ROW};--d:${delay}s"/>`,
    );
  }

  const touched = featureRepos(f)
    .map((r) => lane.get(r))
    .filter((l): l is number => l !== undefined)
    .sort((a, b) => a - b);

  // The interchange bar: this feature landed on all these lines at once.
  if (touched.length > 1) {
    const a = x(touched[0] as number);
    const b = x(touched[touched.length - 1] as number);
    const op = f.status === "planned" ? ".28" : f.status === "reverted" ? ".3" : ".85";
    parts.push(
      `<line class="bar" x1="${a}" y1="${MID}" x2="${b}" y2="${MID}" stroke="#16232B" stroke-width="${
        f.merge ? 4.5 : 2.6
      }" stroke-linecap="round" opacity="${op}" style="--len:${b - a};--d:${delay + 0.12}s"/>`,
    );
  }

  for (const repoId of featureRepos(f)) {
    const l = lane.get(repoId);
    if (l === undefined) continue;
    const hex = esc(repoColor(map, repoId));
    const dash =
      f.status === "flight"
        ? ' stroke-dasharray="3.2 3.2"'
        : f.status === "planned"
          ? ' stroke-dasharray="2 4"'
          : "";
    const op = f.status === "planned" ? ".5" : f.status === "reverted" ? ".38" : "1";
    const sw = f.status === "planned" ? 2.4 : 3.5;

    if (f.merge) {
      parts.push(
        `<rect class="stn" x="${x(l) - R}" y="${MID - R}" width="${R * 2}" height="${
          R * 2
        }" transform="rotate(45 ${x(l)} ${MID})" fill="#F8F9F7" stroke="${hex}" stroke-width="${sw}" opacity="${op}" style="--d:${delay}s"/>`,
      );
    } else {
      parts.push(
        `<circle class="stn" cx="${x(l)}" cy="${MID}" r="${R}" fill="#F8F9F7" stroke="${hex}" stroke-width="${sw}"${dash} opacity="${op}" style="--d:${delay}s"/>`,
      );
    }

    if (f.status === "reverted") {
      parts.push(
        `<line class="stn" x1="${x(l) - 8}" y1="${MID + 8}" x2="${x(l) + 8}" y2="${
          MID - 8
        }" stroke="#5A6B74" stroke-width="2" style="--d:${delay}s"/>`,
      );
    }
  }

  // A row that arrived from a repo check, not from a person drawing it.
  if (f.drift) {
    const first = featureRepos(f)[0];
    const l = first !== undefined ? lane.get(first) : undefined;
    if (l !== undefined) {
      parts.push(
        `<circle class="stn" cx="${x(l) + 8}" cy="${MID - 8}" r="3.6" fill="#D64227" style="--d:${delay}s"/>`,
      );
    }
  }

  parts.push("</svg>");
  return parts.join("");
}
