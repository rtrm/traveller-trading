import { MODULE_ID } from "./constants.mjs";

const FOLDER_NAME = "Traveller Trading";
const FLAG_KIND = "kind";
const FLAG_DATA = "data";

// ---------------------------------------------------------------------------
// Campaign date (shared approach with the Pirates of Drinax Tracker module):
// reads the mgt2e system's own Year/Day world settings, the same values its
// "/time" chat command reports.
// ---------------------------------------------------------------------------
export function getCampaignDate() {
  try {
    const year = game.settings.get("mgt2e", "currentYear");
    let day = String(game.settings.get("mgt2e", "currentDay"));
    if (day.length === 1) day = "00" + day;
    else if (day.length === 2) day = "0" + day;
    return `${year}-${day}`;
  } catch (err) {
    return "";
  }
}

export function gameDayIndex() {
  try {
    const year = Number(game.settings.get("mgt2e", "currentYear"));
    const day = Number(game.settings.get("mgt2e", "currentDay"));
    if (!Number.isFinite(year) || !Number.isFinite(day)) return null;
    return year * 365 + day;
  } catch (err) {
    return null;
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------------------
// Document access. Finance and each ship/storage are stored as JournalEntry
// documents (in a dedicated folder) rather than a world setting, because
// JournalEntry ownership can be set per-user via Foundry's own "Configure
// Permissions" dialog — that's how a GM makes one player a purser (owner of
// the Finance entry) or a merchant (owner of a ship's entry) without this
// module needing to build any permission UI of its own. Default ownership
// on creation is OBSERVER for everyone, so the module is readable by the
// whole group out of the box; a GM grants OWNER to specific players as
// needed.
// ---------------------------------------------------------------------------

export async function getOrCreateFolder() {
  let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === FOLDER_NAME);
  if (!folder && game.user.isGM) {
    folder = await Folder.create({ name: FOLDER_NAME, type: "JournalEntry", color: "#c9a24a" });
  }
  return folder;
}

function defaultOwnership() {
  return { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
}

export async function getFinanceDoc() {
  let doc = game.journal.find(j => j.getFlag(MODULE_ID, FLAG_KIND) === "finance");
  if (!doc && game.user.isGM) {
    const folder = await getOrCreateFolder();
    doc = await JournalEntry.create({
      name: "Group Finance",
      folder: folder?.id,
      ownership: defaultOwnership(),
      flags: {
        [MODULE_ID]: {
          [FLAG_KIND]: "finance",
          [FLAG_DATA]: { balance: 0, transactions: [], recurring: [] }
        }
      }
    });
  }
  return doc;
}

// Deep-cloned so callers can freely mutate before calling saveFinanceData/
// saveShipData without risking Foundry seeing an identical before/after
// reference on the flag and treating the update as a no-op.
export function getFinanceData(doc) {
  const flag = doc?.getFlag(MODULE_ID, FLAG_DATA);
  return flag ? foundry.utils.deepClone(flag) : { balance: 0, transactions: [], recurring: [] };
}

export async function saveFinanceData(doc, data) {
  await doc.setFlag(MODULE_ID, FLAG_DATA, data);
}

export function getShipDocs() {
  return game.journal.filter(j => {
    const k = j.getFlag(MODULE_ID, FLAG_KIND);
    return k === "ship" || k === "storage";
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createShipDoc(name, isStorage) {
  if (!game.user.isGM) return null;
  const folder = await getOrCreateFolder();
  const data = isStorage
    ? { name, cargo: [], cargoNotes: "" }
    : {
        name, type: "", armed: false,
        cargoSpace: 0,
        berths: { high: 0, middle: 0, basic: 0, low: 0 },
        skills: { steward: 0, broker: 0, streetwise: 0, admin: 0 },
        cargo: [], cargoNotes: "",
        passengers: [],
        costs: { recurring: [] }
      };
  return JournalEntry.create({
    name: (isStorage ? "Storage: " : "Starship: ") + name,
    folder: folder?.id,
    ownership: defaultOwnership(),
    flags: {
      [MODULE_ID]: {
        [FLAG_KIND]: isStorage ? "storage" : "ship",
        [FLAG_DATA]: data
      }
    }
  });
}

export async function deleteShipDoc(id) {
  const doc = game.journal.get(id);
  if (doc) await doc.delete();
}

export function getShipData(doc) {
  const flag = doc?.getFlag(MODULE_ID, FLAG_DATA);
  return flag ? foundry.utils.deepClone(flag) : {};
}

export async function saveShipData(doc, data) {
  await doc.setFlag(MODULE_ID, FLAG_DATA, data);
}

export function canEdit(doc) {
  if (!doc) return false;
  return doc.canUserModify(game.user, "update");
}

// ---------------------------------------------------------------------------
// Posts a transaction against the shared Group Finance balance. Used both
// for manual entries and for anything generated elsewhere (recurring
// income/costs, ship running costs, passenger fares) so every change to the
// party's money ends up in the one transaction log.
// ---------------------------------------------------------------------------
export async function postTransaction(financeDoc, { amount, description, source }) {
  const data = getFinanceData(financeDoc);
  data.balance = (data.balance || 0) + amount;
  data.transactions = data.transactions || [];
  data.transactions.unshift({
    id: uid(),
    amount,
    description,
    source: source || "manual",
    realTime: new Date().toISOString(),
    gameDate: getCampaignDate()
  });
  await saveFinanceData(financeDoc, data);
  return data;
}

// Applies any due recurring income/cost entries on the Finance document
// itself, and any due 7-/30-day running costs on every ship (Starport costs
// are manual-only and never auto-applied here). Mutates and saves as needed.
// Returns true if anything changed.
export async function processRecurring(financeDoc) {
  if (!game.user.isGM) return false;
  const nowIdx = gameDayIndex();
  if (nowIdx === null) return false;

  let changed = false;
  const finance = getFinanceData(financeDoc);
  finance.recurring = finance.recurring || [];
  finance.transactions = finance.transactions || [];

  for (const r of finance.recurring) {
    if (typeof r.lastAppliedDay !== "number") { r.lastAppliedDay = nowIdx; changed = true; continue; }
    const elapsed = nowIdx - r.lastAppliedDay;
    const periodDays = Number(r.periodDays) || 30;
    const steps = Math.floor(elapsed / periodDays);
    if (steps <= 0) continue;
    const signedAmount = (r.type === "cost" ? -1 : 1) * Math.abs(Number(r.amount) || 0) * steps;
    finance.balance = (finance.balance || 0) + signedAmount;
    finance.transactions.unshift({
      id: uid(),
      amount: signedAmount,
      description: `${r.description} (recurring ${steps > 1 ? `x${steps} ` : ""}every ${periodDays}d)`,
      source: "recurring",
      realTime: new Date().toISOString(),
      gameDate: getCampaignDate()
    });
    r.lastAppliedDay += steps * periodDays;
    changed = true;
  }

  for (const shipDoc of getShipDocs()) {
    if (shipDoc.getFlag(MODULE_ID, FLAG_KIND) !== "ship") continue;
    const ship = getShipData(shipDoc);
    const recurringCosts = (ship.costs && ship.costs.recurring) || [];
    let shipChanged = false;
    for (const c of recurringCosts) {
      if (c.period === "starport") continue; // manual only
      const periodDays = Number(c.period) || 30;
      if (typeof c.lastAppliedDay !== "number") { c.lastAppliedDay = nowIdx; shipChanged = true; continue; }
      const elapsed = nowIdx - c.lastAppliedDay;
      const steps = Math.floor(elapsed / periodDays);
      if (steps <= 0) continue;
      const amount = -Math.abs(Number(c.amount) || 0) * steps;
      finance.balance = (finance.balance || 0) + amount;
      finance.transactions.unshift({
        id: uid(),
        amount,
        description: `${ship.name}: ${c.description} (recurring ${steps > 1 ? `x${steps} ` : ""}every ${periodDays}d)`,
        source: `ship:${shipDoc.id}`,
        realTime: new Date().toISOString(),
        gameDate: getCampaignDate()
      });
      c.lastAppliedDay += steps * periodDays;
      shipChanged = true;
      changed = true;
    }
    if (shipChanged) await saveShipData(shipDoc, ship);
  }

  if (changed) await saveFinanceData(financeDoc, finance);
  return changed;
}
