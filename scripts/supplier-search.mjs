import { gameDayIndex, getShipDocs, getShipData, saveShipData } from "./data.mjs";
import {
  rollD6, generateMarket, rollPriceOffer, rollLocalBrokerSkill, worldTradeCodes, goodByName
} from "./trade-data.mjs";
import { logDebugBlock, fmtTonsRoll, fmtPriceOffer, fmtRerolls } from "./debug-log.mjs";

// A "search" is either for a CONTACT (a supplier when buying, a buyer when
// selling) or for a local BROKER/fixer to hire for negotiations — both use
// the exact same core-rules "Find a Supplier" procedure (this module's own
// house-rule extension applies it to broker-hunting too). Persisted on the
// ship itself (ship.supplierSearches[mode][kind]), not the app instance, so
// a search survives the window closing and resolves even if nobody has it
// open when the in-game clock catches up — see resolveDueSearches below.

export function worldKeyFor(world) { return `${world?.Sector || ""}|${world?.Hex || ""}`; }

function monthKeyFor(dayIndex) { return Math.floor(dayIndex / 30); }

// The DM-1-per-previous-attempt-this-month penalty, as a negative number
// (or 0) ready to add to the DMs shown in the search dialog.
export function attemptDM(ship, worldKey) {
  const dayIndex = gameDayIndex();
  if (dayIndex === null) return 0;
  const count = ship.supplierAttempts?.[worldKey]?.[monthKeyFor(dayIndex)] || 0;
  return -count;
}

function recordAttempt(ship, worldKey) {
  const dayIndex = gameDayIndex();
  if (dayIndex === null) return;
  ship.supplierAttempts = ship.supplierAttempts || {};
  ship.supplierAttempts[worldKey] = ship.supplierAttempts[worldKey] || {};
  const mk = monthKeyFor(dayIndex);
  ship.supplierAttempts[worldKey][mk] = (ship.supplierAttempts[worldKey][mk] || 0) + 1;
}

// How long the search takes: 1D days for a Broker/Streetwise search, 1D
// hours for an Online (Admin) search, or — rushed, regardless of check type
// — 1D6 x 10 hours (house rule per the user). The campaign clock only
// tracks whole days, so hours are rounded to the nearest day (often 0,
// i.e. resolves the same day).
export function rollSearchWait({ checkType, rushed }) {
  if (rushed) {
    const roll = rollD6();
    const hours = roll * 10;
    return { unit: "hours", rolls: [roll], rawHours: hours, waitDays: Math.round(hours / 24) };
  }
  if (checkType === "online") {
    const roll = rollD6();
    return { unit: "hours", rolls: [roll], rawHours: roll, waitDays: Math.round(roll / 24) };
  }
  const roll = rollD6();
  return { unit: "days", rolls: [roll], rawHours: roll * 24, waitDays: roll };
}

// Shared by both auto-rolled cases below: 2D6 + a known skill + the usual
// Starport/prior-attempt DMs, minus 2 if rushed.
function rollAutoCheck({ skill, starportDM, priorAttemptDM, rushed }) {
  const dice = [rollD6(), rollD6()];
  const diceSum = dice[0] + dice[1];
  const total = diceSum + skill + starportDM + priorAttemptDM - (rushed ? 2 : 0);
  return { dice, diceSum, skill, total };
}

