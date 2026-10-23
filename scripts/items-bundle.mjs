import { hashFnv1a, sanitizeHtml } from "./lore-bundle.mjs";

// ---------------------------------------------------------------------------
// Items bundles: the pure half of the items importer, in the same shape as
// lore-bundle.mjs. Nothing here touches a Foundry global. items-import.mjs
// builds a plain-object snapshot ("index") of the compendium and the image
// folder, hands it to planItemsImport(), shows the plan as the dry run, then
// applies it.
//
// Index shape:
//   items:   { [itemKey]: { id, uuid, name, type, img, folderKey, flag, currentDocHash } }
//   folders: { [folderKey]: { id, name, foreignCount } }   only importer folders
//   assets:  { [assetPath]: serverPath }                   images already uploaded
//   sources: { [sourceKey]: { bundleVersion } }            registry on the Import Log
// ---------------------------------------------------------------------------

export const ITEMS_FORMAT = "tt-items-bundle";
export const ITEMS_FORMAT_VERSION = 1;
export const MAX_ITEMS_BYTES = 25 * 1024 * 1024;
export const ITEM_DESCRIPTION_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "br", "table", "tr", "th", "td"]);

const SOURCE_KEY_RE = /^[a-z0-9-]+$/;
const PACK_NAME_RE = /^[a-z0-9_-]+$/;
const IMAGE_RE = /\.(webp|png|jpe?g|gif|svg|avif)$/i;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message) { throw new Error(message); }
function isObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function requiredString(v, path, max = 300) {
  if (typeof v !== "string" || !v.trim()) fail(`${path} is required.`);
  if (v.length > max) fail(`${path} is too long (over ${max} characters).`);
  return v.trim();
}
function optionalString(v, path, max = 300) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") fail(`${path} must be a string.`);
  if (v.length > max) fail(`${path} is too long (over ${max} characters).`);
  return v.trim();
}

// Asset paths become part of an upload path on the server, so anything that
// could climb out of the target folder, or name another drive, is rejected.
function checkAssetPath(path, where) {
  if (typeof path !== "string" || !path.trim()) fail(`${where} must be a relative file path.`);
  const p = path.trim();
  if (p.startsWith("/") || p.includes("\\") || p.includes(":") || p.split("/").some(seg => !seg || seg === "." || seg === "..")) {
    fail(`${where} "${p}" must be a plain relative path such as "weaponry/club.webp".`);
  }
  if (!IMAGE_RE.test(p)) fail(`${where} "${p}" is not an image file.`);
  return p;
}

export const folderKey = (sourceKey, path) => `${sourceKey}:${path.join("/")}`;

