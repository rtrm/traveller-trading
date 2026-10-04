import { MODULE_ID } from "./constants.mjs";
import { esc } from "./window-base.mjs";
import { TradingWindowBase } from "./window-base.mjs";
import { resolveLocation, pickLocationCandidate } from "./destination-map.mjs";

// ---------------------------------------------------------------------------
// Imports worlds from travellermap.com as mgt2e "world" Actors, organized
// under Actors > <Sector> > <Subsector>. Reuses the same milieu setting and
// resolveLocation()/pickLocationCandidate() search flow destination-map.mjs
// already established for single-world lookups.
// ---------------------------------------------------------------------------

const ACTOR_FOLDER_COLOR = "#c9a24a";
const FLAG_TRAVELLER_MAP_DATA = "travellerMapData";

// ---------------------------------------------------------------------------
// Traveller Map fetches
// ---------------------------------------------------------------------------

async function fetchSectorMetadata(sectorName, milieu) {
  const res = await fetch(`https://travellermap.com/api/metadata?sector=${encodeURIComponent(sectorName)}&milieu=${encodeURIComponent(milieu)}`);
  if (!res.ok) throw new Error(`Traveller Map returned ${res.status} for sector metadata`);
  const json = await res.json();
  if (!json || !json.Names) throw new Error(`Sector "${sectorName}" not found`);
  return {
    name: json.Names?.[0]?.Text || sectorName,
    sx: json.X,
    sy: json.Y,
    subsectors: (json.Subsectors || []).map(s => ({ letter: s.Index, name: s.Name || s.Index })),
    allegiances: (json.Allegiances || []).map(a => ({ code: a.Code, name: a.Name }))
  };
}

function subsectorNameFor(sectorMeta, letter) {
  const found = (sectorMeta.subsectors || []).find(s => s.letter === letter);
  return found?.name || letter || "Unknown Subsector";
}

// Defensive fallback for computing a subsector letter from hex coordinates
// when a row's own "SS" column is somehow blank — each sector is a 4x4 grid
// of subsectors, each 8 hexes wide and 10 tall, lettered A-P row-major
// (confirmed against Spinward Marches: hex 1910 / Regina -> "C").
function subsectorLetterFromHex(hexX, hexY) {
  const col = Math.floor((hexX - 1) / 8);
  const row = Math.floor((hexY - 1) / 10);
  const idx = Math.max(0, Math.min(15, row * 4 + col));
  return "ABCDEFGHIJKLMNOP"[idx];
}

