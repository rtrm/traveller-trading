import { MODULE_ID } from "./constants.mjs";
import { TradingWindowBase, esc } from "./window-base.mjs";
import { chooseFile } from "./file-picker.mjs";
import { fetchSectorMetadata, fetchSingleWorldRow, importWorldRows } from "./world-import.mjs";
import {
  validateBundle, bundleCounts, planLoreImport, planRemoveSource, listLoreSources, finalizePageContent,
  buildActorLore, hashFnv1a, loreKeys, MAX_LORE_BYTES
} from "./lore-bundle.mjs";

// ---------------------------------------------------------------------------
// Lore bundle import: the Foundry half. Everything that decides WHAT to
// write lives in lore-bundle.mjs (pure, tested under Node); this file
// snapshots the world into a plain index, shows the planner's dry run, and
// performs the writes. See docs/lore-import.md for the user-facing side.
//
// Hard rules this file is responsible for keeping:
// - World actors: only flags.traveller-trading.lore is ever written, never
//   system.description or any UWP field (Import Worlds overwrites those).
// - Pages flagged userNotes are never deleted or rewritten; the only write
//   to one is appending a preserved manual edit, below a dated heading.
// - flags.traveller-trading.hookState is never written here.
// - Every journal the importer creates is GM-only (default ownership NONE).
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
const LOG_KEY = "log:lore-import";
const LOG_KEEP = 20;
const HTML_FORMAT = () => CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1;
const OWNERSHIP_NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;

function settingMilieu() {
  try { return game.settings.get(MODULE_ID, "milieu") || "M1105"; } catch (err) { return "M1105"; }
}

function chunks(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const JournalEntryCls = () => JournalEntry.implementation ?? JournalEntry;
const ActorCls = () => Actor.implementation ?? Actor;

// ---------------------------------------------------------------------------
// Index snapshot
// ---------------------------------------------------------------------------

// A plain-object snapshot of every lore document, in the shape the planner
// documents at the top of lore-bundle.mjs. Documents are matched by their
// lore key flag only, never by name, so the GM may rename freely. World
// actors come from Import Worlds' travellerMapData flag; when several
// milieux of the same hex exist, the bundle's milieu wins.
export function buildLoreIndex({ milieu = settingMilieu() } = {}) {
  const index = { entries: {}, pages: {}, notes: {}, actors: {}, sources: {} };
  for (const entry of game.journal) {
    const lore = entry.flags?.[MODULE_ID]?.lore;
    if (lore?.key) {
      if (lore.kind === "log") index.sources = foundry.utils.deepClone(lore.sources || {});
      else index.entries[lore.key] = { id: entry.id, uuid: entry.uuid, name: entry.name, flag: foundry.utils.deepClone(lore), pageCount: entry.pages.size };
    }
    if (!lore?.key || lore.kind === "log") continue;
    for (const page of entry.pages) {
      const flags = page.flags?.[MODULE_ID];
      if (!flags?.lore?.key) continue;
      const rec = {
        id: page.id, uuid: page.uuid, entryId: entry.id, entryKey: lore.key, name: page.name, sort: page.sort,
        flag: foundry.utils.deepClone(flags.lore), contentHash: hashFnv1a(page.text?.content ?? ""), userNotes: !!flags.userNotes
      };
      if (rec.userNotes) index.notes[flags.lore.notesFor ?? flags.lore.key] = rec;
      else index.pages[flags.lore.key] = rec;
    }
  }
  for (const actor of game.actors) {
    if (actor.type !== "world") continue;
    const tm = actor.flags?.[MODULE_ID]?.travellerMapData;
    if (!tm?.sector || !tm?.hex) continue;
    const key = loreKeys.world(tm.sector, tm.hex);
    const prev = index.actors[key];
    if (prev && (prev.milieu === milieu || tm.milieu !== milieu)) continue;
    index.actors[key] = {
      id: actor.id, uuid: actor.uuid, name: actor.name, uwp: tm.uwpRaw || "", milieu: tm.milieu,
      subsector: tm.subsectorName || "", subsectorLetter: tm.subsectorLetter || "",
      lore: foundry.utils.deepClone(actor.flags?.[MODULE_ID]?.lore ?? null)
    };
  }
  return index;
}

function uuidLookup(index, exclude = new Set()) {
  return key => (exclude.has(key) ? null : index.pages[key]?.uuid || index.entries[key]?.uuid || null);
}

// Foundry MERGES object updates into stored flags, so a block, source or
// hook that disappeared from a map has to be deleted explicitly with the
// "-=key" form, alongside the new values, inside the same nested object.
function loreFlagUpdate(flag, deletions = []) {
  const lore = foundry.utils.deepClone(flag);
  for (const { field, key } of deletions) (lore[field] ??= {})[`-=${key}`] = null;
  return { [`flags.${MODULE_ID}.lore`]: lore };
}

// ---------------------------------------------------------------------------
// Folders, Notes pages, opening documents
// ---------------------------------------------------------------------------

async function ensureFolderChain(chain, cache) {
  let parent = null;
  for (const { key, name } of chain || []) {
    let folder = cache.get(key) || game.folders.find(f => f.type === "JournalEntry" && f.flags?.[MODULE_ID]?.lore?.key === key);
    if (!folder) {
      folder = await Folder.implementation.create({ name, type: "JournalEntry", folder: parent?.id ?? null, flags: { [MODULE_ID]: { lore: { key } } } });
    }
    cache.set(key, folder);
    parent = folder;
  }
  return parent;
}

// The GM's own page next to an importer page. Only ever created on demand
// (the Notes button, or preserving a manual edit) — never by a plain import.
export async function getOrCreateNotesPage(entry, page) {
  const pageKey = page.flags?.[MODULE_ID]?.lore?.key ?? page.key;
  const existing = entry.pages.find(p => p.flags?.[MODULE_ID]?.userNotes && p.flags[MODULE_ID].lore?.notesFor === pageKey);
  if (existing) return existing;
  const [notes] = await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name: `${page.name} — Notes`, type: "text", sort: (page.sort ?? 0) + 1,
    text: { content: "", format: HTML_FORMAT() },
    flags: { [MODULE_ID]: { userNotes: true, lore: { key: loreKeys.notes(pageKey), notesFor: pageKey, sector: entry.flags?.[MODULE_ID]?.lore?.sector ?? "", kind: "notes" } } }
  }]);
  return notes;
}

