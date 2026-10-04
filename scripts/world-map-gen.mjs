import { MODULE_ID } from "./constants.mjs";
import { esc } from "./window-base.mjs";

// ---------------------------------------------------------------------------
// Procedural world-surface hex map generator for mgt2e World actors.
//
// This is an ORIGINAL implementation, not a port of any third-party tool.
// Its general technique (grow contiguous terrain regions outward from seed
// hexes rather than classifying each hex independently, and bias land
// terrain by coastal/polar adjacency and atmosphere) was informed by reading
// travellermap.com's companion site travellerworlds.com's own publicly-
// served client-side JS (generate.js/world_mapping.js - inspected directly,
// at the user's request, to ground this feature in a real reference rather
// than invent something disconnected from how Traveller world maps actually
// look) to understand ITS general approach - no code, tables, or specific
// values from that site are copied here. The actual terrain palette, hex
// grid math, growth algorithm, and every probability below are this
// module's own design, not a reproduction of anyone else's rules or code.
// ---------------------------------------------------------------------------

const COLS = 17;
const ROWS = 13;
const HEX_RADIUS = 16;

const TERRAIN_STYLES = {
  ocean: { label: "Ocean", color: "#1b4f72" },
  iceCap: { label: "Ice Cap", color: "#eaf6ff" },
  tundra: { label: "Tundra", color: "#9fb8ad" },
  desert: { label: "Desert", color: "#d9b36c" },
  plains: { label: "Plains", color: "#8fbc5a" },
  forest: { label: "Forest", color: "#3f7d35" },
  hills: { label: "Hills", color: "#a98b5d" },
  mountains: { label: "Mountains", color: "#7a6a5f" },
  barren: { label: "Barren", color: "#8c8c8c" },
  wasteland: { label: "Wasteland", color: "#9a9a3c" }
};

// ---------------------------------------------------------------------------
// Hex grid (flat-top, offset columns, no wraparound - a flat projection,
// not a true sphere).
// ---------------------------------------------------------------------------

function buildGrid() {
  const hexes = [];
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      hexes.push({ col, row, terrain: null });
    }
  }
  return hexes;
}

function hexAt(hexes, col, row) {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return hexes[col * ROWS + row];
}

function neighborsOf(hex, hexes) {
  const { col, row } = hex;
  const evenCol = col % 2 === 0;
  const deltas = evenCol
    ? [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]]
    : [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]];
  return deltas.map(([dc, dr]) => hexAt(hexes, col + dc, row + dr)).filter(Boolean);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Grows a terrain region outward from random seed hexes until it reaches
// `targetCount` hexes (or runs out of room to grow into) - this is what
// gives oceans/ice contiguous, plausible shapes instead of per-hex noise.
function growRegion(hexes, targetCount, terrainKey, seedCount) {
  const empty = () => hexes.filter(h => !h.terrain);
  const seeds = [];
  for (let i = 0; i < seedCount; i++) {
    const candidates = empty();
    if (!candidates.length) break;
    const seed = pickRandom(candidates);
    seed.terrain = terrainKey;
    seeds.push(seed);
  }
  let claimed = seeds.length;
  const frontier = [...seeds];
  while (claimed < targetCount && frontier.length) {
    const idx = Math.floor(Math.random() * frontier.length);
    const h = frontier[idx];
    const openNeighbors = neighborsOf(h, hexes).filter(n => !n.terrain);
    if (!openNeighbors.length) { frontier.splice(idx, 1); continue; }
    const pick = pickRandom(openNeighbors);
    pick.terrain = terrainKey;
    frontier.push(pick);
    claimed++;
  }
}

// Scatters a handful of small blobs of `terrainKey` onto already-assigned
// LAND hexes (anything not in `avoidKeys`), overriding whatever land
// terrain they already had - mountains/hills can occur on any land type.
function scatterBlobs(hexes, count, blobSize, terrainKey, avoidKeys) {
  for (let i = 0; i < count; i++) {
    const candidates = hexes.filter(h => h.terrain && !avoidKeys.includes(h.terrain));
    if (!candidates.length) return;
    const seed = pickRandom(candidates);
    seed.terrain = terrainKey;
    let frontierSize = 1;
    let attempts = 0;
    while (frontierSize < blobSize && attempts < blobSize * 4) {
      attempts++;
      const edge = hexes.filter(h => h.terrain === terrainKey);
      const growable = edge.flatMap(h => neighborsOf(h, hexes)).filter(n => n.terrain && !avoidKeys.includes(n.terrain) && n.terrain !== terrainKey);
      if (!growable.length) break;
      pickRandom(growable).terrain = terrainKey;
      frontierSize++;
    }
  }
}

