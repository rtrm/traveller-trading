import { MODULE_ID } from "./constants.mjs";
import { getFinanceDoc, getShipDocs } from "./data.mjs";

function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

async function buildPermissionsHtml() {
  const financeDoc = await getFinanceDoc();
  const shipDocs = getShipDocs();
  const docs = [financeDoc, ...shipDocs].filter(Boolean);
  const players = game.users.filter(u => !u.isGM);

  if (!players.length) {
    return "<p>There are no non-GM players in this world yet.</p>";
  }
  if (!docs.length) {
    return "<p>Nothing to manage yet — open the Traveller Trading panel first so Group Finance exists.</p>";
  }

  const header = players.map(u => `<th style="text-align:center; padding:4px 8px; font-weight:normal;">${esc(u.name)}</th>`).join("");
  const rows = docs.map(doc => {
    const cells = players.map(u => {
      const level = doc.getUserLevel ? doc.getUserLevel(u) : (doc.ownership?.[u.id] ?? doc.ownership?.default ?? 0);
      const checked = level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER ? "checked" : "";
      return `<td style="text-align:center;"><input type="checkbox" data-doc="${doc.id}" data-user="${u.id}" ${checked}></td>`;
    }).join("");
    const label = doc.name.replace(/^Starship: |^Storage: /, "");
    return `<tr><td style="padding:4px 8px;">${esc(label)}</td>${cells}</tr>`;
  }).join("");

  return `
    <p style="margin-bottom:10px;">Tick a box to let that player <strong>edit</strong> (not just view) Group Finance or a ship/storage location — e.g. make one player the purser for Group Finance, or a merchant for a ship's Cargo/Passengers/Costs. Everyone can already view everything.</p>
    <table style="width:100%; border-collapse:collapse;">
      <thead><tr><th style="text-align:left; padding:4px 8px; font-weight:normal;">Entry</th>${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function applyPermissions(html) {
  const el = html instanceof jQuery ? html[0] : html;
  const checkboxes = el.querySelectorAll("input[type=checkbox][data-doc]");
  const byDoc = new Map();
  checkboxes.forEach(cb => {
    if (!byDoc.has(cb.dataset.doc)) byDoc.set(cb.dataset.doc, {});
    byDoc.get(cb.dataset.doc)[cb.dataset.user] = cb.checked
      ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
      : CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  });
  for (const [docId, ownership] of byDoc.entries()) {
    const doc = game.journal.get(docId);
    if (!doc) continue;
    await doc.update({
      ownership: { ...doc.ownership, ...ownership, default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    });
  }
  ui.notifications.info("Traveller Trading: permissions updated.");
}

// Settings-menu entry replacing the need to use Foundry's own per-document
// "Configure Permissions" dialog (which requires a right-click context menu
// that isn't reliably available in every setup). Uses the same
// FormApplication-with-overridden-render trick as the Drinax Tracker's Reset
// Data menu, since Foundry rejects a settings-menu "type" that isn't a
// FormApplication/ApplicationV2 subclass — the actual UI is a plain Dialog.
export class TravellerTradingPermissionsMenu extends FormApplication {
  async render() {
    const content = await buildPermissionsHtml();
    new Dialog({
      title: "Traveller Trading — Permissions",
      content,
      buttons: {
        save: {
          icon: '<i class="fa-solid fa-check"></i>',
          label: "Save",
          callback: (html) => applyPermissions(html)
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: "Cancel"
        }
      },
      default: "save"
    }, { width: 520 }).render(true);
    return this;
  }

  async _updateObject() { /* never submitted — render() is fully overridden above */ }
}

export function registerPermissionsSettings() {
  game.settings.registerMenu(MODULE_ID, "managePermissions", {
    name: "Manage Permissions",
    label: "Manage Permissions",
    hint: "Choose which players can edit Group Finance or each starship/storage location (e.g. a purser for Group Finance, a merchant for a ship's cargo). Everyone can already view everything.",
    icon: "fa-solid fa-user-lock",
    type: TravellerTradingPermissionsMenu,
    restricted: true
  });
}
