import type { Feature, InterchangeMap } from "../core/types.js";
import { repoColor, repoLabel } from "../core/types.js";
import type { Issue } from "../core/graph.js";
import { downstream, laneSpans } from "../core/graph.js";
import { featureContext } from "../core/context.js";
import { summarize } from "../core/decisions.js";
import type { Decision } from "../core/types.js";
import type { Finding } from "../core/drift.js";
import { applyFinding, ignoreFinding } from "../core/drift.js";
import type { CheckResult } from "../core/check.js";
import { ApiError, api } from "./api.js";
import { detailRails, drawContext, esc, graphWidth, prose, rowSVG } from "./draw.js";
import { renderEditor } from "./editor.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  lines: $("lines"),
  rows: $("rows"),
  banner: $("banner"),
  bannerH: $("banner-h"),
  findings: $("findings"),
  issues: $("issues"),
  scan: $<HTMLButtonElement>("scan"),
  add: $<HTMLButtonElement>("add"),
  stamp: $("stamp"),
  subtitle: $("subtitle"),
  foot: $("foot"),
  editor: $("editor"),
  shade: $("shade"),
  toast: $("toast"),
};

interface State {
  map: InterchangeMap;
  rev: number;
  path: string;
  issues: Issue[];
  open: string | null;
  followed: string | null;
  findings: Finding[] | null;
  handled: Set<number>;
  check: CheckResult | null;
  editing: { feature: Feature | null } | null;
}

const state: State = {
  map: { version: 1, repos: [], features: [] },
  rev: 0,
  path: "",
  issues: [],
  open: null,
  followed: null,
  findings: null,
  handled: new Set(),
  check: null,
  editing: null,
};

const STATUS_TAG: Record<string, { t: string; c: string }> = {
  live: { t: "live", c: "live" },
  flight: { t: "in flight", c: "flight" },
  reverted: { t: "reverted", c: "reverted" },
  planned: { t: "planned", c: "planned" },
};

