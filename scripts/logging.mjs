import { MODULE_ID } from "./constants.mjs";
import { getFinanceDoc } from "./data.mjs";

const LOG_FOLDER = `worlds/${game?.world?.id ?? "world"}/${MODULE_ID}`;
const LOG_FILENAME = "transaction-log.txt";
const LOG_PATH = `${LOG_FOLDER}/${LOG_FILENAME}`;

async function ensureFolder() {
  try {
    await FilePicker.browse("data", LOG_FOLDER);
  } catch (err) {
    await FilePicker.createDirectory("data", LOG_FOLDER, {});
  }
}

// FilePicker.upload's resolved path is the actual browsable URL for the
// uploaded file (which, on Forge, is a full CDN URL, not a same-origin
// relative path) — caching it here avoids having to guess how "data"-source
// paths map to fetchable URLs on any given host.
let cachedFileUrl = null;

async function findExistingFileUrl() {
  if (cachedFileUrl) return cachedFileUrl;
  try {
    const res = await FilePicker.browse("data", LOG_FOLDER);
    cachedFileUrl = (res.files || []).find(f => f.endsWith(LOG_FILENAME)) || null;
  } catch (err) {
    cachedFileUrl = null;
  }
  return cachedFileUrl;
}

async function readExistingLog() {
  const url = await findExistingFileUrl();
  if (!url) return "";
  try {
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return "";
    return await res.text();
  } catch (err) {
    return "";
  }
}

function formatLine(t) {
  const when = new Date(t.realTime || Date.now()).toISOString().replace("T", " ").slice(0, 19);
  const sign = t.amount < 0 ? "-" : "+";
  return `[${when}] [${t.gameDate || "?"}] ${sign}Cr${Math.abs(t.amount).toLocaleString()} — ${t.description} (${t.source || "manual"})`;
}

// Appends new transaction lines to a plain text file under the world's own
// data folder (visible in the Assets/Files browser), so a GM can open a
// full history outside of Foundry entirely. Only the GM's own client writes
// this — file upload permission can't be assumed for players, and every
// transaction is broadcast to the GM via the same JournalEntry update
// regardless of who triggered it, so nothing is missed by only writing here.
let knownTransactionIds = null;

async function appendLines(lines) {
  if (!lines.length) return;
  try {
    await ensureFolder();
    const existing = await readExistingLog();
    const updated = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n";
    const file = new File([updated], LOG_FILENAME, { type: "text/plain" });
    const result = await FilePicker.upload("data", LOG_FOLDER, file, {}, { notify: false });
    if (result?.path) cachedFileUrl = result.path;
  } catch (err) {
    console.warn("Traveller Trading | Could not write to the transaction log file.", err);
  }
}

function handleFinanceUpdate(doc) {
  if (!game.user.isGM) return;
  if (doc.getFlag(MODULE_ID, "kind") !== "finance") return;
  const data = doc.getFlag(MODULE_ID, "data");
  const transactions = data?.transactions || [];

  if (knownTransactionIds === null) {
    // First sighting this session — seed without logging, so reloading
    // doesn't re-append the entire pre-existing history every time.
    knownTransactionIds = new Set(transactions.map(t => t.id));
    return;
  }

  const newOnes = transactions.filter(t => !knownTransactionIds.has(t.id));
  if (!newOnes.length) return;
  newOnes.forEach(t => knownTransactionIds.add(t.id));
  // Transactions are stored newest-first; log oldest-of-the-new first so the
  // file itself reads in chronological order.
  appendLines(newOnes.slice().reverse().map(formatLine));
}

export function registerTransactionLog() {
  Hooks.once("ready", () => {
    if (!game.user.isGM) return;
    getFinanceDoc().then(doc => { if (doc) handleFinanceUpdate(doc); });
  });
  Hooks.on("updateJournalEntry", (doc) => handleFinanceUpdate(doc));
}

export function transactionLogPath() {
  return LOG_PATH;
}
