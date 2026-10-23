// ---------------------------------------------------------------------------
// Lore bundles: the pure half of the lore importer. Nothing in this file
// touches a Foundry global, so the same code runs under `node --test` and in
// the browser. scripts/lore-import.mjs is the Foundry layer: it builds a
// plain-object snapshot ("index") of the lore documents that already exist,
// hands it to planLoreImport()/planRemoveSource() here, shows the resulting
// plan as a dry run, and only then writes documents.
//
// Index shape (built by buildLoreIndex() in lore-import.mjs, or by hand in
// tests/lore-bundle.test.mjs):
//   entries: { [loreKey]: { id, uuid, name, flag, pageCount } }
//   pages:   { [loreKey]: { id, uuid, entryKey, name, sort, flag, contentHash } }
//   notes:   { [pageKey]: { id, uuid, entryKey } }      GM "Notes" pages
//   actors:  { ["world:<Sector>:<hex>"]: { id, uuid, name, uwp, subsector, subsectorLetter, lore } }
//   sources: { [sourceKey]: { bundleVersion, ... } }    registry kept on the import log
// ---------------------------------------------------------------------------

export const LORE_FORMAT = "tt-lore-bundle";
export const LORE_FORMAT_VERSION = 1;
export const MAX_LORE_BYTES = 25 * 1024 * 1024;
export const ALLOWED_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "h4", "h5", "br", "table", "tr", "th", "td", "span"]);
export const HOOK_STATUSES = ["unused", "seeded", "used", "discarded"];
export const DEFAULT_REFERENCE_FOLDER = "Reference";
export const UNKNOWN_SUBSECTOR = "Unknown Subsector";

// Elements whose text content is never meaningful prose, so stripping only
// the tag (as for any other disallowed element) would leave code or markup
// visible on the page. Their content goes too.
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "select", "head", "title"]);
const HEX_RE = /^\d{4}$/;
const SOURCE_KEY_RE = /^[a-z0-9-]+$/;
const RESERVED_KEY_RE = /^(world|sub|hooks|log|folder):/;
const LORE_LINK_RE = /@Lore\[([^\]\n]+)\]\{([^}\n]*)\}/g;

export const loreKeys = {
  world: (sector, hex) => `world:${sector}:${hex}`,
  subsector: (sector, name) => `sub:${sector}:${name}`,
  overview: (sector, name) => `sub:${sector}:${name}:overview`,
  hooks: sector => `hooks:${sector}`,
  hooksIndex: sector => `hooks:${sector}:index`,
  notes: pageKey => `${pageKey}:notes`,
  sectorFolder: sector => `folder:${sector}`,
  gazetteerFolder: sector => `folder:${sector}:Gazetteer`,
  referenceFolder: (sector, name) => `folder:${sector}:ref:${name}`
};

// Block and hook IDs become object keys inside document flags. Foundry
// expands dotted keys in update data into nested objects ("III.54" would
// become {III: {54: …}}), so every ID is stored under a dot-free key. The
// encoding is reversible, and each record also carries its original `id`.
export function safeKey(id) {
  return String(id).replace(/%/g, "%25").replace(/\./g, "%2E");
}
export function unsafeKey(key) {
  return String(key).replace(/%2E/g, ".").replace(/%25/g, "%");
}

function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
// Text inside @UUID[...]{label} / @Lore[...]{label} cannot contain braces
// or brackets without ending the link early.
function linkLabel(s) {
  return String(s ?? "").replace(/[{}[\]]/g, "");
}
// Plain code-unit comparison rather than localeCompare, so ordering (and
// therefore rendered HTML and hashes) is identical in Node and every browser.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameCmp = (a, b) => cmp(String(a).toLowerCase(), String(b).toLowerCase()) || cmp(String(a), String(b));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => (v === undefined ? null : canonical(v)));
  const out = {};
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value)) ?? "null";
}

