import { MODULE_ID } from "./constants.mjs";
import { TradingWindowBase, esc } from "./window-base.mjs";
import { HOOK_STATUSES, safeKey } from "./lore-bundle.mjs";
import { openLoreDocument } from "./lore-import.mjs";

// ---------------------------------------------------------------------------
// Hooks & Rumours: status badges on lore pages, plus the tracker window.
//
// Hook CONTENT comes from bundles and lives in the sector's Hooks & Rumours
// JournalEntry under flags.traveller-trading.lore.hooks. Hook STATE (unused/
// seeded/used/discarded + a note) lives beside it in
// flags.traveller-trading.hookState, which only this file writes — the
// importer never touches it, so re-importing a bundle can't reset progress.
// Both maps are keyed by safeKey(id), since ids such as "III.54" contain
// dots that Foundry would otherwise expand into nested objects.
// ---------------------------------------------------------------------------

const STATUS_LABELS = { unused: "Unused", seeded: "Seeded", used: "Used", discarded: "Discarded" };

function hooksEntries() {
  return game.journal.filter(j => j.flags?.[MODULE_ID]?.lore?.kind === "hooks");
}

function findHook(id) {
  const key = safeKey(id);
  for (const entry of hooksEntries()) {
    const hook = entry.flags[MODULE_ID].lore.hooks?.[key];
    if (hook) return { entry, hook, key };
  }
  return null;
}

function stateOf(entry, key) {
  const state = entry?.flags?.[MODULE_ID]?.hookState?.[key];
  return { status: HOOK_STATUSES.includes(state?.status) ? state.status : "unused", note: state?.note || "", updatedAt: state?.updatedAt || null };
}

export async function setHookState(entry, id, patch) {
  if (!game.user.isGM || !entry) return;
  const key = safeKey(id);
  const next = { ...stateOf(entry, key), ...patch, updatedAt: new Date().toISOString() };
  await entry.update({ [`flags.${MODULE_ID}.hookState.${key}`]: next });
}

// ---------------------------------------------------------------------------
// Page decoration
// ---------------------------------------------------------------------------

