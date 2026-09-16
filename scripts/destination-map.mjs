import { esc, createDialogV2 } from "./window-base.mjs";
import { TradingWindowBase } from "./window-base.mjs";
import { MODULE_ID } from "./constants.mjs";
import { TRADE_CODES, describeUwp, worldTradeCodes } from "./trade-data.mjs";

// Traveller Map's own supported milieux (from its /api/milieux endpoint —
// checked live; this module has no way to keep this list itself in sync if
// they ever add another one, so a GM using a newer milieu than this list
// would need this module updated too).
const MILIEUX = {
  "M1105": "M1105 — Third Imperium (default)",
  "IW": "IW — Interstellar Wars",
  "M0": "M0 — Year 0",
  "M600": "M600 — Year 600",
  "M990": "M990 — Year 990",
  "M1120": "M1120 — Rebellion",
  "M1201": "M1201 — New Era",
  "M1248": "M1248 — Reformation",
  "M1900": "M1900 — Year 1900"
};
const DEFAULT_MILIEU = "M1105"; // matches the Drinax Tracker module's own fixed milieu for this campaign

// Approximate palettes inspired by travellermap.com's own named styles
// (used only for the fallback renderer below — the authentic map fetched
// from travellermap.com itself uses their real styling).
const MAP_STYLES = {
  poster: { title: "Poster (dark)", bg: "#05070d", grid: "#1c2536", labelColor: "#8892a3", origin: "#c9a24a", zoneRed: "#c1443c", zoneAmber: "#d98b3f", zoneGreen: "#4fb0a6" },
  print: { title: "Print (light)", bg: "#f5f2ea", grid: "#c9c2ae", labelColor: "#6b6656", origin: "#8a5a10", zoneRed: "#a5342c", zoneAmber: "#a86b1f", zoneGreen: "#2e7d5b" },
  atlas: { title: "Atlas (grayscale)", bg: "#ffffff", grid: "#c9c9c9", labelColor: "#666666", origin: "#1a1a1a", zoneRed: "#4d4d4d", zoneAmber: "#7a7a7a", zoneGreen: "#333333" },
  candy: { title: "Candy (vibrant)", bg: "#0a1f38", grid: "#274468", labelColor: "#9fd1ff", origin: "#ffe066", zoneRed: "#ff4d6d", zoneAmber: "#ffb347", zoneGreen: "#4dffb8" }
};
const DEFAULT_STYLE = "poster";
const NO_PREFERRED_SECTOR = "";

// Registered at "init" — static choices, safe before any network activity.
export function registerDestinationMapSettings() {
  game.settings.register(MODULE_ID, "milieu", {
    name: "Traveller Map Milieu",
    hint: "Which era's data to query on travellermap.com for world lookups and jump maps. Changing this only takes effect for the Preferred Sector list below after a reload.",
    scope: "world",
    config: true,
    type: String,
    choices: MILIEUX,
    default: DEFAULT_MILIEU
  });

  game.settings.register(MODULE_ID, "mapStyle", {
    name: "Jump Map Style",
    hint: "Visual style requested from travellermap.com for the destination-picker jump map (falls back to an approximation of the same style if the real map can't be reached).",
    scope: "world",
    config: true,
    type: String,
    choices: Object.fromEntries(Object.entries(MAP_STYLES).map(([k, v]) => [k, v.title])),
    default: DEFAULT_STYLE
  });

  // Registered here with just the "no preference" option so the setting
  // exists (and has a stable default) even if the sector-list fetch below
  // never completes (offline, travellermap.com unreachable, etc.) —
  // registerPreferredSectorChoices() re-registers it with the full list.
  game.settings.register(MODULE_ID, "preferredSector", {
    name: "Preferred Sector",
    hint: "Some world names exist in more than one sector — pick this campaign's home sector to prefer those matches when searching by name. Populated from travellermap.com after the world finishes loading; reload once if it still just shows \"Any\".",
    scope: "world",
    config: true,
    type: String,
    choices: { [NO_PREFERRED_SECTOR]: "(Any — show all matches)" },
    default: NO_PREFERRED_SECTOR
  });
}

