import { MODULE_ID } from "./constants.mjs";
import { TradingWindowBase, esc } from "./window-base.mjs";
import { chooseFile, chooseFiles } from "./file-picker.mjs";
import { validateItemsBundle, planItemsImport, matchAssetFiles, docHash, MAX_ITEMS_BYTES } from "./items-bundle.mjs";
import { appendImportLog, importLogEntry, countsRow, listHtml } from "./lore-import.mjs";

// ---------------------------------------------------------------------------
// Items bundle import: the Foundry half. items-bundle.mjs decides what to
// write; this file snapshots the compendium and image folder, uploads
// images, and writes folders and Items into a world compendium.
// See docs/items-import.md.
//
// Hard rules this file is responsible for keeping:
// - Only pack documents carrying flags.traveller-trading.itemKey (items) or
//   folderKey (folders) are ever updated or deleted. Anything else in the
//   pack is left alone.
// - Items on actors and world Items are never written. The only world Items
//   this file creates are backup copies of pack items edited by hand.
// - Everything is GM-only.
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
const DEFAULT_IMAGE_FOLDER = "traveller-trading/items";
const DEFAULT_ITEM_ICON = "icons/svg/item-bag.svg";

const ItemCls = () => Item.implementation ?? Item;
const FolderCls = () => Folder.implementation ?? Folder;
const CompendiumCls = () => foundry.documents?.collections?.CompendiumCollection ?? globalThis.CompendiumCollection;
const FilePickerCls = () => foundry.applications.apps.FilePicker.implementation;

function chunks(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// On the Forge, "forgevtt" is the Assets Library; elsewhere, the user data
// folder.
function storageSource() {
  return typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge ? "forgevtt" : "data";
}

function imageFolderSetting() {
  let value;
  try { value = game.settings.get(MODULE_ID, "itemImageFolder"); } catch (err) { value = ""; }
  return (value || DEFAULT_IMAGE_FOLDER).trim().replace(/^\/+|\/+$/g, "") || DEFAULT_IMAGE_FOLDER;
}

function knownItemTypes() {
  const fromSystem = game.system?.documentTypes?.Item;
  const types = fromSystem ? Object.keys(fromSystem) : (game.documentTypes?.Item || []);
  return types.filter(t => t !== "base");
}

function defaultIcon(type) {
  try { return ItemCls().getDefaultArtwork?.({ type })?.img || ItemCls().DEFAULT_ICON || DEFAULT_ITEM_ICON; }
  catch (err) { return DEFAULT_ITEM_ICON; }
}

// The system's default data for a type, so fields the bundle leaves out
// get their defaults (on update too, rather than keeping stale values).
const defaultSystems = new Map();
function defaultSystem(type) {
  if (!defaultSystems.has(type)) {
    let system = {};
    try { system = new (ItemCls())({ name: "default", type }).toObject().system || {}; } catch (err) { /* unknown type */ }
    defaultSystems.set(type, system);
  }
  return foundry.utils.deepClone(defaultSystems.get(type));
}

function mergedSystem(type, system) {
  return foundry.utils.mergeObject(defaultSystem(type), foundry.utils.deepClone(system || {}), { inplace: false });
}

function currentDocHash(doc) {
  const data = doc.toObject();
  return docHash({ name: data.name, type: data.type, img: data.img, system: data.system });
}

// ---------------------------------------------------------------------------
// Image folder
// ---------------------------------------------------------------------------

function assetBase(sourceKey) {
  return `${imageFolderSetting()}/${sourceKey}`;
}

// Same create-then-verify approach as prepareMapDirectory in
// world-map-gen.mjs: "already exists" errors are ignored, but only once a
// browse proves the folder really is there.
async function ensureDirectory(source, path, cache) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (cache.has(dir)) continue;
    try { await FilePickerCls().createDirectory(source, dir, {}); }
    catch (error) {
      try { await FilePickerCls().browse(source, dir); }
      catch { throw error; }
    }
    cache.add(dir);
  }
}

