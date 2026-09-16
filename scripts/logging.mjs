import { MODULE_ID } from "./constants.mjs";
import { getFinanceDoc } from "./data.mjs";

// On Forge-hosted worlds, FilePicker's "data" source writes to the WORLD's
// own private storage — not the user's personal Assets Library they browse
// from the Forge dashboard (confirmed: a user could not find the log file
// there). "forgevtt" is the source the Forge compatibility layer (visible
// in the console as ForgeVTT.mjs) maps to that Assets Library instead.
// Self-hosted/non-Forge installs have no such source, so fall back to
// "data" there, which is the correct (and only) choice in that case.
function fileSource() {
  return (typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge) ? "forgevtt" : "data";
}

// The bare global "FilePicker" is deprecated as of v13 in favor of this
// namespaced accessor.
function FP() { return foundry.applications.apps.FilePicker.implementation; }

// Root-level folder (not nested under "worlds/<id>") so it reads sensibly
// from the top of a Forge Assets Library that may hold files from several
// worlds/modules; the world id still separates campaigns within it.
const LOG_FOLDER = `${MODULE_ID}/${game?.world?.id ?? "world"}`;
const LOG_FILENAME = "transaction-log.txt";
const LOG_PATH = `${LOG_FOLDER}/${LOG_FILENAME}`;

async function ensureFolder() {
  try {
    await FP().browse(fileSource(), LOG_FOLDER);
  } catch (err) {
    await FP().createDirectory(fileSource(), LOG_FOLDER, {});
  }
}

// FilePicker.upload's resolved path is the actual browsable URL for the
// uploaded file (a full CDN URL on Forge, not a same-origin relative path)
// — caching it here avoids having to guess how a given source's paths map
// to fetchable URLs on any given host.
let cachedFileUrl = null;

async function findExistingFileUrl() {
  if (cachedFileUrl) return cachedFileUrl;
  try {
    const res = await FP().browse(fileSource(), LOG_FOLDER);
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

// Appends new transaction lines to a plain text file (visible in the
// Assets/Files browser — the user's Forge Assets Library when hosted
// there), so a GM can open a full history outside of Foundry entirely.
// Only the GM's own client writes this — file upload permission can't be
// assumed for players, and every transaction is broadcast to the GM via
// the same JournalEntry update regardless of who triggered it, so nothing
// is missed by only writing here.
let knownTransactionIds = null;

async function appendLines(lines) {
  if (!lines.length) return;
  try {
    await ensureFolder();
    const existing = await readExistingLog();
    const updated = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n";
    const file = new File([updated], LOG_FILENAME, { type: "text/plain" });
    const result = await FP().upload(fileSource(), LOG_FOLDER, file, {}, { notify: false });
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

// Resolves the actual fetchable/browsable URL for the log file so the
// Group Finance window can link straight to it. Returns null if the file
// hasn't been created yet (e.g. no transaction has ever been posted, or
// this client hasn't browsed the folder this session).
export async function getTransactionLogUrl() {
  return findExistingFileUrl();
}