// Called at "ready" (settings are readable by then) to replace the
// Preferred Sector setting's choices with the real sector list for the
// currently-selected milieu. Best-effort: leaves the "(Any)"-only setting
// in place if travellermap.com can't be reached.
export async function registerPreferredSectorChoices() {
  // World-scope settings can only be written by whoever holds "Manage World
  // Settings" (normally just the GM) — skip the fetch and re-register
  // entirely for everyone else rather than have every player's client hit
  // travellermap.com just to fail on the game.settings.set() below.
  if (!game.user.isGM) return;
  try {
    const milieu = currentMilieu();
    const res = await fetch(`https://travellermap.com/api/universe?milieu=${encodeURIComponent(milieu)}&tag=Official`);
    if (!res.ok) return;
    const json = await res.json();
    const sectors = (json?.Sectors || [])
      .map(s => s.Names?.[0]?.Text)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (!sectors.length) return;
    const choices = { [NO_PREFERRED_SECTOR]: "(Any — show all matches)" };
    for (const name of sectors) choices[name] = name;
    const current = currentPreferredSector();
    game.settings.register(MODULE_ID, "preferredSector", {
      name: "Preferred Sector",
      hint: "Some world names exist in more than one sector — pick this campaign's home sector to prefer those matches when searching by name.",
      scope: "world",
      config: true,
      type: String,
      choices,
      default: NO_PREFERRED_SECTOR
    });
    // Re-registering resets the stored value to the new default in some
    // Foundry versions unless it's explicitly restored.
    if (current && choices[current]) await game.settings.set(MODULE_ID, "preferredSector", current);
  } catch (err) {
    console.warn("Traveller Trading | Couldn't load the Traveller Map sector list", err);
  }
}

function currentMilieu() {
  try { return game.settings.get(MODULE_ID, "milieu") || DEFAULT_MILIEU; } catch (err) { return DEFAULT_MILIEU; }
}

function currentPreferredSector() {
  try { return game.settings.get(MODULE_ID, "preferredSector") || NO_PREFERRED_SECTOR; } catch (err) { return NO_PREFERRED_SECTOR; }
}

function currentStyleKey() {
  try { return game.settings.get(MODULE_ID, "mapStyle") || DEFAULT_STYLE; } catch (err) { return DEFAULT_STYLE; }
}

function currentStyle() {
  return MAP_STYLES[currentStyleKey()] || MAP_STYLES[DEFAULT_STYLE];
}

function formatHex(hexX, hexY) {
  return String(hexX).padStart(2, "0") + String(hexY).padStart(2, "0");
}

// Resolves a free-text "Current Location"/"Destination" value into
// {name, sector, hex} candidates. Two shapes are recognized without a
// network round trip: "Name (Sector HHHH)" (what this module itself
// writes when a destination is picked from the map) and a bare
// "Sector HHHH". Anything else falls back to travellermap.com's public
// search API — same endpoint and response shape the Drinax Tracker module
// already relies on for its own world lookups — narrowed to the Preferred
// Sector setting when it matches something, to cut down on the same-name-
// in-different-sectors ambiguity.
export async function resolveLocation(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const parenthesized = /^(.*)\(([^()]+?)\s+(\d{4})\)\s*$/.exec(trimmed);
  if (parenthesized) return [{ name: parenthesized[1].trim() || trimmed, sector: parenthesized[2].trim(), hex: parenthesized[3] }];
  const direct = /^(.+?)\s+(\d{4})$/.exec(trimmed);
  if (direct) return [{ name: trimmed, sector: direct[1], hex: direct[2] }];
  try {
    const res = await fetch(`https://travellermap.com/api/search?q=${encodeURIComponent(trimmed)}&milieu=${encodeURIComponent(currentMilieu())}`);
    if (!res.ok) return [];
    const json = await res.json();
    const items = json?.Results?.Items || [];
    let worlds = items
      .filter(it => it.World)
      .map(it => it.World)
      .map(w => ({ name: w.Name, sector: w.Sector, hex: formatHex(w.HexX, w.HexY) }));
    const preferred = currentPreferredSector();
    if (preferred) {
      const scoped = worlds.filter(w => w.sector === preferred);
      if (scoped.length) worlds = scoped;
    }
    return worlds.slice(0, 8);
  } catch (err) {
    console.warn("Traveller Trading | Traveller Map lookup failed", err);
    return [];
  }
}