export async function openLoreDocument(uuid) {
  const doc = uuid ? await fromUuid(uuid) : null;
  if (!doc) { ui.notifications.warn("Traveller Trading: that lore page no longer exists. Re-import the bundle to recreate it."); return null; }
  if (doc.documentName === "JournalEntryPage") doc.parent.sheet.render(true, { pageId: doc.id });
  else doc.sheet.render(true);
  return doc;
}

// ---------------------------------------------------------------------------
// Applying an import
// ---------------------------------------------------------------------------

async function createMissingActors(plan, bundle, milieu, { generateMaps, onProgress }) {
  const result = { created: 0, errors: [] };
  let meta;
  try { meta = await fetchSectorMetadata(bundle.sector, milieu); }
  catch (err) { result.errors.push(`Couldn't read sector "${bundle.sector}" from Traveller Map: ${err.message || err}`); return result; }
  if (meta.name !== bundle.sector) result.errors.push(`Traveller Map calls this sector "${meta.name}", but the bundle says "${bundle.sector}"; created actors may not link.`);
  const rows = [];
  for (const [i, world] of plan.missingActors.entries()) {
    onProgress?.(`Fetching ${world.name} (${world.hex}) from Traveller Map… ${i + 1}/${plan.missingActors.length}`);
    try {
      const row = await fetchSingleWorldRow(meta.name, world.hex, milieu);
      if (row?.Name) rows.push(row);
      else result.errors.push(`${world.name} (${world.hex}): no world in that hex on Traveller Map.`);
    } catch (err) {
      result.errors.push(`${world.name} (${world.hex}): ${err.message || err}`);
    }
  }
  if (rows.length) {
    const { created } = await importWorldRows(rows, meta, milieu, {
      generateMaps, onProgress: ({ name, created: c, updated, total }) => onProgress?.(`Creating World actors… ${c + updated}/${total} (${name})`)
    });
    result.created = created;
  }
  return result;
}

