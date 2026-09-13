import { fetchJumpWorlds } from "./destination-map.mjs";

// Shared by passenger-gen.mjs and freight-gen.mjs — dice, UWP parsing, and
// hex distance are identical for both; the actual modifier VALUES differ
// between the two (and are deliberately kept local to each file, not here,
// so they can never get cross-contaminated).

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------
export function rollD6() { return 1 + Math.floor(Math.random() * 6); }
export function roll2D6() { return rollD6() + rollD6(); }

// ---------------------------------------------------------------------------
// UWP parsing. A UWP is Starport + 6 digits (Size, Atmosphere, Hydrographics,
// Population, Government, Law Level) + "-" + Tech Level, e.g. "A788899-C" —
// Population is therefore the 5th character and Tech Level the last, once
// the hyphen is removed. Extended hex digit: 0-9, then A=10, B=11, ...
// ---------------------------------------------------------------------------
export function parseHexDigit(ch) {
  if (!ch) return null;
  if (/[0-9]/.test(ch)) return Number(ch);
  const n = ch.toUpperCase().charCodeAt(0) - 55; // 'A' (65) -> 10
  return Number.isFinite(n) && n >= 10 ? n : null;
}

export function worldPopulation(uwp) {
  const clean = (uwp || "").replace(/[^A-Za-z0-9]/g, "");
  return clean.length >= 5 ? parseHexDigit(clean[4]) : null;
}

export function worldStarport(uwp) {
  return (uwp || "").trim().charAt(0).toUpperCase() || null;
}

export function worldTechLevel(uwp) {
  const clean = (uwp || "").replace(/[^A-Za-z0-9]/g, "");
  return clean.length >= 1 ? parseHexDigit(clean[clean.length - 1]) : null;
}

// ---------------------------------------------------------------------------
// Hex distance. WorldX/WorldY (from /api/jumpworlds) are offset hex-grid
// coordinates, not plain Cartesian — same "even columns get a half-row
// offset" convention already verified empirically for the jump map's own
// plotting (see destination-map.mjs's worldToPixel). Converts to cube
// coordinates for an exact hex-step distance, which a Euclidean distance
// on the plotted (x,y) would NOT give.
// ---------------------------------------------------------------------------
function toCube(col, row) {
  const x = col;
  const z = row - (col + (col & 1)) / 2;
  const y = -x - z;
  return { x, y, z };
}

export function hexDistance(worldA, worldB) {
  const a = toCube(worldA.WorldX ?? 0, worldA.WorldY ?? 0);
  const b = toCube(worldB.WorldX ?? 0, worldB.WorldY ?? 0);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

// Fetches full world data (UWP, Zone, WorldX/WorldY) for one sector/hex via
// the same /api/jumpworlds endpoint the jump map uses, jump=0 for a
// single-system lookup.
export async function fetchWorldInfo(sector, hex) {
  const worlds = await fetchJumpWorlds(sector, hex, 0);
  return worlds[0] || null;
}
