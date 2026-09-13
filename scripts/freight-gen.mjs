import { rollD6, roll2D6, worldPopulation, worldStarport, worldTechLevel, hexDistance, fetchWorldInfo } from "./travel-roll-utils.mjs";

// Number of D6 to roll (then sum) for the actual lot count, keyed by the
// final modified 2D6 roll — this is a DIFFERENT table from the passenger
// traffic one in passenger-gen.mjs (they diverge at several rolls), so it's
// kept entirely separate rather than shared.
const DICE_BY_ROLL = { 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 4, 10: 4, 11: 4, 12: 5, 13: 5, 14: 5, 15: 6, 16: 6, 17: 7, 18: 8, 19: 9 };
function diceCountForRoll(roll) {
  if (roll <= 1) return 0;
  if (roll >= 20) return 10;
  return DICE_BY_ROLL[roll] ?? 0;
}

function populationModifier(pop) {
  if (pop === null) return 0;
  if (pop <= 1) return -4;
  if (pop >= 8) return 4;
  if (pop >= 6) return 2;
  return 0;
}

function starportModifier(sp) {
  if (sp === "A") return 2;
  if (sp === "B") return 1;
  if (sp === "E") return -1;
  if (sp === "X") return -3;
  return 0;
}

function techLevelModifier(tl) {
  if (tl === null) return 0;
  if (tl <= 6) return -1;
  if (tl >= 9) return 2;
  return 0;
}

function zoneModifier(zone) {
  if (zone === "A") return -2;
  if (zone === "R") return -6;
  return 0;
}

// Each lot's own size, in tons, once its category's lot count is known.
export const LOT_SIZES = {
  major: { label: "Major Cargo", dieMultiplier: 10 },
  minor: { label: "Minor Cargo", dieMultiplier: 5 },
  incidental: { label: "Incidental Cargo", dieMultiplier: 1 }
};
const LOT_ROLL_ORDER = ["major", "minor", "incidental"];

// Cr per ton, by parsecs travelled (single jump) — the standard Mongoose
// Traveller 2e freight rate table.
const FREIGHT_RATE_BY_PARSEC = { 1: 1000, 2: 1600, 3: 2600, 4: 4400, 5: 8500, 6: 32000 };
export function freightRatePerTon(parsecs) {
  const p = Math.max(1, Math.min(6, Math.round(parsecs) || 1));
  return FREIGHT_RATE_BY_PARSEC[p] ?? FREIGHT_RATE_BY_PARSEC[6];
}

// Rolls how many lots of one size category are on offer. `skills` is the
// ship's skills object ({broker, streetwise, ...} — Carouse doesn't apply
// to freight brokering, unlike the passenger roll); the rest mirror
// passenger-gen.mjs's rollCategory.
function rollLotCount(sizeId, { skills, originUwp, destUwp, originZone, destZone, distanceParsecs }) {
  let roll = roll2D6();
  if (sizeId === "major") roll -= 4;
  if (sizeId === "incidental") roll += 2;

  for (const uwp of [originUwp, destUwp]) {
    roll += populationModifier(worldPopulation(uwp));
    roll += starportModifier(worldStarport(uwp));
    roll += techLevelModifier(worldTechLevel(uwp));
  }
  for (const zone of [originZone, destZone]) roll += zoneModifier(zone);

  if (distanceParsecs > 1) roll -= (distanceParsecs - 1);

  const bestSkill = Math.max(Number(skills?.broker) || 0, Number(skills?.streetwise) || 0);
  const subRoll = roll2D6() + bestSkill;
  if (subRoll > 8) roll += (subRoll - 8);

  const diceCount = diceCountForRoll(roll);
  let lotCount = 0;
  for (let i = 0; i < diceCount; i++) lotCount += rollD6();
  return { roll, diceCount, lotCount };
}

// Resolves both worlds, computes distance, rolls how many lots of each size
// are available, then rolls each individual lot's own tonnage. Throws if
// either world can't be found on Traveller Map.
export async function generateFreight({ skills, originSector, originHex, destSector, destHex }) {
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
  const ratePerTon = freightRatePerTon(distanceParsecs);

  const results = {};
  for (const sizeId of LOT_ROLL_ORDER) {
    const { roll, diceCount, lotCount } = rollLotCount(sizeId, context);
    const multiplier = LOT_SIZES[sizeId].dieMultiplier;
    const lots = [];
    for (let i = 0; i < lotCount; i++) lots.push(rollD6() * multiplier);
    results[sizeId] = { roll, diceCount, lotCount, lots };
  }

  return { origin, destination, distanceParsecs, ratePerTon, results };
}