// FNV-1a, 32-bit, over the UTF-8 bytes of canonical JSON (object keys
// sorted at every depth). Synchronous on purpose: SubtleCrypto is async and
// unavailable outside secure contexts, and these hashes are only change
// detectors, never security checks.
const encoder = new TextEncoder();
export function hashFnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(canonicalJson(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// HTML sanitizing
// ---------------------------------------------------------------------------

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

function escapeText(text) {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function allowedAttributes(tag, raw) {
  if (tag !== "td" && tag !== "th") return "";
  let out = "";
  for (const m of raw.matchAll(/\b(colspan|rowspan)\s*=\s*["']?(\d{1,2})["']?/gi)) out += ` ${m[1].toLowerCase()}="${m[2]}"`;
  return out;
}

// A small tokenizer rather than DOMParser, so it runs in Node too. Allowed
// tags are re-emitted without attributes (only table colspan/rowspan
// survive), disallowed tags are dropped and reported, and every "<" or ">"
// left in text is escaped — so an unterminated "<img onerror=…" can never be
// completed by markup the renderer appends after it.
// `allowed` defaults to the lore tag list; items-bundle.mjs passes its own.
export function sanitizeHtml(html, allowed = ALLOWED_TAGS) {
  const input = String(html ?? "");
  const stripped = new Set();
  let out = "", last = 0, dropping = null;
  for (const m of input.matchAll(TAG_RE)) {
    const text = input.slice(last, m.index);
    last = m.index + m[0].length;
    if (!dropping) out += escapeText(text);
    if (!m[1]) continue; // comment
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === "/";
    if (dropping) {
      if (closing && tag === dropping) dropping = null;
      continue;
    }
    if (allowed.has(tag)) {
      if (tag === "br") { if (!closing) out += "<br>"; continue; }
      out += closing ? `</${tag}>` : `<${tag}${allowedAttributes(tag, m[0])}>`;
      continue;
    }
    stripped.add(tag);
    if (!closing && DROP_WITH_CONTENT.has(tag) && !/\/\s*>$/.test(m[0])) dropping = tag;
  }
  if (!dropping) out += escapeText(input.slice(last));
  return { html: out, stripped: [...stripped].sort() };
}

// ---------------------------------------------------------------------------
// Validation + normalization
// ---------------------------------------------------------------------------

function fail(message) { throw new Error(message); }
function isObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function requireObject(v, path) { if (!isObject(v)) fail(`${path} must be an object.`); return v; }
function optionalString(v, path, max = 2000) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") fail(`${path} must be a string.`);
  if (v.length > max) fail(`${path} is too long (over ${max} characters).`);
  return v.trim();
}
function requiredString(v, path, max = 2000) {
  if (typeof v !== "string" || !v.trim()) fail(`${path} is required.`);
  return optionalString(v, path, max);
}
function optionalList(v, path) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${path} must be a list.`);
  return v;
}
function checkHex(hex, path) {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) fail(`${path} "${hex}" is not a four-digit hex (for example "2223").`);
}
function checkTarget(t, path) {
  requireObject(t, path);
  if (t.type === "world") checkHex(t.hex, `${path}.hex`);
  else if (t.type === "subsector") requiredString(t.name, `${path}.name`, 200);
  else if (t.type === "journal") requiredString(t.page, `${path}.page`, 500);
  else fail(`${path}.type must be "world", "subsector" or "journal".`);
}

// Rejects anything the importer can't handle safely, with messages naming
// the offending field — same spirit as deserializeWorldMap() in
// world-map-data.mjs. Returns a clean copy (normalizeBundle) plus the list
// of HTML tags that were stripped, so the window can report them.
export function validateBundle(input) {
  let data = input;
  if (typeof input === "string") {
    if (input.length > MAX_LORE_BYTES) fail("Lore bundle exceeds the 25 MB limit.");
    try { data = JSON.parse(input.replace(/^﻿/, "")); }
    catch { fail("The selected file is not valid lore bundle JSON."); }
  }
  if (!isObject(data) || data.format !== LORE_FORMAT) fail(`This is not a Traveller Trading lore bundle (format must be "${LORE_FORMAT}").`);
  if (data.formatVersion !== LORE_FORMAT_VERSION) fail(`Unsupported lore bundle formatVersion (${JSON.stringify(data.formatVersion)}). Update Traveller Trading before importing this file.`);
  const source = requireObject(data.source, "source");
  if (typeof source.key !== "string" || !SOURCE_KEY_RE.test(source.key)) fail("source.key is required and may only contain a-z, 0-9 and \"-\".");
  optionalString(source.title, "source.title", 300);
  optionalString(source.short, "source.short", 40);
  if (source.order !== undefined && !Number.isFinite(source.order)) fail("source.order must be a number.");
  if (!Number.isInteger(data.bundleVersion) || data.bundleVersion < 0) fail("bundleVersion is required and must be a whole number.");
  requiredString(data.sector, "sector", 200);
  optionalString(data.milieu, "milieu", 40);
  optionalString(data.generatedAt, "generatedAt", 100);

  const blockIds = new Set();
  const checkBlocks = (list, path) => optionalList(list, path).forEach((b, i) => {
    const p = `${path}[${i}]`;
    requireObject(b, p);
    const id = requiredString(b.id, `${p}.id`, 300);
    if (blockIds.has(id)) fail(`Duplicate block id "${id}" (${p}). Block ids must be unique within a bundle.`);
    blockIds.add(id);
    if (typeof b.html !== "string") fail(`${p}.html (block "${id}") must be a string.`);
    optionalString(b.heading, `${p}.heading`, 500);
    optionalString(b.cite, `${p}.cite`, 500);
  });

  const subsectorNames = new Set();
  optionalList(data.subsectors, "subsectors").forEach((s, i) => {
    requireObject(s, `subsectors[${i}]`);
    const name = requiredString(s.name, `subsectors[${i}].name`, 200);
    if (subsectorNames.has(name)) fail(`Duplicate subsector "${name}".`);
    subsectorNames.add(name);
    if (s.letter !== undefined && s.letter !== null && !/^[A-Pa-p]$/.test(s.letter)) fail(`subsectors[${i}].letter must be a single letter A-P.`);
    checkBlocks(s.blocks, `subsectors[${i}].blocks`);
  });

  const hexes = new Set();
  optionalList(data.worlds, "worlds").forEach((w, i) => {
    requireObject(w, `worlds[${i}]`);
    checkHex(w.hex, `worlds[${i}].hex`);
    if (hexes.has(w.hex)) fail(`Duplicate world hex "${w.hex}".`);
    hexes.add(w.hex);
    requiredString(w.name, `worlds[${i}].name`, 200);
    optionalString(w.subsector, `worlds[${i}].subsector`, 200);
    if (w.uwpAlt !== undefined && w.uwpAlt !== null) {
      requireObject(w.uwpAlt, `worlds[${i}].uwpAlt`);
      requiredString(w.uwpAlt.uwp, `worlds[${i}].uwpAlt.uwp`, 20);
      optionalString(w.uwpAlt.note, `worlds[${i}].uwpAlt.note`, 500);
    }
    checkBlocks(w.blocks, `worlds[${i}].blocks`);
  });

  const journalKeys = new Set(), pageKeys = new Set();
  optionalList(data.journals, "journals").forEach((j, i) => {
    requireObject(j, `journals[${i}]`);
    const key = requiredString(j.key, `journals[${i}].key`, 300);
    if (RESERVED_KEY_RE.test(key)) fail(`journals[${i}].key "${key}" uses a reserved prefix (world:, sub:, hooks:, log:, folder:).`);
    if (journalKeys.has(key)) fail(`Duplicate journal key "${key}".`);
    journalKeys.add(key);
    requiredString(j.title, `journals[${i}].title`, 300);
    optionalString(j.folder, `journals[${i}].folder`, 200);
    optionalList(j.pages, `journals[${i}].pages`).forEach((p, k) => {
      requireObject(p, `journals[${i}].pages[${k}]`);
      const pageKey = requiredString(p.key, `journals[${i}].pages[${k}].key`, 300);
      if (RESERVED_KEY_RE.test(pageKey)) fail(`journals[${i}].pages[${k}].key "${pageKey}" uses a reserved prefix.`);
      if (pageKeys.has(pageKey) || journalKeys.has(pageKey)) fail(`Duplicate journal page key "${pageKey}".`);
      pageKeys.add(pageKey);
      requiredString(p.title, `journals[${i}].pages[${k}].title`, 300);
      checkBlocks(p.blocks, `journals[${i}].pages[${k}].blocks`);
    });
  });

  const hookIds = new Set();
  optionalList(data.hooks, "hooks").forEach((h, i) => {
    requireObject(h, `hooks[${i}]`);
    const id = requiredString(h.id, `hooks[${i}].id`, 100);
    if (hookIds.has(id)) fail(`Duplicate hook id "${id}".`);
    hookIds.add(id);
    optionalString(h.label, `hooks[${i}].label`, 100);
    checkTarget(h.target, `hooks[${i}].target`);
    optionalList(h.also, `hooks[${i}].also`).forEach((t, k) => checkTarget(t, `hooks[${i}].also[${k}]`));
    if (typeof h.html !== "string") fail(`hooks[${i}].html (hook "${id}") must be a string.`);
  });

  return normalizeBundle(data);
}

// Builds the clean copy the planner works from: unknown properties are
// dropped, optional fields get their defaults, and every html string is
// sanitized. Assumes validateBundle() has already accepted `data`.
export function normalizeBundle(data) {
  const stripped = [];
  const clean = (html, where) => {
    const result = sanitizeHtml(html);
    if (result.stripped.length) stripped.push({ where, tags: result.stripped });
    return result.html;
  };
  const blocks = list => (list || []).map(b => ({
    id: b.id.trim(), heading: (b.heading || "").trim(), html: clean(b.html, `block ${b.id.trim()}`), cite: (b.cite || "").trim()
  }));
  const target = t => t.type === "world" ? { type: "world", hex: t.hex }
    : t.type === "subsector" ? { type: "subsector", name: t.name.trim() }
    : { type: "journal", page: t.page.trim() };
  const src = data.source;
  const bundle = {
    format: LORE_FORMAT,
    formatVersion: LORE_FORMAT_VERSION,
    source: {
      key: src.key,
      title: (src.title || "").trim() || src.key,
      short: (src.short || "").trim() || src.key,
      order: Number.isFinite(src.order) ? src.order : 0
    },
    bundleVersion: data.bundleVersion,
    generatedAt: (data.generatedAt || "").trim(),
    sector: data.sector.trim(),
    milieu: (data.milieu || "").trim(),
    subsectors: (data.subsectors || []).map(s => ({ name: s.name.trim(), letter: s.letter ? s.letter.toUpperCase() : "", blocks: blocks(s.blocks) })),
    worlds: (data.worlds || []).map(w => ({
      hex: w.hex, name: w.name.trim(), subsector: (w.subsector || "").trim(),
      uwpAlt: w.uwpAlt ? { uwp: w.uwpAlt.uwp.trim().toUpperCase(), note: (w.uwpAlt.note || "").trim() } : null,
      blocks: blocks(w.blocks)
    })),
    journals: (data.journals || []).map(j => ({
      key: j.key.trim(), title: j.title.trim(), folder: (j.folder || "").trim() || DEFAULT_REFERENCE_FOLDER,
      pages: (j.pages || []).map(p => ({ key: p.key.trim(), title: p.title.trim(), blocks: blocks(p.blocks) }))
    })),
    hooks: (data.hooks || []).map(h => ({
      id: h.id.trim(), label: (h.label || "").trim() || "Hook", target: target(h.target),
      also: (h.also || []).map(target), html: clean(h.html, `hook ${h.id.trim()}`)
    }))
  };
  return { bundle, stripped };
}

export function bundleCounts(bundle) {
  const blockCount = [...bundle.subsectors, ...bundle.worlds, ...bundle.journals.flatMap(j => j.pages)]
    .reduce((n, item) => n + item.blocks.length, 0);
  return {
    subsectors: bundle.subsectors.length, worlds: bundle.worlds.length, journals: bundle.journals.length,
    pages: bundle.journals.reduce((n, j) => n + j.pages.length, 0), blocks: blockCount, hooks: bundle.hooks.length
  };
}

// ---------------------------------------------------------------------------
// Block merging
// ---------------------------------------------------------------------------

function blockHash(rec) {
  return hashFnv1a({ heading: rec.heading, html: rec.html, cite: rec.cite, order: rec.order });
}

// Merges one source's incoming blocks into a page's stored blocks. Blocks
// from other sources pass through untouched. A stored block of this source
// that the bundle no longer contains is an orphan: kept (and reported)
// unless removeOrphans is on. A block whose id now appears on a different
// page of the same bundle has moved, so it is always removed here.
export function mergeBlocks(existing = {}, sourceKey, incoming = [], { removeOrphans = false, bundleBlockIds = null } = {}) {
  const blocks = {};
  const stats = { added: [], changed: [], unchanged: [], orphaned: [], removed: [] };
  const incomingIds = new Set(incoming.map(b => b.id));
  for (const [key, rec] of Object.entries(existing || {})) {
    if (rec.source !== sourceKey) { blocks[key] = rec; continue; }
    if (incomingIds.has(rec.id)) continue;
    if (bundleBlockIds?.has(rec.id)) { stats.removed.push(rec.id); continue; }
    stats.orphaned.push(rec.id);
    if (removeOrphans) stats.removed.push(rec.id);
    else blocks[key] = rec;
  }
  incoming.forEach((b, order) => {
    const rec = { id: b.id, source: sourceKey, order, heading: b.heading || "", html: b.html, cite: b.cite || "" };
    rec.hash = blockHash(rec);
    const key = safeKey(b.id);
    const prev = existing?.[key];
    if (!prev || prev.source !== sourceKey) stats.added.push(b.id);
    else if (prev.hash !== rec.hash) stats.changed.push(b.id);
    else stats.unchanged.push(b.id);
    blocks[key] = rec;
  });
  return { blocks, ...stats };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlock(b) {
  return `<div class="tt-lore-block" data-tt-block="${esc(b.id)}">`
    + (b.heading ? `<h4>${esc(b.heading)}</h4>` : "")
    + b.html
    + (b.cite ? `<p class="tt-lore-cite">${esc(b.cite)}</p>` : "")
    + `</div>`;
}

function renderHook(h, ctx, { withTargetLink = false } = {}) {
  const short = ctx.shorts?.[h.source] || h.source;
  const target = withTargetLink ? ` — @Lore[${h.targetKey}]{${linkLabel(ctx.pageName?.(h.targetKey) || h.targetKey)}}` : "";
  return `<div class="tt-hook" data-tt-hook="${esc(h.id)}">`
    + `<p class="tt-hook-head"><strong>${esc(h.label)} ${esc(h.id)}</strong> <span class="tt-lore-src-tag">${esc(short)}</span>${target}</p>`
    + (withTargetLink ? "" : h.html)
    + `</div>`;
}

function renderWorldHeader(flag, ctx) {
  const actor = ctx.actor;
  const alts = Object.entries(flag.uwpAlt || {})
    .sort(([a], [b]) => ((flag.sources?.[a]?.order ?? 0) - (flag.sources?.[b]?.order ?? 0)) || cmp(a, b))
    .map(([src, alt]) => {
      const label = ctx.shorts?.[src] || flag.sources?.[src]?.short || src;
      return ` · <span class="tt-lore-uwp-alt">${esc(alt.uwp)} <span class="tt-lore-uwp-src">(${esc(label)}${alt.note ? `: ${esc(alt.note)}` : ""})</span></span>`;
    }).join("");
  const uwp = actor?.uwp ? `${esc(actor.uwp)} <span class="tt-lore-uwp-src">(Traveller Map)</span>` : "<em>unknown</em>";
  const actorLine = actor
    ? `@UUID[${actor.uuid}]{${linkLabel(actor.name)}}`
    : "<em>No World actor linked yet</em>";
  return `<div class="tt-lore-head"><p class="tt-lore-uwp"><strong>UWP</strong> ${uwp}${alts}</p>`
    + `<p class="tt-lore-actor"><strong>World:</strong> ${actorLine}</p></div>`;
}

function renderHooksIndex(ctx) {
  const hooks = ctx.allHooks || [];
  if (!hooks.length) return `<p class="tt-lore-empty">No hooks imported yet.</p>`;
  const groups = new Map();
  for (const h of hooks) {
    const group = h.subsector || UNKNOWN_SUBSECTOR;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(h);
  }
  return [...groups.keys()].sort(nameCmp).map(group =>
    `<section class="tt-lore-hook-index"><h3>${esc(group)}</h3>`
    + groups.get(group).sort((a, b) => cmp(a.id, b.id)).map(h => renderHook(h, ctx, { withTargetLink: true })).join("")
    + `</section>`).join("\n");
}

// Renders a page entirely from its stored flag: sources (sorted by their
// `order`) become sections, blocks become divs. World pages also get the
// UWP header and actor link, and any page targeted by hooks gets a "Hooks &
// Rumours" section plus an "Also mentioned in" line. The result still
// contains @Lore[...] tokens; resolveLoreLinks() turns them into @UUID links
// once every document exists.
export function renderPageHtml(flag, ctx = {}) {
  const parts = [];
  if (flag.kind === "world") parts.push(renderWorldHeader(flag, ctx));
  const bySource = new Map();
  for (const block of Object.values(flag.blocks || {})) {
    if (!bySource.has(block.source)) bySource.set(block.source, []);
    bySource.get(block.source).push(block);
  }
  const order = src => flag.sources?.[src]?.order ?? 0;
  for (const src of [...bySource.keys()].sort((a, b) => (order(a) - order(b)) || cmp(a, b))) {
    const title = flag.sources?.[src]?.title || src;
    const blocks = bySource.get(src).sort((a, b) => (a.order - b.order) || cmp(a.id, b.id));
    parts.push(`<section class="tt-lore-src" data-tt-src="${esc(src)}"><h3>${esc(title)}</h3>${blocks.map(renderBlock).join("")}</section>`);
  }
  if (flag.kind === "hooks") {
    parts.push(renderHooksIndex(ctx));
  } else {
    const hooks = ctx.hooks || [];
    if (hooks.length) {
      parts.push(`<section class="tt-lore-hooks"><h3>Hooks &amp; Rumours</h3>${hooks.map(h => renderHook(h, ctx)).join("")}</section>`);
    }
    const also = ctx.also || [];
    if (also.length) {
      const refs = also.map(h => `@Lore[${h.targetKey}]{${linkLabel(`${h.label} ${h.id}${ctx.pageName?.(h.targetKey) ? ` (${ctx.pageName(h.targetKey)})` : ""}`)}}`);
      parts.push(`<p class="tt-lore-also"><strong>Also mentioned in:</strong> ${refs.join(", ")}</p>`);
    }
  }
  if (!parts.length) parts.push(`<p class="tt-lore-empty">No lore imported for this page yet.</p>`);
  return parts.join("\n");
}

// Turns @Lore[key]{label} into @UUID[uuid]{label}. `keyToUuid` is a plain
// object, a Map or a function. Keys that can't be resolved become their bare
// label and are listed in `unresolved`.
export function resolveLoreLinks(html, keyToUuid) {
  const lookup = typeof keyToUuid === "function" ? keyToUuid
    : keyToUuid instanceof Map ? k => keyToUuid.get(k)
    : k => keyToUuid?.[k];
  const unresolved = [];
  const out = String(html ?? "").replace(LORE_LINK_RE, (_, rawKey, label) => {
    const key = rawKey.trim();
    const uuid = lookup(key);
    if (uuid) return `@UUID[${uuid}]{${label}}`;
    unresolved.push({ key, label });
    return label;
  });
  return { html: out, unresolved };
}

// Pass 2 of an apply: resolve links against real UUIDs and hash the result.
export function finalizePageContent(rawHtml, keyToUuid) {
  const { html, unresolved } = resolveLoreLinks(rawHtml, keyToUuid);
  return { content: html, renderedHash: hashFnv1a(html), unresolved };
}

// The actor-side link, merged per source so one source's import never
// drops another source's alternate UWP.
export function buildActorLore(existing, { pageUuid, journalUuid, source, uwpAlt }) {
  const prev = existing || {};
  const alts = (prev.uwpAlt || []).filter(a => a.source !== source);
  if (uwpAlt) alts.push({ source, uwp: uwpAlt.uwp, note: uwpAlt.note || "" });
  alts.sort((a, b) => cmp(a.source, b.source));
  const sources = [...new Set([...(prev.sources || []), source])].sort(cmp);
  return { pageUuid: pageUuid ?? null, journalUuid: journalUuid ?? null, uwpAlt: alts, sources };
}

// ---------------------------------------------------------------------------
// Planning helpers
// ---------------------------------------------------------------------------

function normalizeIndex(index = {}) {
  return {
    entries: index.entries || {}, pages: index.pages || {}, notes: index.notes || {},
    actors: index.actors || {}, sources: index.sources || {}
  };
}

function normalizePageFlag(flag) {
  flag.blocks ||= {};
  flag.sources ||= {};
  if (flag.kind === "world") flag.uwpAlt ||= {};
  delete flag.renderedHash;
  delete flag.storedHash;
  return flag;
}

function normalizeEntryFlag(flag) {
  if (flag.kind === "hooks") { flag.hooks ||= {}; flag.sources ||= {}; }
  return flag;
}

function stateFromIndex(idx) {
  const entries = new Map(), pages = new Map();
  for (const [key, e] of Object.entries(idx.entries)) {
    if (!e?.flag || e.flag.kind === "log") continue;
    entries.set(key, { key, name: e.name, kind: e.flag.kind, isNew: false, flag: normalizeEntryFlag(clone(e.flag)) });
  }
  for (const [key, p] of Object.entries(idx.pages)) {
    if (!p?.flag || p.userNotes || p.flag.kind === "notes") continue;
    pages.set(key, { key, entryKey: p.entryKey, name: p.name, sort: p.sort ?? 0, kind: p.flag.kind, isNew: false, flag: normalizePageFlag(clone(p.flag)) });
  }
  return { entries, pages };
}

function ensureEntry(state, key, init) {
  let entry = state.entries.get(key);
  if (!entry) { entry = { key, isNew: true, ...init }; state.entries.set(key, entry); }
  return entry;
}

function ensurePage(state, key, init) {
  let page = state.pages.get(key);
  if (!page) { page = { key, isNew: true, sort: null, ...init }; state.pages.set(key, page); }
  return page;
}

function metaDiffers(stored, meta) {
  return !stored || stored.title !== meta.title || stored.order !== meta.order || stored.short !== meta.short;
}

function storedSourceVersion(idx, sourceKey) {
  const versions = [];
  if (Number.isInteger(idx.sources[sourceKey]?.bundleVersion)) versions.push(idx.sources[sourceKey].bundleVersion);
  for (const p of Object.values(idx.pages)) {
    const v = p?.flag?.sources?.[sourceKey]?.bundleVersion;
    if (Number.isInteger(v)) versions.push(v);
  }
  for (const e of Object.values(idx.entries)) {
    const v = e?.flag?.sources?.[sourceKey]?.bundleVersion;
    if (Number.isInteger(v)) versions.push(v);
  }
  return versions.length ? Math.max(...versions) : null;
}

// Every map field the importer may shrink. Foundry merges object updates
// into stored flags, so keys that disappear must be deleted explicitly
// ("-=key"); the Foundry layer turns these paths into that syntax.
const MAP_FIELDS = ["blocks", "sources", "uwpAlt", "hooks"];
export function flagDeletions(oldFlag, newFlag) {
  const out = [];
  for (const field of MAP_FIELDS) {
    const before = oldFlag?.[field];
    if (!isObject(before)) continue;
    const after = newFlag?.[field] || {};
    for (const key of Object.keys(before)) if (!(key in after)) out.push({ field, key });
  }
  return out;
}

// New pages only: existing pages keep their sort (the GM may have
// reordered them, and Notes pages sit at their world's sort + 1, which the
// importer must never touch). A fresh subsector gets world pages at 1000,
// 2000, … in alphabetical order; a world added later slots into the gap
// between its alphabetical neighbours.
function assignSorts(state, warnings) {
  const byEntry = new Map();
  for (const page of state.pages.values()) {
    if (!byEntry.has(page.entryKey)) byEntry.set(page.entryKey, []);
    byEntry.get(page.entryKey).push(page);
  }
  for (const pages of byEntry.values()) {
    if (!pages.some(p => p.isNew)) continue;
    for (const page of pages) {
      if (!page.isNew) continue;
      if (page.kind === "hooks" || page.key.endsWith(":overview")) page.sort = 0;
      else if (page.kind === "journal") page.sort = page.sortHint ?? 1000;
    }
    const worlds = pages.filter(p => p.kind === "world").sort((a, b) => nameCmp(a.name, b.name) || cmp(a.key, b.key));
    let lastSort = 0;
    worlds.forEach((page, i) => {
      if (!page.isNew) { lastSort = page.sort ?? lastSort; return; }
      const next = worlds.slice(i + 1).find(p => !p.isNew);
      const nextSort = next ? next.sort ?? Infinity : Infinity;
      let sort = lastSort + 1000 < nextSort - 1 ? lastSort + 1000 : lastSort + Math.floor((nextSort - lastSort) / 2);
      if (sort <= lastSort + 1) {
        sort = lastSort + 2;
        warnings.push(`No sort gap left for "${page.name}"; it may appear out of alphabetical order.`);
      }
      page.sort = sort;
      lastSort = sort;
    });
    for (const page of pages) delete page.sortHint;
  }
}

function hookTargetKey(sector, target) {
  if (target.type === "world") return loreKeys.world(sector, target.hex);
  if (target.type === "subsector") return loreKeys.overview(sector, target.name);
  return target.page;
}

function sourceShorts(state, sector) {
  const shorts = {};
  const add = sources => { for (const [k, meta] of Object.entries(sources || {})) shorts[k] ||= meta.short || meta.title || k; };
  for (const page of state.pages.values()) if (page.flag.sector === sector) add(page.flag.sources);
  add(state.entries.get(loreKeys.hooks(sector))?.flag.sources);
  return shorts;
}

// Renders every importer page of `sector` and diffs it against the index.
function renderAndDiff(state, idx, sector, { skip = new Set() } = {}) {
  const hooksEntry = state.entries.get(loreKeys.hooks(sector));
  const hooks = Object.values(hooksEntry?.flag.hooks || {}).sort((a, b) => cmp(a.id, b.id));
  const byTarget = new Map(), byAlso = new Map();
  for (const h of hooks) {
    if (!byTarget.has(h.targetKey)) byTarget.set(h.targetKey, []);
    byTarget.get(h.targetKey).push(h);
    for (const key of new Set(h.alsoKeys || [])) {
      if (key === h.targetKey) continue;
      if (!byAlso.has(key)) byAlso.set(key, []);
      byAlso.get(key).push(h);
    }
  }
  const pageName = key => (skip.has(key) ? undefined : state.pages.get(key)?.name ?? state.entries.get(key)?.name);
  const shorts = sourceShorts(state, sector);
  // Documents this plan will create resolve to a placeholder for the dry
  // run; the apply's pass 2 re-resolves against real UUIDs.
  const uuidFor = key => {
    if (skip.has(key)) return null;
    const known = idx.pages[key]?.uuid || idx.entries[key]?.uuid;
    if (known) return known;
    return state.pages.get(key)?.isNew || state.entries.get(key)?.isNew ? `pending:${key}` : null;
  };

  const ops = [], unresolved = [];
  for (const page of state.pages.values()) {
    if (page.flag.sector !== sector || skip.has(page.key)) continue;
    const ctx = {
      actor: page.kind === "world" ? idx.actors[page.key] || null : null,
      hooks: byTarget.get(page.key) || [], also: byAlso.get(page.key) || [],
      allHooks: hooks, pageName, shorts
    };
    const rawHtml = renderPageHtml(page.flag, ctx);
    const { html, unresolved: missing } = resolveLoreLinks(rawHtml, uuidFor);
    for (const m of missing) unresolved.push({ page: page.key, ...m });
    const renderedHash = hashFnv1a(html);
    const existing = idx.pages[page.key];
    const op = { key: page.key, entryKey: page.entryKey, name: page.name, sort: page.sort, kind: page.kind, flag: page.flag, rawHtml, renderedHash, manualEdit: false, deletions: [] };
    if (!existing) { ops.push({ ...op, op: "create" }); continue; }
    const manualEdit = existing.contentHash != null && existing.contentHash !== (existing.flag.storedHash ?? existing.flag.renderedHash);
    const sameFlag = hashFnv1a(normalizePageFlag(clone(existing.flag))) === hashFnv1a(page.flag);
    const changed = manualEdit || !sameFlag || existing.flag.renderedHash !== renderedHash;
    ops.push({ ...op, op: changed ? "update" : "unchanged", manualEdit, deletions: flagDeletions(existing.flag, page.flag) });
  }
  ops.sort((a, b) => cmp(a.entryKey || "", b.entryKey || "") || ((a.sort ?? 0) - (b.sort ?? 0)) || cmp(a.key, b.key));
  return { ops, unresolved };
}

function diffEntries(state, idx, sector) {
  const ops = [];
  for (const entry of state.entries.values()) {
    if (entry.flag.sector !== sector) continue;
    const existing = idx.entries[entry.key];
    if (!existing) { ops.push({ op: "create", key: entry.key, name: entry.name, kind: entry.kind, folders: entry.folders, flag: entry.flag, deletions: [] }); continue; }
    const same = hashFnv1a(normalizeEntryFlag(clone(existing.flag))) === hashFnv1a(entry.flag);
    ops.push({ op: same ? "unchanged" : "update", key: entry.key, name: existing.name, kind: entry.kind, flag: entry.flag, deletions: flagDeletions(existing.flag, entry.flag) });
  }
  return ops.sort((a, b) => cmp(a.key, b.key));
}

function countOps(ops) {
  const out = { create: 0, update: 0, unchanged: 0, delete: 0 };
  for (const op of ops) out[op.op] = (out[op.op] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Import planning
// ---------------------------------------------------------------------------

// Works out everything an import would do, without doing any of it. The
// window shows the result as the dry run; lore-import.mjs then applies the
// same plan. Pure and deterministic, so applying a plan and planning the
// same bundle again must produce zero changes (the idempotency test).
// `hookState` never appears anywhere in a plan: hook status lives in its own
// flag, which only the tracker and page badges write.
export function planLoreImport(bundle, index = {}, { removeOrphans = false } = {}) {
  const idx = normalizeIndex(index);
  const state = stateFromIndex(idx);
  const sector = bundle.sector;
  const src = bundle.source.key;
  const srcMeta = { bundleVersion: bundle.bundleVersion, title: bundle.source.title, short: bundle.source.short, order: bundle.source.order };
  const warnings = [];

  const storedVersion = storedSourceVersion(idx, src);
  const needsConfirm = storedVersion !== null && bundle.bundleVersion < storedVersion;
  if (needsConfirm) warnings.push(`This bundle is version ${bundle.bundleVersion} of "${bundle.source.title}", but version ${storedVersion} has already been imported. Importing it may roll lore back.`);

  const letters = new Map(bundle.subsectors.filter(s => s.letter).map(s => [s.name, s.letter]));
  const letterFor = name => letters.get(name)
    || Object.entries(idx.actors).find(([key, a]) => key.startsWith(`world:${sector}:`) && a.subsector === name && a.subsectorLetter)?.[1].subsectorLetter
    || "";
  const sectorFolder = { key: loreKeys.sectorFolder(sector), name: sector };
  const subsectorEntry = name => ensureEntry(state, loreKeys.subsector(sector, name), {
    name: letterFor(name) ? `${name} (${letterFor(name)})` : name, kind: "subsector",
    flag: { key: loreKeys.subsector(sector, name), sector, kind: "subsector", subsector: name },
    folders: [sectorFolder, { key: loreKeys.gazetteerFolder(sector), name: "Gazetteer" }]
  });
  const ensureOverview = name => {
    const entry = subsectorEntry(name);
    const key = loreKeys.overview(sector, name);
    return ensurePage(state, key, { entryKey: entry.key, name: "Overview", kind: "subsector", flag: { key, sector, kind: "subsector", blocks: {}, sources: {} } });
  };

  const incoming = new Map(); // pageKey -> this source's blocks for that page
  const bundleBlockIds = new Set();
  const addIncoming = (key, blocks) => { incoming.set(key, blocks); for (const b of blocks) bundleBlockIds.add(b.id); };

  for (const s of bundle.subsectors) addIncoming(ensureOverview(s.name).key, s.blocks);

  const uwpAltChanged = new Set();
  for (const w of bundle.worlds) {
    const key = loreKeys.world(sector, w.hex);
    let page = state.pages.get(key);
    if (!page) {
      const subName = w.subsector || idx.actors[key]?.subsector || UNKNOWN_SUBSECTOR;
      const entry = ensureOverview(subName) && state.entries.get(loreKeys.subsector(sector, subName));
      page = ensurePage(state, key, { entryKey: entry.key, name: w.name, kind: "world", flag: { key, sector, kind: "world", hex: w.hex, blocks: {}, sources: {}, uwpAlt: {} } });
    }
    page.flag.uwpAlt ||= {};
    const before = page.flag.uwpAlt[src];
    if (w.uwpAlt) page.flag.uwpAlt[src] = { uwp: w.uwpAlt.uwp, note: w.uwpAlt.note };
    else delete page.flag.uwpAlt[src];
    if (hashFnv1a(before ?? null) !== hashFnv1a(page.flag.uwpAlt[src] ?? null)) uwpAltChanged.add(key);
    addIncoming(key, w.blocks);
  }

  for (const j of bundle.journals) {
    const entry = ensureEntry(state, j.key, {
      name: j.title, kind: "journal", flag: { key: j.key, sector, kind: "journal" },
      folders: [sectorFolder, { key: loreKeys.referenceFolder(sector, j.folder), name: j.folder }]
    });
    j.pages.forEach((p, i) => {
      const page = ensurePage(state, p.key, { entryKey: entry.key, name: p.title, kind: "journal", sortHint: (i + 1) * 1000, flag: { key: p.key, sector, kind: "journal", blocks: {}, sources: {} } });
      addIncoming(page.key, p.blocks);
    });
  }

  // Merge blocks on every page of this sector that either receives blocks
  // from this bundle or still holds blocks from this source (orphans).
  const blocks = { added: [], changed: [], unchanged: [], orphaned: [], removed: [] };
  for (const page of state.pages.values()) {
    if (page.flag.sector !== sector || page.kind === "hooks") continue;
    const list = incoming.get(page.key);
    const holdsSource = Object.values(page.flag.blocks).some(b => b.source === src) || page.flag.uwpAlt?.[src];
    if (!list && !holdsSource) continue;
    if (!list && removeOrphans && page.flag.uwpAlt?.[src]) { delete page.flag.uwpAlt[src]; uwpAltChanged.add(page.key); }
    const r = mergeBlocks(page.flag.blocks, src, list || [], { removeOrphans, bundleBlockIds });
    page.flag.blocks = r.blocks;
    for (const stat of Object.keys(blocks)) for (const id of r[stat]) blocks[stat].push({ page: page.key, id });
    const present = Object.values(r.blocks).some(b => b.source === src) || !!page.flag.uwpAlt?.[src];
    const touched = r.added.length || r.changed.length || r.removed.length || uwpAltChanged.has(page.key);
    // A page's copy of the source metadata (including bundleVersion) is only
    // refreshed when something on that page changed, so a regenerated
    // bundle doesn't rewrite every untouched page. The authoritative "latest
    // imported version" lives in the import log's source registry.
    if (present) { if (touched || metaDiffers(page.flag.sources[src], srcMeta)) page.flag.sources[src] = { ...srcMeta }; }
    else delete page.flag.sources[src];
  }

  // Hooks: content lives in the hooks entry's lore.hooks; status lives in
  // the separate hookState flag, which is never read or written here.
  const hooksKey = loreKeys.hooks(sector);
  const prevHooks = state.entries.get(hooksKey)?.flag.hooks || {};
  const nextHooks = {};
  const hooks = { added: [], changed: [], unchanged: [], orphaned: [], removed: [] };
  const bundleHookIds = new Set(bundle.hooks.map(h => h.id));
  for (const [key, h] of Object.entries(prevHooks)) {
    if (h.source !== src) { nextHooks[key] = h; continue; }
    if (bundleHookIds.has(h.id)) continue;
    hooks.orphaned.push(h.id);
    if (removeOrphans) hooks.removed.push(h.id);
    else nextHooks[key] = h;
  }
  const subsectorOf = target => {
    if (target.type === "subsector") return target.name;
    if (target.type === "journal") return DEFAULT_REFERENCE_FOLDER;
    const page = state.pages.get(loreKeys.world(sector, target.hex));
    return (page && state.entries.get(page.entryKey)?.flag.subsector) || idx.actors[loreKeys.world(sector, target.hex)]?.subsector || UNKNOWN_SUBSECTOR;
  };
  for (const h of bundle.hooks) {
    const rec = {
      id: h.id, source: src, label: h.label, target: h.target, also: h.also, html: h.html,
      targetKey: hookTargetKey(sector, h.target), alsoKeys: h.also.map(t => hookTargetKey(sector, t)), subsector: subsectorOf(h.target)
    };
    rec.hash = hashFnv1a({ label: rec.label, target: rec.target, also: rec.also, html: rec.html, subsector: rec.subsector });
    const key = safeKey(h.id);
    const prev = prevHooks[key];
    if (prev && prev.source !== src) warnings.push(`Hook ${h.id} was imported from "${prev.source}" and is replaced by this source's hook of the same id.`);
    if (!prev || prev.source !== src) hooks.added.push(h.id);
    else if (prev.hash !== rec.hash) hooks.changed.push(h.id);
    else hooks.unchanged.push(h.id);
    nextHooks[key] = rec;
    if (!state.pages.has(rec.targetKey)) warnings.push(`Hook ${h.id} targets "${rec.targetKey}", which has no lore page; it appears only on the Hooks & Rumours index.`);
  }
  if (Object.keys(nextHooks).length || state.entries.has(hooksKey)) {
    const entry = ensureEntry(state, hooksKey, {
      name: "Hooks & Rumours", kind: "hooks", flag: { key: hooksKey, sector, kind: "hooks", hooks: {}, sources: {} }, folders: [sectorFolder]
    });
    entry.flag.hooks = nextHooks;
    const present = Object.values(nextHooks).some(h => h.source === src);
    const touched = hooks.added.length || hooks.changed.length || hooks.removed.length;
    if (present) { if (touched || metaDiffers(entry.flag.sources[src], srcMeta)) entry.flag.sources[src] = { ...srcMeta }; }
    else delete entry.flag.sources[src];
    const indexKey = loreKeys.hooksIndex(sector);
    ensurePage(state, indexKey, { entryKey: hooksKey, name: "Index", kind: "hooks", flag: { key: indexKey, sector, kind: "hooks", blocks: {}, sources: {} } });
  }

  assignSorts(state, warnings);
  const entries = diffEntries(state, idx, sector);
  const { ops: pages, unresolved } = renderAndDiff(state, idx, sector);

  // Actor links. Missing actors are reported here; lore-import.mjs may
  // create them from Traveller Map and then plan again.
  const actors = [], missingActors = [];
  const uuidOrPending = key => idx.pages[key]?.uuid || idx.entries[key]?.uuid || `pending:${key}`;
  for (const w of bundle.worlds) {
    const key = loreKeys.world(sector, w.hex);
    const actor = idx.actors[key];
    const page = state.pages.get(key);
    if (!actor) { missingActors.push({ hex: w.hex, name: w.name, key }); continue; }
    const lore = buildActorLore(actor.lore, { pageUuid: uuidOrPending(key), journalUuid: uuidOrPending(page.entryKey), source: src, uwpAlt: w.uwpAlt });
    const same = hashFnv1a(actor.lore ?? null) === hashFnv1a(lore);
    actors.push({ op: same ? "unchanged" : "update", key, hex: w.hex, name: actor.name, actorId: actor.id, pageKey: key, entryKey: page.entryKey, source: src, uwpAlt: w.uwpAlt, lore });
  }

  const manualEdits = pages.filter(p => p.manualEdit).map(p => p.key);
  const summary = {
    entries: countOps(entries), pages: countOps(pages), actors: countOps(actors),
    blocks: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.length])),
    hooks: Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length])),
    missingActors: missingActors.length, manualEdits: manualEdits.length, unresolved: unresolved.length
  };
  const changeCount = summary.entries.create + summary.entries.update + summary.pages.create + summary.pages.update
    + summary.actors.update + summary.blocks.added + summary.blocks.changed + summary.blocks.removed
    + summary.hooks.added + summary.hooks.changed + summary.hooks.removed;

  return {
    kind: "import", source: { ...bundle.source }, bundleVersion: bundle.bundleVersion, sector, milieu: bundle.milieu,
    storedVersion, needsConfirm, removeOrphans, warnings,
    entries, pages, actors, missingActors, blocks, hooks, unresolved, manualEdits, summary, changeCount
  };
}