function statusSelectHtml(status, attr) {
  return `<select ${attr}>${HOOK_STATUSES.map(s => `<option value="${s}" ${s === status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}</select>`;
}

function updateBadge(el) {
  const bar = el.querySelector(":scope .tt-hook-status");
  if (!bar) return;
  const found = findHook(el.dataset.ttHook);
  const { status } = stateOf(found?.entry, found?.key);
  const badge = bar.querySelector(".tt-hook-badge");
  // Only touch the DOM on a real change: the sheet observer below would
  // otherwise see every rewrite as a new mutation and loop forever.
  if (badge.dataset.status !== status) badge.dataset.status = status;
  if (badge.textContent !== STATUS_LABELS[status]) badge.textContent = STATUS_LABELS[status];
  const select = bar.querySelector("select");
  if (select && select.value !== status) select.value = status;
}

// Adds a badge (and, for the GM, a status dropdown) to every rendered hook.
// Works on the live DOM, so status changes show without re-rendering or
// rewriting the page HTML the importer owns.
export function decorateHooks(root) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll("[data-tt-hook]")) {
    if (el.querySelector(":scope .tt-hook-status")) { updateBadge(el); continue; }
    const bar = document.createElement("span");
    bar.className = "tt-hook-status";
    bar.innerHTML = `<span class="tt-hook-badge" data-status="unused">Unused</span>`
      + (game.user.isGM ? statusSelectHtml("unused", 'class="tt-hook-select" aria-label="Hook status"') : "");
    const select = bar.querySelector("select");
    select?.addEventListener("change", async (event) => {
      event.stopPropagation();
      const found = findHook(el.dataset.ttHook);
      if (!found) { ui.notifications.warn("This hook isn't in any Hooks & Rumours journal; re-import its bundle."); return; }
      await setHookState(found.entry, found.hook.id, { status: select.value });
    });
    select?.addEventListener("click", event => event.stopPropagation());
    (el.querySelector(":scope > .tt-hook-head") || el).append(bar);
    updateBadge(el);
  }
}

export function refreshAllHookBadges() {
  for (const el of document.querySelectorAll("[data-tt-hook]")) updateBadge(el);
}

// Journal page rendering has changed between v13 and v14 (and between
// single-page and multi-page views), and a page's HTML can land in the
// sheet after its render hook fires. So: listen to every plausible sheet
// hook, decorate immediately, and keep a light observer on each sheet so
// pages that render later are decorated too. decorateHooks is idempotent.
const observed = new WeakSet();
function onSheetRender(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] || app?.element;
  if (!root) return;
  decorateHooks(root);
  const frame = app?.element instanceof HTMLElement ? app.element : root;
  if (observed.has(frame)) return;
  observed.add(frame);
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; decorateHooks(frame); });
  }).observe(frame, { childList: true, subtree: true });
}

export function registerLoreHookDecorations() {
  for (const hook of [
    "renderJournalEntryPageTextSheet", "renderJournalEntryPageProseMirrorSheet", "renderJournalEntryPageSheet",
    "renderJournalTextPageSheet", "renderJournalPageSheet", "renderJournalEntrySheet", "renderJournalSheet"
  ]) Hooks.on(hook, onSheetRender);

  Hooks.on("updateJournalEntry", (doc, changes) => {
    const flags = changes?.flags?.[MODULE_ID];
    if (!flags || !(flags.hookState || flags.lore?.hooks)) return;
    refreshAllHookBadges();
    if (trackerInstance?.rendered) trackerInstance._renderContent();
  });

  game.settings.registerMenu(MODULE_ID, "hookTracker", {
    name: "Hooks & Rumours Tracker",
    label: "Open Tracker",
    hint: "List every imported adventure hook and rumour, filter by subsector, status or source, and mark them seeded, used or discarded.",
    icon: "fa-solid fa-list-check",
    type: HookTrackerMenu,
    restricted: true
  });
}

class HookTrackerMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "tt-hook-tracker-menu", window: { title: "Hooks & Rumours Tracker" } };
  async render(options) { openHookTrackerApp(); return this; }
}

// ---------------------------------------------------------------------------
// Tracker window
// ---------------------------------------------------------------------------

let trackerInstance = null;
export function openHookTrackerApp() {
  if (!game.user.isGM) return null;
  if (trackerInstance?.rendered) { trackerInstance.bringToFront(); return trackerInstance; }
  trackerInstance = new HookTrackerApp();
  trackerInstance.render(true);
  return trackerInstance;
}

function pageUuidsByKey() {
  const out = new Map();
  for (const entry of game.journal) {
    if (!entry.flags?.[MODULE_ID]?.lore?.key) continue;
    for (const page of entry.pages) {
      const key = page.flags?.[MODULE_ID]?.lore?.key;
      if (key && !page.flags[MODULE_ID].userNotes) out.set(key, page.uuid);
    }
  }
  return out;
}

class HookTrackerApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-hook-tracker-app",
    classes: ["traveller-trading-window"],
    window: { title: "Hooks & Rumours Tracker", resizable: true },
    position: { width: 760, height: 620 }
  };

  constructor(options) {
    super(options);
    this.filters = { subsector: "", status: "", source: "", text: "" };
  }

  async close(options) {
    trackerInstance = null;
    return super.close(options);
  }

  async _load() {}

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", async (e) => {
      const filter = e.target.closest("[data-tt-hook-filter]");
      if (filter) { this.filters[filter.dataset.ttHookFilter] = filter.value; this._renderContent(); return; }
      const row = e.target.closest("[data-tt-hook-row]");
      if (!row) return;
      const found = findHook(row.dataset.ttHookRow);
      if (!found) return;
      if (e.target.matches("[data-tt-hook-status]")) await setHookState(found.entry, found.hook.id, { status: e.target.value });
      if (e.target.matches("[data-tt-hook-note]")) await setHookState(found.entry, found.hook.id, { note: e.target.value.trim() });
    });
    this.root.addEventListener("input", (e) => {
      if (!e.target.matches("[data-tt-hook-search]")) return;
      this.filters.text = e.target.value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._renderContent({ keepSearchFocus: true }), 200);
    });
    this.root.addEventListener("click", async (e) => {
      const open = e.target.closest("[data-tt-hook-open]");
      if (!open) return;
      e.preventDefault();
      await openLoreDocument(open.dataset.ttHookOpen);
    });
  }

  _rows() {
    const rows = [];
    for (const entry of hooksEntries()) {
      const lore = entry.flags[MODULE_ID].lore;
      for (const [key, hook] of Object.entries(lore.hooks || {})) {
        const state = stateOf(entry, key);
        rows.push({ entry, key, hook, state, sector: lore.sector, short: lore.sources?.[hook.source]?.short || hook.source });
      }
    }
    return rows.sort((a, b) => (a.hook.subsector || "").localeCompare(b.hook.subsector || "") || a.hook.id.localeCompare(b.hook.id, undefined, { numeric: true }));
  }

  _renderContent({ keepSearchFocus = false } = {}) {
    if (!this.root) return;
    const all = this._rows();
    const uuids = pageUuidsByKey();
    const f = this.filters;
    const text = f.text.trim().toLowerCase();
    const shown = all.filter(r => (!f.subsector || r.hook.subsector === f.subsector) && (!f.status || r.state.status === f.status)
      && (!f.source || r.hook.source === f.source)
      && (!text || `${r.hook.id} ${r.hook.label} ${r.hook.html} ${r.state.note}`.toLowerCase().includes(text)));
    const optionList = (values, selected, allLabel) => `<option value="">${allLabel}</option>`
      + [...new Set(values)].sort().map(v => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(v)}</option>`).join("");
    const sources = [...new Map(all.map(r => [r.hook.source, r.short])).entries()];
    const counts = Object.fromEntries(HOOK_STATUSES.map(s => [s, all.filter(r => r.state.status === s).length]));

    const rowsHtml = shown.map(r => {
      const uuid = uuids.get(r.hook.targetKey);
      const plain = r.hook.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `<tr data-tt-hook-row="${esc(r.hook.id)}">
        <td class="tt-hook-id">${uuid ? `<a data-tt-hook-open="${esc(uuid)}" title="Open target page">${esc(r.hook.label)} ${esc(r.hook.id)}</a>` : `${esc(r.hook.label)} ${esc(r.hook.id)}`}
          <div class="tt-hint">${esc(r.hook.subsector || "")} · ${esc(r.short)}</div></td>
        <td class="tt-hook-text">${esc(plain.length > 220 ? `${plain.slice(0, 220)}…` : plain)}</td>
        <td>${statusSelectHtml(r.state.status, 'class="tt-input" data-tt-hook-status')}
          <input type="text" class="tt-input" data-tt-hook-note value="${esc(r.state.note)}" placeholder="Note"></td>
      </tr>`;
    }).join("");

    this.root.innerHTML = `<div class="tt-lore-window tt-hook-tracker">
      <div class="tt-inline-row">
        <select class="tt-input" data-tt-hook-filter="subsector">${optionList(all.map(r => r.hook.subsector || ""), f.subsector, "All subsectors")}</select>
        <select class="tt-input" data-tt-hook-filter="status"><option value="">All statuses</option>${HOOK_STATUSES.map(s => `<option value="${s}" ${s === f.status ? "selected" : ""}>${STATUS_LABELS[s]} (${counts[s]})</option>`).join("")}</select>
        <select class="tt-input" data-tt-hook-filter="source"><option value="">All sources</option>${sources.map(([k, s]) => `<option value="${esc(k)}" ${k === f.source ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <input type="search" class="tt-input tt-input-wide" data-tt-hook-search value="${esc(f.text)}" placeholder="Search hooks and notes">
      </div>
      <p class="tt-hint">${shown.length} of ${all.length} hooks shown.</p>
      ${all.length ? `<table class="tt-table"><thead><tr><th>Hook</th><th>Text</th><th>Status &amp; note</th></tr></thead><tbody>${rowsHtml || `<tr><td colspan="3" class="tt-empty">No hooks match these filters.</td></tr>`}</tbody></table>`
        : `<p class="tt-empty">No hooks imported yet. Use Game Settings › Import Lore Bundle.</p>`}
    </div>`;
    if (keepSearchFocus) {
      const search = this.root.querySelector("[data-tt-hook-search]");
      search?.focus();
      search?.setSelectionRange(search.value.length, search.value.length);
    }
  }
}
