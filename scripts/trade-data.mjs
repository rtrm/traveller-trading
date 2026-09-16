import { TRADE_GOODS } from "./constants.mjs";

// Deliberately self-contained (no import from travel-roll-utils.mjs, even
// though the dice/UWP-parsing logic below overlaps it) — travel-roll-utils
// itself depends on destination-map.mjs, which depends on this file for the
// map tooltip's trade-code breakdown; importing back from travel-roll-utils
// here would create a three-file import cycle.
export function rollD6() { return 1 + Math.floor(Math.random() * 6); }

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

// Standard Mongoose Traveller 2e trade-code abbreviations used by both the
// Trade Goods table's Purchase/Sale DM columns and by a world's own trade
// codes (parsed from Traveller Map's Remarks field below). AZ/RZ aren't real
// UWP trade codes — they're synthesized from a world's Travel Zone, which
// the core rules explicitly say "can act as a trade code" for Advanced
// Weapons/Vehicles and the illegal-goods Sale DMs.
export const TRADE_CODES = {
  Ag: "Agricultural", As: "Asteroid", Ba: "Barren", De: "Desert",
  Fl: "Fluid Oceans", Ga: "Garden", Hi: "High Population", Ht: "High Technology",
  Ic: "Ice-Capped", In: "Industrial", Lo: "Low Population", Lt: "Low Technology",
  Na: "Non-Agricultural", Ni: "Non-Industrial", Po: "Poor", Ri: "Rich",
  Va: "Vacuum", Wa: "Water World",
  AZ: "Amber Zone", RZ: "Red Zone"
};

function dm(code, value) { return { code, dm: value }; }