// Shared disambiguation dialog for a list of {name, sector, hex} candidates
// from resolveLocation() — same shape ship-app.mjs's own destination/origin
// picker dialog uses; exported here so trade-app.mjs (which also resolves a
// ship's Current Location, for its Buy/Sell Goods windows) doesn't need its
// own copy. Resolves the chosen candidate, or null if cancelled.
export function pickLocationCandidate(candidates) {
  return new Promise(resolve => {
    let resolved = false;
    const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
    const container = document.createElement("div");
    container.id = "tt-root";
    container.innerHTML = `
      <p class="tt-hint">Multiple matches — pick one:</p>
      <div class="tt-tm-results">
        ${candidates.map((c, i) => `<div class="tt-tm-result" data-tt-tm-idx="${i}">${esc(c.name)} &mdash; ${esc(c.sector)} ${esc(c.hex)}</div>`).join("")}
      </div>`;
    const dlg = createDialogV2({
      window: { title: "Choose Location" },
      content: container,
      buttons: [{ action: "cancel", label: "Cancel" }],
      rejectClose: false
    }, () => finish(null));
    container.querySelectorAll("[data-tt-tm-idx]").forEach(el => {
      el.addEventListener("click", () => {
        finish(candidates[Number(el.dataset.ttTmIdx)]);
        dlg.close();
      });
    });
    dlg.render(true);
  });
}

export async function fetchJumpWorlds(sector, hex, jump) {
  const res = await fetch(`https://travellermap.com/api/jumpworlds?sector=${encodeURIComponent(sector)}&hex=${encodeURIComponent(hex)}&jump=${jump}&milieu=${encodeURIComponent(currentMilieu())}`);
  if (!res.ok) throw new Error(`Traveller Map returned ${res.status}`);
  const json = await res.json();
  return json?.Worlds || [];
}

// Pixels-per-parsec requested from travellermap.com's own jumpmap image —
// also fed into worldToPixel() below when computing where each world
// SHOULD sit in that image, so the two stay on the same scale.
const JUMPMAP_SCALE = 48;

async function fetchJumpMapSvg(sector, hex, jump, styleKey) {
  const url = `https://travellermap.com/api/jumpmap?sector=${encodeURIComponent(sector)}&hex=${encodeURIComponent(hex)}&jump=${jump}&milieu=${encodeURIComponent(currentMilieu())}&style=${encodeURIComponent(styleKey)}&scale=${JUMPMAP_SCALE}&accept=image/svg+xml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Traveller Map returned ${res.status}`);
  const text = await res.text();
  if (!text.includes("<svg")) throw new Error("Traveller Map didn't return SVG for this request");
  return text;
}

function zoneColorKey(zone) {
  if (zone === "R") return "zoneRed";
  if (zone === "A") return "zoneAmber";
  return "zoneGreen";
}

// ---------------------------------------------------------------------------
// Hex geometry. Traveller Map's own world-space coordinates (WorldX/WorldY,
// as returned per-world by /api/jumpworlds) are NOT plain Cartesian — hex
// columns are offset vertically by half a row on alternating columns. This
// is travellermap.com's own documented worldXYToMapXY transform (per their
// API docs), which is what makes hexes tile correctly and lets both the
// fallback grid below and the authentic-map overlay share the exact same
// coordinate math.
// ---------------------------------------------------------------------------
const PARSEC_SCALE_X = Math.cos(Math.PI / 6); // ~0.866

function isEven(n) { return ((n % 2) + 2) % 2 === 0; }

function worldToPixel(worldX, worldY, scale) {
  const ix = worldX - 0.5;
  const iy = isEven(worldX) ? worldY - 0.5 : worldY;
  const mapX = ix * PARSEC_SCALE_X;
  const mapY = -iy;
  return { x: mapX * scale, y: -mapY * scale };
}

// Center of `el`'s bounding box, converted into `rootSvg`'s own internal
// coordinate system (its viewBox units) regardless of any transforms
// between them. Dividing el's screen-space CTM by the root's own
// screen-space CTM cancels out the CSS viewport scaling (width:100% etc.)
// and page position that both share, leaving just the local transform
// between the two — see the "authentic map miscalibrated" fix history
// above _calibrateAndInjectOverlay for why this can't just use
// el.getCTM() directly. Returns null if either element isn't laid out
// (e.g. not yet attached to the document).
function svgElementCenterInRoot(rootSvg, el) {
  const bbox = el.getBBox();
  const pt = rootSvg.createSVGPoint();
  pt.x = bbox.x + bbox.width / 2;
  pt.y = bbox.y + bbox.height / 2;
  const elCTM = el.getScreenCTM();
  const rootCTM = rootSvg.getScreenCTM();
  if (!elCTM || !rootCTM) return null;
  return pt.matrixTransform(rootCTM.inverse().multiply(elCTM));
}

