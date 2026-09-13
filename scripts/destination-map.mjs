import { esc } from "./window-base.mjs";
import { TradingWindowBase } from "./window-base.mjs";
import { MODULE_ID } from "./constants.mjs";

// Same milieu the Drinax Tracker module already uses for this campaign's
// own Traveller Map lookups — keeps results consistent across both tools.
const CAMPAIGN_MILIEU = "M1105";

// Approximate palettes inspired by travellermap.com's own named styles
// (not pixel-exact reproductions — this is our own SVG rendering, not
// their image renderer, so it can only aim for "in the spirit of").
const MAP_STYLES = {
  poster: { title: "Poster (dark)", bg: "#05070d", grid: "#1c2536", labelColor: "#8892a3", origin: "#c9a24a", zoneRed: "#c1443c", zoneAmber: "#d98b3f", zoneGreen: "#4fb0a6" },
  print: { title: "Print (light)", bg: "#f5f2ea", grid: "#c9c2ae", labelColor: "#6b6656", origin: "#8a5a10", zoneRed: "#a5342c", zoneAmber: "#a86b1f", zoneGreen: "#2e7d5b" },
  atlas: { title: "Atlas (grayscale)", bg: "#ffffff", grid: "#c9c9c9", labelColor: "#666666", origin: "#1a1a1a", zoneRed: "#4d4d4d", zoneAmber: "#7a7a7a", zoneGreen: "#333333" },
  candy: { title: "Candy (vibrant)", bg: "#0a1f38", grid: "#274468", labelColor: "#9fd1ff", origin: "#ffe066", zoneRed: "#ff4d6d", zoneAmber: "#ffb347", zoneGreen: "#4dffb8" }
};
const DEFAULT_STYLE = "poster";

export function registerMapStyleSettings() {
  game.settings.register(MODULE_ID, "mapStyle", {
    name: "Jump Map Style",
    hint: "Visual style for the destination-picker jump map, loosely matching travellermap.com's own named styles.",
    scope: "world",
    config: true,
    type: String,
    choices: Object.fromEntries(Object.entries(MAP_STYLES).map(([k, v]) => [k, v.title])),
    default: DEFAULT_STYLE
  });
}

function currentStyle() {
  let key = DEFAULT_STYLE;
  try { key = game.settings.get(MODULE_ID, "mapStyle") || DEFAULT_STYLE; } catch (err) { /* setting not registered yet */ }
  return MAP_STYLES[key] || MAP_STYLES[DEFAULT_STYLE];
}

function formatHex(hexX, hexY) {
  return String(hexX).padStart(2, "0") + String(hexY).padStart(2, "0");
}

// Resolves a free-text "Current Location"/"Destination" value into
// {name, sector, hex} candidates. Two shapes are recognized without a
// network round trip: "Name (Sector HHHH)" (what this module itself
// writes when a destination is picked from the map) and a bare
// "Sector HHHH". Anything else falls back to travellermap.com's public
// search API — same endpoint, milieu, and response shape the Drinax
// Tracker module already relies on for its own world lookups.
export async function resolveLocation(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const parenthesized = /^(.*)\(([^()]+?)\s+(\d{4})\)\s*$/.exec(trimmed);
  if (parenthesized) return [{ name: parenthesized[1].trim() || trimmed, sector: parenthesized[2].trim(), hex: parenthesized[3] }];
  const direct = /^(.+?)\s+(\d{4})$/.exec(trimmed);
  if (direct) return [{ name: trimmed, sector: direct[1], hex: direct[2] }];
  try {
    const res = await fetch(`https://travellermap.com/api/search?q=${encodeURIComponent(trimmed)}&milieu=${CAMPAIGN_MILIEU}`);
    if (!res.ok) return [];
    const json = await res.json();
    const items = json?.Results?.Items || [];
    return items
      .filter(it => it.World)
      .map(it => it.World)
      .map(w => ({ name: w.Name, sector: w.Sector, hex: formatHex(w.HexX, w.HexY) }))
      .slice(0, 8);
  } catch (err) {
    console.warn("Traveller Trading | Traveller Map lookup failed", err);
    return [];
  }
}