// ---------------------------------------------------------------------------
// Terrain assignment, driven by the world's actual UWP.
// ---------------------------------------------------------------------------

export function generateWorldTerrain({ size, atmosphere, hydrographics }) {
  const hexes = buildGrid();
  const total = hexes.length;

  // Water: hydrographics is literally "percent of surface covered by
  // liquid", so it drives the ocean region's target size directly.
  const targetWater = Math.round(total * (hydrographics / 10));
  if (targetWater > 0) {
    const seedCount = Math.max(1, Math.round(targetWater / 14));
    growRegion(hexes, targetWater, "ocean", seedCount);
  }

  // Polar ice: thinner atmospheres hold less heat, so they get bigger caps.
  // A size-0 world (asteroid belt/tiny) or airless world (atmosphere 0) is
  // frozen almost pole-to-pole; a thick, good atmosphere keeps caps small.
  let iceRows;
  if (size === 0 || atmosphere === 0) iceRows = 4;
  else if (atmosphere <= 3) iceRows = 3;
  else if (atmosphere <= 6) iceRows = 2;
  else if (atmosphere <= 9) iceRows = 1;
  else iceRows = 0;
  if (iceRows > 0) {
    for (const h of hexes) {
      if (h.row < iceRows || h.row >= ROWS - iceRows) h.terrain = "iceCap";
    }
  }

  // Atmosphere's UWP code already distinguishes breathable-ish ranges from
  // hostile ones - 0-3 is none/trace/very-thin, 10+ (A-F) is exotic/
  // corrosive/insidious/unusual. Both ends are treated as surface-hostile
  // here regardless of how much liquid is present, since "hostile
  // atmosphere" says more about surface chemistry than hydrographics does.
  const harsh = atmosphere <= 1 || atmosphere >= 10;
  const marginal = atmosphere === 2 || atmosphere === 3;

  for (const h of hexes) {
    if (h.terrain) continue; // already ocean or ice
    const neighbors = neighborsOf(h, hexes);
    const coastal = neighbors.some(n => n.terrain === "ocean");
    const polarAdjacent = neighbors.some(n => n.terrain === "iceCap");

    if (polarAdjacent) { h.terrain = "tundra"; continue; }
    if (harsh) { h.terrain = hydrographics > 0 ? "wasteland" : "barren"; continue; }
    if (marginal) { h.terrain = Math.random() < 0.7 ? "desert" : "plains"; continue; }
    // Good atmosphere (4-9): coastal land leans forest, inland leans plains,
    // with a plain desert band for whatever's left dry and far from water.
    if (coastal) { h.terrain = Math.random() < 0.65 ? "forest" : "plains"; continue; }
    const r = Math.random();
    h.terrain = r < 0.5 ? "plains" : (r < 0.75 ? "forest" : "desert");
  }

  // Hills scattered lightly everywhere land exists; mountains in a few
  // clusters whose count scales with world Size (bigger world, more room
  // for real mountain ranges).
  scatterBlobs(hexes, Math.round(total * 0.08), 1, "hills", ["ocean", "iceCap"]);
  const mountainClusters = Math.max(0, Math.round(size / 3));
  scatterBlobs(hexes, mountainClusters, 4, "mountains", ["ocean", "iceCap"]);

  return hexes;
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

function hexCenter(col, row) {
  const x = col * HEX_RADIUS * 1.5;
  const y = row * HEX_RADIUS * Math.sqrt(3) + (col % 2 === 1 ? (HEX_RADIUS * Math.sqrt(3)) / 2 : 0);
  return { x, y };
}

export function renderWorldMapSvg(hexes, worldName) {
  const pad = HEX_RADIUS * 2;
  const mapW = COLS * HEX_RADIUS * 1.5 + pad;
  const mapH = ROWS * HEX_RADIUS * Math.sqrt(3) + pad;

  const used = new Set(hexes.map(h => h.terrain));
  const legendEntries = Object.entries(TERRAIN_STYLES).filter(([key]) => used.has(key));
  const legendRowH = 18;
  const legendW = 110;
  const totalW = mapW + legendW;
  const totalH = Math.max(mapH, legendEntries.length * legendRowH + pad);

  const hexesHtml = hexes.map(h => {
    const { x, y } = hexCenter(h.col, h.row);
    const color = TERRAIN_STYLES[h.terrain]?.color || "#444";
    return `<polygon points="${hexPoints(x + pad / 2, y + pad / 2, HEX_RADIUS * 0.98)}" fill="${color}" stroke="#00000033" stroke-width="1"/>`;
  }).join("");

  const legendHtml = legendEntries.map(([key, style], i) => {
    const y = pad / 2 + i * legendRowH;
    return `
      <rect x="${mapW}" y="${y}" width="12" height="12" fill="${style.color}" stroke="#00000055"/>
      <text x="${mapW + 18}" y="${y + 10}" font-size="11" font-family="sans-serif" fill="#222">${esc(style.label)}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW.toFixed(1)} ${totalH.toFixed(1)}" width="${totalW.toFixed(0)}" height="${totalH.toFixed(0)}">
    <rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#f0f4f7"/>
    <title>${esc(worldName || "World")} - procedurally generated surface map</title>
    ${hexesHtml}
    ${legendHtml}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Orchestration: generate from an Actor's own UWP, upload, and save.
// ---------------------------------------------------------------------------

async function ensureUploadDirectory(source, path) {
  try {
    await foundry.applications.apps.FilePicker.implementation.createDirectory(source, path);
  } catch (err) {
    // Already exists - FilePicker throws for that case, which is fine.
  }
}

// Generates a fresh surface map for `actor` (an mgt2e "world" Actor) from
// its own UWP, uploads the SVG into this module's own data folder, and sets
// it as the actor's system.world.map. Returns the uploaded file path.
export async function generateAndSaveWorldMap(actor) {
  if (!game.user.isGM) return null;
  const uwp = actor.system?.world?.uwp;
  if (!uwp) { ui.notifications.warn(`${actor.name} has no UWP to generate a map from.`); return null; }

  const hexes = generateWorldTerrain({
    size: Number(uwp.size) || 0,
    atmosphere: Number(uwp.atmosphere) || 0,
    hydrographics: Number(uwp.hydrographics) || 0
  });
  const svg = renderWorldMapSvg(hexes, actor.name);

  const source = "data";
  const dir = `worlds/${MODULE_ID}/maps`;
  const filename = `${actor.id}.svg`;
  await ensureUploadDirectory(source, dir);

  const file = new File([svg], filename, { type: "image/svg+xml" });
  const result = await foundry.applications.apps.FilePicker.implementation.upload(source, dir, file, {}, { notify: false });
  if (!result?.path) { ui.notifications.error(`Couldn't save the generated map for ${actor.name}.`); return null; }

  await actor.update({ "system.world.map": result.path });
  return result.path;
}

// ---------------------------------------------------------------------------
// Sheet integration: a button next to the Map tab's image on a World actor
// sheet, since that template belongs to the mgt2e system, not this module -
// injected via the standard renderActorSheet hook rather than owning the
// template.
// ---------------------------------------------------------------------------

export function registerWorldMapGenButton() {
  Hooks.on("renderActorSheet", (app, html) => {
    const actor = app.actor || app.document;
    if (!actor || actor.type !== "world") return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const img = root.querySelector('img[data-edit="system.world.map"]');
    if (!img || img.parentElement.querySelector("[data-tt-gen-map]")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.ttGenMap = "1";
    btn.textContent = "Generate / Reroll Surface Map";
    btn.style.cssText = "margin-top:8px;";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!game.user.isGM) { ui.notifications.warn("Only the GM can generate a surface map."); return; }
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        await generateAndSaveWorldMap(actor);
      } finally {
        btn.disabled = false;
        btn.textContent = "Generate / Reroll Surface Map";
      }
    });
    img.insertAdjacentElement("afterend", btn);
  });
}