// Flat-top hexagon path centered at (cx, cy) — vertices at 0/60/120/180/
// 240/300 degrees give flat (horizontal) top and bottom edges, matching
// Traveller's column-offset hex layout.
function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

let instance = null;

// Opens (or refocuses) the destination-picker map for one ship. onPick is
// invoked with {sector, hex, name} when a system is clicked; the caller
// decides what to do with it (normally: save it as the ship's
// destination) — this module only renders the map and reports the click.
export function openDestinationMapApp({ docId, originSector, originHex, initialJump, onPick }) {
  if (instance && instance.rendered && instance.docId === docId) { instance.bringToTop(); return instance; }
  if (instance) instance.close();
  instance = new DestinationMapApp({ docId, originSector, originHex, initialJump, onPick });
  instance.render(true);
  return instance;
}

class DestinationMapApp extends TradingWindowBase {
  constructor({ docId, originSector, originHex, initialJump, onPick }, options) {
    super(options);
    this.docId = docId;
    this.originSector = originSector;
    this.originHex = originHex;
    this.onPick = onPick;
    // Seeded from the ship's own Jump Rating, but freely changeable here —
    // this only sets the map's starting range, it's never written back.
    const seed = Number(initialJump);
    this.jump = Math.max(0, Math.min(6, Number.isFinite(seed) ? seed : 2));
    this.worlds = [];
    this.loadError = "";
    this.authentic = null; // {svgMarkup, viewBox, offsetX, offsetY} when the real travellermap.com render worked
    this.zoom = 1;
  }

  static DEFAULT_OPTIONS = {
    id: "tt-destination-map-app",
    classes: ["traveller-trading-window"],
    window: { title: "Choose Destination", resizable: true },
    position: { width: 780, height: "auto" }
  };

  async close(options) {
    instance = null;
    return super.close(options);
  }

  async _load() {
    await this._fetchWorlds();
  }

  async _fetchWorlds() {
    this.loadError = "";
    this.authentic = null;
    try {
      this.worlds = await fetchJumpWorlds(this.originSector, this.originHex, this.jump);
    } catch (err) {
      console.warn("Traveller Trading | Jump map fetch failed", err);
      this.worlds = [];
      this.loadError = "Couldn't reach Traveller Map. Check your connection and try again.";
      return;
    }
    await this._fetchAuthenticMap();
  }

  // Best-effort: fetches travellermap.com's own rendered jump map as SVG.
  // Just fetches and validates it here — the actual click/hover overlay
  // calibration (see _calibrateAndInjectOverlay) needs the SVG live in the
  // document to measure correctly, so it happens after _renderContent()
  // inserts this markup, not here. Any failure along the way (network,
  // CORS, unexpected shape) leaves this.authentic null and _renderContent()
  // below falls back to its own fully self-contained rendering instead.
  async _fetchAuthenticMap() {
    const originWorld = this.worlds.find(w => w.Hex === this.originHex && w.Sector === this.originSector);
    if (!originWorld) return;
    try {
      const svgText = await fetchJumpMapSvg(this.originSector, this.originHex, this.jump, currentStyleKey());
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const svgEl = doc.querySelector("svg");
      if (!svgEl || doc.querySelector("parsererror")) throw new Error("Unparseable SVG");
      const viewBox = svgEl.getAttribute("viewBox") || `0 0 ${svgEl.getAttribute("width")} ${svgEl.getAttribute("height")}`;
      this.authentic = { svgMarkup: svgEl.outerHTML, viewBox };
    } catch (err) {
      console.warn("Traveller Trading | Couldn't render travellermap.com's own jump map, using the built-in fallback map instead", err);
      this.authentic = null;
    }
  }