// Applies a bundle in two passes so @Lore links can point at documents
// created in the same import:
//   pass 1 creates folders, entries and pages (pages get placeholder text);
//   pass 2 resolves links against the now-real UUIDs and writes every
//   changed page's content, flags and renderedHash, then links actors.
// The plan is recomputed here rather than reused from the dry run, so
// nothing that changed in between (or actors just created) is missed.
export async function applyLoreImport(bundle, options, onProgress) {
  const milieu = bundle.milieu || settingMilieu();
  const report = {
    kind: "import", when: new Date().toISOString(), source: bundle.source, bundleVersion: bundle.bundleVersion, sector: bundle.sector,
    actorsCreated: 0, actorErrors: [], preservedEdits: [], unresolved: [], warnings: []
  };
  let index = buildLoreIndex({ milieu });
  let plan = planLoreImport(bundle, index, options);

  if (options.createMissingActors && plan.missingActors.length) {
    const r = await createMissingActors(plan, bundle, milieu, { generateMaps: options.generateMaps, onProgress });
    report.actorsCreated = r.created;
    report.actorErrors = r.errors;
    index = buildLoreIndex({ milieu });
    plan = planLoreImport(bundle, index, options);
  }
  report.plan = plan.summary;
  report.warnings = plan.warnings;
  report.missingActors = plan.missingActors;
  report.orphans = options.removeOrphans ? [] : plan.blocks.orphaned;

  // Pass 1a: entries.
  const folderCache = new Map();
  const entryDocs = new Map(Object.entries(index.entries).map(([key, e]) => [key, game.journal.get(e.id)]));
  const entryCreates = [];
  for (const e of plan.entries.filter(e => e.op === "create")) {
    const folder = await ensureFolderChain(e.folders, folderCache);
    entryCreates.push({ name: e.name, folder: folder?.id ?? null, ownership: { default: OWNERSHIP_NONE() }, flags: { [MODULE_ID]: { lore: e.flag } } });
  }
  for (const batch of chunks(entryCreates)) {
    onProgress?.(`Creating journal entries… (${batch.length})`);
    for (const doc of await JournalEntryCls().createDocuments(batch)) entryDocs.set(doc.flags[MODULE_ID].lore.key, doc);
  }
  const entryUpdates = plan.entries.filter(e => e.op === "update").map(e => ({ _id: index.entries[e.key].id, ...loreFlagUpdate(e.flag, e.deletions) }));
  for (const batch of chunks(entryUpdates)) await JournalEntryCls().updateDocuments(batch);

  // Pass 1b: create missing pages, grouped by entry.
  const byEntry = new Map();
  for (const p of plan.pages.filter(p => p.op === "create")) {
    if (!byEntry.has(p.entryKey)) byEntry.set(p.entryKey, []);
    byEntry.get(p.entryKey).push(p);
  }
  let created = 0;
  const totalCreates = plan.summary.pages.create;
  for (const [entryKey, pages] of byEntry) {
    const entry = entryDocs.get(entryKey);
    if (!entry) { report.warnings.push(`Journal entry ${entryKey} is missing; skipped ${pages.length} page(s).`); continue; }
    for (const batch of chunks(pages)) {
      await entry.createEmbeddedDocuments("JournalEntryPage", batch.map(p => ({
        name: p.name, type: "text", sort: p.sort ?? 0,
        text: { content: "<p><em>Importing…</em></p>", format: HTML_FORMAT() },
        flags: { [MODULE_ID]: { lore: p.flag } }
      })));
      created += batch.length;
      onProgress?.(`Creating pages… ${created}/${totalCreates}`);
    }
  }

  // Pass 2: real UUIDs now exist for everything this import created.
  index = buildLoreIndex({ milieu });
  const uuidFor = uuidLookup(index);
  const writes = plan.pages.filter(p => p.op === "create" || p.op === "update");
  const updatesByEntry = new Map();
  for (const p of writes) {
    const rec = index.pages[p.key];
    const entry = rec && game.journal.get(rec.entryId);
    const page = entry?.pages.get(rec.id);
    if (!page) { report.warnings.push(`Page ${p.key} could not be found after creation.`); continue; }
    if (p.manualEdit) {
      const notes = await getOrCreateNotesPage(entry, page);
      const date = new Date().toISOString().slice(0, 10);
      await notes.update({ "text.content": `${notes.text?.content ?? ""}<h3>Edit preserved from lore import, ${date}</h3>${page.text?.content ?? ""}` });
      report.preservedEdits.push({ page: p.key, name: page.name, notes: notes.name });
    }
    const { content, renderedHash, unresolved } = finalizePageContent(p.rawHtml, uuidFor);
    for (const u of unresolved) report.unresolved.push({ page: p.key, ...u });
    if (!updatesByEntry.has(entry.id)) updatesByEntry.set(entry.id, []);
    updatesByEntry.get(entry.id).push({
      _id: page.id, "text.content": content,
      ...loreFlagUpdate({ ...p.flag, renderedHash, storedHash: null }, p.deletions)
    });
  }
  let written = 0;
  for (const [entryId, updates] of updatesByEntry) {
    const entry = game.journal.get(entryId);
    for (const batch of chunks(updates)) {
      const docs = await entry.updateEmbeddedDocuments("JournalEntryPage", batch);
      written += batch.length;
      onProgress?.(`Writing pages… ${written}/${writes.length}`);
      // Foundry may normalize HTML as it saves. Record the hash of what was
      // actually stored, so that normalization isn't later mistaken for a
      // manual edit by the GM.
      const fixes = [];
      for (const doc of docs || []) {
        const actual = hashFnv1a(doc.text?.content ?? "");
        if (actual !== doc.flags?.[MODULE_ID]?.lore?.renderedHash) fixes.push({ _id: doc.id, [`flags.${MODULE_ID}.lore.storedHash`]: actual });
      }
      if (fixes.length) await entry.updateEmbeddedDocuments("JournalEntryPage", fixes);
    }
  }
  report.pagesWritten = written;
  if (plan.unresolved.length && !report.unresolved.length) report.unresolved = plan.unresolved;

  // Actors: flags only, merged per source.
  const actorUpdates = [];
  for (const a of plan.actors) {
    const actor = index.actors[a.key];
    if (!actor) continue;
    const lore = buildActorLore(actor.lore, { pageUuid: uuidFor(a.pageKey), journalUuid: uuidFor(a.entryKey), source: a.source, uwpAlt: a.uwpAlt });
    if (hashFnv1a(actor.lore ?? null) !== hashFnv1a(lore)) actorUpdates.push({ _id: actor.id, [`flags.${MODULE_ID}.lore`]: lore });
  }
  for (const batch of chunks(actorUpdates)) {
    onProgress?.(`Linking World actors… (${batch.length})`);
    await ActorCls().updateDocuments(batch);
  }
  report.actorsLinked = actorUpdates.length;

  await writeImportLog(report, {
    [`flags.${MODULE_ID}.lore.sources.${bundle.source.key}`]: {
      bundleVersion: bundle.bundleVersion, title: bundle.source.title, short: bundle.source.short, order: bundle.source.order, importedAt: report.when
    }
  });
  return report;
}

// ---------------------------------------------------------------------------
// Applying a source removal
// ---------------------------------------------------------------------------