function parseTabDelimited(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map(line => {
    const cells = line.split("\t");
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

async function fetchWorldRows(params, milieu) {
  const qs = new URLSearchParams({ ...params, milieu, type: "TabDelimited" });
  const res = await fetch(`https://travellermap.com/api/sec?${qs.toString()}`);
  if (!res.ok) throw new Error(`Traveller Map returned ${res.status}`);
  const text = await res.text();
  return parseTabDelimited(text);
}

export async function fetchSectorWorldRows(sectorName, milieu) {
  return fetchWorldRows({ sector: sectorName }, milieu);
}

export async function fetchSubsectorWorldRows(sectorName, subsectorLetter, milieu) {
  return fetchWorldRows({ sector: sectorName, subsector: subsectorLetter }, milieu);
}

export async function fetchSingleWorldRow(sectorName, hex, milieu) {
  const rows = await fetchWorldRows({ sector: sectorName, hex }, milieu);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// UWP / stellar parsing
// ---------------------------------------------------------------------------

const EHEX_DIGITS = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // standard Traveller EHex - skips I and O

function ehexToNumber(ch) {
  const idx = EHEX_DIGITS.indexOf((ch || "").toUpperCase());
  return idx >= 0 ? idx : 0;
}

export function parseUwp(uwp) {
  const s = (uwp || "???????-?").toUpperCase();
  return {
    port: s.charAt(0) || "X",
    size: ehexToNumber(s.charAt(1)),
    atmosphere: ehexToNumber(s.charAt(2)),
    hydrographics: ehexToNumber(s.charAt(3)),
    population: ehexToNumber(s.charAt(4)),
    government: ehexToNumber(s.charAt(5)),
    lawLevel: ehexToNumber(s.charAt(6)),
    techLevel: ehexToNumber(s.charAt(8)) // index 7 is the literal "-" separator
  };
}

const LUMINOSITY_CLASSES = new Set(["IA", "IB", "II", "III", "IV", "V", "VI", "VII", "D"]);

// Best-effort tokenizer for the "Stars" column (e.g. "F7 V M3 V" for a binary
// system). Each star is normally two tokens (spectral class+subtype, then
// luminosity class); a lone "D" (white dwarf) or "BD" (brown dwarf) is its
// own single-token star. Falls back to a single {raw} entry for anything
// that doesn't fit this shape, so no stellar data is ever silently dropped -
// the full raw string is always kept alongside this parse regardless.
export function parseStellar(starsText) {
  const tokens = (starsText || "").trim().split(/\s+/).filter(Boolean);
  const stars = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i].toUpperCase();
    if (tok === "BD") { stars.push({ raw: tokens[i] }); i += 1; continue; }
    const spectralMatch = /^[OBAFGKM]\d$/.exec(tok);
    if (spectralMatch && i + 1 < tokens.length && LUMINOSITY_CLASSES.has(tokens[i + 1].toUpperCase())) {
      stars.push({ spectralClass: tok.charAt(0), spectralSubtype: Number(tok.charAt(1)), luminosityClass: tokens[i + 1].toUpperCase(), raw: `${tokens[i]} ${tokens[i + 1]}` });
      i += 2;
      continue;
    }
    if (tok === "D" || LUMINOSITY_CLASSES.has(tok)) { stars.push({ luminosityClass: tok, raw: tokens[i] }); i += 1; continue; }
    // Unrecognized token shape - keep it rather than discard.
    stars.push({ raw: tokens[i] });
    i += 1;
  }
  return stars;
}

const ZONE_MAP = { "A": "Amber", "R": "Red" };

// ---------------------------------------------------------------------------
// Row -> Actor data
// ---------------------------------------------------------------------------

export function mapWorldRowToActorData(row, sectorMeta, milieu) {
  const hex = row.Hex || "0000";
  const hexX = Number(hex.slice(0, 2)) || 0;
  const hexY = Number(hex.slice(2, 4)) || 0;
  const letter = row.SS || subsectorLetterFromHex(hexX, hexY);
  const subsectorName = subsectorNameFor(sectorMeta, letter);
  const uwp = parseUwp(row.UWP);
  const stellar = parseStellar(row.Stars);
  const allegiance = (sectorMeta.allegiances || []).find(a => a.code === row.Allegiance);

  const descriptionLines = [
    `UWP ${row.UWP || "unknown"} - Starport ${uwp.port}, Size ${uwp.size}, Atmosphere ${uwp.atmosphere}, Hydrographics ${uwp.hydrographics}, Population ${uwp.population}, Government ${uwp.government}, Law Level ${uwp.lawLevel}, Tech Level ${uwp.techLevel}.`,
    row.Stars ? `Stellar: ${row.Stars}.` : "",
    row.Remarks ? `Trade codes: ${row.Remarks}.` : "",
    row.Bases ? `Bases: ${row.Bases}.` : "",
    `Imported from Traveller Map (${sectorMeta.name} ${hex}, milieu ${milieu}).`
  ].filter(Boolean);

  return {
    name: row.Name || `Hex ${hex}`,
    type: "world",
    system: {
      description: descriptionLines.join(" "),
      world: {
        location: {
          sector: sectorMeta.name,
          sectorX: sectorMeta.sx ?? 0,
          sectorY: sectorMeta.sy ?? 0,
          x: hexX,
          y: hexY,
          systemUuid: null
        },
        uwp: {
          port: uwp.port,
          size: uwp.size,
          atmosphere: uwp.atmosphere,
          hydrographics: uwp.hydrographics,
          population: uwp.population,
          government: uwp.government,
          lawLevel: uwp.lawLevel,
          techLevel: uwp.techLevel,
          zone: ZONE_MAP[row.Zone] || "",
          bases: row.Bases || "",
          codes: row.Remarks || ""
        },
        extra: {
          temperature: 0,
          berthingCost: 1000,
          culturalDifferences: "",
          popDigit: Number((row.PBG || "").charAt(0)) || 1,
          allegiance: row.Allegiance || "",
          autoCodes: false
        }
      }
    },
    flags: {
      [MODULE_ID]: {
        [FLAG_TRAVELLER_MAP_DATA]: {
          milieu,
          sector: sectorMeta.name,
          subsectorLetter: letter,
          subsectorName,
          hex,
          uwpRaw: row.UWP || "",
          stellarRaw: row.Stars || "",
          stellar,
          pbg: row.PBG || "",
          importance: row["{Ix}"] || "",
          economicExtension: row["(Ex)"] || "",
          culturalExtension: row["[Cx]"] || "",
          nobility: row.Nobility || "",
          worldsInSystem: row.W || "",
          resourceUnits: row.RU || "",
          allegianceCode: row.Allegiance || "",
          allegianceName: allegiance?.name || "",
          importedAt: new Date().toISOString()
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Actor folders + upsert
// ---------------------------------------------------------------------------

async function getOrCreateActorFolder(name, parentId) {
  let folder = game.folders.find(f => f.type === "Actor" && f.name === name && (f.folder?.id || null) === (parentId || null));
  if (!folder) {
    folder = await Folder.create({ name, type: "Actor", color: ACTOR_FOLDER_COLOR, folder: parentId || null });
  }
  return folder;
}

async function getOrCreateSectorSubsectorFolders(sectorName, subsectorName) {
  const sectorFolder = await getOrCreateActorFolder(sectorName, null);
  const subsectorFolder = await getOrCreateActorFolder(subsectorName, sectorFolder.id);
  return { sectorFolder, subsectorFolder };
}

function findExistingWorldActor(sector, hex, milieu) {
  return game.actors.find(a => {
    const flag = a.getFlag(MODULE_ID, FLAG_TRAVELLER_MAP_DATA);
    return flag && flag.sector === sector && flag.hex === hex && flag.milieu === milieu;
  });
}

// Stars are NOT a field on the World actor itself - the system's own sheet
// (mgt2e/module/sheets/actors/world.mjs, _createStar()) represents each one
// as an embedded Item of type "worlddata" with system.world.datatype="star",
// spectralType (the combined class+subtype, e.g. "F7") and luminosityClass
// (e.g. "V"). Confirmed directly from that file after the first pass of
// this module wrongly assumed stellar data had nowhere to go but a flag.
function starItemCreateData(star, index) {
  // A lone "D"/"BD" token (white/brown dwarf, see parseStellar) has no
  // separate luminosity class of its own - the type itself IS the class.
  const spectralType = star.spectralClass ? `${star.spectralClass}${star.spectralSubtype}` : (star.raw && !star.luminosityClass ? star.raw : "");
  const luminosityClass = star.luminosityClass || "";
  const label = index === 0 ? "Primary" : `Companion ${index}`;
  const designation = [spectralType, luminosityClass].filter(Boolean).join(" ") || star.raw || "?";
  return {
    name: `${label} (${designation})`,
    type: "worlddata",
    system: { world: { datatype: "star", spectralType, luminosityClass } }
  };
}

// Replaces whatever star items an actor already has with fresh ones from
// `stellar` - simplest way to keep a re-import idempotent (no piling up of
// duplicate stars across repeated imports) without trying to diff/match
// old stars to new ones.
async function syncStarItems(actor, stellar) {
  const existingStarIds = actor.items
    .filter(i => i.type === "worlddata" && i.system?.world?.datatype === "star")
    .map(i => i.id);
  if (existingStarIds.length) await actor.deleteEmbeddedDocuments("Item", existingStarIds);
  if (stellar.length) await actor.createEmbeddedDocuments("Item", stellar.map(starItemCreateData));
}

// Creates or updates (in place, preserving the existing Actor's id so any
// drag-and-drop link to it elsewhere keeps working) one world Actor per row,
// including its star(s) as embedded Items. Returns {created, updated}.
export async function importWorldRows(rows, sectorMeta, milieu, { onProgress } = {}) {
  if (!game.user.isGM) return { created: 0, updated: 0 };
  let created = 0, updated = 0;
  const folderCache = new Map();
  for (const row of rows) {
    if (!row.Hex || !row.Name) continue; // blank/empty hexes carry no world
    const data = mapWorldRowToActorData(row, sectorMeta, milieu);
    const stellar = data.flags[MODULE_ID][FLAG_TRAVELLER_MAP_DATA].stellar;
    const subsectorName = data.flags[MODULE_ID][FLAG_TRAVELLER_MAP_DATA].subsectorName;
    const folderKey = subsectorName;
    let folders = folderCache.get(folderKey);
    if (!folders) {
      folders = await getOrCreateSectorSubsectorFolders(sectorMeta.name, subsectorName);
      folderCache.set(folderKey, folders);
    }
    data.folder = folders.subsectorFolder.id;

    let actor = findExistingWorldActor(sectorMeta.name, row.Hex, milieu);
    if (actor) {
      await actor.update(data);
      updated++;
    } else {
      actor = await Actor.create(data);
      created++;
    }
    await syncStarItems(actor, stellar);
    onProgress?.({ name: row.Name, created, updated, total: rows.length });
  }
  return { created, updated };
}

// ---------------------------------------------------------------------------
// Settings menu entry + import dialog
// ---------------------------------------------------------------------------

export function registerWorldImportSettings() {
  game.settings.registerMenu(MODULE_ID, "importWorlds", {
    name: "Import Worlds from Traveller Map",
    label: "Import Worlds",
    hint: "Import a single world, a whole subsector, or a whole sector from travellermap.com as mgt2e World actors, organized under Actors > Sector > Subsector.",
    icon: "fa-solid fa-earth-americas",
    type: WorldImportMenu,
    restricted: true
  });
}

// Same ApplicationV2-with-overridden-render trick as the other settings-menu
// entries (main.mjs/permissions.mjs/trade-goods.mjs) - here the override
// opens a real window instead of a one-shot confirm dialog.
class WorldImportMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "tt-world-import-menu", window: { title: "Import Worlds" } };

  async render(options) {
    openImportWorldsApp();
    return this;
  }
}

let instance = null;

function openImportWorldsApp() {
  if (instance && instance.rendered) { instance.bringToFront(); return instance; }
  instance = new ImportWorldsApp();
  instance.render(true);
  return instance;
}

class ImportWorldsApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-world-import-app",
    classes: ["traveller-trading-window"],
    window: { title: "Import Worlds from Traveller Map" },
    position: { width: 520, height: "auto" }
  };

  constructor(options) {
    super(options);
    this.mode = "world"; // "world" | "subsector" | "sector"
    this.busy = false;
    this.statusHtml = "";
    this.sectorInput = "";
    this.worldInput = "";
    this.resolvedSector = null; // {name, sx, sy, subsectors, allegiances}
    this.selectedSubsectorLetter = "";
  }

  async close(options) {
    instance = null;
    return super.close(options);
  }

  async _load() {}

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("click", async (e) => {
      const tabBtn = e.target.closest("[data-tt-import-tab]");
      if (tabBtn) { this.mode = tabBtn.dataset.ttImportTab; this.resolvedSector = null; this.statusHtml = ""; this._renderContent(); return; }
    });
    this.root.addEventListener("input", (e) => {
      if (e.target.matches("[data-tt-sector-input]")) this.sectorInput = e.target.value;
      if (e.target.matches("[data-tt-world-input]")) this.worldInput = e.target.value;
    });
    this.root.addEventListener("change", (e) => {
      if (e.target.matches("[data-tt-subsector-select]")) this.selectedSubsectorLetter = e.target.value;
    });
  }

  async _action_validate_sector() {
    const name = this.sectorInput.trim();
    if (!name) { ui.notifications.warn("Enter a sector name first."); return; }
    this.busy = true; this.statusHtml = "<p class=\"tt-hint\">Checking Traveller Map…</p>"; this._renderContent();
    try {
      this.resolvedSector = await fetchSectorMetadata(name, this._milieu());
      this.selectedSubsectorLetter = this.resolvedSector.subsectors[0]?.letter || "";
      this.statusHtml = `<p class="tt-hint">Found <b>${esc(this.resolvedSector.name)}</b> (${this.resolvedSector.subsectors.length} subsectors).</p>`;
    } catch (err) {
      this.resolvedSector = null;
      this.statusHtml = `<p class="tt-hint">Couldn't find a sector named "${esc(name)}" on Traveller Map${err?.message ? ` (${esc(err.message)})` : ""}.</p>`;
    }
    this.busy = false;
    this._renderContent();
  }

  async _action_import_sector() {
    if (!this.resolvedSector) return;
    await this._runImport(() => fetchSectorWorldRows(this.resolvedSector.name, this._milieu()), this.resolvedSector);
  }

  async _action_import_subsector() {
    if (!this.resolvedSector || !this.selectedSubsectorLetter) return;
    await this._runImport(() => fetchSubsectorWorldRows(this.resolvedSector.name, this.selectedSubsectorLetter, this._milieu()), this.resolvedSector);
  }

  async _action_import_world() {
    const text = this.worldInput.trim();
    if (!text) { ui.notifications.warn("Enter a world name first."); return; }
    this.busy = true; this.statusHtml = "<p class=\"tt-hint\">Searching Traveller Map…</p>"; this._renderContent();
    const candidates = await resolveLocation(text);
    if (!candidates.length) {
      this.busy = false;
      this.statusHtml = `<p class="tt-hint">Couldn't find "${esc(text)}" on Traveller Map.</p>`;
      this._renderContent();
      return;
    }
    let picked = candidates[0];
    if (candidates.length > 1) {
      this.busy = false;
      this._renderContent();
      picked = await pickLocationCandidate(candidates);
      if (!picked) return;
      this.busy = true;
    }
    try {
      const sectorMeta = await fetchSectorMetadata(picked.sector, this._milieu());
      const row = await fetchSingleWorldRow(picked.sector, picked.hex, this._milieu());
      if (!row) throw new Error("World not found in sector data");
      await this._doImport([row], sectorMeta);
    } catch (err) {
      console.error("Traveller Trading | World import failed", err);
      this.statusHtml = `<p class="tt-hint">Import failed: ${esc(err.message || String(err))}.</p>`;
    }
    this.busy = false;
    this._renderContent();
  }

  async _runImport(fetchRows, sectorMeta) {
    this.busy = true; this.statusHtml = "<p class=\"tt-hint\">Fetching worlds…</p>"; this._renderContent();
    try {
      const rows = await fetchRows();
      await this._doImport(rows, sectorMeta);
    } catch (err) {
      console.error("Traveller Trading | World import failed", err);
      this.statusHtml = `<p class="tt-hint">Import failed: ${esc(err.message || String(err))}.</p>`;
    }
    this.busy = false;
    this._renderContent();
  }

  async _doImport(rows, sectorMeta) {
    const milieu = this._milieu();
    const { created, updated } = await importWorldRows(rows, sectorMeta, milieu, {
      onProgress: ({ name, created, updated, total }) => {
        this.statusHtml = `<p class="tt-hint">Importing… ${created + updated}/${total} (${esc(name)})</p>`;
        this._renderContent();
      }
    });
    this.statusHtml = `<p class="tt-hint">Done - ${created} world${created === 1 ? "" : "s"} created, ${updated} updated.</p>`;
    ui.notifications.info(`Traveller Trading: imported ${created} new and updated ${updated} existing world(s).`);
  }

  _milieu() {
    try { return game.settings.get(MODULE_ID, "milieu") || "M1105"; } catch (err) { return "M1105"; }
  }

  _renderContent() {
    const tabs = [["world", "Single World"], ["subsector", "Subsector"], ["sector", "Sector"]];
    const tabsHtml = `<div class="tt-subtabs">${tabs.map(([id, label]) =>
      `<button type="button" class="tt-subtab ${this.mode === id ? "active" : ""}" data-tt-import-tab="${id}">${label}</button>`
    ).join("")}</div>`;

    let bodyHtml;
    if (this.mode === "world") {
      bodyHtml = `
        <p class="tt-hint">Enter a world name - if more than one Traveller Map match is found you'll be asked which one.</p>
        <div class="tt-inline-row">
          <input type="text" class="tt-input" data-tt-world-input value="${esc(this.worldInput)}" placeholder="e.g. Regina" ${this.busy ? "disabled" : ""}>
          <button type="button" class="tt-btn" data-tt-action="import_world" ${this.busy ? "disabled" : ""}>Import</button>
        </div>`;
    } else {
      bodyHtml = `
        <p class="tt-hint">Enter a sector name and validate it against Traveller Map first.</p>
        <div class="tt-inline-row">
          <input type="text" class="tt-input" data-tt-sector-input value="${esc(this.sectorInput)}" placeholder="e.g. Spinward Marches" ${this.busy ? "disabled" : ""}>
          <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="validate_sector" ${this.busy ? "disabled" : ""}>Check</button>
        </div>`;
      if (this.resolvedSector) {
        if (this.mode === "subsector") {
          const opts = this.resolvedSector.subsectors.map(s => `<option value="${esc(s.letter)}" ${s.letter === this.selectedSubsectorLetter ? "selected" : ""}>${esc(s.name)} (${esc(s.letter)})</option>`).join("");
          bodyHtml += `
            <div class="tt-inline-row" style="margin-top:8px;">
              <select data-tt-subsector-select class="tt-input" ${this.busy ? "disabled" : ""}>${opts}</select>
              <button type="button" class="tt-btn" data-tt-action="import_subsector" ${this.busy ? "disabled" : ""}>Import Subsector</button>
            </div>`;
        } else {
          bodyHtml += `
            <div class="tt-inline-row" style="margin-top:8px;">
              <button type="button" class="tt-btn" data-tt-action="import_sector" ${this.busy ? "disabled" : ""}>Import Entire Sector (${this.resolvedSector.subsectors.length} subsectors)</button>
            </div>`;
        }
      }
    }

    this.root.innerHTML = `
      <div class="tt-world-import">
        ${tabsHtml}
        <div style="margin-top:12px;">${bodyHtml}</div>
        <div style="margin-top:12px;">${this.statusHtml}</div>
      </div>`;
  }
}