// Full Mongoose Traveller 2e Trade Goods table (core rulebook pp.244-245),
// keyed by name to the same entries already in constants.mjs's TRADE_GOODS
// (base price/illegal flag come from there — single source of truth).
// Freight and Exotics are deliberately excluded: Freight isn't part of the
// D66 table at all, and Exotics (66) is explicitly "a matter for roleplaying
// and adventure" with no fixed price, so it's never offered by the
// automated market below (a 66 roll is always rerolled, per house rule).
export const SPECULATIVE_GOODS_DEF = [
  { d66: 11, name: "Common Electronics", availability: "All", tons: { count: 2, mult: 10 },
    purchaseDM: [dm("In", 2), dm("Ht", 3), dm("Ri", 1)], saleDM: [dm("Ni", 2), dm("Lt", 1), dm("Po", 1)] },
  { d66: 12, name: "Common Industrial Goods", availability: "All", tons: { count: 2, mult: 10 },
    purchaseDM: [dm("Na", 2), dm("In", 5)], saleDM: [dm("Ni", 3), dm("Ag", 2)] },
  { d66: 13, name: "Common Manufactured Goods", availability: "All", tons: { count: 2, mult: 10 },
    purchaseDM: [dm("Na", 2), dm("In", 5)], saleDM: [dm("Ni", 3), dm("Hi", 2)] },
  { d66: 14, name: "Common Raw Materials", availability: "All", tons: { count: 2, mult: 20 },
    purchaseDM: [dm("Ag", 3), dm("Ga", 2)], saleDM: [dm("In", 2), dm("Po", 2)] },
  { d66: 15, name: "Common Consumables", availability: "All", tons: { count: 2, mult: 20 },
    purchaseDM: [dm("Ag", 3), dm("Wa", 2), dm("Ga", 1), dm("As", -4)], saleDM: [dm("As", 1), dm("Fl", 1), dm("Ic", 1), dm("Hi", 1)] },
  { d66: 16, name: "Common Ore", availability: "All", tons: { count: 2, mult: 20 },
    purchaseDM: [dm("As", 4)], saleDM: [dm("In", 3), dm("Ni", 1)] },
  { d66: 21, name: "Advanced Electronics", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("In", 2), dm("Ht", 3)], saleDM: [dm("Ni", 1), dm("Ri", 2), dm("As", 3)] },
  { d66: 22, name: "Advanced Machine Parts", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("In", 2), dm("Ht", 1)], saleDM: [dm("As", 2), dm("Ni", 1)] },
  { d66: 23, name: "Advanced Manufactured Goods", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("In", 1)], saleDM: [dm("Hi", 1), dm("Ri", 2)] },
  { d66: 24, name: "Advanced Weapons", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Ht", 2)], saleDM: [dm("Po", 1), dm("AZ", 2), dm("RZ", 4)] },
  { d66: 25, name: "Advanced Vehicles", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Ht", 2)], saleDM: [dm("As", 2), dm("Ri", 2)] },
  { d66: 26, name: "Biochemicals", availability: ["Ag", "Wa"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Ag", 1), dm("Wa", 2)], saleDM: [dm("In", 2), dm("Po", 2)] },
  { d66: 31, name: "Crystals & Gems", availability: ["As", "De", "Ic"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("As", 2), dm("De", 1), dm("Ic", 1)], saleDM: [dm("In", 3), dm("Ri", 2)] },
  { d66: 32, name: "Cybernetics", availability: ["Ht"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("Ht", 1)], saleDM: [dm("As", 1), dm("Ic", 1), dm("Ri", 2)] },
  { d66: 33, name: "Live Animals", availability: ["Ag", "Ga"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("Ag", 2)], saleDM: [dm("Lo", 3)] },
  { d66: 34, name: "Luxury Consumables", availability: ["Ag", "Ga", "Wa"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("Ag", 2), dm("Wa", 1)], saleDM: [dm("Ri", 2), dm("Hi", 2)] },
  { d66: 35, name: "Luxury Goods", availability: ["Hi"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("Hi", 1)], saleDM: [dm("Ri", 4)] },
  { d66: 36, name: "Medical Supplies", availability: ["Ht", "Hi"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Ht", 2)], saleDM: [dm("In", 2), dm("Po", 1), dm("Ri", 1)] },
  { d66: 41, name: "Petrochemicals", availability: ["De", "Fl", "Ic", "Wa"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("De", 2)], saleDM: [dm("In", 2), dm("Ag", 1), dm("Lt", 2)] },
  { d66: 42, name: "Pharmaceuticals", availability: ["As", "De", "Hi", "Wa"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("As", 2), dm("Hi", 1)], saleDM: [dm("Ri", 2), dm("Lt", 1)] },
  { d66: 43, name: "Polymers", availability: ["In"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("In", 1)], saleDM: [dm("Ri", 2), dm("Ni", 1)] },
  { d66: 44, name: "Precious Metals", availability: ["As", "De", "Ic", "Fl"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("As", 3), dm("De", 1), dm("Ic", 2)], saleDM: [dm("Ri", 3), dm("In", 2), dm("Ht", 1)] },
  { d66: 45, name: "Radioactives", availability: ["As", "De", "Lo"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("As", 2), dm("Lo", 2)], saleDM: [dm("In", 3), dm("Ht", 1), dm("Ni", -2), dm("Ag", -3)] },
  { d66: 46, name: "Robots", availability: ["In"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("In", 1)], saleDM: [dm("Ag", 2), dm("Ht", 1)] },
  { d66: 51, name: "Spices", availability: ["Ga", "De", "Wa"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("De", 2)], saleDM: [dm("Hi", 2), dm("Ri", 3), dm("Po", 3)] },
  { d66: 52, name: "Textiles", availability: ["Ag", "Ni"], tons: { count: 1, mult: 20 },
    purchaseDM: [dm("Ag", 7)], saleDM: [dm("Hi", 3), dm("Na", 2)] },
  { d66: 53, name: "Uncommon Ore", availability: ["As", "Ic"], tons: { count: 1, mult: 20 },
    purchaseDM: [dm("As", 4)], saleDM: [dm("In", 3), dm("Ni", 1)] },
  { d66: 54, name: "Uncommon Raw Materials", availability: ["Ag", "De", "Wa"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("Ag", 2), dm("Wa", 1)], saleDM: [dm("In", 2), dm("Ht", 1)] },
  { d66: 55, name: "Wood", availability: ["Ag", "Ga"], tons: { count: 1, mult: 20 },
    purchaseDM: [dm("Ag", 6)], saleDM: [dm("Ri", 2), dm("In", 1)] },
  { d66: 56, name: "Vehicles", availability: ["In", "Ht"], tons: { count: 1, mult: 10 },
    purchaseDM: [dm("In", 2), dm("Ht", 1)], saleDM: [dm("Ni", 2), dm("Hi", 1)] },
  { d66: 61, name: "Illegal Biochemicals", availability: ["Ag", "Wa"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Wa", 2)], saleDM: [dm("In", 6)] },
  { d66: 62, name: "Illegal Cybernetics", availability: ["Ht"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("Ht", 1)], saleDM: [dm("As", 4), dm("Ic", 4), dm("Ri", 8), dm("AZ", 6), dm("RZ", 6)] },
  { d66: 63, name: "Illegal Drugs", availability: ["As", "De", "Hi", "Wa"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("As", 1), dm("De", 1), dm("Ga", 1), dm("Wa", 1)], saleDM: [dm("Ri", 6), dm("Hi", 6)] },
  { d66: 64, name: "Illegal Luxuries", availability: ["Ag", "Ga", "Wa"], tons: { count: 1, mult: 1 },
    purchaseDM: [dm("Ag", 2), dm("Wa", 1)], saleDM: [dm("Ri", 6), dm("Hi", 4)] },
  { d66: 65, name: "Illegal Weapons", availability: ["In", "Ht"], tons: { count: 1, mult: 5 },
    purchaseDM: [dm("Ht", 2)], saleDM: [dm("Po", 6), dm("AZ", 8), dm("RZ", 10)] },
];

const PRICE_BY_NAME = Object.fromEntries(TRADE_GOODS.map(g => [g.name, g]));

// Merges each definition above with its base price/illegal flag from
// constants.mjs's TRADE_GOODS (already the source Item-creation reads from),
// so the two never drift apart.
export const SPECULATIVE_GOODS = SPECULATIVE_GOODS_DEF.map(def => {
  const base = PRICE_BY_NAME[def.name];
  return { ...def, price: base?.price ?? 0, illegal: !!base?.illegal };
});

export function goodByD66(code) { return SPECULATIVE_GOODS.find(g => g.d66 === code); }
export function goodByName(name) { return SPECULATIVE_GOODS.find(g => g.name === name); }

// Modified Price table (core rulebook p.243) — index 0 is roll "-3 or less",
// index 28 is roll "25+"; everything in between is 1:1 with the roll.
const MODIFIED_PRICE_TABLE = [
  { purchasePercent: 300, salePercent: 10 },  // -3 or less
  { purchasePercent: 250, salePercent: 20 },  // -2
  { purchasePercent: 200, salePercent: 30 },  // -1
  { purchasePercent: 175, salePercent: 40 },  // 0
  { purchasePercent: 150, salePercent: 45 },  // 1
  { purchasePercent: 135, salePercent: 50 },  // 2
  { purchasePercent: 125, salePercent: 55 },  // 3
  { purchasePercent: 120, salePercent: 60 },  // 4
  { purchasePercent: 115, salePercent: 65 },  // 5
  { purchasePercent: 110, salePercent: 70 },  // 6
  { purchasePercent: 105, salePercent: 75 },  // 7
  { purchasePercent: 100, salePercent: 80 },  // 8
  { purchasePercent: 95, salePercent: 85 },   // 9
  { purchasePercent: 90, salePercent: 90 },   // 10
  { purchasePercent: 85, salePercent: 100 },  // 11
  { purchasePercent: 80, salePercent: 105 },  // 12
  { purchasePercent: 75, salePercent: 110 },  // 13
  { purchasePercent: 70, salePercent: 115 },  // 14
  { purchasePercent: 65, salePercent: 120 },  // 15
  { purchasePercent: 60, salePercent: 125 },  // 16
  { purchasePercent: 55, salePercent: 130 },  // 17
  { purchasePercent: 50, salePercent: 140 },  // 18
  { purchasePercent: 45, salePercent: 150 },  // 19
  { purchasePercent: 40, salePercent: 160 },  // 20
  { purchasePercent: 35, salePercent: 175 },  // 21
  { purchasePercent: 30, salePercent: 200 },  // 22
  { purchasePercent: 25, salePercent: 250 },  // 23
  { purchasePercent: 20, salePercent: 300 },  // 24
  { purchasePercent: 15, salePercent: 400 },  // 25+
];

export function modifiedPriceRow(total) {
  const clamped = Math.max(-3, Math.min(25, Math.round(total)));
  return { roll: clamped, ...MODIFIED_PRICE_TABLE[clamped + 3] };
}

// ---------------------------------------------------------------------------
// World trade codes: parsed from Traveller Map's own Remarks field (which
// already carries the standard 2-letter trade classifications, e.g. "Ag Ri
// Pa") plus AZ/RZ synthesized from the world's Travel Zone — matching the
// exact same code vocabulary the Purchase/Sale DM columns above use, so a
// world's codes can be checked directly against a good's DM list.
// ---------------------------------------------------------------------------
export function worldTradeCodes(world) {
  const codes = new Set();
  const tokens = (world?.Remarks || "").split(/\s+/);
  const known = Object.keys(TRADE_CODES);
  for (const token of tokens) {
    const match = known.find(k => k.toLowerCase() === token.toLowerCase());
    if (match) codes.add(match);
  }
  if (world?.Zone === "A") codes.add("AZ");
  if (world?.Zone === "R") codes.add("RZ");
  return codes;
}

// ---------------------------------------------------------------------------
// "Find a Supplier" helpers (core rulebook p.241) — the Starport-size bonus
// and the TL8+ gate for an Online search.
// ---------------------------------------------------------------------------
export function worldStarportClass(uwp) {
  return (uwp || "").trim().charAt(0).toUpperCase() || null;
}

export function starportSearchDM(starportClass) {
  if (starportClass === "A") return 6;
  if (starportClass === "B") return 4;
  if (starportClass === "C") return 2;
  return 0;
}

export function worldTechLevelValue(uwp) {
  const tlMatch = /-([A-Za-z0-9]+)\s*$/.exec((uwp || "").trim());
  return tlMatch ? parseHexDigit(tlMatch[1]) : null;
}

// Splits a UWP string into its labeled components (Starport + the six hex
// digits + Tech Level) for display — raw values only, not full canonical
// descriptions (e.g. "Atmosphere 6" rather than "Standard"), which keeps
// this simple while still answering "what does this UWP mean".
const UWP_FIELDS = ["Starport", "Size", "Atmosphere", "Hydrographics", "Population", "Government", "Law Level"];
export function describeUwp(uwp) {
  const clean = (uwp || "").replace(/[^A-Za-z0-9]/g, "");
  if (clean.length < 7) return null;
  const parts = UWP_FIELDS.map((label, i) => ({ label, value: clean[i] || "?" }));
  const tlMatch = /-([A-Za-z0-9]+)\s*$/.exec((uwp || "").trim());
  parts.push({ label: "Tech Level", value: tlMatch ? tlMatch[1] : (clean[7] || "?") });
  return parts;
}

// ---------------------------------------------------------------------------
// Dice/roll helpers for the speculative-trade procedure itself.
// ---------------------------------------------------------------------------

// Rolls D66 against the full goods table. A 66 result (Exotics) is always
// rerolled and left out of the returned rerolls entirely — Exotics has no
// fixed price and isn't offered by this automated market at all, per house
// rule. `illegalOnly` restricts to the 61-65 illegal range (with the tens
// digit fixed at 6, per the core rules' black-market roll); the legal path
// instead rerolls anything landing in that illegal range.
export function rollTradeGood({ illegalOnly = false } = {}) {
  const rerolls = [];
  for (;;) {
    const tens = illegalOnly ? 6 : rollD6();
    const ones = rollD6();
    const code = tens * 10 + ones;
    if (code === 66) { rerolls.push({ code, reason: "66 (Exotics) has no fixed price — reroll" }); continue; }
    if (!illegalOnly && code >= 61 && code <= 65) { rerolls.push({ code, reason: "illegal goods — reroll (legal market)" }); continue; }
    const good = goodByD66(code);
    if (!good) { rerolls.push({ code, reason: "no matching good — reroll" }); continue; }
    return { good, code, tens, ones, rerolls };
  }
}

// Tons available for one good: sum the formula's dice, apply the
// population quantity modifier, floor at zero, then multiply.
export function rollTons(formula, popMod) {
  const rolls = [];
  for (let i = 0; i < formula.count; i++) rolls.push(rollD6());
  const sum = rolls.reduce((a, b) => a + b, 0);
  const modified = sum + popMod;
  const tons = Math.max(0, modified) * formula.mult;
  return { rolls, sum, popMod, modified, mult: formula.mult, tons };
}

export function populationQuantityMod(pop) {
  if (pop === null) return 0;
  if (pop <= 3) return -3;
  if (pop >= 9) return 3;
  return 0;
}

// Local broker/fixer skill per the core rules ("Broker skill of 2D/3" —
// 2D6 divided by 3, rounded down).
export function rollLocalBrokerSkill() {
  const dice = [rollD6(), rollD6()];
  const sum = dice[0] + dice[1];
  return { dice, sum, skill: Math.floor(sum / 3) };
}

// Best (largest) DM from `dmList` whose code the world actually has —
// "In cases where multiple Purchase or Sale DMs apply, use only the largest
// from each column."
export function bestDM(dmList, worldCodes) {
  let best = null;
  for (const entry of dmList) {
    if (worldCodes.has(entry.code) && (!best || entry.dm > best.dm)) best = entry;
  }
  return best;
}

// Generates the market of goods on offer at `world` for buying: all Common
// Goods, every good matching the world's own trade codes, plus one random
// roll per point of the world's Population code (rerolling 66/Exotics, and
// the illegal range unless `blackMarket`). When `blackMarket` is set, also
// adds any Illegal good matching the world's trade codes and one extra
// illegal-range roll (the core rules' black-market fixer roll).
export function generateMarket(world, { blackMarket = false } = {}) {
  const codes = worldTradeCodes(world);
  const pop = worldPopulation(world?.UWP);
  const popMod = populationQuantityMod(pop);
  const entries = [];
  const rollLog = [];

  function addEntry(good, source) {
    const tonsRoll = rollTons(good.tons, popMod);
    rollLog.push({ good: good.name, source, tonsRoll });
    const existing = entries.find(e => e.good.name === good.name);
    if (existing) { existing.availableTons += tonsRoll.tons; existing.tonsRolls.push(tonsRoll); }
    else entries.push({ good, source, availableTons: tonsRoll.tons, tonsRolls: [tonsRoll] });
  }

  for (const good of SPECULATIVE_GOODS) {
    if (!good.illegal && good.availability === "All") addEntry(good, "common");
  }
  for (const good of SPECULATIVE_GOODS) {
    if (!good.illegal && good.availability !== "All" && good.availability.some(c => codes.has(c))) addEntry(good, "trade-code");
  }

  const randomCount = Math.max(0, pop ?? 0);
  for (let i = 0; i < randomCount; i++) {
    const { good, code, rerolls } = rollTradeGood({ illegalOnly: false });
    rollLog.push({ note: `Random good roll #${i + 1} of ${randomCount} (Population ${pop})`, code, rerolls });
    addEntry(good, "random");
  }

  if (blackMarket) {
    for (const good of SPECULATIVE_GOODS) {
      if (good.illegal && good.availability !== "All" && good.availability.some(c => codes.has(c))) addEntry(good, "illegal-trade-code");
    }
    const { good, code, rerolls } = rollTradeGood({ illegalOnly: true });
    rollLog.push({ note: "Black market fixer's extra illegal good roll", code, rerolls });
    addEntry(good, "illegal-random");
  }

  entries.sort((a, b) => a.good.name.localeCompare(b.good.name));
  return { world, codes, pop, popMod, entries, rollLog };
}

// Rolls one purchase or sale price offer for `good` at a world with
// `worldCodes`, per the core rules' 3D6 + Broker - counterpart's Broker +
// DMs procedure. `brokerSkill`/`brokerBonus` are the Traveller's own Broker
// skill (or, if a local broker/fixer was hired, their 2D/3 skill plus the
// DM+2 "local knowledge" bonus); `counterpartSkill` is the supplier's/
// buyer's own Broker skill (assumed 2, but adjustable).
export function rollPriceOffer({ mode, good, worldCodes, brokerSkill = 0, brokerBonus = 0, counterpartSkill = 2 }) {
  const dice = [rollD6(), rollD6(), rollD6()];
  const diceSum = dice[0] + dice[1] + dice[2];
  const favorable = mode === "purchase" ? bestDM(good.purchaseDM, worldCodes) : bestDM(good.saleDM, worldCodes);
  const unfavorable = mode === "purchase" ? bestDM(good.saleDM, worldCodes) : bestDM(good.purchaseDM, worldCodes);
  const total = diceSum + brokerSkill + brokerBonus + (favorable?.dm || 0) - (unfavorable?.dm || 0) - counterpartSkill;
  const row = modifiedPriceRow(total);
  const percent = mode === "purchase" ? row.purchasePercent : row.salePercent;
  const unitPrice = Math.round((good.price || 0) * percent / 100);
  return { mode, dice, diceSum, brokerSkill, brokerBonus, favorable, unfavorable, counterpartSkill, total, rowRoll: row.roll, percent, unitPrice };
}

// A "typical" (not best/worst-case) price band for display before rolling —
// evaluates the same formula at dice sums 6 and 15 (trimming 3D6's extreme
// tails at 3 and 18) rather than showing the true min/max possible.
export function typicalPriceRange({ mode, good, worldCodes, brokerSkill = 0, brokerBonus = 0, counterpartSkill = 2 }) {
  const favorable = mode === "purchase" ? bestDM(good.purchaseDM, worldCodes) : bestDM(good.saleDM, worldCodes);
  const unfavorable = mode === "purchase" ? bestDM(good.saleDM, worldCodes) : bestDM(good.purchaseDM, worldCodes);
  const fixed = brokerSkill + brokerBonus + (favorable?.dm || 0) - (unfavorable?.dm || 0) - counterpartSkill;
  const percents = [6, 15].map(sum => {
    const row = modifiedPriceRow(sum + fixed);
    return mode === "purchase" ? row.purchasePercent : row.salePercent;
  });
  const prices = percents.map(p => Math.round((good.price || 0) * p / 100));
  return { low: Math.min(...prices), high: Math.max(...prices), favorable, unfavorable };
}