export async function applyRemoveSource(sourceKey, onProgress) {
  const index = buildLoreIndex();
  const plan = planRemoveSource(index, sourceKey);
  const report = { kind: "remove", when: new Date().toISOString(), source: { key: sourceKey, title: sourceKey, short: sourceKey }, plan: plan.summary, unresolved: [], warnings: [] };
  const meta = listLoreSources(index).find(s => s.key === sourceKey);
  if (meta) report.source = { key: sourceKey, title: meta.title, short: meta.short };

  const deletedKeys = new Set(plan.pages.filter(p => p.op === "delete").map(p => p.key));
  for (const e of plan.entries.filter(e => e.op === "delete")) {
    for (const [key, p] of Object.entries(index.pages)) if (p.entryKey === e.key) deletedKeys.add(key);
  }
  const uuidFor = uuidLookup(index, deletedKeys);

  const updatesByEntry = new Map();
  for (const p of plan.pages.filter(p => p.op === "update")) {
    const rec = index.pages[p.key];
    const { content, renderedHash, unresolved } = finalizePageContent(p.rawHtml, uuidFor);
    for (const u of unresolved) report.unresolved.push({ page: p.key, ...u });
    if (!updatesByEntry.has(rec.entryId)) updatesByEntry.set(rec.entryId, []);
    updatesByEntry.get(rec.entryId).push({ _id: rec.id, "text.content": content, ...loreFlagUpdate({ ...p.flag, renderedHash, storedHash: null }, p.deletions) });
  }
  for (const [entryId, updates] of updatesByEntry) {
    for (const batch of chunks(updates)) {
      onProgress?.(`Re-rendering pages… (${batch.length})`);
      await game.journal.get(entryId).updateEmbeddedDocuments("JournalEntryPage", batch);
    }
  }
  const entryUpdates = plan.entries.filter(e => e.op === "update").map(e => ({ _id: index.entries[e.key].id, ...loreFlagUpdate(e.flag, e.deletions) }));
  for (const batch of chunks(entryUpdates)) await JournalEntryCls().updateDocuments(batch);

  const deletesByEntry = new Map();
  for (const p of plan.pages.filter(p => p.op === "delete")) {
    const rec = index.pages[p.key];
    // Belt and braces: the planner never lists Notes pages, but never let
    // one be deleted even if the index were somehow wrong.
    const doc = game.journal.get(rec.entryId)?.pages.get(rec.id);
    if (!doc || doc.flags?.[MODULE_ID]?.userNotes) continue;
    if (!deletesByEntry.has(rec.entryId)) deletesByEntry.set(rec.entryId, []);
    deletesByEntry.get(rec.entryId).push(rec.id);
  }
  for (const [entryId, ids] of deletesByEntry) {
    for (const batch of chunks(ids)) await game.journal.get(entryId).deleteEmbeddedDocuments("JournalEntryPage", batch);
  }
  const entryDeletes = plan.entries.filter(e => e.op === "delete").map(e => index.entries[e.key].id)
    .filter(id => !game.journal.get(id)?.pages.some(p => p.flags?.[MODULE_ID]?.userNotes));
  for (const batch of chunks(entryDeletes)) await JournalEntryCls().deleteDocuments(batch);

  const actorUpdates = plan.actors.map(a => a.op === "clear"
    ? { _id: a.actorId, [`flags.${MODULE_ID}.-=lore`]: null }
    : { _id: a.actorId, [`flags.${MODULE_ID}.lore`]: a.lore });
  for (const batch of chunks(actorUpdates)) await ActorCls().updateDocuments(batch);

  await writeImportLog(report, { [`flags.${MODULE_ID}.lore.sources.-=${sourceKey}`]: null });
  return report;
}

// ---------------------------------------------------------------------------
// Report + import log
// ---------------------------------------------------------------------------

function countsRow(label, counts, keys) {
  return `<tr><td>${esc(label)}</td><td>${keys.map(k => `${esc(k)} <strong>${counts?.[k] ?? 0}</strong>`).join(" · ")}</td></tr>`;
}

function listHtml(title, items, render) {
  if (!items?.length) return "";
  return `<h4>${esc(title)} (${items.length})</h4><ul>${items.slice(0, 200).map(i => `<li>${render(i)}</li>`).join("")}${items.length > 200 ? `<li>…and ${items.length - 200} more</li>` : ""}</ul>`;
}

export function reportHtml(report) {
  const s = report.plan || {};
  const rows = report.kind === "remove"
    ? [
      `<tr><td>Blocks removed</td><td><strong>${s.blocksRemoved ?? 0}</strong></td></tr>`,
      `<tr><td>Hooks removed</td><td><strong>${s.hooksRemoved ?? 0}</strong></td></tr>`,
      countsRow("Pages", s.pages, ["update", "delete"]),
      countsRow("Journal entries", s.entries, ["update", "delete"]),
      `<tr><td>World actors</td><td>updated <strong>${s.actorsUpdated ?? 0}</strong> · unlinked <strong>${s.actorsCleared ?? 0}</strong></td></tr>`
    ]
    : [
      countsRow("Journal entries", s.entries, ["create", "update", "unchanged"]),
      countsRow("Pages", s.pages, ["create", "update", "unchanged"]),
      countsRow("Blocks", s.blocks, ["added", "changed", "unchanged", "orphaned", "removed"]),
      countsRow("Hooks", s.hooks, ["added", "changed", "unchanged", "orphaned", "removed"]),
      `<tr><td>World actors</td><td>created <strong>${report.actorsCreated ?? 0}</strong> · linked <strong>${report.actorsLinked ?? 0}</strong> · not found <strong>${report.missingActors?.length ?? 0}</strong></td></tr>`
    ];
  return `<p><strong>${esc(report.source?.title)}</strong> (${esc(report.source?.key)})${report.bundleVersion !== undefined ? `, bundle version ${esc(report.bundleVersion)}` : ""} — ${esc(new Date(report.when).toLocaleString())}</p>`
    + `<table class="tt-table">${rows.join("")}</table>`
    + listHtml("Warnings", report.warnings, w => esc(w))
    + listHtml("World actor problems", report.actorErrors, e => esc(e))
    + listHtml("World actors not found", report.missingActors, m => `${esc(m.name)} (${esc(m.hex)})`)
    + listHtml("Manual edits preserved on Notes pages", report.preservedEdits, e => `${esc(e.name)} → ${esc(e.notes)}`)
    + listHtml("Orphaned blocks kept", report.orphans, o => `${esc(o.id)} <em>on</em> ${esc(o.page)}`)
    + listHtml("Unresolved links", report.unresolved, u => `${esc(u.label)} → <code>${esc(u.key)}</code> <em>on</em> ${esc(u.page)}`);
}