let toastTimer: number | undefined;
function toast(msg: string, bad = false): void {
  el.toast.textContent = msg;
  el.toast.className = `toast${bad ? " bad" : ""}`;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

/* ---------------- rendering ---------------- */

function renderLines(): void {
  el.lines.innerHTML = state.map.repos
    .map(
      (r) =>
        `<button class="chip" data-repo="${esc(r.id)}" data-on="${
          state.followed === r.id ? 1 : 0
        }" style="--c:${esc(repoColor(state.map, r.id))}"><span class="dot"></span>${esc(
          repoLabel(state.map, r.id),
        )}</button>`,
    )
    .join("");
}

function fieldOr(key: string, value: string | undefined, gap: string): string {
  const body = value
    ? `<span class="v">${prose(value)}</span>`
    : `<span class="v gap">${esc(gap)}</span>`;
  return `<p class="field"><span class="k">${esc(key)}</span>${body}</p>`;
}

function decisionList(list: Decision[], bad: boolean): string {
  return (
    '<span class="calls">' +
    list
      .map((d) => {
        const where = d.feature ? ` <span class="at">decided at ${esc(d.feature)}</span>` : "";
        const cost = d.cost ? `<span class="cost">cost: ${prose(d.cost)}</span>` : "";
        return `<span class="call${bad ? " bad" : ""}"><b>${esc(d.id)}</b> ${prose(
          summarize(d),
        )}${where}${cost}</span>`;
      })
      .join("") +
    "</span>"
  );
}

function renderDetail(f: Feature, rails: string): string {
  const down = downstream(state.map, f.id);
  const blast = down.length
    ? down.map((d) => `<span>${esc(d.name)}</span>`).join("")
    : '<span class="none">Nothing yet</span>';

  const up = (f.deps ?? [])
    .map((d) => state.map.features.find((x) => x.id === d)?.name ?? d)
    .join(", ");

  const prs = (f.prs ?? [])
    .map((p) =>
      p.url
        ? `<a class="prlink" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.repo)}#${p.number}</a>`
        : `${esc(p.repo)}#${p.number}`,
    )
    .join(" · ");

  const out: string[] = [rails, '<div class="detail-in">'];

  if (f.drift) {
    out.push(
      '<p class="field warn"><span class="k">Drifted</span><span class="v">Found on the branch, added from a repo check rather than drawn at merge time.</span></p>',
    );
  }

  out.push(
    `<p class="field"><span class="k">Sits on</span><span class="v">${
      up ? esc(up) : "Nothing. This is the floor."
    }</span></p>`,
  );
  out.push(fieldOr("Assumes", f.assumes, "Not written down."));
  out.push(fieldOr("Hands up", f.exposes, "Not written down."));
  // Optional on purpose: an empty "Chose" is a visible gap, not a blocked save.
  out.push(fieldOr("Chose", f.chose, "No decision recorded."));
  out.push(
    `<p class="field"><span class="k">Breaks if you pull this out</span><span class="v"><span class="blast">${blast}</span></span></p>`,
  );
  out.push(
    `<p class="field"><span class="k">Pull requests</span><span class="v">${
      prs || '<span class="gap">None referenced.</span>'
    }</span></p>`,
  );
  const ctx = featureContext(state.map, f.id);
  if (ctx.mustNotBreak.length) {
    out.push(
      `<p class="field"><span class="k">Rests on these calls holding</span><span class="v">${decisionList(
        ctx.mustNotBreak,
        false,
      )}</span></p>`,
    );
  }
  if (ctx.brokenNearby.length) {
    out.push(
      `<p class="field warn"><span class="k">Calls here that stopped holding</span><span class="v">${decisionList(
        ctx.brokenNearby,
        true,
      )}</span></p>`,
    );
  }

  if (f.note) out.push(fieldOr("Note", f.note, ""));
  out.push(
    `<div class="detail-acts"><button class="ghost" data-edit="${esc(f.id)}">Edit</button></div>`,
  );
  out.push("</div>");
  return out.join("");
}

let painted = false;

function renderRows(): void {
  const { map } = state;
  document.documentElement.style.setProperty("--graph", `${graphWidth(map)}px`);
  // Only the first paint traces the lines; later renders appear finished.
  el.rows.dataset["first"] = painted ? "0" : "1";

  if (!map.features.length) {
    el.rows.innerHTML = `<p class="empty">Nothing drawn yet. ${
      map.repos.length
        ? 'Start with the base layer — the thing everything else will sit on — and press "Draw a feature".'
        : `No repos declared either. Add some to <code>${esc(state.path)}</code>, or run <code>interchange init</code>.`
    }</p>`;
    return;
  }

  const spans = laneSpans(map);
  const ctx = drawContext(map, spans);
  const hit = new Set(state.open ? downstream(map, state.open).map((f) => f.id) : []);

  el.rows.innerHTML = map.features
    .map((f, i) => {
      // Following a line drops everything that line never touched.
      const dimmed =
        state.followed !== null &&
        !(f.repos ?? []).includes(state.followed) &&
        !(f.prs ?? []).some((p) => p.repo === state.followed);
      const st = STATUS_TAG[f.status] ?? { t: f.status, c: "" };

      let tags = `<span class="tag ${st.c}">${esc(st.t)}</span>`;
      if (f.drift) tags += '<span class="tag drift">drifted</span>';
      for (const r of new Set([...(f.repos ?? []), ...(f.prs ?? []).map((p) => p.repo)])) {
        const c = esc(repoColor(map, r));
        tags += `<span class="tag" style="border-color:${c};color:${c}">${esc(repoLabel(map, r))}</span>`;
      }

      const isOpen = state.open === f.id;
      return (
        `<button class="row${dimmed ? " dim" : ""}" data-id="${esc(f.id)}" data-status="${esc(
          f.status,
        )}" aria-expanded="${isOpen}">` +
        rowSVG(ctx, f, i, i * 0.07) +
        `<span class="body"><span class="name"${
          hit.has(f.id) ? ' style="color:var(--drift)"' : ""
        }>${esc(f.name)}</span><span class="tags">${tags}</span></span></button>` +
        (isOpen ? `<div class="detail">${renderDetail(f, detailRails(ctx, i))}</div>` : "")
      );
    })
    .join("");

  if (!painted && map.features.length) {
    painted = true;
    window.setTimeout(() => {
      el.rows.dataset["first"] = "0";
    }, 1400);
  }
}

function renderIssues(): void {
  if (!state.issues.length) {
    el.issues.hidden = true;
    return;
  }
  const errors = state.issues.filter((i) => i.severity === "error").length;
  el.issues.hidden = false;
  el.issues.innerHTML =
    `<h3>${
      errors
        ? `${errors} thing${errors === 1 ? "" : "s"} the map cannot draw honestly`
        : `${state.issues.length} thing${state.issues.length === 1 ? "" : "s"} worth a second look`
    }</h3>` +
    state.issues
      .map(
        (i) =>
          `<p class="issue${i.severity === "error" ? " error" : ""}"><b>${
            i.severity === "error" ? "Error" : "Check"
          }</b> — ${esc(i.message)}</p>`,
      )
      .join("");
}

function renderFindings(): void {
  const findings = state.findings;
  if (!findings) {
    el.banner.hidden = true;
    return;
  }
  el.banner.hidden = false;

  const left = findings.filter((_, i) => !state.handled.has(i));
  const skippedNote = state.check?.skipped.length
    ? `<p class="issue">${state.check.skipped
        .map((s) => `<b>${esc(s.repo)}</b> — ${esc(s.reason)}`)
        .join("<br>")}</p>`
    : "";

  if (!left.length) {
    el.banner.className = "banner ok";
    el.bannerH.textContent = findings.length
      ? "Map matches the repos"
      : "Map matches the repos — nothing shipped that isn't drawn";
    el.findings.innerHTML = skippedNote;
    el.scan.classList.add("clean");
    el.scan.textContent = "Up to date";
    return;
  }

  el.banner.className = "banner";
  el.scan.classList.remove("clean");
  const unmapped = left.filter((f) => f.kind === "unmapped-pr").length;
  el.bannerH.textContent = unmapped
    ? unmapped === 1
      ? "1 thing shipped that isn't on this map"
      : `${unmapped} things shipped that aren't on this map`
    : `${left.length} difference${left.length === 1 ? "" : "s"} between the map and the repos`;

  el.findings.innerHTML =
    findings
      .map((f, i) => {
        const done = state.handled.has(i);
        const acts =
          f.kind === "unmapped-pr"
            ? `<button class="add" data-accept="${i}"${done ? " disabled" : ""}>${
                done ? "Added" : "Add to map"
              }</button><button class="skip" data-ignore="${i}"${done ? " disabled" : ""}>Not a feature</button>`
            : `<button class="add" data-accept="${i}"${done ? " disabled" : ""}>${
                done ? "Fixed" : "Correct the map"
              }</button>`;
        return (
          `<div class="finding"><span class="src">${esc(f.source)}</span>` +
          `<span class="txt">${esc(f.message)}</span>` +
          `<span class="acts">${acts}</span></div>`
        );
      })
      .join("") + skippedNote;
}

function renderStamp(): void {
  const n = state.map.features.length;
  const r = state.map.repos.length;
  const checked = state.map.checkedAt
    ? ` · checked ${new Date(state.map.checkedAt).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "";
  el.stamp.textContent = `${n} feature${n === 1 ? "" : "s"} · ${r} repo${r === 1 ? "" : "s"} · ${state.path}${checked}`;
  if (state.map.title) el.subtitle.textContent = state.map.title;
}

function render(): void {
  renderLines();
  renderRows();
  renderIssues();
  renderFindings();
  renderStamp();
}

/* ---------------- persistence ---------------- */

async function save(next: InterchangeMap, msg: string): Promise<boolean> {
  try {
    const res = await api.putMap(next, state.rev);
    state.map = next;
    state.rev = res.rev;
    state.issues = res.issues;
    render();
    toast(msg);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      toast("The map file changed on disk. Reloading rather than overwriting it.", true);
      await load();
    } else {
      toast((e as Error).message, true);
    }
    return false;
  }
}

async function load(): Promise<void> {
  const res = await api.getMap();
  state.map = res.map;
  state.rev = res.rev;
  state.path = res.path;
  state.issues = res.issues;
  render();
}

/* ---------------- editor ---------------- */

function openEditor(feature: Feature | null): void {
  state.editing = { feature };
  el.editor.hidden = false;
  el.shade.hidden = false;
  renderEditor(el.editor, state.map, feature, {
    onClose: closeEditor,
    onSave: async (next, original) => {
      const features = state.map.features.slice();
      if (original) {
        const i = features.findIndex((f) => f.id === original.id);
        if (i >= 0) features[i] = next;
      } else {
        features.push(next);
      }
      const ok = await save({ ...state.map, features }, original ? "Saved." : "Drawn.");
      if (ok) closeEditor();
    },
    onDelete: async (f) => {
      const used = state.map.features.filter((x) => (x.deps ?? []).includes(f.id));
      if (used.length) {
        const names = used.map((x) => x.name).join(", ");
        if (!window.confirm(`${names} sit${used.length === 1 ? "s" : ""} on "${f.name}". Remove it anyway?`)) {
          return;
        }
      }
      const features = state.map.features
        .filter((x) => x.id !== f.id)
        .map((x) =>
          (x.deps ?? []).includes(f.id) ? { ...x, deps: (x.deps ?? []).filter((d) => d !== f.id) } : x,
        );
      const ok = await save({ ...state.map, features }, "Removed.");
      if (ok) {
        if (state.open === f.id) state.open = null;
        closeEditor();
      }
    },
  });
  (el.editor.querySelector("#e-name") as HTMLInputElement | null)?.focus();
}

function closeEditor(): void {
  state.editing = null;
  el.editor.hidden = true;
  el.shade.hidden = true;
  el.editor.innerHTML = "";
}

/* ---------------- events ---------------- */

el.rows.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;

  const edit = target.closest("[data-edit]") as HTMLElement | null;
  if (edit) {
    ev.stopPropagation();
    const f = state.map.features.find((x) => x.id === edit.dataset["edit"]);
    if (f) openEditor(f);
    return;
  }
  if (target.closest("a")) return;

  const row = target.closest(".row") as HTMLElement | null;
  if (!row) return;
  const id = row.dataset["id"] as string;
  state.open = state.open === id ? null : id;
  renderRows();
});

el.lines.addEventListener("click", (ev) => {
  const chip = (ev.target as HTMLElement).closest(".chip") as HTMLElement | null;
  if (!chip) return;
  const repo = chip.dataset["repo"] as string;
  state.followed = state.followed === repo ? null : repo;
  renderLines();
  renderRows();
});

el.add.addEventListener("click", () => openEditor(null));
el.shade.addEventListener("click", closeEditor);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.editing) closeEditor();
});

el.scan.addEventListener("click", async () => {
  el.scan.disabled = true;
  el.scan.textContent = "Reading the repos…";
  try {
    const result = await api.check();
    // The check stamps checkedAt on the file, so re-read before overlaying
    // the findings — otherwise the next save fights a stale revision.
    await load();
    state.check = result;
    state.findings = result.findings;
    state.issues = result.issues;
    state.handled = new Set();
    render();
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    el.scan.disabled = false;
    if (!el.scan.classList.contains("clean")) el.scan.textContent = "Check against repos";
  }
});

el.findings.addEventListener("click", async (ev) => {
  const target = ev.target as HTMLElement;
  const accept = target.closest("[data-accept]") as HTMLElement | null;
  const skip = target.closest("[data-ignore]") as HTMLElement | null;
  const findings = state.findings;
  if (!findings || (!accept && !skip)) return;

  const i = Number((accept ?? skip)?.dataset[accept ? "accept" : "ignore"]);
  const finding = findings[i];
  if (!finding) return;

  const next = accept
    ? applyFinding(state.map, finding)
    : ignoreFinding(state.map, finding, "not a feature");
  const ok = await save(next, accept ? "Added to the map." : "Left off the map.");
  if (ok) {
    state.handled.add(i);
    renderFindings();
  }
});

load().catch((e) => {
  el.rows.innerHTML = `<p class="empty">${esc((e as Error).message)}</p>`;
});
