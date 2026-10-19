import { buildWorldGrid, parseWorldSize } from "./world-map-grid.mjs";
import { TERRAIN_STYLES } from "./world-map-terrain.mjs";

export const MAP_FORMAT = "traveller-trading-world-map";
export const MAP_VERSION = 1;
export const MAX_MAP_BYTES = 5 * 1024 * 1024;

export function serializeWorldMap(grid, worldName = "World") {
  const terrain = Boolean(grid.terrainStyles);
  return {
    format: MAP_FORMAT, version: MAP_VERSION, geometryVersion: 1,
    worldName: String(worldName), size: grid.size, hexScaleKm: 1000,
    kind: terrain ? "surface" : "blank",
    uwp: grid.uwp ? { ...grid.uwp } : null,
    cells: grid.cells.map(cell => ({
      id: cell.id, terrain: terrain ? cell.terrain : null,
      surface: terrain ? cell.surface ?? null : null
    }))
  };
}

// Regenerate geometry from trusted code, never from imported polygons or SVG.
// Only cell identity and terrain state cross the serialization boundary.
export function deserializeWorldMap(input) {
  let data = input;
  if (typeof input === "string") {
    if (input.length > MAX_MAP_BYTES) throw new Error("Map data exceeds the 5 MB limit.");
    try { data = JSON.parse(input.replace(/^\uFEFF/, "")); }
    catch { throw new Error("The selected file is not valid map JSON."); }
  }
  if (!data || data.format !== MAP_FORMAT) throw new Error("This is not a Traveller Trading map-data file.");
  if (data.version !== MAP_VERSION || data.geometryVersion !== 1) throw new Error("Unsupported map-data version. Update Traveller Trading before importing this file.");
  if (typeof data.size !== "number" || parseWorldSize(data.size) === 0) throw new Error("Map size must describe a non-zero world.");
  if (data.hexScaleKm !== 1000) throw new Error("Only 1,000 km world hexes are supported.");
  if (!["blank", "surface"].includes(data.kind)) throw new Error("Unknown map kind.");
  if (typeof data.worldName !== "string" || data.worldName.length > 1000) throw new Error("Invalid world name in map data.");
  const grid = buildWorldGrid(data.size);
  if (!Array.isArray(data.cells) || data.cells.length !== grid.cells.length) throw new Error("Map cell count does not match its world size.");
  const byId = new Map(grid.cells.map(cell => [cell.id, cell]));
  const seen = new Set();
  for (const record of data.cells) {
    if (!record || !byId.has(record.id) || seen.has(record.id)) throw new Error("Map contains duplicate or unknown cell identities.");
    seen.add(record.id);
    const cell = byId.get(record.id);
    if (data.kind === "blank") {
      if (record.terrain !== null || record.surface !== null) throw new Error("Blank maps cannot contain terrain.");
      continue;
    }
    if (!Object.hasOwn(TERRAIN_STYLES, record.terrain)) throw new Error("Map contains an unknown terrain type.");
    if (!["water", "land", null].includes(record.surface) ||
      (record.terrain === "ocean" && record.surface !== "water") ||
      (record.terrain !== "ocean" && record.terrain !== "ice" && record.surface !== "land")) {
      throw new Error("Map contains an invalid land/liquid classification.");
    }
    cell.terrain = record.terrain;
    cell.surface = record.surface;
  }
  if (data.kind === "surface") grid.terrainStyles = TERRAIN_STYLES;
  if (data.uwp !== null) {
    const a = data.uwp?.atmosphere, h = data.uwp?.hydrographics;
    if (!Number.isInteger(a) || a < 0 || a > 15 || !Number.isInteger(h) || h < 0 || h > 10) throw new Error("Invalid UWP metadata.");
    grid.uwp = { atmosphere: a, hydrographics: h };
  }
  // Return a clean copy, excluding unrecognized properties and input objects.
  return { grid, data: serializeWorldMap(grid, data.worldName) };
}

export function embedWorldMapData(svg, data) {
  const json = JSON.stringify(data).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return svg.replace("</svg>", `<metadata id="tt-world-map-data">${json}</metadata></svg>`);
}

// Backward compatibility for maps generated before JSON metadata existed.
// Old SVGs already carry canonical cell IDs and palette colors. Recover the
// visible terrain exactly; legacy polar ice has unknown land/liquid state.
export function recoverWorldMapData(polygons, worldName) {
  const records = new Map();
  const palette = new Map(Object.entries(TERRAIN_STYLES).map(([key, style]) => [style.color.toLowerCase(), key]));
  for (const { id, fill } of polygons) {
    const color = (fill || "white").toLowerCase();
    const terrain = ["white", "#fff", "#ffffff"].includes(color) ? null : palette.get(color);
    if (terrain === undefined) throw new Error("The existing image does not contain recoverable Traveller Trading terrain.");
    if (records.has(id) && records.get(id).terrain !== terrain) throw new Error("Existing map has inconsistent shared-cell colors.");
    records.set(id, { id, terrain, surface: terrain === null || terrain === "ice" ? null : terrain === "ocean" ? "water" : "land" });
  }
  const size = Math.sqrt((records.size - 2) / 10);
  if (!Number.isInteger(size) || size < 1) throw new Error("No recoverable map data. Only maps generated by Traveller Trading can be exported as JSON.");
  const kind = [...records.values()].every(cell => cell.terrain === null) ? "blank" : "surface";
  return deserializeWorldMap({ format: MAP_FORMAT, version: MAP_VERSION, geometryVersion: 1,
    worldName, size, hexScaleKm: 1000, kind, uwp: null, cells: [...records.values()] }).data;
}