async function writeImportLog(report, registryUpdate) {
  let entry = game.journal.find(j => j.flags?.[MODULE_ID]?.lore?.key === LOG_KEY);
  if (!entry) {
    entry = await JournalEntryCls().create({
      name: "Lore Import Log", ownership: { default: OWNERSHIP_NONE() },
      flags: { [MODULE_ID]: { lore: { key: LOG_KEY, kind: "log", sources: {} } } }
    });
  }
  if (registryUpdate) await entry.update(registryUpdate);
  const stamp = new Date(report.when);
  const name = `${stamp.toISOString().slice(0, 16).replace("T", " ")} — ${report.kind === "remove" ? "Removed" : "Imported"} ${report.source?.short || report.source?.key}${report.bundleVersion !== undefined ? ` v${report.bundleVersion}` : ""}`;
  await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name, type: "text", sort: Math.floor(stamp.getTime() / 1000),
    text: { content: reportHtml(report), format: HTML_FORMAT() },
    flags: { [MODULE_ID]: { loreLog: true } }
  }]);
  const logPages = entry.pages.filter(p => p.flags?.[MODULE_ID]?.loreLog).sort((a, b) => b.sort - a.sort);
  const stale = logPages.slice(LOG_KEEP).map(p => p.id);
  if (stale.length) await entry.deleteEmbeddedDocuments("JournalEntryPage", stale);
}

// ---------------------------------------------------------------------------
// Settings menus
// ---------------------------------------------------------------------------

export function registerLoreImportSettings() {
  game.settings.registerMenu(MODULE_ID, "importLoreBundle", {
    name: "Import Lore Bundle",
    label: "Import Lore",
    hint: "Import a lore bundle (.tt-lore.json) as GM-only journals: a gazetteer page per world and subsector, reference journals and a Hooks & Rumours tracker, linked to your World actors. Always shows a dry run first; re-importing only updates what changed.",
    icon: "fa-solid fa-book-atlas",
    type: LoreImportMenu,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "removeLoreSource", {
    name: "Remove Lore Source",
    label: "Remove Source",
    hint: "Remove every block and hook imported from one lore source, re-render the affected pages, and delete pages left empty. Your Notes pages are never removed. Shows a dry run first.",
    icon: "fa-solid fa-book-skull",
    type: RemoveLoreSourceMenu,
    restricted: true
  });
}

// Same ApplicationV2-with-overridden-render trick as WorldImportMenu
// (world-import.mjs): the settings button opens a real window instead.
class LoreImportMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "tt-lore-import-menu", window: { title: "Import Lore Bundle" } };
  async render(options) { openLoreImportApp(); return this; }
}
class RemoveLoreSourceMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "tt-lore-remove-menu", window: { title: "Remove Lore Source" } };
  async render(options) { openRemoveLoreSourceApp(); return this; }
}

let importInstance = null;
export function openLoreImportApp() {
  if (!game.user.isGM) return null;
  if (importInstance?.rendered) { importInstance.bringToFront(); return importInstance; }
  importInstance = new LoreImportApp();
  importInstance.render(true);
  return importInstance;
}

let removeInstance = null;
export function openRemoveLoreSourceApp() {
  if (!game.user.isGM) return null;
  if (removeInstance?.rendered) { removeInstance.bringToFront(); return removeInstance; }
  removeInstance = new RemoveLoreSourceApp();
  removeInstance.render(true);
  return removeInstance;
}

// ---------------------------------------------------------------------------
// Import window
// ---------------------------------------------------------------------------

function opBadge(op) {
  return `<span class="tt-badge tt-lore-op tt-lore-op-${esc(op)}">${esc(op)}</span>`;
}