// ---------------------------------------------------------------------------
// Source removal
// ---------------------------------------------------------------------------

export function listLoreSources(index = {}) {
  const idx = normalizeIndex(index);
  const out = new Map();
  const get = key => { if (!out.has(key)) out.set(key, { key, title: key, short: key, bundleVersion: null, blocks: 0, hooks: 0, pages: 0 }); return out.get(key); };
  const meta = (key, m) => {
    const rec = get(key);
    if (m?.title) rec.title = m.title;
    if (m?.short) rec.short = m.short;
    if (Number.isInteger(m?.bundleVersion)) rec.bundleVersion = Math.max(rec.bundleVersion ?? m.bundleVersion, m.bundleVersion);
  };
  for (const [key, m] of Object.entries(idx.sources)) meta(key, m);
  for (const p of Object.values(idx.pages)) {
    if (!p?.flag || p.userNotes) continue;
    for (const [key, m] of Object.entries(p.flag.sources || {})) meta(key, m);
    const seen = new Set();
    for (const b of Object.values(p.flag.blocks || {})) { get(b.source).blocks++; seen.add(b.source); }
    for (const key of seen) get(key).pages++;
  }
  for (const e of Object.values(idx.entries)) {
    if (e?.flag?.kind !== "hooks") continue;
    for (const [key, m] of Object.entries(e.flag.sources || {})) meta(key, m);
    for (const h of Object.values(e.flag.hooks || {})) get(h.source).hooks++;
  }
  return [...out.values()].filter(s => s.blocks || s.hooks || s.pages).sort((a, b) => cmp(a.key, b.key));
}