  // Runs once the authentic map's SVG is actually attached to the page
  // (called from _renderContent right after setting innerHTML). Finding
  // the origin's own label and reading its position via getBBox()/getCTM()
  // — rather than its raw x/y attributes — matters because travellermap.com
  // very likely wraps its content in a positioning <g transform="...">
  // internally; raw attribute reads ignore that transform entirely and
  // silently produce a wrong (but not obviously invalid) offset, which is
  // exactly the "renders fine, clicks land on the wrong system" failure
  // mode this replaces. getBBox()/getCTM() only return sensible values
  // once the element is laid out in the live DOM, which is why this can't
  // run back in _fetchAuthenticMap on the detached, parsed document.
  _calibrateAndInjectOverlay() {
    const container = this.root.querySelector(".tt-map-authentic");
    const liveSvg = container?.querySelector("svg");
    const originWorld = this.worlds.find(w => w.Hex === this.originHex && w.Sector === this.originSector);
    if (!container || !liveSvg || !originWorld) return;

    let offsetX, offsetY;
    try {
      const norm = s => (s || "").trim().toLowerCase();
      const texts = Array.from(liveSvg.querySelectorAll("text"));
      let match = texts.find(t => norm(t.textContent) === norm(originWorld.Name));
      if (!match) match = texts.find(t => norm(t.textContent) === norm(originWorld.Hex));
      if (!match) throw new Error("Origin label not found in the fetched map");

      const labelPos = svgElementCenterInRoot(liveSvg, match);
      if (!labelPos) throw new Error("No screen CTM available for the origin label");

      // The label's own position is offset from its world's actual dot —
      // travellermap.com draws the name a fixed distance below the icon,
      // confirmed live (hotspots landing consistently on the name instead
      // of the hex). Re-anchor on the nearest <circle> to that label
      // instead, converting every candidate into the same root-space
      // coordinates before comparing distances so this stays correct
      // regardless of how travellermap.com nests its transforms.
      let anchor = labelPos;
      let bestDist = Infinity;
      for (const c of liveSvg.querySelectorAll("circle")) {
        const p = svgElementCenterInRoot(liveSvg, c);
        if (!p) continue;
        const d = Math.hypot(p.x - labelPos.x, p.y - labelPos.y);
        if (d < bestDist) { bestDist = d; anchor = p; }
      }

      const theoretical = worldToPixel(originWorld.WorldX ?? 0, originWorld.WorldY ?? 0, JUMPMAP_SCALE);
      offsetX = anchor.x - theoretical.x;
      offsetY = anchor.y - theoretical.y;
    } catch (err) {
      // Fall back to assuming the origin sits at the image's center —
      // travellermap.com's likely (but unconfirmed) convention for a jump
      // map clipped symmetrically around the given hex.
      console.warn("Traveller Trading | Couldn't calibrate against the origin's label, falling back to a centered guess", err);
      const vb = this.authentic.viewBox.split(/\s+/).map(Number);
      offsetX = (vb[0] ?? 0) + (vb[2] ?? 0) / 2;
      offsetY = (vb[1] ?? 0) + (vb[3] ?? 0) / 2;
    }

    const hits = this.worlds.map(world => {
      const isOrigin = world.Hex === this.originHex && world.Sector === this.originSector;
      const p = worldToPixel(world.WorldX ?? 0, world.WorldY ?? 0, JUMPMAP_SCALE);
      const cx = p.x + offsetX, cy = p.y + offsetY;
      return `
        <circle class="tt-map-hit ${isOrigin ? "tt-map-origin" : ""}"
          data-tt-map-world
          data-name="${esc(world.Name || "(unnamed)")}"
          data-sector="${esc(world.Sector || "")}"
          data-hex="${esc(world.Hex || "")}"
          data-uwp="${esc(world.UWP || "")}"
          data-remarks="${esc(world.Remarks || "")}"
          data-zone="${esc(world.Zone || "")}"
          cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(JUMPMAP_SCALE * 0.4).toFixed(1)}"></circle>`;
    }).join("");

    // Inserted as markup (parsed by the HTML parser's own built-in SVG
    // foreign-content handling) rather than building the <svg> via
    // createElementNS + setting .innerHTML on it — the latter is NOT
    // consistently supported for SVG elements across browsers, unlike
    // plain string insertion, which every other rendered element in this
    // module already relies on successfully.
    container.insertAdjacentHTML("beforeend", `<svg class="tt-map-overlay" viewBox="${this.authentic.viewBox}" data-tt-map-svg>${hits}</svg>`);
    this._wireMapInteractions();
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", async (e) => {
      if (e.target.matches("[data-tt-jump-range]")) {
        this.jump = Math.max(0, Math.min(6, Number(e.target.value) || 0));
        await this._fetchWorlds();
        this._renderContent();
      }
    });
    // Scaling the shared zoom wrapper directly (no re-render) keeps this
    // smooth and, for the authentic map, keeps the invisible click overlay
    // pixel-perfectly aligned with the real map underneath — both are
    // descendants of the same wrapper, so one CSS transform scales them
    // together instead of needing to recompute either one's coordinates.
    this.root.addEventListener("wheel", (e) => {
      const canvas = this.root.querySelector(".tt-map-canvas");
      const zoomEl = this.root.querySelector("[data-tt-map-zoom]");
      if (!canvas || !zoomEl || !canvas.contains(e.target)) return;
      e.preventDefault();
      this.zoom = Math.max(0.5, Math.min(3, this.zoom + (e.deltaY < 0 ? 0.15 : -0.15)));
      zoomEl.style.transform = `scale(${this.zoom})`;
    }, { passive: false });
  }

  _renderContent() {
    const worlds = this.worlds;
    const hasMap = !this.loadError && worlds.length > 0;
    let mapHtml;

    if (this.loadError) {
      mapHtml = `<p class="tt-empty">${esc(this.loadError)}</p>`;
    } else if (!worlds.length) {
      mapHtml = `<p class="tt-empty">No worlds found within range.</p>`;
    } else if (this.authentic) {
      mapHtml = this._authenticMapHtml();
    } else {
      mapHtml = this._fallbackMapHtml();
    }
    // The tooltip lives outside the zoom wrapper so it never scales with
    // the map; only the map content itself (and, for the authentic path,
    // the overlay appended into it below) does.
    const bodyHtml = hasMap
      ? `<div class="tt-map-zoom" data-tt-map-zoom style="transform: scale(${this.zoom});">${mapHtml}</div>
         <div class="tt-map-tooltip" data-tt-map-tooltip hidden></div>`
      : mapHtml;

    this.root.innerHTML = `
      <div class="tt-destmap">
        <p class="tt-hint">Worlds within jump range of ${esc(this.originSector)} ${esc(this.originHex)}. Hover a system for its UWP and trade codes; click one to set it as the destination. Scroll to zoom.</p>
        <div class="tt-inline-row" style="margin-bottom:10px;">
          <label style="font-size:12.5px;color:var(--text-muted);">Jump range</label>
          <input type="number" data-tt-jump-range min="0" max="6" value="${this.jump}" class="tt-input" style="width:60px;">
        </div>
        <div class="tt-map-canvas">${bodyHtml}</div>
      </div>`;

    if (!this.loadError && worlds.length) {
      // The authentic map's markup is now live in the DOM (needed for the
      // getBBox()/getCTM() calibration below); the fallback map already
      // has everything it needs and just wires up its existing SVG
      // directly.
      if (this.authentic) this._calibrateAndInjectOverlay();
      else this._wireMapInteractions();
    }
    // The window's own "auto" height is only computed once, at first
    // render — re-request it here too, since every jump-range change (and
    // the map's own capped max-height) changes how tall the content
    // actually is, and a stale fixed height otherwise leaves the window
    // either clipping the map or towering over it with empty space.
    this.setPosition({ height: "auto" });
  }

  // Renders travellermap.com's own SVG as the visual background. The
  // click/hover overlay isn't built here — it needs this markup already
  // live in the document to calibrate correctly, so _renderContent() adds
  // it afterward via _calibrateAndInjectOverlay().
  _authenticMapHtml() {
    return `
      <div class="tt-map-authentic">${this.authentic.svgMarkup}</div>`;
  }

  // Fully self-contained rendering used whenever the authentic map above
  // couldn't be fetched or calibrated — always available, no external
  // dependency beyond the world data already fetched for either path.
  _fallbackMapHtml() {
    const style = currentStyle();
    const scale = 58;
    const hexRadius = scale / Math.sqrt(3);
    const pad = hexRadius * 2;
    const positioned = this.worlds.map(world => ({ world, px: worldToPixel(world.WorldX ?? 0, world.WorldY ?? 0, scale) }));
    const xs = positioned.map(p => p.px.x), ys = positioned.map(p => p.px.y);
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const vbW = maxX - minX, vbH = maxY - minY;

    const worldXs = this.worlds.map(w => w.WorldX ?? 0), worldYs = this.worlds.map(w => w.WorldY ?? 0);
    const gridCells = [];
    for (let gx = Math.min(...worldXs) - 1; gx <= Math.max(...worldXs) + 1; gx++) {
      for (let gy = Math.min(...worldYs) - 1; gy <= Math.max(...worldYs) + 1; gy++) {
        const p = worldToPixel(gx, gy, scale);
        gridCells.push(`<polygon points="${hexPoints(p.x, p.y, hexRadius)}" fill="none" stroke="${style.grid}" stroke-width="1"></polygon>`);
      }
    }

    const dots = positioned.map(({ world, px }) => {
      const isOrigin = world.Hex === this.originHex && world.Sector === this.originSector;
      const color = isOrigin ? style.origin : style[zoneColorKey(world.Zone)];
      const starport = (world.UWP || "?").charAt(0);
      return `
        <g class="tt-map-world ${isOrigin ? "tt-map-origin" : ""}"
           data-tt-map-world
           data-name="${esc(world.Name || "(unnamed)")}"
           data-sector="${esc(world.Sector || "")}"
           data-hex="${esc(world.Hex || "")}"
           data-uwp="${esc(world.UWP || "")}"
           data-remarks="${esc(world.Remarks || "")}"
           data-zone="${esc(world.Zone || "")}">
          <circle cx="${px.x.toFixed(1)}" cy="${px.y.toFixed(1)}" r="${(hexRadius * 0.42).toFixed(1)}" fill="${color}" stroke="${style.bg}" stroke-width="1.5"></circle>
          <text x="${px.x.toFixed(1)}" y="${(px.y + 3).toFixed(1)}" text-anchor="middle" class="tt-map-starport" fill="${style.bg}">${esc(starport)}</text>
          <text x="${px.x.toFixed(1)}" y="${(px.y + hexRadius * 0.85).toFixed(1)}" text-anchor="middle" class="tt-map-label" fill="${isOrigin ? style.origin : style.labelColor}">${esc(world.Name || "")}${isOrigin ? " (current)" : ""}</text>
        </g>`;
    }).join("");

    return `
      <svg class="tt-map-svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" data-tt-map-svg
           style="background:${style.bg};">
        <g>${gridCells.join("")}</g>
        <g>${dots}</g>
      </svg>`;
  }

  // Breaks a hovered system's UWP and Remarks down into labeled fields
  // (Starport/Size/.../Tech Level, trade codes with their full names, and
  // the Travel Zone — Amber/Red act as trade codes in their own right for
  // Advanced Weapons/Vehicles and illegal-goods pricing) rather than
  // showing the raw UWP/Remarks strings as before.
  _worldTooltipHtml(dataset) {
    const uwpParts = describeUwp(dataset.uwp) || [];
    const world = { UWP: dataset.uwp, Remarks: dataset.remarks, Zone: dataset.zone };
    const codes = worldTradeCodes(world);
    const zoneLabel = dataset.zone === "A" ? "Amber" : (dataset.zone === "R" ? "Red" : "Green");
    const codeList = [...codes].sort().map(c => `${esc(c)} (${esc(TRADE_CODES[c] || c)})`).join(", ") || "none";
    return `
      <b>${esc(dataset.name)}</b><br>
      ${esc(dataset.sector)} ${esc(dataset.hex)}<br>
      <span class="tt-mono">${esc(dataset.uwp)}</span><br>
      ${uwpParts.map(p => `${esc(p.label)}: ${esc(p.value)}`).join(" &middot; ")}<br>
      Zone: ${zoneLabel}<br>
      Trade codes: ${codeList}`;
  }

  _wireMapInteractions() {
    const svg = this.root.querySelector("[data-tt-map-svg]");
    const tooltip = this.root.querySelector("[data-tt-map-tooltip]");
    const canvas = this.root.querySelector(".tt-map-canvas");
    const targets = svg ? svg.querySelectorAll("[data-tt-map-world]") : [];
    if (!svg || !tooltip) return;
    targets.forEach(g => {
      g.addEventListener("mouseenter", () => {
        tooltip.innerHTML = this._worldTooltipHtml(g.dataset);
        tooltip.hidden = false;
      });
      g.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left + 14}px`;
        tooltip.style.top = `${e.clientY - rect.top + 14}px`;
      });
      g.addEventListener("mouseleave", () => { tooltip.hidden = true; });
      if (!g.classList.contains("tt-map-origin")) {
        g.addEventListener("click", () => {
          this.onPick({ sector: g.dataset.sector, hex: g.dataset.hex, name: g.dataset.name });
          this.close();
        });
      }
    });
  }
}