// FNV-1a over canonical JSON of the bundle's view of an item. `img` is the
// asset path from the bundle (or null), not the server URL, so the hash
// doesn't change between Forge and a self-hosted server.
export function itemHash(item) {
  return hashFnv1a({ name: item.name, type: item.type, folder: item.folder, img: item.img ?? null, system: item.system });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Mirrors validateBundle() in lore-bundle.mjs. Whether each item `type`
// exists is checked by the Foundry layer (it needs game.system), and passed
// to the planner as `knownTypes`.
export function validateItemsBundle(input) {
  let data = input;
  if (typeof input === "string") {
    if (input.length > MAX_ITEMS_BYTES) fail("Items bundle exceeds the 25 MB limit.");
    try { data = JSON.parse(input.replace(/^﻿/, "")); }
    catch { fail("The selected file is not valid items bundle JSON."); }
  }
  if (!isObject(data) || data.format !== ITEMS_FORMAT) fail(`This is not a Traveller Trading items bundle (format must be "${ITEMS_FORMAT}").`);
  if (data.formatVersion !== ITEMS_FORMAT_VERSION) fail(`Unsupported items bundle formatVersion (${JSON.stringify(data.formatVersion)}). Update Traveller Trading before importing this file.`);
  if (!isObject(data.source)) fail("source must be an object.");
  if (typeof data.source.key !== "string" || !SOURCE_KEY_RE.test(data.source.key)) fail("source.key is required and may only contain a-z, 0-9 and \"-\".");
  optionalString(data.source.title, "source.title");
  optionalString(data.source.short, "source.short", 40);
  if (data.source.order !== undefined && !Number.isFinite(data.source.order)) fail("source.order must be a number.");
  if (!Number.isInteger(data.bundleVersion) || data.bundleVersion < 0) fail("bundleVersion is required and must be a whole number.");
  if (!isObject(data.pack)) fail("pack is required, with a name and a label.");
  if (typeof data.pack.name !== "string" || !PACK_NAME_RE.test(data.pack.name)) fail("pack.name is required and may only contain a-z, 0-9, \"-\" and \"_\".");
  optionalString(data.pack.label, "pack.label");

  if (data.assets !== undefined && !Array.isArray(data.assets)) fail("assets must be a list.");
  const assets = new Set();
  (data.assets || []).forEach((a, i) => {
    const p = checkAssetPath(a, `assets[${i}]`);
    if (assets.has(p)) fail(`Duplicate asset "${p}".`);
    assets.add(p);
  });

  if (data.items !== undefined && !Array.isArray(data.items)) fail("items must be a list.");
  const keys = new Set();
  (data.items || []).forEach((item, i) => {
    const at = `items[${i}]`;
    if (!isObject(item)) fail(`${at} must be an object.`);
    const key = requiredString(item.key, `${at}.key`);
    if (keys.has(key)) fail(`Duplicate item key "${key}". Item keys must be unique within a bundle.`);
    keys.add(key);
    requiredString(item.name, `${at}.name (item "${key}")`);
    requiredString(item.type, `${at}.type (item "${key}")`, 60);
    if (item.folder !== undefined && item.folder !== null) {
      if (!Array.isArray(item.folder)) fail(`${at}.folder (item "${key}") must be a list of folder names.`);
      item.folder.forEach((seg, k) => {
        const name = requiredString(seg, `${at}.folder[${k}] (item "${key}")`, 200);
        if (name.includes("/")) fail(`${at}.folder[${k}] (item "${key}") must not contain "/".`);
      });
    }
    if (item.img !== undefined && item.img !== null) {
      const img = checkAssetPath(item.img, `${at}.img (item "${key}")`);
      if (!assets.has(img)) fail(`${at}.img "${img}" (item "${key}") is not listed in assets.`);
    }
    if (item.page !== undefined && item.page !== null && !Number.isFinite(item.page) && typeof item.page !== "string") fail(`${at}.page (item "${key}") must be a number.`);
    if (item.system !== undefined && !isObject(item.system)) fail(`${at}.system (item "${key}") must be an object.`);
  });

  return normalizeItemsBundle(data);
}

function normalizeItemsBundle(data) {
  const stripped = [];
  const items = (data.items || []).map(item => {
    const system = structuredClone(item.system || {});
    if (typeof system.description === "string") {
      const r = sanitizeHtml(system.description, ITEM_DESCRIPTION_TAGS);
      if (r.stripped.length) stripped.push({ where: `item ${item.key.trim()}`, tags: r.stripped });
      system.description = r.html;
    }
    return {
      key: item.key.trim(), name: item.name.trim(), type: item.type.trim(),
      folder: (item.folder || []).map(s => s.trim()),
      img: item.img ? item.img.trim() : null,
      page: item.page ?? null,
      system
    };
  });
  const src = data.source;
  const bundle = {
    format: ITEMS_FORMAT, formatVersion: ITEMS_FORMAT_VERSION,
    source: { key: src.key, title: (src.title || "").trim() || src.key, short: (src.short || "").trim() || src.key, order: Number.isFinite(src.order) ? src.order : 0 },
    bundleVersion: data.bundleVersion,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
    pack: { name: data.pack.name, label: (data.pack.label || "").trim() || data.pack.name },
    assets: (data.assets || []).map(a => a.trim()),
    items
  };
  return { bundle, stripped };
}

// Matches locally chosen image files to the bundle's asset paths. `files`
// is a list of { path } where path is webkitRelativePath with the chosen
// folder's own name removed, or just the file name (multi-file fallback).
// Exact relative paths win; otherwise a file name that is unique among the
// assets is accepted.
export function matchAssetFiles(assets, files) {
  const byPath = new Map(), byName = new Map();
  for (const f of files) {
    byPath.set(f.path, f);
    const name = f.path.split("/").pop();
    byName.set(name, byName.has(name) ? null : f);
  }
  const nameCount = new Map();
  for (const a of assets) { const n = a.split("/").pop(); nameCount.set(n, (nameCount.get(n) || 0) + 1); }
  const matched = new Map();
  for (const a of assets) {
    const name = a.split("/").pop();
    const file = byPath.get(a) || (nameCount.get(name) === 1 ? byName.get(name) : null);
    if (file) matched.set(a, file);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function storedVersion(index, sourceKey) {
  const versions = [];
  const reg = index.sources?.[sourceKey]?.bundleVersion;
  if (Number.isInteger(reg)) versions.push(reg);
  for (const item of Object.values(index.items || {})) {
    if (item.flag?.source === sourceKey && Number.isInteger(item.flag.bundleVersion)) versions.push(item.flag.bundleVersion);
  }
  return versions.length ? Math.max(...versions) : null;
}

function countOps(ops) {
  const out = { create: 0, update: 0, unchanged: 0, delete: 0, skip: 0 };
  for (const op of ops) out[op.op] = (out[op.op] || 0) + 1;
  return out;
}

// Works out what an import would do, without doing it. Options:
//   chosenAssets: asset paths the GM picked local files for
//   reupload:     upload chosen images even if already on the server
//   removeOrphans: delete this source's items missing from the bundle
//   knownTypes:   Item types the system defines (null = don't check)
// Item images resolve to the server path in index.assets; an image about to
// be uploaded resolves to "pending:<path>", which the apply replaces after
// uploading (it re-plans against a fresh index).
export function planItemsImport(bundle, index = {}, { chosenAssets = [], reupload = false, removeOrphans = false, knownTypes = null } = {}) {
  const src = bundle.source.key;
  const idxItems = index.items || {};
  const idxFolders = index.folders || {};
  const present = index.assets || {};
  const chosen = new Set(chosenAssets);
  const warnings = [];

  const stored = storedVersion(index, src);
  const needsConfirm = stored !== null && bundle.bundleVersion < stored;
  if (needsConfirm) warnings.push(`This bundle is version ${bundle.bundleVersion} of "${bundle.source.title}", but version ${stored} has already been imported. Importing it may roll items back.`);

  // Images.
  const assets = bundle.assets.map(path => {
    const isPresent = Object.hasOwn(present, path);
    const isChosen = chosen.has(path);
    const status = isChosen && (!isPresent || reupload) ? "upload" : isPresent ? "present" : "missing";
    return { path, status, url: present[path] ?? null };
  });
  const assetStatus = new Map(assets.map(a => [a.path, a]));

  // Items.
  const known = knownTypes ? new Set(knownTypes) : null;
  const unknownTypes = [];
  const items = [];
  const neededFolders = new Map(); // key -> { key, name, parentKey, path }
  const missingImages = [];
  const bundleKeys = new Set(bundle.items.map(i => i.key));

  for (const item of bundle.items) {
    if (known && !known.has(item.type)) {
      unknownTypes.push({ key: item.key, name: item.name, type: item.type });
      items.push({ op: "skip", key: item.key, name: item.name, type: item.type, reason: `unknown type "${item.type}"` });
      continue;
    }
    for (let depth = 1; depth <= item.folder.length; depth++) {
      const path = item.folder.slice(0, depth);
      const key = folderKey(src, path);
      if (!neededFolders.has(key)) neededFolders.set(key, { key, name: path.at(-1), parentKey: depth > 1 ? folderKey(src, path.slice(0, -1)) : null, path });
    }
    const hash = itemHash(item);
    const existing = idxItems[item.key];
    const fKey = item.folder.length ? folderKey(src, item.folder) : null;

    // Where the item's image will point.
    let img;
    if (!item.img) img = { kind: "default" };
    else {
      const a = assetStatus.get(item.img);
      if (a.status === "upload") img = { kind: "asset", path: item.img, url: a.url ?? `pending:${item.img}` };
      else if (a.status === "present") img = { kind: "asset", path: item.img, url: a.url };
      else {
        img = existing ? { kind: "keep" } : { kind: "default" };
        missingImages.push({ key: item.key, name: item.name, asset: item.img });
      }
    }

    const flag = { source: src, bundleVersion: bundle.bundleVersion, hash, page: item.page, asset: item.img };
    const op = { key: item.key, name: item.name, type: item.type, folderKey: fKey, img, system: item.system, flag, manualEdit: false, reasons: [] };
    if (!existing) { items.push({ ...op, op: "create" }); continue; }
    op.id = existing.id;
    op.manualEdit = !!(existing.flag?.docHash && existing.currentDocHash && existing.currentDocHash !== existing.flag.docHash);
    if (op.manualEdit) op.reasons.push("edited in Foundry");
    if (existing.flag?.hash !== hash) op.reasons.push("changed in bundle");
    if (existing.flag?.source !== src) op.reasons.push("source changed");
    if (img.kind === "asset" && img.url !== existing.img) op.reasons.push("image");
    if (op.reasons.length) items.push({ ...op, op: "update" });
    else items.push({ ...op, op: "unchanged", flag: existing.flag });
  }

  // Orphans: this source's items that the bundle no longer contains.
  const orphaned = [];
  for (const [key, existing] of Object.entries(idxItems)) {
    if (existing.flag?.source !== src || bundleKeys.has(key)) continue;
    orphaned.push({ key, name: existing.name, id: existing.id });
    if (removeOrphans) items.push({ op: "delete", key, name: existing.name, id: existing.id, folderKey: existing.folderKey });
  }

  // Folders: create what's missing; when removing orphans, also delete this
  // source's folders that end up with nothing in them. A folder holding
  // anything the importer didn't create (foreignCount) is always kept.
  const folders = [];
  for (const f of [...neededFolders.values()].sort((a, b) => a.path.length - b.path.length || cmp(a.key, b.key))) {
    folders.push(idxFolders[f.key] ? { op: "unchanged", ...f, id: idxFolders[f.key].id } : { op: "create", ...f });
  }
  if (removeOrphans) {
    const deleting = new Set(items.filter(i => i.op === "delete").map(i => i.key));
    const occupied = new Set();
    for (const [key, existing] of Object.entries(idxItems)) {
      if (deleting.has(key) || !existing.folderKey) continue;
      occupied.add(existing.folderKey);
    }
    for (const i of items) if (i.folderKey && i.op !== "delete" && i.op !== "skip") occupied.add(i.folderKey);
    const keepPrefix = key => [...occupied].some(k => k === key || k.startsWith(`${key}/`));
    for (const [key, f] of Object.entries(idxFolders)) {
      if (!key.startsWith(`${src}:`) || neededFolders.has(key)) continue;
      if (f.foreignCount || keepPrefix(key)) continue;
      // Foreign content in a subfolder also keeps the parent.
      if (Object.entries(idxFolders).some(([k, sub]) => k.startsWith(`${key}/`) && sub.foreignCount)) continue;
      folders.push({ op: "delete", key, name: f.name, id: f.id });
    }
  }

  const manualEdits = items.filter(i => i.manualEdit).map(i => ({ key: i.key, name: i.name }));
  const summary = {
    items: countOps(items), orphaned: orphaned.length,
    folders: countOps(folders),
    assets: { upload: assets.filter(a => a.status === "upload").length, present: assets.filter(a => a.status === "present").length, missing: assets.filter(a => a.status === "missing").length },
    manualEdits: manualEdits.length, unknownTypes: unknownTypes.length, missingImages: missingImages.length
  };
  const changeCount = summary.items.create + summary.items.update + summary.items.delete
    + summary.folders.create + summary.folders.delete + summary.assets.upload;

  return {
    kind: "items", source: { ...bundle.source }, bundleVersion: bundle.bundleVersion, pack: { ...bundle.pack },
    storedVersion: stored, needsConfirm, warnings, removeOrphans, reupload,
    items, folders, assets, orphaned, manualEdits, unknownTypes, missingImages, summary, changeCount
  };
}

// The hash stored after a write, compared on the next import to spot edits
// made in Foundry. Covers what a GM would edit (name, image, system data),
// not folder placement or flags: moving an item isn't an edit.
export function docHash({ name, type, img, system }) {
  return hashFnv1a({ name, type, img: img ?? null, system: system ?? {} });
}