// Removes every block, alternate UWP and hook belonging to one source,
// re-renders what's left, and deletes importer pages/entries that end up
// empty. Notes pages are never deleted, and an entry that still holds a
// Notes page (or any page the importer didn't create) is kept. Hooks
// entries are always kept, because they also hold the GM's hook status.
export function planRemoveSource(index = {}, sourceKey) {
  const idx = normalizeIndex(index);
  const state = stateFromIndex(idx);
  const sectors = new Set();
  const removedBlocks = [], removedHooks = [];
  const affected = new Set();

  for (const page of state.pages.values()) {
    const f = page.flag;
    let hit = false;
    for (const [key, b] of Object.entries(f.blocks)) {
      if (b.source !== sourceKey) continue;
      delete f.blocks[key];
      removedBlocks.push({ page: page.key, id: b.id });
      hit = true;
    }
    if (f.uwpAlt?.[sourceKey]) { delete f.uwpAlt[sourceKey]; hit = true; }
    if (f.sources[sourceKey]) { delete f.sources[sourceKey]; hit = true; }
    if (hit) { affected.add(page.key); sectors.add(f.sector); }
  }
  for (const entry of state.entries.values()) {
    if (entry.kind !== "hooks") continue;
    let hit = false;
    for (const [key, h] of Object.entries(entry.flag.hooks)) {
      if (h.source !== sourceKey) continue;
      delete entry.flag.hooks[key];
      removedHooks.push({ sector: entry.flag.sector, id: h.id });
      hit = true;
    }
    if (entry.flag.sources[sourceKey]) { delete entry.flag.sources[sourceKey]; hit = true; }
    if (hit) sectors.add(entry.flag.sector);
  }

  const isEmpty = (page, targeted) => page.kind !== "hooks"
    && !Object.keys(page.flag.blocks).length && !Object.keys(page.flag.uwpAlt || {}).length && !targeted.has(page.key);
  const deletePages = new Set(), deleteEntries = new Set();
  for (const sector of sectors) {
    const hooks = Object.values(state.entries.get(loreKeys.hooks(sector))?.flag.hooks || {});
    const targeted = new Set(hooks.flatMap(h => [h.targetKey, ...(h.alsoKeys || [])]));
    for (const key of affected) {
      const page = state.pages.get(key);
      if (page.flag.sector === sector && isEmpty(page, targeted)) deletePages.add(key);
    }
    // An entry goes only when every page it holds is an importer page that
    // is (or has just become) empty — never if it holds a Notes page.
    const touchedEntries = new Set([...deletePages].map(k => state.pages.get(k).entryKey));
    for (const entryKey of touchedEntries) {
      const entry = state.entries.get(entryKey);
      if (!entry || entry.kind === "hooks") continue;
      const lorePages = [...state.pages.values()].filter(p => p.entryKey === entryKey);
      const total = idx.entries[entryKey]?.pageCount ?? lorePages.length;
      if (total !== lorePages.length) continue;
      if (!lorePages.every(p => deletePages.has(p.key) || isEmpty(p, targeted))) continue;
      deleteEntries.add(entryKey);
      for (const p of lorePages) deletePages.add(p.key);
    }
  }

  const pages = [], entries = [], unresolved = [];
  for (const sector of sectors) {
    const r = renderAndDiff(state, idx, sector, { skip: deletePages });
    pages.push(...r.ops);
    unresolved.push(...r.unresolved);
    entries.push(...diffEntries(state, idx, sector).filter(e => !deleteEntries.has(e.key)));
  }
  for (const key of deletePages) {
    const rec = idx.pages[key];
    if (!deleteEntries.has(rec.entryKey)) pages.push({ op: "delete", key, entryKey: rec.entryKey, name: rec.name, id: rec.id });
  }
  for (const key of deleteEntries) entries.push({ op: "delete", key, name: idx.entries[key].name, id: idx.entries[key].id });

  const deletedUuids = new Set([...deletePages].map(k => idx.pages[k]?.uuid).filter(Boolean));
  const actors = [];
  for (const [key, actor] of Object.entries(idx.actors)) {
    const lore = actor.lore;
    if (!lore?.sources?.includes(sourceKey)) continue;
    const sources = lore.sources.filter(s => s !== sourceKey);
    if (!sources.length || deletedUuids.has(lore.pageUuid)) {
      actors.push({ op: "clear", key, actorId: actor.id, name: actor.name, lore: null });
    } else {
      actors.push({ op: "update", key, actorId: actor.id, name: actor.name, lore: { ...lore, sources, uwpAlt: (lore.uwpAlt || []).filter(a => a.source !== sourceKey) } });
    }
  }

  const summary = {
    blocksRemoved: removedBlocks.length, hooksRemoved: removedHooks.length,
    pages: countOps(pages), entries: countOps(entries),
    actorsUpdated: actors.filter(a => a.op === "update").length, actorsCleared: actors.filter(a => a.op === "clear").length
  };
  return { kind: "remove", source: sourceKey, pages, entries, actors, removedBlocks, removedHooks, unresolved, summary };
}