// Starts a new search of `kind` ("contact" | "broker") for `mode` ("buy" |
// "sell") on `ship`, mutating it in place (caller saves).
//
// Finding a supplier/buyer (CONTACT) and finding a local broker/fixer
// (BROKER) are both the Traveller's own check — the core rules literally
// call this "Finding a Supplier or Broker" as one and the same procedure.
// `playerResult` is that already-DM-adjusted roll total, taken at face
// value — this module only tells the player what DMs SHOULD apply (via
// attemptDM/starportSearchDM, read by the caller before showing the
// dialog), it never does the arithmetic for them. The found broker's OWN
// skill (2D/3) is only rolled afterward, in finalizeSearch, once you
// actually know you found one — it has no bearing on whether the search
// itself succeeds.
//
// The ONE exception: a CONTACT search can be handed to an ALREADY-hired
// local broker instead — pass their known skill as `brokerSkill` and this
// auto-rolls against it (no player check at all, since they're the one
// doing the legwork now). `playerResult` is ignored whenever `brokerSkill`
// is given. This never applies to a BROKER search itself — you always
// roll your own check to find a broker in the first place.
//
// Returns the created record.
export function startSearch(ship, mode, kind, { checkType, blackMarket, rushed, playerResult, brokerSkill, world, starportDM, priorAttemptDM }) {
  const worldKey = worldKeyFor(world);
  const wait = rollSearchWait({ checkType, rushed });
  const startedDayIndex = gameDayIndex() ?? 0;

  let success, autoRoll = null;
  if (kind === "contact" && brokerSkill != null) {
    autoRoll = rollAutoCheck({ skill: brokerSkill, starportDM, priorAttemptDM, rushed });
    success = autoRoll.total >= 8;
  } else {
    success = Number(playerResult) >= 8;
  }

  const record = {
    kind, checkType, blackMarket: !!blackMarket, rushed: !!rushed,
    playerResult: autoRoll ? null : Number(playerResult), autoRoll, success,
    viaBroker: autoRoll != null,
    starportDM, priorAttemptDM,
    worldKey,
    world: { Name: world?.Name || "", Sector: world?.Sector || "", Hex: world?.Hex || "", UWP: world?.UWP || "", Remarks: world?.Remarks || "", Zone: world?.Zone || "" },
    startedDayIndex, waitDays: wait.waitDays, waitRolls: wait.rolls, waitUnit: wait.unit, rawHours: wait.rawHours,
    resolveDayIndex: startedDayIndex + wait.waitDays,
    status: "searching", resolved: false,
    market: null, priceOffers: null, // contact/buy
    worldCodes: null,                // contact/sell
    broker: null                     // broker (rolled and revealed only on success — see finalizeSearch)
  };
  ship.supplierSearches = ship.supplierSearches || {};
  ship.supplierSearches[mode] = ship.supplierSearches[mode] || {};
  ship.supplierSearches[mode][kind] = record;
  recordAttempt(ship, worldKey);
  return record;
}

// Finalizes a search whose wait has elapsed: on success, rolls the market
// and baseline (no-broker, counterpart 2) price offers for a contact
// search, or the broker/fixer's own 2D/3 skill for a broker search; marks
// resolved either way. `ship`/`mode` are needed for a "sell" contact search
// (offers are rolled against the ship's own current cargo, not a random
// market). Mutates `record` in place.
export function finalizeSearch(record, ship, mode) {
  const purpose = record.kind === "contact" ? (mode === "buy" ? "supplier" : "buyer") : (record.blackMarket ? "fixer" : "local broker");
  const logLines = [`Result: ${record.success ? "SUCCESS" : "FAILURE"} (${record.autoRoll ? `auto-roll ${record.autoRoll.total}` : `player-reported ${record.playerResult}`} vs 8+)`];
  if (record.kind === "contact" && record.viaBroker) {
    logLines.push(`Handled by the local broker (skill ${record.autoRoll.skill}) instead of a player check: 2D6=[${record.autoRoll.dice.join("+")}]=${record.autoRoll.diceSum} + skill ${record.autoRoll.skill} + starport ${record.starportDM >= 0 ? "+" : ""}${record.starportDM} + prior attempts ${record.priorAttemptDM}${record.rushed ? " - 2 (rushed)" : ""} = ${record.autoRoll.total}`);
  }

  if (record.kind === "contact") {
    if (record.success) {
      if (mode === "buy") {
        const market = generateMarket(record.world, { blackMarket: record.blackMarket });
        record.market = {
          codes: Array.from(market.codes), pop: market.pop, popMod: market.popMod,
          entries: market.entries.map(e => ({ goodName: e.good.name, source: e.source, availableTons: e.availableTons, tonsRolls: e.tonsRolls })),
          rollLog: market.rollLog
        };
        const offers = {};
        for (const entry of market.entries) {
          offers[entry.good.name] = rollPriceOffer({ mode: "purchase", good: entry.good, worldCodes: market.codes, brokerSkill: 0, brokerBonus: 0, counterpartSkill: 2 });
        }
        record.priceOffers = offers;

        logLines.push(`Population ${market.pop ?? "?"} -> quantity DM ${market.popMod >= 0 ? "+" : ""}${market.popMod}`);
        for (const r of market.rollLog) {
          if (r.note) { logLines.push(`${r.note}`); logLines.push(...fmtRerolls(r.rerolls)); }
          else { logLines.push(`Good "${r.good}" (${r.source}):`); logLines.push(fmtTonsRoll("tons", r.tonsRoll)); }
        }
        for (const [name, offer] of Object.entries(offers)) { logLines.push(`Baseline offer "${name}":`); logLines.push(...fmtPriceOffer(offer)); }
      } else {
        const codes = worldTradeCodes(record.world);
        record.worldCodes = Array.from(codes);
        const seen = new Set();
        const offers = {};
        for (const row of (ship.cargo || [])) {
          const good = goodByName(row.itemName);
          if (!good || !good.price || seen.has(good.name)) continue;
          seen.add(good.name);
          offers[good.name] = rollPriceOffer({ mode: "sale", good, worldCodes: codes, brokerSkill: 0, brokerBonus: 0, counterpartSkill: 2 });
        }
        record.priceOffers = offers;
        for (const [name, offer] of Object.entries(offers)) { logLines.push(`Baseline offer "${name}":`); logLines.push(...fmtPriceOffer(offer)); }
      }
    }
  } else if (record.success) {
    // Found — NOW roll the broker/fixer's own 2D/3 skill (their
    // competence has no bearing on whether they were found at all, only
    // on how useful they are once hired).
    const roll = rollLocalBrokerSkill();
    record.broker = { ...roll, doubleCrosser: record.blackMarket && roll.dice[0] === 1 && roll.dice[1] === 1 };
    logLines.push(`Broker/fixer skill: 2D6=[${roll.dice.join("+")}]=${roll.sum} /3 = ${roll.skill}${record.broker.doubleCrosser ? " (natural 2 — possible double-crosser)" : ""}`);
  }
  record.status = record.success ? "found" : "failed";
  record.resolved = true;
  logDebugBlock(`Search resolved: ${purpose} at ${record.world.Name} (${mode})`, logLines);
}