// Lists what's already uploaded for these assets: { assetPath: serverPath }.
// One browse per sub-folder. A folder that doesn't exist yet means nothing
// is uploaded there.
async function browseUploadedAssets(sourceKey, assetPaths) {
  const base = assetBase(sourceKey);
  const byDir = new Map();
  for (const path of assetPaths) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(path);
  }
  const found = {};
  for (const [dir, paths] of byDir) {
    let files = [];
    try { files = (await FilePickerCls().browse(storageSource(), dir ? `${base}/${dir}` : base))?.files || []; }
    catch (err) { continue; }
    const byName = new Map();
    for (const file of files) {
      const name = decodeURIComponent(String(file).split("?")[0].split("/").pop());
      byName.set(name, file);
    }
    for (const path of paths) {
      const url = byName.get(path.split("/").pop());
      if (url) found[path] = url;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Index snapshot
// ---------------------------------------------------------------------------

function findPack(packName) {
  return game.packs.get(`world.${packName}`) || null;
}

async function buildItemsIndex(bundle) {
  const index = { items: {}, folders: {}, assets: {}, sources: {} };
  index.sources = foundry.utils.deepClone(importLogEntry()?.flags?.[MODULE_ID]?.itemSources || {});
  index.assets = await browseUploadedAssets(bundle.source.key, bundle.assets);
  const pack = findPack(bundle.pack.name);
  if (!pack) return { index, pack: null, docs: [] };
  const docs = await pack.getDocuments();
  for (const folder of pack.folders) {
    const key = folder.flags?.[MODULE_ID]?.folderKey;
    if (!key) continue;
    const foreignItems = docs.filter(d => d.folder?.id === folder.id && !d.flags?.[MODULE_ID]?.itemKey).length;
    const foreignFolders = pack.folders.filter(f => f.folder?.id === folder.id && !f.flags?.[MODULE_ID]?.folderKey).length;
    index.folders[key] = { id: folder.id, name: folder.name, foreignCount: foreignItems + foreignFolders };
  }
  for (const doc of docs) {
    const key = doc.flags?.[MODULE_ID]?.itemKey;
    if (!key) continue;
    index.items[key] = {
      id: doc.id, uuid: doc.uuid, name: doc.name, type: doc.type, img: doc.img,
      folderKey: doc.folder?.flags?.[MODULE_ID]?.folderKey ?? null,
      flag: foundry.utils.deepClone(doc.flags[MODULE_ID].item || {}),
      currentDocHash: currentDocHash(doc)
    };
  }
  return { index, pack, docs };
}

export async function planItemsFromWorld(bundle, files, options) {
  const { index, pack } = await buildItemsIndex(bundle);
  const plan = planItemsImport(bundle, index, { ...options, chosenAssets: [...files.keys()], knownTypes: knownItemTypes() });
  plan.packExists = !!pack;
  plan.assetBase = assetBase(bundle.source.key);
  return plan;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function backupFolder(source) {
  const key = `backup:${source.key}`;
  let folder = game.folders.find(f => f.type === "Item" && f.flags?.[MODULE_ID]?.folderKey === key);
  if (!folder) folder = await FolderCls().create({ name: `${source.short} edits (backup)`, type: "Item", flags: { [MODULE_ID]: { folderKey: key } } });
  return folder;
}

// A pack item edited by hand is copied into the world before the import
// overwrites it. The copy loses its itemKey, so the importer never touches
// it again.
async function backupEditedItem(doc, source, date) {
  const folder = await backupFolder(source);
  const data = doc.toObject();
  delete data._id;
  data.folder = folder.id;
  data.name = `${doc.name} (edited, backed up ${date})`;
  data.flags = { ...(data.flags || {}), [MODULE_ID]: { backupOf: doc.flags?.[MODULE_ID]?.itemKey } };
  return ItemCls().create(data);
}

export async function applyItemsImport(bundle, files, options, onProgress) {
  if (!game.user.isGM) throw new Error("Only a GM can import items.");
  const report = {
    when: new Date().toISOString(), source: bundle.source, bundleVersion: bundle.bundleVersion, pack: bundle.pack,
    uploaded: [], uploadErrors: [], backups: [], warnings: [], packCreated: false
  };
  const runOptions = { removeOrphans: !!options.removeOrphans, reupload: !!options.reupload };

  let pack = findPack(bundle.pack.name);
  if (!pack) {
    onProgress?.(`Creating compendium "${bundle.pack.label}"…`);
    pack = await CompendiumCls().createCompendium({ type: "Item", label: bundle.pack.label, name: bundle.pack.name, package: "world" });
    report.packCreated = true;
  }
  if (pack.documentName !== "Item") throw new Error(`Compendium world.${bundle.pack.name} exists but doesn't hold Items.`);
  const wasLocked = !!pack.locked;
  if (wasLocked) await pack.configure({ locked: false });

  try {
    // 1. Images. Upload in sequence, with a counter.
    let plan = await planItemsFromWorld(bundle, files, runOptions);
    const uploads = plan.assets.filter(a => a.status === "upload");
    const source = storageSource();
    const base = assetBase(bundle.source.key);
    const dirs = new Set();
    for (const [i, asset] of uploads.entries()) {
      onProgress?.(`Uploading images… ${i + 1}/${uploads.length} (${asset.path})`);
      const file = files.get(asset.path);
      const name = asset.path.split("/").pop();
      const dir = asset.path.includes("/") ? `${base}/${asset.path.slice(0, asset.path.lastIndexOf("/"))}` : base;
      try {
        await ensureDirectory(source, dir, dirs);
        const upload = new File([file], name, { type: file.type || "image/webp" });
        const result = await FilePickerCls().upload(source, dir, upload, {}, { notify: false });
        if (!result || result.status === "error" || !result.path) throw new Error(result?.message || "upload returned no path");
        report.uploaded.push(asset.path);
      } catch (err) {
        report.uploadErrors.push(`${asset.path}: ${err.message || err}`);
      }
    }

    // 2. Re-plan against what's now on the server, so items point at the
    //    real uploaded paths.
    plan = await planItemsFromWorld(bundle, files, { ...runOptions, reupload: false });
    report.plan = plan.summary;
    report.warnings.push(...plan.warnings);
    report.missingImages = plan.missingImages;
    report.unknownTypes = plan.unknownTypes;
    report.orphans = runOptions.removeOrphans ? [] : plan.orphaned;
    const { index } = await buildItemsIndex(bundle);

    // 3. Folders, parents first.
    const folderIds = new Map(Object.entries(index.folders).map(([key, f]) => [key, f.id]));
    const folderCreates = plan.folders.filter(f => f.op === "create");
    for (const [i, f] of folderCreates.entries()) {
      onProgress?.(`Creating folders… ${i + 1}/${folderCreates.length}`);
      const folder = await FolderCls().create({
        name: f.name, type: "Item", folder: f.parentKey ? folderIds.get(f.parentKey) ?? null : null,
        flags: { [MODULE_ID]: { folderKey: f.key } }
      }, { pack: pack.collection });
      folderIds.set(f.key, folder.id);
    }

    // 4. Back up hand-edited items before overwriting them.
    const date = new Date().toISOString().slice(0, 10);
    for (const op of plan.items.filter(i => i.op === "update" && i.manualEdit)) {
      const doc = await pack.getDocument(op.id);
      if (!doc) continue;
      await backupEditedItem(doc, bundle.source, date);
      report.backups.push(op.name);
    }

    // 5. Creates and updates, in batches.
    const imgFor = (op) => {
      if (op.img.kind === "asset" && op.img.url && !op.img.url.startsWith("pending:")) return op.img.url;
      if (op.img.kind === "keep" || (op.img.kind === "asset" && op.op === "update")) return undefined;
      return defaultIcon(op.type);
    };
    const dataFor = (op) => {
      const data = {
        name: op.name, type: op.type, folder: op.folderKey ? folderIds.get(op.folderKey) ?? null : null,
        system: mergedSystem(op.type, op.system),
        flags: { [MODULE_ID]: { itemKey: op.key, item: { ...op.flag } } }
      };
      const img = imgFor(op);
      if (img !== undefined) data.img = img;
      return data;
    };
    const written = [];
    const creates = plan.items.filter(i => i.op === "create");
    for (const batch of chunks(creates)) {
      written.push(...await ItemCls().createDocuments(batch.map(dataFor), { pack: pack.collection }));
      onProgress?.(`Creating items… ${written.length}/${creates.length}`);
    }
    const updates = plan.items.filter(i => i.op === "update");
    let updated = 0;
    // An ordinary update can't change an Item's type, so `type` is left out;
    // a bundle that changes a type gets a warning instead.
    for (const op of updates) {
      const current = index.items[op.key];
      if (current && current.type !== op.type) report.warnings.push(`${op.name}: the bundle changes its type from "${current.type}" to "${op.type}", which an update can't do. Delete the compendium item and re-import to recreate it.`);
    }
    for (const batch of chunks(updates)) {
      const data = batch.map(op => { const d = { _id: op.id, ...dataFor(op) }; delete d.type; return d; });
      written.push(...await ItemCls().updateDocuments(data, { pack: pack.collection }));
      updated += batch.length;
      onProgress?.(`Updating items… ${updated}/${updates.length}`);
    }

    // 6. Record what each written document now hashes to, so a later edit
    //    in Foundry can be told apart from the import's own write.
    const hashes = written.filter(Boolean).map(doc => ({ _id: doc.id, [`flags.${MODULE_ID}.item.docHash`]: currentDocHash(doc) }));
    for (const batch of chunks(hashes)) await ItemCls().updateDocuments(batch, { pack: pack.collection });

    // 7. Orphans, only when asked; then folders left empty (deepest first).
    const deletes = plan.items.filter(i => i.op === "delete").map(i => i.id);
    for (const batch of chunks(deletes)) await ItemCls().deleteDocuments(batch, { pack: pack.collection });
    const folderDeletes = plan.folders.filter(f => f.op === "delete").sort((a, b) => b.key.split("/").length - a.key.split("/").length).map(f => f.id);
    for (const batch of chunks(folderDeletes)) await FolderCls().deleteDocuments(batch, { pack: pack.collection });

    report.created = creates.length;
    report.updated = updates.length;
    report.deleted = deletes.length;
    report.foldersCreated = folderCreates.length;
    report.foldersDeleted = folderDeletes.length;
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }

  await appendImportLog({
    when: report.when,
    title: `Imported items: ${bundle.source.short} v${bundle.bundleVersion}`,
    html: itemsReportHtml(report),
    registryUpdate: {
      [`flags.${MODULE_ID}.itemSources.${bundle.source.key}`]: {
        bundleVersion: bundle.bundleVersion, title: bundle.source.title, short: bundle.source.short, pack: bundle.pack.name, importedAt: report.when
      }
    }
  });
  return report;
}

export function itemsReportHtml(report) {
  return `<p><strong>${esc(report.source?.title)}</strong> (${esc(report.source?.key)}), bundle version ${esc(report.bundleVersion)} → compendium <strong>${esc(report.pack?.label)}</strong>${report.packCreated ? " (created)" : ""} — ${esc(new Date(report.when).toLocaleString())}</p>`
    + `<table class="tt-table">`
    + `<tr><td>Items</td><td>created <strong>${report.created ?? 0}</strong> · updated <strong>${report.updated ?? 0}</strong> · unchanged <strong>${report.plan?.items?.unchanged ?? 0}</strong> · removed <strong>${report.deleted ?? 0}</strong></td></tr>`
    + `<tr><td>Folders</td><td>created <strong>${report.foldersCreated ?? 0}</strong> · removed <strong>${report.foldersDeleted ?? 0}</strong></td></tr>`
    + `<tr><td>Images</td><td>uploaded <strong>${report.uploaded?.length ?? 0}</strong> · failed <strong>${report.uploadErrors?.length ?? 0}</strong> · missing <strong>${report.missingImages?.length ?? 0}</strong></td></tr>`
    + `</table>`
    + listHtml("Warnings", report.warnings, w => esc(w))
    + listHtml("Image upload failures", report.uploadErrors, e => esc(e))
    + listHtml("Items without their image (not chosen and not on the server)", report.missingImages, m => `${esc(m.name)} — <code>${esc(m.asset)}</code>`)
    + listHtml("Hand-edited items backed up to the world before overwriting", report.backups, n => esc(n))
    + listHtml("Unknown item types (skipped)", report.unknownTypes, u => `${esc(u.name)} — <code>${esc(u.type)}</code>`)
    + listHtml("Orphaned items kept", report.orphans, o => esc(o.name));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function registerItemsImportSettings() {
  game.settings.register(MODULE_ID, "itemImageFolder", {
    name: "Item image folder",
    hint: "Where imported item images are uploaded (on the Forge, inside your Assets Library). Each source gets its own sub-folder.",
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    default: DEFAULT_IMAGE_FOLDER
  });
  game.settings.registerMenu(MODULE_ID, "importItemsBundle", {
    name: "Import Items Bundle",
    label: "Import Items",
    hint: "Import an items bundle (.tt-items.json plus its images) into a world compendium, such as the Central Supply Catalogue. Always shows a dry run first; re-importing only updates what changed.",
    icon: "fa-solid fa-boxes-stacked",
    type: ItemsImportMenu,
    restricted: true
  });
}

class ItemsImportMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "tt-items-import-menu", window: { title: "Import Items Bundle" } };
  async render(options) { openItemsImportApp(); return this; }
}

let instance = null;
export function openItemsImportApp() {
  if (!game.user.isGM) return null;
  if (instance?.rendered) { instance.bringToFront(); return instance; }
  instance = new ItemsImportApp();
  instance.render(true);
  return instance;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function opBadge(op) {
  return `<span class="tt-badge tt-lore-op tt-lore-op-${esc(op)}">${esc(op)}</span>`;
}

class ItemsImportApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-items-import-app",
    classes: ["traveller-trading-window"],
    window: { title: "Import Items Bundle", resizable: true },
    position: { width: 640, height: "auto" }
  };

  constructor(options) {
    super(options);
    this.fileName = "";
    this.bundle = null;
    this.stripped = [];
    this.files = new Map();   // asset path -> File
    this.imageCount = 0;      // files the GM chose
    this.error = "";
    this.plan = null;
    this.planning = false;
    this.report = null;
    this.busy = false;
    this.statusHtml = "";
    // Not `this.options`: ApplicationV2 keeps its own configuration there.
    this.importOptions = { reupload: false, removeOrphans: false };
  }

  async close(options) {
    instance = null;
    return super.close(options);
  }

  async _load() {}

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", (e) => {
      const opt = e.target.closest("[data-tt-items-opt]");
      if (!opt) return;
      this.importOptions[opt.dataset.ttItemsOpt] = opt.checked;
      this._replan();
    });
  }

  async _replan() {
    if (!this.bundle) { this.plan = null; this._renderContent(); return; }
    this.planning = true;
    this._renderContent();
    try {
      this.plan = await planItemsFromWorld(this.bundle, this.files, this.importOptions);
      this.error = "";
    } catch (err) {
      console.error("Traveller Trading | Items dry run failed", err);
      this.plan = null;
      this.error = `Dry run failed: ${err.message || err}`;
    }
    this.planning = false;
    this._renderContent();
  }

  async _action_choose_bundle() {
    const file = await chooseFile({ accept: ".json,.tt-items.json,application/json" });
    if (!file) return;
    this.fileName = file.name;
    this.bundle = null; this.plan = null; this.report = null; this.error = "";
    try {
      if (file.size > MAX_ITEMS_BYTES) throw new Error("Items bundle exceeds the 25 MB limit.");
      const { bundle, stripped } = validateItemsBundle(await file.text());
      this.bundle = bundle;
      this.stripped = stripped;
      this._matchImages(this._chosenImages || []);
    } catch (err) {
      this.error = err.message || String(err);
    }
    await this._replan();
  }

  async _action_choose_images(button) {
    const files = await chooseFiles({ accept: "image/*", directory: button?.dataset.ttDirectory === "1" });
    if (!files.length) return;
    this._chosenImages = files;
    this._matchImages(files);
    this.report = null;
    await this._replan();
  }

  // webkitRelativePath starts with the chosen folder's own name; drop it so
  // "images/weaponry/club.webp" matches the asset "weaponry/club.webp".
  _matchImages(files) {
    this.imageCount = files.length;
    if (!this.bundle) { this.files = new Map(); return; }
    const entries = files.map(file => ({
      file, path: file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name
    }));
    const matched = matchAssetFiles(this.bundle.assets, entries);
    this.files = new Map([...matched].map(([asset, entry]) => [asset, entry.file]));
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
      this.report = await applyItemsImport(this.bundle, this.files, this.importOptions, (text) => {
        this.statusHtml = `<p class="tt-hint">${esc(text)}</p>`;
        this._renderContent();
      });
      this.statusHtml = "";
      ui.notifications.info(`Traveller Trading: imported ${this.bundle.items.length} items into ${this.bundle.pack.label}.`);
    } catch (err) {
      console.error("Traveller Trading | Items import failed", err);
      this.statusHtml = `<p class="tt-hint tt-lore-error">Import failed: ${esc(err.message || String(err))}. Anything written before the failure is kept; re-importing will finish the job.</p>`;
    }
    this.busy = false;
    await this._replan();
  }

  _dryRunHtml() {
    const plan = this.plan;
    const s = plan.summary;
    const changed = plan.items.filter(i => i.op === "create" || i.op === "update" || i.op === "delete");
    let html = "";
    if (plan.warnings.length) html += `<div class="tt-lore-warn"><ul>${plan.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    html += `<h4 class="tt-lore-h">Dry run</h4>
      <table class="tt-table">
        <tr><td>Compendium</td><td>${esc(plan.pack.label)} <span class="tt-hint">world.${esc(plan.pack.name)}</span>${plan.packExists ? "" : " — <strong>will be created</strong>"}</td></tr>
        <tr><td>Items</td><td>create <strong>${s.items.create}</strong> · update <strong>${s.items.update}</strong> · unchanged <strong>${s.items.unchanged}</strong> · orphaned <strong>${s.orphaned}</strong>${plan.removeOrphans ? ` (remove <strong>${s.items.delete}</strong>)` : ""}</td></tr>
        <tr><td>Folders</td><td>create <strong>${s.folders.create}</strong>${s.folders.delete ? ` · remove <strong>${s.folders.delete}</strong>` : ""}</td></tr>
        <tr><td>Images</td><td>upload <strong>${s.assets.upload}</strong> · already uploaded <strong>${s.assets.present}</strong> · missing <strong>${s.assets.missing}</strong></td></tr>
        <tr><td>Edited in Foundry</td><td><strong>${s.manualEdits}</strong>${s.manualEdits ? " (backed up to the world before overwriting)" : ""}</td></tr>
        <tr><td>Unknown item types</td><td><strong>${s.unknownTypes}</strong>${s.unknownTypes ? " (skipped)" : ""}</td></tr>
      </table>
      <p class="tt-hint">${plan.changeCount === 0 ? "No changes — everything in this bundle is already imported." : `${plan.changeCount} change(s) to apply.`} Images go to <code>${esc(plan.assetBase)}</code>.</p>
      <details class="tt-lore-details"><summary>Details</summary>
        ${listHtml("Items", changed, i => `${opBadge(i.op)} ${esc(i.name)}${i.reasons?.length ? ` <span class="tt-hint">${esc(i.reasons.join(", "))}</span>` : ""}`)}
        ${listHtml(plan.removeOrphans ? "Orphaned items (will be removed)" : "Orphaned items (kept)", plan.orphaned, o => esc(o.name))}
        ${listHtml("Edited in Foundry", plan.manualEdits, m => esc(m.name))}
        ${listHtml("Unknown item types", plan.unknownTypes, u => `${esc(u.name)} — <code>${esc(u.type)}</code>`)}
        ${listHtml("Images to upload", plan.assets.filter(a => a.status === "upload"), a => `<code>${esc(a.path)}</code>`)}
        ${listHtml("Images missing (choose the images folder to include them)", plan.assets.filter(a => a.status === "missing"), a => `<code>${esc(a.path)}</code>`)}
        ${listHtml("Folders", plan.folders.filter(f => f.op !== "unchanged"), f => `${opBadge(f.op)} ${esc(f.key.slice(f.key.indexOf(":") + 1))}`)}
      </details>`;
    return html;
  }

  _renderContent() {
    if (!this.root) return;
    const disabled = this.busy || this.planning ? "disabled" : "";
    let body = `<p class="tt-hint">Choose an items bundle (<code>.tt-items.json</code>) and the folder holding its images. Nothing is written until you review the dry run and click Apply.</p>
      <div class="tt-inline-row">
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="choose_bundle" ${disabled}>Choose bundle…</button>
        ${this.fileName ? `<span class="tt-hint">${esc(this.fileName)}</span>` : ""}
      </div>
      <div class="tt-inline-row" style="margin-top:6px;">
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="choose_images" data-tt-directory="1" ${disabled}>Choose images folder…</button>
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="choose_images" ${disabled}>…or image files</button>
        ${this.imageCount ? `<span class="tt-hint">${this.imageCount} file(s) chosen${this.bundle ? `, ${this.files.size} of ${this.bundle.assets.length} bundle images matched` : ""}</span>` : ""}
      </div>`;
    if (this.error) body += `<p class="tt-hint tt-lore-error">${esc(this.error)}</p>`;
    if (this.bundle) {
      const b = this.bundle;
      body += `<div class="tt-lore-bundle-info">
        <p><strong>${esc(b.source.title)}</strong> <span class="tt-badge">${esc(b.source.key)}</span> · bundle version <strong>${b.bundleVersion}</strong>${this.plan?.storedVersion != null ? ` (imported so far: ${this.plan.storedVersion})` : ""}</p>
        <p class="tt-hint">${b.items.length} items, ${b.assets.length} images → compendium "${esc(b.pack.label)}".</p>
      </div>`;
      if (this.stripped.length) body += `<div class="tt-lore-warn"><p><strong>Disallowed HTML was stripped from descriptions:</strong></p><ul>${this.stripped.map(s => `<li>${esc(s.where)}: ${s.tags.map(t => `&lt;${esc(t)}&gt;`).join(", ")}</li>`).join("")}</ul></div>`;
      if (this.planning) body += `<p class="tt-hint">Checking the compendium and image folder…</p>`;
      else if (this.plan) body += this._dryRunHtml();
      const opt = (key, label) => `<label class="tt-lore-opt"><input type="checkbox" data-tt-items-opt="${key}" ${this.importOptions[key] ? "checked" : ""} ${disabled}> ${label}</label>`;
      body += `<div class="tt-lore-options">
        ${opt("reupload", "Re-upload images that already exist")}
        ${opt("removeOrphans", "Remove orphaned items from this source")}
      </div>
      <div class="tt-inline-row" style="margin-top:10px;">
        <button type="button" class="tt-btn" data-tt-action="apply" ${disabled || !this.plan ? "disabled" : ""}>Apply Import</button>
      </div>`;
    }
    body += this.statusHtml || "";
    if (this.report) body += `<div class="tt-lore-report"><h4 class="tt-lore-h">Import report</h4>${itemsReportHtml(this.report)}<p class="tt-hint">Also saved to the "Import Log" journal.</p></div>`;
    this.root.innerHTML = `<div class="tt-lore-window">${body}</div>`;
  }
}
