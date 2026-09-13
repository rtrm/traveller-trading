import { fetchJumpWorlds } from "./destination-map.mjs";

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------
function rollD6() { return 1 + Math.floor(Math.random() * 6); }
function roll2D6() { return rollD6() + rollD6(); }

// Number of D6 to roll (then sum) for the actual passenger count, keyed by
// the final modified 2D6 roll — the standard Mongoose Traveller 2e
// passenger traffic table.
const DICE_BY_ROLL = { 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 3, 11: 4, 12: 4, 13: 4, 14: 5, 15: 5, 16: 6, 17: 7, 18: 8, 19: 9 };
function diceCountForRoll(roll) {
  if (roll <= 1) return 0;
  if (roll >= 20) return 10;
  return DICE_BY_ROLL[roll] ?? 0;
}

// ---------------------------------------------------------------------------
// UWP parsing. A UWP is Starport + 6 digits (Size, Atmosphere, Hydrographics,
// Population, Government, Law Level) + "-" + Tech Level, e.g. "A788899-C" —
// Population is therefore the 5th character once the hyphen is removed.
// Extended hex digit: 0-9, then A=10, B=11, ...
// ---------------------------------------------------------------------------
function parseHexDigit(ch) {
  if (!ch) return null;
  if (/[0-9]/.test(ch)) return Number(ch);
  const n = ch.toUpperCase().charCodeAt(0) - 55; // 'A' (65) -> 10
  return Number.isFinite(n) && n >= 10 ? n : null;
}

function worldPopulation(uwp) {
  const clean = (uwp || "").replace(/[^A-Za-z0-9]/g, "");
  return clean.length >= 5 ? parseHexDigit(clean[4]) : null;
}

function worldStarport(uwp) {
  return (uwp || "").trim().charAt(0).toUpperCase() || null;
}

function populationModifier(pop) {
  if (pop === null) return 0;
  if (pop <= 1) return -4;
  if (pop >= 8) return 3;
  if (pop >= 6) return 1;
  return 0;
}

function starportModifier(sp) {
  if (sp === "A") return 2;
  if (sp === "B") return 1;
  if (sp === "E") return -1;
  if (sp === "X") return -3;
  return 0;
}

function zoneModifier(zone) {
  if (zone === "A") return 1;
  if (zone === "R") return -4;
  return 0;
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

// ---------------------------------------------------------------------------
// Passenger generation
// ---------------------------------------------------------------------------
const PASSENGER_ROLL_ORDER = ["high", "middle", "basic", "low"];

// Fetches full world data (UWP, Zone, WorldX/WorldY) for one sector/hex via
// the same /api/jumpworlds endpoint the jump map uses, jump=0 for a
// single-system lookup.
export async function fetchWorldInfo(sector, hex) {
  const worlds = await fetchJumpWorlds(sector, hex, 0);
  return worlds[0] || null;
}

// Rolls the number of available passengers for one category. `skills` is
// the ship's skills object ({steward, broker, carouse, streetwise, ...});
// `originUwp`/`destUwp` and `originZone`/`destZone` come from the two
// resolved worlds; `distanceParsecs` is their hex distance.
function rollCategory(category, { skills, originUwp, destUwp, originZone, destZone, distanceParsecs }) {
  let roll = roll2D6();
  roll += Number(skills?.steward) || 0;
  if (category === "high") roll -= 4;
  if (category === "low") roll += 1;

  for (const uwp of [originUwp, destUwp]) {
    roll += populationModifier(worldPopulation(uwp));
    roll += starportModifier(worldStarport(uwp));
  }
  for (const zone of [originZone, destZone]) roll += zoneModifier(zone);

  if (distanceParsecs > 1) roll -= (distanceParsecs - 1);

  const bestSkill = Math.max(Number(skills?.broker) || 0, Number(skills?.carouse) || 0, Number(skills?.streetwise) || 0);
  const subRoll = roll2D6() + bestSkill;
  if (subRoll > 8) roll += (subRoll - 8);

  const diceCount = diceCountForRoll(roll);
  let count = 0;
  for (let i = 0; i < diceCount; i++) count += rollD6();
  return { roll, diceCount, count };
}

// Resolves both worlds, computes distance, and rolls all four passenger
// categories. Throws if either world can't be found on Traveller Map.
export async function generatePassengers({ skills, originSector, originHex, destSector, destHex }) {
  const [origin, destination] = await Promise.all([
    fetchWorldInfo(originSector, originHex),
    fetchWorldInfo(destSector, destHex)
  ]);
  if (!origin) throw new Error(`Couldn't find ${originSector} ${originHex} on Traveller Map.`);
  if (!destination) throw new Error(`Couldn't find ${destSector} ${destHex} on Traveller Map.`);

  const distanceParsecs = hexDistance(origin, destination);
  const context = {
    skills,
    originUwp: origin.UWP, destUwp: destination.UWP,
    originZone: origin.Zone, destZone: destination.Zone,
    distanceParsecs
  };

  const results = {};
  for (const category of PASSENGER_ROLL_ORDER) results[category] = rollCategory(category, context);

  return { origin, destination, distanceParsecs, results };
}
