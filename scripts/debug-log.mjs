import { MODULE_ID } from "./constants.mjs";
import { getCampaignDate } from "./data.mjs";

// A verbose, session-scoped dice-roll log for Cargo (freight), Passengers,
// and Speculative Trade — every roll and DM breakdown, so a GM can check the
// generation logic is behaving as intended. Deliberately separate from
// logging.mjs's transaction log (which is a permanent, append-only ledger of
// money moved): this one is overwritten fresh each session, purely a
// debugging aid, not a campaign record.
function fileSource() {
  return (typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge) ? "forgevtt" : "data";
}

// The bare global "FilePicker" is deprecated as of v13 in favor of this
// namespaced accessor.
function FP() { return foundry.applications.apps.FilePicker.implementation; }

const LOG_FOLDER = `${MODULE_ID}/${game?.world?.id ?? "world"}`;
const LOG_FILENAME = "session-debug-log.txt";

async function ensureFolder() {
  try {
    await FP().browse(fileSource(), LOG_FOLDER);
  } catch (err) {
    await FP().createDirectory(fileSource(), LOG_FOLDER, {});
  }
}

let cachedFileUrl = null;
let buffer = ""; // in-memory tail so appends within the same session don't need to re-fetch the file each time

async function uploadBuffer() {
  try {
    await ensureFolder();
    const file = new File([buffer], LOG_FILENAME, { type: "text/plain" });
    const result = await FP().upload(fileSource(), LOG_FOLDER, file, {}, { notify: false });
    if (result?.path) cachedFileUrl = result.path;
  } catch (err) {
    console.warn("Traveller Trading | Could not write to the session debug log file.", err);
  }
}

// resetDebugLog/logDebugBlock are called from many places without being
// awaited (fire-and-forget, by design — nothing should block on a
// debug-log write). Without this queue, two overlapping calls could each
// snapshot `buffer` and start uploading, and if the one with the SMALLER
// snapshot happens to finish its network round-trip second, its upload
// would silently overwrite the other's larger one — losing whatever was
// appended in between, which is exactly the "doesn't always seem to
// update" symptom reported live. Chaining every upload onto this promise
// guarantees they run one at a time, in call order, each reading `buffer`
// only once it's actually its turn — so every upload sees everything
// appended before it, however the underlying network calls happen to land.
let uploadChain = Promise.resolve();
function scheduleUpload() {
  uploadChain = uploadChain.then(() => uploadBuffer());
  return uploadChain;
}

// Overwrites the log with a fresh header — called once per session (GM
// only, at "ready") so this always reflects only the current session's
// activity, per the design note that this is a debugging aid, not a record.
export async function resetDebugLog() {
  if (!game.user.isGM) return;
  const when = new Date().toISOString().replace("T", " ").slice(0, 19);
  buffer = `=== Traveller Trading session debug log — started ${when} (game date ${getCampaignDate() || "?"}) ===\n`;
  await scheduleUpload();
}

function fmtDM(entry) {
  if (!entry) return "none";
  return `${entry.code} ${entry.dm >= 0 ? "+" : ""}${entry.dm}`;
}

// Appends a titled block of lines to the log. `lines` may itself contain
// newlines (multi-line detail per entry) — everything is flushed to the
// file immediately so the log stays current even if the client crashes.
export async function logDebugBlock(title, lines) {
  if (!game.user.isGM) return;
  const when = new Date().toISOString().replace("T", " ").slice(11, 19);
  const gameDate = getCampaignDate() || "?";
  buffer += `\n--- [${when}] [${gameDate}] ${title} ---\n`;
  for (const line of lines) buffer += `${line}\n`;
  await scheduleUpload();
}

export async function getDebugLogUrl() {
  if (cachedFileUrl) return cachedFileUrl;
  try {
    const res = await FP().browse(fileSource(), LOG_FOLDER);
    cachedFileUrl = (res.files || []).find(f => f.endsWith(LOG_FILENAME)) || null;
  } catch (err) {
    cachedFileUrl = null;
  }
  return cachedFileUrl;
}

// ---------------------------------------------------------------------------
// Formatting helpers for the specific roll shapes this module generates —
// kept here (rather than scattered at each call site) so every call site
// logs in a consistent, readable format.
// ---------------------------------------------------------------------------

export function fmtTonsRoll(label, r) {
  return `  ${label}: [${r.rolls.join("+")}]=${r.sum} ${r.popMod >= 0 ? "+" : ""}${r.popMod} (pop mod) = ${r.modified} -> max(0,${r.modified}) x${r.mult} = ${r.tons} tons`;
}

export function fmtPriceOffer(r) {
  const lines = [];
  lines.push(`  Mode: ${r.mode}`);
  lines.push(`  3D6 roll: [${r.dice.join("+")}] = ${r.diceSum}`);
  lines.push(`  + Broker skill ${r.brokerSkill}${r.brokerBonus ? ` + local broker bonus ${r.brokerBonus}` : ""}`);
  lines.push(`  + Favorable DM: ${fmtDM(r.favorable)}`);
  lines.push(`  - Unfavorable DM: ${fmtDM(r.unfavorable)}`);
  lines.push(`  - Counterpart Broker skill ${r.counterpartSkill}`);
  lines.push(`  = Total ${r.total} (clamped to ${r.rowRoll}) -> ${r.percent}% of base price -> Cr${r.unitPrice}/ton`);
  return lines;
}

export function fmtRerolls(rerolls) {
  return (rerolls || []).map(rr => `    reroll: D66=${rr.code} — ${rr.reason}`);
}
