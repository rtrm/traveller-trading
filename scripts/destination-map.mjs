import { esc } from "./window-base.mjs";
import { TradingWindowBase } from "./window-base.mjs";

// Same milieu the Drinax Tracker module already uses for this campaign's
// own Traveller Map lookups — keeps results consistent across both tools.
const CAMPAIGN_MILIEU = "M1105";

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

function zoneColor(zone) {
  if (zone === "R") return "#c1443c";
  if (zone === "A") return "#d98b3f";
  return "#4fb0a6";
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
      width: 720,
      height: 620,
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
    const pad = 36, w = 640, h = 460;
    let bodyHtml;
    if (this.loadError) {
      bodyHtml = `<p class="tt-empty">${esc(this.loadError)}</p>`;
    } else if (!worlds.length) {
      bodyHtml = `<p class="tt-empty">No worlds found within range.</p>`;
    } else {
      const xs = worlds.map(x => x.WorldX ?? 0);
      const ys = worlds.map(x => x.WorldY ?? 0);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const spanX = (maxX - minX) || 1;
      const spanY = (maxY - minY) || 1;
      const toX = (x) => pad + (x - minX) / spanX * (w - 2 * pad);
      // Flipped so increasing WorldY (coreward) renders toward the top of the map.
      const toY = (y) => pad + (maxY - y) / spanY * (h - 2 * pad);
      const dots = worlds.map(world => {
        const isOrigin = world.Hex === this.originHex && world.Sector === this.originSector;
        const cx = toX(world.WorldX ?? 0), cy = toY(world.WorldY ?? 0);
        const color = isOrigin ? "#c9a24a" : zoneColor(world.Zone);
        return `
          <g class="tt-map-world ${isOrigin ? "tt-map-origin" : ""}"
             data-tt-map-world
             data-name="${esc(world.Name || "(unnamed)")}"
             data-sector="${esc(world.Sector || "")}"
             data-hex="${esc(world.Hex || "")}"
             data-uwp="${esc(world.UWP || "")}"
             data-remarks="${esc(world.Remarks || "")}">
            <circle cx="${cx}" cy="${cy}" r="7" fill="${color}" stroke="#0b0f17" stroke-width="1.5"></circle>
            <text x="${cx}" y="${cy + 18}" text-anchor="middle">${esc(world.Name || "")}${isOrigin ? " (current)" : ""}</text>
          </g>`;
      }).join("");
      bodyHtml = `
        <svg class="tt-map-svg" viewBox="0 0 ${w} ${h}" data-tt-map-svg>${dots}</svg>
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