function planDetailsHtml(plan) {
  const changedPages = plan.pages.filter(p => p.op !== "unchanged");
  const changedEntries = plan.entries.filter(e => e.op !== "unchanged");
  const blockList = (title, list) => listHtml(title, list, b => `${esc(b.id)} <em>on</em> ${esc(b.page)}`);
  const hookList = (title, list) => listHtml(title, list, id => esc(id));
  return `<details class="tt-lore-details"><summary>Details</summary>`
    + listHtml("Journal entries", changedEntries, e => `${opBadge(e.op)} ${esc(e.name)}`)
    + listHtml("Pages", changedPages, p => `${opBadge(p.op)} ${esc(p.name)} <span class="tt-hint">${esc(p.key)}</span>${p.manualEdit ? " — <strong>edited by hand</strong>" : ""}`)
    + blockList("Blocks added", plan.blocks.added) + blockList("Blocks changed", plan.blocks.changed)
    + blockList(plan.removeOrphans ? "Orphaned blocks (will be removed)" : "Orphaned blocks (kept)", plan.blocks.orphaned)
    + blockList("Blocks moved or removed", plan.blocks.removed.filter(b => !plan.blocks.orphaned.some(o => o.id === b.id)))
    + hookList("Hooks added", plan.hooks.added) + hookList("Hooks changed", plan.hooks.changed)
    + hookList(plan.removeOrphans ? "Orphaned hooks (will be removed)" : "Orphaned hooks (kept)", plan.hooks.orphaned)
    + listHtml("World actor links to update", plan.actors.filter(a => a.op === "update"), a => `${esc(a.name)} (${esc(a.hex)})`)
    + listHtml("World actors not found", plan.missingActors, m => `${esc(m.name)} (${esc(m.hex)})`)
    + listHtml("Pages edited by hand (edit will be copied to a Notes page)", plan.manualEdits, k => esc(k))
    + listHtml("Unresolved links", plan.unresolved, u => `${esc(u.label)} → <code>${esc(u.key)}</code> <em>on</em> ${esc(u.page)}`)
    + `</details>`;
}

class LoreImportApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-lore-import-app",
    classes: ["traveller-trading-window"],
    window: { title: "Import Lore Bundle", resizable: true },
    position: { width: 620, height: "auto" }
  };

  constructor(options) {
    super(options);
    this.fileName = "";
    this.bundle = null;
    this.stripped = [];
    this.error = "";
    this.plan = null;
    this.report = null;
    this.busy = false;
    this.statusHtml = "";
    // Not 	his.options: ApplicationV2 keeps its own window configuration
    // there, and overwriting it stops the window from rendering at all.
    this.importOptions = { createMissingActors: true, removeOrphans: false, generateMaps: false };
  }

  async close(options) {
    importInstance = null;
    return super.close(options);
  }

  async _load() {}

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", (e) => {
      const opt = e.target.closest("[data-tt-lore-opt]");
      if (!opt) return;
      this.importOptions[opt.dataset.ttLoreOpt] = opt.checked;
      if (opt.dataset.ttLoreOpt === "removeOrphans") this._replan();
      this._renderContent();
    });
  }

  _replan() {
    if (!this.bundle) { this.plan = null; return; }
    try {
      this.plan = planLoreImport(this.bundle, buildLoreIndex({ milieu: this.bundle.milieu || settingMilieu() }), { removeOrphans: this.importOptions.removeOrphans });
    } catch (err) {
      console.error("Traveller Trading | Lore dry run failed", err);
      this.plan = null;
      this.error = `Dry run failed: ${err.message || err}`;
    }
  }

  async _action_choose_file() {
    const file = await chooseFile({ accept: ".json,.tt-lore.json,application/json" });
    if (!file) return;
    this.fileName = file.name;
    this.bundle = null; this.plan = null; this.report = null; this.error = ""; this.statusHtml = "";
    try {
      if (file.size > MAX_LORE_BYTES) throw new Error("Lore bundle exceeds the 25 MB limit.");
      const { bundle, stripped } = validateBundle(await file.text());
      this.bundle = bundle;
      this.stripped = stripped;
      this._replan();
    } catch (err) {
      this.error = err.message || String(err);
    }
    this._renderContent();
  }

  async _action_apply() {
    if (!this.bundle || !this.plan || this.busy) return;
    if (this.plan.needsConfirm) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Import an older bundle?" },
        content: `<p>${esc(this.plan.warnings[0])}</p><p>Import it anyway?</p>`
      });
      if (!ok) return;
    }
    this.busy = true;
    this.statusHtml = `<p class="tt-hint">Starting import…</p>`;
    this._renderContent();
    try {
      this.report = await applyLoreImport(this.bundle, { ...this.importOptions }, (text) => {
        this.statusHtml = `<p class="tt-hint">${esc(text)}</p>`;
        this._renderContent();
      });
      this.statusHtml = "";
      ui.notifications.info(`Traveller Trading: imported lore from ${this.bundle.source.title}.`);
    } catch (err) {
      console.error("Traveller Trading | Lore import failed", err);
      this.statusHtml = `<p class="tt-hint tt-lore-error">Import failed: ${esc(err.message || String(err))}. Documents written before the failure are kept; re-importing will finish the job.</p>`;
    }
    this.busy = false;
    this._replan();
    this._renderContent();
  }

  _summaryHtml() {
    const b = this.bundle, plan = this.plan;
    const c = bundleCounts(b);
    let html = `<div class="tt-lore-bundle-info">
      <p><strong>${esc(b.source.title)}</strong> <span class="tt-badge">${esc(b.source.key)}</span> · bundle version <strong>${b.bundleVersion}</strong>${plan?.storedVersion !== null && plan?.storedVersion !== undefined ? ` (imported so far: ${plan.storedVersion})` : ""}</p>
      <p class="tt-hint">${esc(b.sector)}${b.milieu ? ` · ${esc(b.milieu)}` : ""} — ${c.subsectors} subsectors, ${c.worlds} worlds, ${c.journals} reference journals (${c.pages} pages), ${c.blocks} blocks, ${c.hooks} hooks.</p>
    </div>`;
    if (this.stripped.length) {
      html += `<div class="tt-lore-warn"><p><strong>Disallowed HTML was stripped:</strong></p><ul>${this.stripped.map(s => `<li>${esc(s.where)}: ${s.tags.map(t => `&lt;${esc(t)}&gt;`).join(", ")}</li>`).join("")}</ul></div>`;
    }
    if (!plan) return html;
    const s = plan.summary;
    if (plan.warnings.length) html += `<div class="tt-lore-warn"><ul>${plan.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    const actorsLine = this.importOptions.createMissingActors
      ? `link updates <strong>${s.actors.update}</strong> · to create from Traveller Map <strong>${s.missingActors}</strong>`
      : `link updates <strong>${s.actors.update}</strong> · not found <strong>${s.missingActors}</strong>`;
    html += `<h4 class="tt-lore-h">Dry run</h4>
      <table class="tt-table">
        ${countsRow("Journal entries", s.entries, ["create", "update", "unchanged"])}
        ${countsRow("Pages", s.pages, ["create", "update", "unchanged"])}
        ${countsRow("Blocks", s.blocks, ["added", "changed", "unchanged", "orphaned"])}
        ${countsRow("Hooks", s.hooks, ["added", "changed", "unchanged", "orphaned"])}
        <tr><td>World actors</td><td>${actorsLine}</td></tr>
        <tr><td>Manual edits</td><td><strong>${s.manualEdits}</strong>${s.manualEdits ? " (copied to Notes pages before overwriting)" : ""}</td></tr>
        <tr><td>Unresolved links</td><td><strong>${s.unresolved}</strong></td></tr>
      </table>
      <p class="tt-hint">${plan.changeCount === 0 && !(this.importOptions.createMissingActors && s.missingActors) ? "No changes — everything in this bundle is already imported." : `${plan.changeCount} change(s) to apply.`}</p>
      ${planDetailsHtml(plan)}`;
    return html;
  }

  _optionsHtml() {
    const opt = (key, label) => `<label class="tt-lore-opt"><input type="checkbox" data-tt-lore-opt="${key}" ${this.importOptions[key] ? "checked" : ""} ${this.busy ? "disabled" : ""}> ${label}</label>`;
    return `<div class="tt-lore-options">
      ${opt("createMissingActors", "Create missing world actors from Traveller Map")}
      ${opt("removeOrphans", "Remove orphaned blocks and hooks from this source")}
      ${opt("generateMaps", "Generate world maps for newly created actors")}
    </div>`;
  }

  _renderContent() {
    if (!this.root) return;
    let body = `<p class="tt-hint">Choose a lore bundle (<code>.tt-lore.json</code>). Nothing is written until you review the dry run and click Apply.</p>
      <div class="tt-inline-row">
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="choose_file" ${this.busy ? "disabled" : ""}>Choose Lore Bundle…</button>
        ${this.fileName ? `<span class="tt-hint">${esc(this.fileName)}</span>` : ""}
      </div>`;
    if (this.error) body += `<p class="tt-hint tt-lore-error">${esc(this.error)}</p>`;
    if (this.bundle) {
      body += this._summaryHtml();
      body += this._optionsHtml();
      body += `<div class="tt-inline-row" style="margin-top:10px;">
        <button type="button" class="tt-btn" data-tt-action="apply" ${this.busy || !this.plan ? "disabled" : ""}>Apply Import</button>
      </div>`;
    }
    body += this.statusHtml || "";
    if (this.report) body += `<div class="tt-lore-report"><h4 class="tt-lore-h">Import report</h4>${reportHtml(this.report)}<p class="tt-hint">Also saved to the "Lore Import Log" journal.</p></div>`;
    this.root.innerHTML = `<div class="tt-lore-window">${body}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Remove-source window
// ---------------------------------------------------------------------------

class RemoveLoreSourceApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-lore-remove-app",
    classes: ["traveller-trading-window"],
    window: { title: "Remove Lore Source", resizable: true },
    position: { width: 560, height: "auto" }
  };

  constructor(options) {
    super(options);
    this.sources = [];
    this.selected = "";
    this.plan = null;
    this.report = null;
    this.busy = false;
    this.statusHtml = "";
  }

  async close(options) {
    removeInstance = null;
    return super.close(options);
  }

  async _load() { this._refresh(); }

  _refresh() {
    const index = buildLoreIndex();
    this.sources = listLoreSources(index);
    if (!this.sources.some(s => s.key === this.selected)) this.selected = this.sources[0]?.key || "";
    this.plan = this.selected ? planRemoveSource(index, this.selected) : null;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", (e) => {
      if (!e.target.matches("[data-tt-remove-source]")) return;
      this.selected = e.target.value;
      this.report = null;
      this._refresh();
      this._renderContent();
    });
  }

  async _action_remove_source() {
    if (!this.plan || this.busy) return;
    const source = this.sources.find(s => s.key === this.selected);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Lore Source" },
      content: `<p>Remove all ${this.plan.summary.blocksRemoved} block(s) and ${this.plan.summary.hooksRemoved} hook(s) from <strong>${esc(source?.title || this.selected)}</strong>? Your Notes pages are kept. Re-importing the bundle restores the lore.</p>`
    });
    if (!ok) return;
    this.busy = true;
    this._renderContent();
    try {
      this.report = await applyRemoveSource(this.selected, (text) => { this.statusHtml = `<p class="tt-hint">${esc(text)}</p>`; this._renderContent(); });
      this.statusHtml = "";
      ui.notifications.info(`Traveller Trading: removed lore source ${source?.title || this.selected}.`);
    } catch (err) {
      console.error("Traveller Trading | Remove lore source failed", err);
      this.statusHtml = `<p class="tt-hint tt-lore-error">Removal failed: ${esc(err.message || String(err))}</p>`;
    }
    this.busy = false;
    this._refresh();
    this._renderContent();
  }

  _renderContent() {
    if (!this.root) return;
    let body;
    if (!this.sources.length) {
      body = `<p class="tt-hint">No imported lore sources were found.</p>`;
    } else {
      const opts = this.sources.map(s => `<option value="${esc(s.key)}" ${s.key === this.selected ? "selected" : ""}>${esc(s.title)} (${esc(s.key)}${s.bundleVersion !== null ? `, v${s.bundleVersion}` : ""}) — ${s.blocks} blocks, ${s.hooks} hooks</option>`).join("");
      body = `<p class="tt-hint">Choose a source. The dry run below shows what removing it would change.</p>
        <select class="tt-input tt-input-wide" data-tt-remove-source ${this.busy ? "disabled" : ""}>${opts}</select>`;
      if (this.plan) {
        const s = this.plan.summary;
        body += `<h4 class="tt-lore-h">Dry run</h4><table class="tt-table">
          <tr><td>Blocks removed</td><td><strong>${s.blocksRemoved}</strong></td></tr>
          <tr><td>Hooks removed</td><td><strong>${s.hooksRemoved}</strong> <span class="tt-hint">(hook status is kept)</span></td></tr>
          ${countsRow("Pages", s.pages, ["update", "delete", "unchanged"])}
          ${countsRow("Journal entries", s.entries, ["update", "delete"])}
          <tr><td>World actors</td><td>updated <strong>${s.actorsUpdated}</strong> · unlinked <strong>${s.actorsCleared}</strong></td></tr>
        </table>
        <details class="tt-lore-details"><summary>Details</summary>
          ${listHtml("Pages", this.plan.pages.filter(p => p.op !== "unchanged"), p => `${opBadge(p.op)} ${esc(p.name)}`)}
          ${listHtml("Journal entries", this.plan.entries.filter(e => e.op !== "unchanged"), e => `${opBadge(e.op)} ${esc(e.name)}`)}
        </details>
        <div class="tt-inline-row" style="margin-top:10px;">
          <button type="button" class="tt-btn" data-tt-action="remove_source" ${this.busy ? "disabled" : ""}>Remove Source</button>
        </div>`;
      }
    }
    body += this.statusHtml || "";
    if (this.report) body += `<div class="tt-lore-report"><h4 class="tt-lore-h">Report</h4>${reportHtml(this.report)}</div>`;
    this.root.innerHTML = `<div class="tt-lore-window">${body}</div>`;
  }
}