async function fetchJumpWorlds(sector, hex, jump) {
  const res = await fetch(`https://travellermap.com/api/jumpworlds?sector=${encodeURIComponent(sector)}&hex=${encodeURIComponent(hex)}&jump=${jump}&milieu=${CAMPAIGN_MILIEU}`);
  if (!res.ok) throw new Error(`Traveller Map returned ${res.status}`);
  const json = await res.json();
  return json?.Worlds || [];
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
// API docs), which is what makes hexes tile correctly and lets the grid
// backdrop below share the exact same coordinate math as the world dots.
// ---------------------------------------------------------------------------
const PARSEC_SCALE_X = Math.cos(Math.PI / 6); // ~0.866
const RENDER_SCALE = 58; // our own pixels-per-parsec for this SVG, independent of travellermap.com's own image scale
const HEX_RADIUS = RENDER_SCALE / Math.sqrt(3); // center-to-vertex, derived to match the column/row spacing below

function isEven(n) { return ((n % 2) + 2) % 2 === 0; }

function worldToPixel(worldX, worldY) {
  const ix = worldX - 0.5;
  const iy = isEven(worldX) ? worldY - 0.5 : worldY;
  const mapX = ix * PARSEC_SCALE_X;
  const mapY = -iy;
  return { x: mapX * RENDER_SCALE, y: -mapY * RENDER_SCALE };
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
export function openDestinationMapApp({ docId, originSector, originHex, onPick }) {
  if (instance && instance.rendered && instance.docId === docId) { instance.bringToTop(); return instance; }
  if (instance) instance.close();
  instance = new DestinationMapApp({ docId, originSector, originHex, onPick });
  instance.render(true);
  return instance;
}

class DestinationMapApp extends TradingWindowBase {
  constructor({ docId, originSector, originHex, onPick }, options) {
    super(options);
    this.docId = docId;
    this.originSector = originSector;
    this.originHex = originHex;
    this.onPick = onPick;
    this.jump = 2;
    this.worlds = [];
    this.loadError = "";
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tt-destination-map-app",
      title: "Choose Destination",
      classes: ["traveller-trading-window"],
      width: 760,
      height: 660,
      resizable: true
    });
  }

  async close(options) {
    instance = null;
    return super.close(options);
  }

  async _load() {
    await this._fetchWorlds();
  }

  async _fetchWorlds() {
    this.loadError = "";
    try {
      this.worlds = await fetchJumpWorlds(this.originSector, this.originHex, this.jump);
    } catch (err) {
      console.warn("Traveller Trading | Jump map fetch failed", err);
      this.worlds = [];
      this.loadError = "Couldn't reach Traveller Map. Check your connection and try again.";
    }
  }

  activateListeners(html) {
    super.activateListeners(html);
    this.root.addEventListener("change", async (e) => {
      if (e.target.matches("[data-tt-jump-range]")) {
        this.jump = Math.max(0, Math.min(6, Number(e.target.value) || 0));
        await this._fetchWorlds();
        this._renderContent();
      }
    });
  }

  _renderContent() {
    const worlds = this.worlds;
    const style = currentStyle();
    const pad = HEX_RADIUS * 2;
    let bodyHtml;

    if (this.loadError) {
      bodyHtml = `<p class="tt-empty">${esc(this.loadError)}</p>`;
    } else if (!worlds.length) {
      bodyHtml = `<p class="tt-empty">No worlds found within range.</p>`;
    } else {
      const positioned = worlds.map(world => ({ world, px: worldToPixel(world.WorldX ?? 0, world.WorldY ?? 0) }));
      const xs = positioned.map(p => p.px.x), ys = positioned.map(p => p.px.y);
      const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
      const vbW = maxX - minX, vbH = maxY - minY;

      // Hex grid backdrop: every cell within the visible hex-column/row
      // range, not just cells that happen to hold a world, so it reads as
      // an actual sector map rather than floating dots.
      const worldXs = worlds.map(w => w.WorldX ?? 0), worldYs = worlds.map(w => w.WorldY ?? 0);
      const gridCells = [];
      for (let gx = Math.min(...worldXs) - 1; gx <= Math.max(...worldXs) + 1; gx++) {
        for (let gy = Math.min(...worldYs) - 1; gy <= Math.max(...worldYs) + 1; gy++) {
          const p = worldToPixel(gx, gy);
          gridCells.push(`<polygon points="${hexPoints(p.x, p.y, HEX_RADIUS)}" fill="none" stroke="${style.grid}" stroke-width="1"></polygon>`);
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
             data-remarks="${esc(world.Remarks || "")}">
            <circle cx="${px.x.toFixed(1)}" cy="${px.y.toFixed(1)}" r="${(HEX_RADIUS * 0.42).toFixed(1)}" fill="${color}" stroke="${style.bg}" stroke-width="1.5"></circle>
            <text x="${px.x.toFixed(1)}" y="${(px.y + 3).toFixed(1)}" text-anchor="middle" class="tt-map-starport" fill="${style.bg}">${esc(starport)}</text>
            <text x="${px.x.toFixed(1)}" y="${(px.y + HEX_RADIUS * 0.85).toFixed(1)}" text-anchor="middle" class="tt-map-label" fill="${isOrigin ? style.origin : style.labelColor}">${esc(world.Name || "")}${isOrigin ? " (current)" : ""}</text>
          </g>`;
      }).join("");

      bodyHtml = `
        <svg class="tt-map-svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" data-tt-map-svg
             style="background:${style.bg};">
          <g>${gridCells.join("")}</g>
          <g>${dots}</g>
        </svg>
        <div class="tt-map-tooltip" data-tt-map-tooltip hidden></div>`;
    }

    this.root.innerHTML = `
      <div class="tt-destmap">
        <p class="tt-hint">Worlds within jump range of ${esc(this.originSector)} ${esc(this.originHex)}. Hover a system for its UWP and trade codes; click one to set it as the destination.</p>
        <div class="tt-inline-row" style="margin-bottom:10px;">
          <label style="font-size:12.5px;color:var(--text-muted);">Jump range</label>
          <input type="number" data-tt-jump-range min="0" max="6" value="${this.jump}" class="tt-input" style="width:60px;">
        </div>
        <div class="tt-map-canvas">${bodyHtml}</div>
      </div>`;

    if (!this.loadError && worlds.length) this._wireMapInteractions();
  }

  _wireMapInteractions() {
    const svg = this.root.querySelector("[data-tt-map-svg]");
    const tooltip = this.root.querySelector("[data-tt-map-tooltip]");
    const canvas = this.root.querySelector(".tt-map-canvas");
    if (!svg || !tooltip) return;
    svg.querySelectorAll("[data-tt-map-world]").forEach(g => {
      g.addEventListener("mouseenter", () => {
        tooltip.innerHTML = `
          <b>${esc(g.dataset.name)}</b><br>
          ${esc(g.dataset.sector)} ${esc(g.dataset.hex)}<br>
          <span class="tt-mono">${esc(g.dataset.uwp)}</span><br>
          ${esc(g.dataset.remarks)}`;
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
