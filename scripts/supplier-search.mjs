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
// For a plain CONTACT search (no broker helping), `playerResult` is the
// Traveller's own already-DM-adjusted roll total, taken at face value —
// this module only tells the player what DMs SHOULD apply (via attemptDM/
// starportSearchDM, read by the caller before showing the dialog), it
// never does the arithmetic for them.
//
// For a BROKER search, there's no player check at all: you're not using
// your own skill to find someone else's business, so this rolls the
// prospective broker/fixer's own 2D/3 skill FIRST, then auto-rolls against
// it. The rolled skill is stashed (as `_rolledBrokerSkill`, persisted like
// any other field) so finalizeSearch can reveal it on success without
// rolling a second, different skill.
//
// A CONTACT search can ALSO be handed to an already-hired local broker —
// pass their known skill as `brokerSkill` and this auto-rolls against it
// exactly like a broker search does, just without rolling a fresh skill
// (it's already known). `playerResult` is ignored whenever `brokerSkill`
// is given.
//
// Returns the created record.
export function startSearch(ship, mode, kind, { checkType, blackMarket, rushed, playerResult, brokerSkill, world, starportDM, priorAttemptDM }) {
  const worldKey = worldKeyFor(world);
  const wait = rollSearchWait({ checkType, rushed });
  const startedDayIndex = gameDayIndex() ?? 0;

  let success, autoRoll = null, rolledBrokerSkill = null;
  if (kind === "broker") {
    const skillRoll = rollLocalBrokerSkill();
    rolledBrokerSkill = { ...skillRoll, doubleCrosser: !!blackMarket && skillRoll.dice[0] === 1 && skillRoll.dice[1] === 1 };
    autoRoll = rollAutoCheck({ skill: skillRoll.skill, starportDM, priorAttemptDM, rushed });
    success = autoRoll.total >= 8;
  } else if (brokerSkill != null) {
    autoRoll = rollAutoCheck({ skill: brokerSkill, starportDM, priorAttemptDM, rushed });
    success = autoRoll.total >= 8;
  } else {
    success = Number(playerResult) >= 8;
  }

  const record = {
    kind, checkType, blackMarket: !!blackMarket, rushed: !!rushed,
    playerResult: autoRoll ? null : Number(playerResult), autoRoll, success,
    viaBroker: brokerSkill != null,
    starportDM, priorAttemptDM,
    worldKey,
    world: { Name: world?.Name || "", Sector: world?.Sector || "", Hex: world?.Hex || "", UWP: world?.UWP || "", Remarks: world?.Remarks || "", Zone: world?.Zone || "" },
    startedDayIndex, waitDays: wait.waitDays, waitRolls: wait.rolls, waitUnit: wait.unit, rawHours: wait.rawHours,
    resolveDayIndex: startedDayIndex + wait.waitDays,
    status: "searching", resolved: false,
    market: null, priceOffers: null, // contact/buy
    worldCodes: null,                // contact/sell
    broker: null,                    // broker (revealed only on success — see finalizeSearch)
    _rolledBrokerSkill: rolledBrokerSkill
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
  } else {
    logLines.push(`Auto-roll (broker's own skill): 2D6=[${record.autoRoll.dice.join("+")}]=${record.autoRoll.diceSum} + skill ${record.autoRoll.skill} + starport ${record.starportDM >= 0 ? "+" : ""}${record.starportDM} + prior attempts ${record.priorAttemptDM}${record.rushed ? " - 2 (rushed)" : ""} = ${record.autoRoll.total}`);
    if (record.success) {
      record.broker = record._rolledBrokerSkill;
      logLines.push(`Broker/fixer skill: 2D6=[${record.broker.dice.join("+")}]=${record.broker.sum} /3 = ${record.broker.skill}${record.broker.doubleCrosser ? " (natural 2 — possible double-crosser)" : ""}`);
    }
  }
  delete record._rolledBrokerSkill;
  record.status = record.success ? "found" : "failed";
  record.resolved = true;
  logDebugBlock(`Search resolved: ${purpose} at ${record.world.Name} (${mode})`, logLines);
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
