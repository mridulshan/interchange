import type { Feature, InterchangeMap, PrRef, Status } from "../core/types.js";
import { STATUSES, repoColor, repoLabel } from "../core/types.js";
import { slugify } from "../core/drift.js";
import { esc } from "./draw.js";

export interface EditorHandles {
  onSave: (f: Feature, original: Feature | null) => void;
  onDelete: (f: Feature) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<Status, string> = {
  planned: "planned — drawn before it is built",
  flight: "in flight — being built now",
  live: "live — shipped and standing",
  reverted: "reverted — shipped and taken back out",
};

/** "web#214, be#661" in, PrRef[] out. Unparseable chunks are dropped. */
export function parsePrs(text: string): PrRef[] {
  const out: PrRef[] = [];
  for (const chunk of text.split(/[,\s]+/)) {
    const m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(chunk.trim());
    if (m) out.push({ repo: m[1] as string, number: Number(m[2]) });
  }
  return out;
}

export function formatPrs(prs: PrRef[] | undefined): string {
  return (prs ?? []).map((p) => `${p.repo}#${p.number}`).join(", ");
}

export function renderEditor(
  host: HTMLElement,
  map: InterchangeMap,
  feature: Feature | null,
  handles: EditorHandles,
): void {
  const isNew = feature === null;
  const f: Feature = feature ?? { id: "", name: "", status: "planned" };
  const drawnRepos = new Set(f.repos ?? []);
  const deps = new Set(f.deps ?? []);

  host.innerHTML = `
    <h2>${isNew ? "Draw a feature" : "Edit feature"}</h2>
    <p class="sub">${
      isNew
        ? "Draw it now, before or after it lands. The gap between the two is the point."
        : `Row ${map.features.findIndex((x) => x.id === f.id) + 1} of ${map.features.length}.`
    }</p>

    <label class="f"><span>Name</span>
      <input type="text" id="e-name" value="${esc(f.name)}" placeholder="Users tab"></label>

    <label class="f"><span>Status</span>
      <select id="e-status">${STATUSES.map(
        (s) => `<option value="${s}"${s === f.status ? " selected" : ""}>${STATUS_LABEL[s]}</option>`,
      ).join("")}</select></label>

    <div class="f"><span>Lines it touched <em>— derived from pull requests, plus anything you add here</em></span>
      <div class="pills" id="e-repos">${map.repos
        .map(
          (r) =>
            `<button type="button" class="pill" data-repo="${esc(r.id)}" data-on="${
              drawnRepos.has(r.id) ? 1 : 0
            }" style="--c:${esc(repoColor(map, r.id))}">${esc(repoLabel(map, r.id))}</button>`,
        )
        .join("")}</div></div>

    <label class="f"><span>Pull requests <em>— "web#214, be#661"</em></span>
      <input type="text" id="e-prs" value="${esc(formatPrs(f.prs))}" placeholder="web#214, be#661"></label>

    <div class="f"><span>Sits on</span>
      <div class="pills" id="e-deps">${map.features
        .filter((x) => x.id !== f.id)
        .map(
          (x) =>
            `<button type="button" class="pill" data-dep="${esc(x.id)}" data-on="${
              deps.has(x.id) ? 1 : 0
            }">${esc(x.name)}</button>`,
        )
        .join("")}${map.features.length <= 1 ? '<span class="sub">Nothing else is drawn yet.</span>' : ""}</div></div>

    <label class="check"><input type="checkbox" id="e-merge"${
      f.merge ? " checked" : ""
    }> Draw as an interchange — this joins lines that were independent</label>

    <label class="f"><span>Assumes <em>— what it takes as given</em></span>
      <textarea id="e-assumes" placeholder="settlementDelay is a fixed number per provider">${esc(
        f.assumes ?? "",
      )}</textarea></label>

    <label class="f"><span>Hands up <em>— what the layers above can rely on</em></span>
      <textarea id="e-exposes" placeholder="A pending-action queue the mobile app polls">${esc(
        f.exposes ?? "",
      )}</textarea></label>

    <label class="f"><span>Chose <em>— optional; the call you made and what you gave up</em></span>
      <textarea id="e-chose" placeholder="Polling over push. Cheap now, needs replacing at volume.">${esc(
        f.chose ?? "",
      )}</textarea></label>

    <p class="err" id="e-err" hidden></p>

    <div class="editor-acts">
      <button class="primary" id="e-save">${isNew ? "Draw it" : "Save"}</button>
      <button class="ghost" id="e-cancel">Cancel</button>
      ${isNew ? "" : '<button class="danger" id="e-del">Remove</button>'}
    </div>
  `;

  for (const group of ["e-repos", "e-deps"]) {
    host.querySelector(`#${group}`)?.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest(".pill") as HTMLElement | null;
      if (!b) return;
      b.dataset["on"] = b.dataset["on"] === "1" ? "0" : "1";
    });
  }

  const err = host.querySelector("#e-err") as HTMLElement;
  const fail = (msg: string): void => {
    err.textContent = msg;
    err.hidden = false;
  };

  host.querySelector("#e-cancel")?.addEventListener("click", handles.onClose);
  host.querySelector("#e-del")?.addEventListener("click", () => handles.onDelete(f));

  host.querySelector("#e-save")?.addEventListener("click", () => {
    const val = (id: string): string =>
      (host.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement).value.trim();

    const name = val("e-name");
    if (!name) return fail("A feature needs a name.");

    const picked = (attr: string, group: string): string[] =>
      [...host.querySelectorAll(`#${group} .pill[data-on="1"]`)].map(
        (n) => (n as HTMLElement).dataset[attr] as string,
      );

    const prs = parsePrs(val("e-prs"));
    const rawPrs = val("e-prs");
    if (rawPrs && !prs.length) return fail('Pull requests should look like "web#214, be#661".');

    const unknown = prs.map((p) => p.repo).filter((r) => !map.repos.some((x) => x.id === r));
    if (unknown.length) return fail(`No line called "${unknown[0]}". Declared: ${map.repos.map((r) => r.id).join(", ")}.`);

    const repos = picked("repo", "e-repos");
    const deps2 = picked("dep", "e-deps");
    const status = (host.querySelector("#e-status") as HTMLSelectElement).value as Status;

    if (!repos.length && !prs.length) {
      return fail("A feature has to touch at least one line. Pick one, or give it a pull request.");
    }

    const next: Feature = {
      id: f.id || slugify(name, new Set(map.features.map((x) => x.id))),
      name,
      status,
    };
    if (repos.length) next.repos = repos;
    if (deps2.length) next.deps = deps2;
    if ((host.querySelector("#e-merge") as HTMLInputElement).checked) next.merge = true;
    if (prs.length) next.prs = prs;
    for (const k of ["assumes", "exposes", "chose"] as const) {
      const v = val(`e-${k}`);
      if (v) next[k] = v;
    }
    if (f.note) next.note = f.note;
    if (f.shippedAt) next.shippedAt = f.shippedAt;
    if (f.drift) next.drift = f.drift;

    handles.onSave(next, feature);
  });
}
