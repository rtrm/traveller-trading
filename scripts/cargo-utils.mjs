import { DEFAULT_ITEM_ICON } from "./constants.mjs";
import { uid } from "./data.mjs";

// Shared by ship-app.mjs (drag/drop, manual cargo edits) and trade-app.mjs
// (speculative-trade buy/sell) — both mutate a ship/storage's own `cargo`
// array the same way, so the merge/split logic lives in one place.

// Merges a quantity into an existing cargo row for the same item (matched
// by its source Item's uuid and current price/ton) rather than piling up a
// separate row per addition, so the hold's total stays a single accurate
// line per good.
export function addOrMergeCargo(ship, { itemName, unitValue, img, sourceUuid, quantity }) {
  ship.cargo = ship.cargo || [];
  const existing = sourceUuid && ship.cargo.find(c => c.sourceUuid === sourceUuid && Number(c.unitValue) === Number(unitValue));
  if (existing) {
    existing.quantity = (Number(existing.quantity) || 0) + quantity;
    if (img && !existing.img) existing.img = img;
  } else {
    ship.cargo.push({ id: uid(), itemName, quantity, unitValue, notes: "", sourceUuid, img: img || DEFAULT_ITEM_ICON });
  }
}

// Reduces a cargo row by the given quantity, dropping the row entirely once
// it hits zero.
export function removeCargoQuantity(ship, cargoId, quantity) {
  ship.cargo = ship.cargo || [];
  const row = ship.cargo.find(c => c.id === cargoId);
  if (!row) return;
  row.quantity = (Number(row.quantity) || 0) - quantity;
  if (row.quantity <= 0) ship.cargo = ship.cargo.filter(c => c.id !== cargoId);
}

// Personal luggage allowance per boarded passenger, in tons — mirrors
// ship-app.mjs's own copy (kept local there for its berth-upgrade display
// logic); duplicated here only for the space-remaining figure trade-app.mjs
// needs when capping a speculative-trade purchase.
const PASSENGER_CARGO_ALLOWANCE = { high: 1, middle: 0.1, basic: 0.01, low: 0.01 };

function passengerCargoTons(ship) {
  let raw = 0;
  for (const p of (ship.passengers || [])) {
    if (p.refunded) continue;
    raw += PASSENGER_CARGO_ALLOWANCE[p.category] || 0;
  }
  raw = Math.round(raw * 1000) / 1000;
  if (raw <= 0) return 0;
  const holdSpace = Number(ship.cargoSpace) || 0;
  const allocation = holdSpace - Math.floor(holdSpace - raw);
  return Math.round(allocation * 1000) / 1000;
}

// Total hold space used (cargo + freight + passenger luggage allowance)
// against the ship's own configured Total Cargo Space — shared by
// ship-app.mjs's Cargo tab display and trade-app.mjs's purchase cap.
export function cargoSpaceUsage(ship) {
  const cargoTons = (ship.cargo || []).reduce((s, c) => s + (Number(c.quantity) || 0), 0);
  const freightTons = (ship.freight || []).reduce((s, f) => s + (Number(f.tons) || 0), 0);
  const passengerCargo = passengerCargoTons(ship);
  const used = cargoTons + freightTons + passengerCargo;
  const total = Number(ship.cargoSpace) || 0;
  return { cargoTons, freightTons, passengerCargo, used, total, remaining: Math.max(0, total - used) };
}