// ---------------------------------------------------------------------------
// World sheet buttons
// ---------------------------------------------------------------------------

// Its own renderActorSheet registration (same pattern as
// registerWorldMapGenButton in world-map-gen.mjs), placed after the map
// buttons. "Lore" opens the linked page; "Notes" opens or creates the GM's
// own Notes page beside it.
export function registerLoreSheetButtons() {
  Hooks.on("renderActorSheet", (app, html) => {
    const actor = app.actor || app.document;
    if (!actor || actor.type !== "world" || !game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector("[data-tt-lore-buttons]")) return;
    const anchor = root.querySelector("div[data-tt-gen-map]") || root.querySelector('img[data-edit="system.world.map"]');
    if (!anchor) return;
    const container = document.createElement("div");
    container.dataset.ttLoreButtons = "1";
    const linkedPage = async () => {
      const lore = actor.getFlag(MODULE_ID, "lore");
      if (!lore?.pageUuid) { ui.notifications.info(`${actor.name} has no imported lore yet. Use Game Settings › Import Lore Bundle.`); return null; }
      const page = await fromUuid(lore.pageUuid);
      if (!page) ui.notifications.warn(`${actor.name}'s lore page no longer exists. Re-import the bundle to recreate it.`);
      return page;
    };
    const actions = [
      { label: "Lore", run: async () => { const page = await linkedPage(); if (page) page.parent.sheet.render(true, { pageId: page.id }); } },
      { label: "Notes", run: async () => {
        const page = await linkedPage();
        if (!page) return;
        const notes = await getOrCreateNotesPage(page.parent, page);
        notes.parent.sheet.render(true, { pageId: notes.id });
      } }
    ];
    for (const { label, run } of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.style.cssText = "margin-top:8px;";
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        btn.disabled = true;
        try { await run(); }
        catch (error) {
          console.error(`Traveller Trading | ${label} failed`, error);
          ui.notifications.error(`${label}: ${error.message || String(error)}`);
        }
        finally { btn.disabled = false; }
      });
      container.append(btn);
    }
    anchor.insertAdjacentElement("afterend", container);
  });
}
