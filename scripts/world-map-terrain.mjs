import { parseWorldSize } from "./world-map-grid.mjs";

// Illustrative terrain, not a full T5 climate simulation. The UWP determines
// water coverage and broad environmental suitability; it does not specify
// temperature, axial tilt, seasons or the chemical composition of oceans.
export const TERRAIN_STYLES = Object.freeze({
  ocean: { label: "Ocean / surface liquid", color: "#317ba3" },
  ice: { label: "Polar ice", color: "#e2eff4" },
  tundra: { label: "Tundra", color: "#a7b8a0" },
  plains: { label: "Plains", color: "#b3c679" },
  forest: { label: "Forest", color: "#56844a" },
  desert: { label: "Desert", color: "#dfc48b" },
  hills: { label: "Hills", color: "#b29c76" },
  mountains: { label: "Mountains", color: "#837c70" },
  barren: { label: "Barren", color: "#aaa69f" },
  wasteland: { label: "Wasteland", color: "#b2a871" },
  clear: { label: "Clear", color: "#cbd6a0" },
  marsh: { label: "Marsh", color: "#9ebdaa" },
  rough: { label: "Rough", color: "#b5ae8f" },
  swamp: { label: "Swamp", color: "#719889" },
  roughWood: { label: "Rough woods", color: "#6f8057" },
  chasm: { label: "Chasm", color: "#665f59" },
  cropland: { label: "Cropland", color: "#d9d581" },
  rural: { label: "Rural", color: "#b5cf8a" },
  islands: { label: "Islands", color: "#6ba69e" },
  shore: { label: "Shore", color: "#afd3c6" },
  river: { label: "River", color: "#5d9fc1" },
  lake: { label: "Lake", color: "#5791b7" },
  baked: { label: "Baked lands", color: "#c98e65" },
  twilight: { label: "Twilight", color: "#b4a8c5" },
  frozen: { label: "Frozen lands", color: "#c2d7dc" },
  iceField: { label: "Ice field", color: "#b9dce9" },
  precipice: { label: "Precipice", color: "#9a847a" },
  exotic: { label: "Exotic", color: "#ad97bb" }
});

function uwpValue(value, label, maximum) {
  let result;
  try { result = parseWorldSize(value); } catch { /* use field-specific error below */ }
  if (result === undefined || result > maximum) throw new Error(`Invalid UWP ${label}; expected 0–${maximum}.`);
  return result;
}

// Claim connected patches on the globe graph. Drawing coordinates are never
// used for adjacency, so regions grow across cut edges just as across any face.
function grow(cells, byId, count, seeds, eligible, claim, random) {
  if (!count) return;
  const available = cells.filter(eligible);
  const frontier = [];
  let claimed = 0;
  const pick = list => Math.floor(random() * list.length);
  const add = cell => { claim(cell); frontier.push(cell); claimed++; };
  for (let i = 0; i < Math.min(seeds, count) && available.length; i++) {
    add(available.splice(pick(available), 1)[0]);
  }
  while (claimed < count) {
    if (!frontier.length) {
      // Other terrain can partition eligible land into separate islands.
      const remaining = cells.filter(eligible);
      if (!remaining.length) break;
      add(remaining[pick(remaining)]);
      continue;
    }
    const index = pick(frontier);
    const neighbors = [...frontier[index].neighbors].map(id => byId.get(id)).filter(eligible);
    if (!neighbors.length) { frontier.splice(index, 1); continue; }
    add(neighbors[pick(neighbors)]);
  }
}

export function generateWorldTerrain(grid, uwp, { random = Math.random } = {}) {
  if (!grid) throw new Error("A size-zero world has no globe surface map.");
  const atmosphere = uwpValue(uwp?.atmosphere, "atmosphere", 15);
  const hydrographics = uwpValue(uwp?.hydrographics, "hydrographics", 10);
  const cells = grid.cells;
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  for (const cell of cells) { cell.surface = "land"; cell.terrain = null; }

  const targetWater = Math.round(cells.length * hydrographics / 10);
  grow(cells, byId, targetWater, Math.max(1, Math.round(grid.size / 2)),
    cell => cell.surface === "land", cell => { cell.surface = "water"; cell.terrain = "ocean"; }, random);

  const temperate = (atmosphere >= 4 && atmosphere <= 9) || atmosphere === 13 || atmosphere === 14;
  // Modest illustrative polar caps on wet, temperate worlds only. Keep the
  // water/land classification: ice does not silently change UWP coverage.
  if (temperate && hydrographics > 0) {
    for (const cell of cells) {
      if (cell.latitude < 0.07 || cell.latitude > 0.93) cell.terrain = "ice";
    }
  }
  const iceNeighbors = new Set(cells.filter(cell => cell.terrain === "ice").flatMap(cell => [...cell.neighbors]));
  for (const cell of cells) {
    if (cell.terrain) continue;
    if (!temperate) {
      cell.terrain = atmosphere <= 1 ? "barren" : atmosphere <= 3 ? "desert" : "wasteland";
    } else if (iceNeighbors.has(cell.id)) cell.terrain = "tundra";
    else cell.terrain = hydrographics === 0 ? "desert" : "plains";
  }
  if (temperate && hydrographics > 0) {
    const forestCandidates = cells.filter(cell => cell.terrain === "plains");
    grow(cells, byId, Math.round(forestCandidates.length * 0.32), Math.max(1, Math.round(grid.size / 3)),
      cell => cell.terrain === "plains", cell => { cell.terrain = "forest"; }, random);
    // Smaller arid regions inland, avoiding wet coastal cells.
    const inland = cell => cell.terrain === "plains" &&
      ![...cell.neighbors].some(id => byId.get(id).surface === "water");
    grow(cells, byId, Math.round(cells.filter(inland).length * 0.35), Math.max(1, Math.round(grid.size / 4)),
      inland, cell => { cell.terrain = "desert"; }, random);
  }
  const land = cell => cell.surface === "land" && cell.terrain !== "ice";
  const mountainCount = Math.round(cells.filter(land).length * 0.07);
  grow(cells, byId, mountainCount, Math.max(1, Math.round(grid.size / 3)),
    cell => land(cell) && cell.terrain !== "mountains", cell => { cell.terrain = "mountains"; }, random);
  // Hills flank mountain ranges, preserving surface liquid, ice and tundra.
  const ranges = cells.filter(cell => cell.terrain === "mountains");
  for (const mountain of ranges) {
    for (const id of mountain.neighbors) {
      const cell = byId.get(id);
      if (land(cell) && !["mountains", "tundra"].includes(cell.terrain) && random() < 0.5) cell.terrain = "hills";
    }
  }
  grid.terrainStyles = TERRAIN_STYLES;
  grid.uwp = { atmosphere, hydrographics };
  return grid;
}