// Bumped whenever the search mechanic itself changes in a way that makes
// old persisted records meaningless or misleading under the new rules
// (e.g. this version: "find a broker" reverted from an always-auto-rolled
// check back to the Traveller's own roll) — migrateSupplierSearches below
// wipes ship.supplierSearches once per ship when it sees an older stamp,
// so nobody's window shows a supplier/broker "found" (or "searching") via
// the old, now-incorrect mechanic.
const SEARCH_SCHEMA_VERSION = 2;

// Clears every ship's in-progress/found supplier, buyer, and local broker
// search state (but NOT the separate "previous attempts this month" DM
// tracking, which is still valid) if it was written under an older search
// schema. GM-only; call once at ready and let it no-op on every later
// call once every ship is stamped current. Returns true if anything
// changed (caller may want to know, though nothing currently uses it).
export async function migrateSupplierSearches() {
  if (!game.user.isGM) return false;
  let changed = false;
  for (const doc of getShipDocs()) {
    const ship = getShipData(doc);
    if ((ship.supplierSearchSchemaVersion || 0) >= SEARCH_SCHEMA_VERSION) continue;
    ship.supplierSearches = {};
    ship.supplierSearchSchemaVersion = SEARCH_SCHEMA_VERSION;
    await saveShipData(doc, ship);
    changed = true;
  }
  return changed;
}

// Sweeps every ship for due, unresolved searches and finalizes them —
// GM-only (writes ship data; run from a periodic/date-change check, not
// per-render). Returns what was resolved so the caller can announce it and
// refresh any open windows.
export async function resolveDueSearches() {
  if (!game.user.isGM) return [];
  const nowIdx = gameDayIndex();
  if (nowIdx === null) return [];
  const resolved = [];
  for (const doc of getShipDocs()) {
    const ship = getShipData(doc);
    const searches = ship.supplierSearches;
    if (!searches) continue;
    let changed = false;
    for (const mode of ["buy", "sell"]) {
      for (const kind of ["contact", "broker"]) {
        const record = searches[mode]?.[kind];
        if (!record || record.resolved || record.status !== "searching") continue;
        if (record.resolveDayIndex > nowIdx) continue;
        finalizeSearch(record, ship, mode);
        changed = true;
        resolved.push({ doc, mode, kind, record });
      }
    }
    if (changed) await saveShipData(doc, ship);
  }
  return resolved;
}
