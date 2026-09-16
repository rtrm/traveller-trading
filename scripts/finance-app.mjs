import { MODULE_ID } from "./constants.mjs";
import {
  getFinanceDoc, getFinanceData, saveFinanceData, postTransaction, canEdit, uid,
  getCampaignDate, gameDayIndex, formatGameDate, dayIndexToGameDate, getShipDocs, getShipData
} from "./data.mjs";
import { TradingWindowBase, customSelectHtml, bindCustomSelects, esc, fmtCr, createDialogV2 } from "./window-base.mjs";
import { getTransactionLogUrl } from "./logging.mjs";
import { getDebugLogUrl } from "./debug-log.mjs";

const DEFAULT_TRANSACTION_LIMIT = 25;

export function registerFinanceSettings() {
  game.settings.register(MODULE_ID, "transactionDisplayLimit", {
    name: "Transactions Shown in Group Finance",
    hint: "How many of the most recent transactions to list on the Group Finance screen. The full history is always kept in the transaction log text file (Open Transaction Log button), regardless of this limit.",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULT_TRANSACTION_LIMIT,
    range: { min: 5, max: 500, step: 5 }
  });
}

function transactionDisplayLimit() {
  try {
    const n = Number(game.settings.get(MODULE_ID, "transactionDisplayLimit"));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRANSACTION_LIMIT;
  } catch (err) {
    return DEFAULT_TRANSACTION_LIMIT;
  }
}

let instance = null;

export function openGroupFinanceApp() {
  if (instance && instance.rendered) { instance.bringToTop(); return instance; }
  instance = new GroupFinanceApp();
  instance.render(true);
  return instance;
}

export function refreshGroupFinanceApp() {
  if (instance?.rendered) instance._renderContent();
}

function sourceDisplayName(doc) {
  return doc.name.replace(/^Starship: |^Storage: /, "");
}

// A recurring entry is either "every N days" (group-added, arbitrary period)
// or one of RECURRING_COST_PERIODS' fixed ids (ship-/storage-added) — this
// covers both shapes for the merged table below.
function frequencyLabel(row) {
  if (row.periodDays != null) return `${row.periodDays} Days`;
  if (row.period === "starport") return "Starport";
  if (row.period != null) return `${row.period} Days`;
  return "";
}

function fmtSignedCr(amount) {
  const v = Number(amount) || 0;
  return `Cr ${Math.abs(v).toLocaleString()} ${v < 0 ? "-" : "+"}`;
}

function transactionSourceLabel(source) {
  const m = /^ship:(.+)$/.exec(source || "");
  if (!m) return "";
  const doc = game.journal.get(m[1]);
  return doc ? sourceDisplayName(doc) : "";
}

class GroupFinanceApp extends TradingWindowBase {
  static DEFAULT_OPTIONS = {
    id: "tt-finance-app",
    classes: ["traveller-trading-window"],
    window: { resizable: true },
    position: { width: 680, height: 680 }
  };

  get title() {
    const date = formatGameDate(getCampaignDate());
    return date ? `Group Finance — ${date}` : "Group Finance";
  }

  async _load() {
    this.doc = await getFinanceDoc();
  }

  async close(options) {
    instance = null;
    return super.close(options);
  }

  // Gathers the finance sheet's own recurring entries alongside every ship's
  // and storage location's recurring costs into one list, per the design
  // note that recurring income/costs can be added on a starship's or
  // warehouse's own screen as well as directly on Group Finance.
  _recurringRows(data) {
    const rows = [];
    for (const r of (data.recurring || [])) {
      const signed = (r.type === "cost" ? -1 : 1) * (Math.abs(Number(r.amount)) || 0);
      rows.push({
        id: r.id, kind: "group", description: r.description, amount: signed,
        frequency: frequencyLabel(r), lastAppliedDay: r.lastAppliedDay, sourceName: null
      });
    }
    for (const doc of getShipDocs()) {
      const kind = doc.getFlag(MODULE_ID, "kind");
      const shipData = getShipData(doc);
      const recurring = (shipData.costs && shipData.costs.recurring) || [];
      for (const c of recurring) {
        rows.push({
          id: c.id, kind, description: c.description, amount: -(Math.abs(Number(c.amount)) || 0),
          frequency: frequencyLabel(c), lastAppliedDay: c.lastAppliedDay, sourceName: sourceDisplayName(doc)
        });
      }
    }
    return rows;
  }

  _recurringTableHtml(rows, editable) {
    return `
      <table class="tt-table">
        <thead><tr><th>Description</th><th>Frequency</th><th>Last Applied</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r.amount < 0 ? "tt-negative" : "tt-positive"}">
              <td>${esc(r.description)}</td>
              <td>${esc(r.frequency)}</td>
              <td>${esc(dayIndexToGameDate(r.lastAppliedDay)) || "&mdash;"}</td>
              <td class="tt-amount-cell">${fmtSignedCr(r.amount)}</td>
              <td class="tt-source-cell">
                ${r.kind === "group"
                  ? (editable ? `<button type="button" class="tt-icon-btn" data-tt-action="edit-group-recurring" data-id="${r.id}">Edit</button>
                     <button type="button" class="tt-icon-btn danger" data-tt-action="remove-group-recurring" data-id="${r.id}">Remove</button>` : "")
                  : `<span class="tt-source-name">${esc(r.sourceName)}</span>`}
              </td>
            </tr>`).join("") || `<tr><td colspan="5" class="tt-empty">No recurring income or costs yet.</td></tr>`}
        </tbody>
      </table>`;
  }

  _transactionsTableHtml(transactions) {
    return `
      <table class="tt-table">
        <thead><tr><th>Description</th><th>Date</th><th>Amount</th><th>Source</th></tr></thead>
        <tbody>
          ${transactions.map(t => `
            <tr class="${t.amount < 0 ? "tt-negative" : "tt-positive"}">
              <td>${esc(t.description)}</td>
              <td>${esc(formatGameDate(t.gameDate))}</td>
              <td class="tt-amount-cell">${fmtSignedCr(t.amount)}</td>
              <td><span class="tt-source-name">${esc(transactionSourceLabel(t.source))}</span></td>
            </tr>`).join("") || `<tr><td colspan="4" class="tt-empty">No transactions yet.</td></tr>`}
        </tbody>
      </table>`;
  }

  _renderContent() {
    // Application only reads the title getter when the outer chrome first
    // renders; patch the header text directly so the date shown there stays
    // current without a disruptive full re-render.
    const titleEl = this.element?.querySelector(".window-title");
    if (titleEl) titleEl.textContent = this.title;

    if (!this.doc) { this.root.innerHTML = `<p class="tt-empty">Group Finance hasn't been set up yet.</p>`; return; }
    const data = getFinanceData(this.doc);
    const editable = canEdit(this.doc);
    const limit = transactionDisplayLimit();
    const allTransactions = data.transactions || [];
    const transactions = allTransactions.slice(0, limit);
    const recurringRows = this._recurringRows(data);

    this.root.innerHTML = `
      <div class="tt-finance">
        <div class="tt-balance-row">
          <div class="tt-balance-label">Group Balance</div>
          <div class="tt-balance-right">
            <span class="tt-balance-value">${fmtCr(data.balance)}</span>
            ${editable ? `<button type="button" class="tt-btn" data-tt-action="add-transaction">Add Transaction</button>` : ""}
          </div>
        </div>
        ${!editable ? `<p class="tt-readonly-note">You have read-only access to Group Finance.</p>` : ""}

        <div class="tt-fin-section">
          <h3>Recurring Income and Costs</h3>
          ${this._recurringTableHtml(recurringRows, editable)}
          ${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="add-group-recurring">New Group Recurring Income or Cost</button>` : ""}
        </div>

        <div class="tt-fin-section">
          <div class="tt-inline-row" style="justify-content:space-between;">
            <h3 style="margin:0;">Transactions${allTransactions.length > limit ? ` <span class="tt-source-name">(showing latest ${limit} of ${allTransactions.length})</span>` : ""}</h3>
            <div class="tt-inline-row">
              ${game.user.isGM ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="open-transaction-log">Open Transaction Log</button>` : ""}
              ${game.user.isGM ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="open-debug-log">Open Session Debug Log</button>` : ""}
            </div>
          </div>
          ${this._transactionsTableHtml(transactions)}
        </div>
      </div>`;
  }

  async _action_open_transaction_log() {
    const url = await getTransactionLogUrl();
    if (!url) { ui.notifications.warn("No transaction log file yet — it's created the first time a transaction is posted."); return; }
    // Cache-busted so reopening the same tab/URL later doesn't show a
    // stale copy from before the latest write (Forge's CDN and/or the
    // browser can otherwise cache the exact same URL indefinitely).
    window.open(`${url}?t=${Date.now()}`, "_blank");
  }

  // The session debug log records every dice roll and DM breakdown for
  // Freight, Passengers, and Speculative Trade generation — a debugging aid
  // (overwritten fresh each session), not a permanent record like the
  // transaction log above.
  async _action_open_debug_log() {
    const url = await getDebugLogUrl();
    if (!url) { ui.notifications.warn("No session debug log file yet — it's created as soon as the world finishes loading."); return; }
    window.open(`${url}?t=${Date.now()}`, "_blank");
  }

  // ---- Add Transaction dialog --------------------------------------------
  async _action_add_transaction() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    // Wrapped in the same "#tt-root" id the sidebar/window content uses —
    // dialog content renders outside any window's own #tt-root, so without
    // it the module's scoped CSS variables and .tt-field/.tt-select rules
    // would never reach this form. Built as a detached element (rather than
    // an HTML string) so bindCustomSelects can be wired before DialogV2
    // ever inserts it into the document — see createDialogV2's own note on
    // why this sidesteps needing DialogV2's exact render-callback shape.
    // DialogV2 requires the element passed as `content` itself to have no
    // attributes ("config.content element must have no attributes"), so
    // the actual "#tt-root" scoping div is nested one level inside it.
    const content = document.createElement("div");
    content.innerHTML = `
      <div id="tt-root">
        <div class="tt-field">
          <label>Type</label>
          ${customSelectHtml("txType", [{ value: "income", label: "Income" }, { value: "payment", label: "Payment" }], "income")}
        </div>
        <div class="tt-field"><label>Description</label><input type="text" id="tt-dlg-desc" placeholder="What is this transaction for?"></div>
        <div class="tt-field"><label>Amount</label><input type="number" id="tt-dlg-amount" min="0"></div>
      </div>`;
    bindCustomSelects(content);
    // Track field values via live listeners; resolved via an explicit
    // finish() call made as a side effect from inside the button's own
    // callback — confirmed live (2026-09-16) that NEITHER a callback's
    // return value NOR DialogV2's own resolved value (the plain action
    // string) can be trusted to carry data reliably.
    let type = "income";
    const typeWrapper = content.querySelector('[data-tt-select-handler="txType"]');
    typeWrapper.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-tt-select-opt]");
      if (opt) type = opt.dataset.ttSelectOpt;
    });
    const descEl = content.querySelector("#tt-dlg-desc");
    const amountEl = content.querySelector("#tt-dlg-amount");
    const clicked = await new Promise(resolve => {
      let resolved = false;
      const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
      createDialogV2({
        window: { title: "Add Transaction" },
        content,
        buttons: [
          { action: "ok", label: "Add", default: true, callback: () => finish(true) },
          { action: "cancel", label: "Cancel", callback: () => finish(false) }
        ],
        rejectClose: false
      }, () => finish(false)).render(true);
    });
    if (!clicked) return;
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    if (!description || !amount) { ui.notifications.warn("Enter both an amount and a description."); return; }
    const signed = type === "payment" ? -amount : amount;
    await postTransaction(this.doc, { amount: signed, description, source: "manual" });
    this._renderContent();
  }

  // ---- Group recurring income/cost dialog (add + edit) -------------------
  async _openGroupRecurringDialog(existing) {
    const isEdit = !!existing;
    const content = document.createElement("div");
    content.innerHTML = `
      <div id="tt-root">
        <div class="tt-field">
          <label>Type</label>
          ${customSelectHtml("recType", [{ value: "income", label: "Income" }, { value: "cost", label: "Cost" }], existing?.type || "income")}
        </div>
        <div class="tt-field"><label>Description</label><input type="text" id="tt-dlg-desc" value="${esc(existing?.description || "")}"></div>
        <div class="tt-field"><label>Amount</label><input type="number" id="tt-dlg-amount" min="0" value="${existing ? Math.abs(existing.amount) : ""}"></div>
        <div class="tt-field"><label>Every N days</label><input type="number" id="tt-dlg-period" min="1" value="${existing?.periodDays || 30}"></div>
      </div>`;
    bindCustomSelects(content);
    // Track field values via live listeners; resolved via an explicit
    // finish() call made as a side effect from inside the button's own
    // callback — see the matching note in _action_add_transaction above
    // for why neither a callback's return value nor DialogV2's own
    // resolved value can be relied on at all.
    let type = existing?.type || "income";
    const typeWrapper = content.querySelector('[data-tt-select-handler="recType"]');
    typeWrapper.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-tt-select-opt]");
      if (opt) type = opt.dataset.ttSelectOpt;
    });
    const descEl = content.querySelector("#tt-dlg-desc");
    const amountEl = content.querySelector("#tt-dlg-amount");
    const periodEl = content.querySelector("#tt-dlg-period");
    const clicked = await new Promise(resolve => {
      let resolved = false;
      const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
      createDialogV2({
        window: { title: isEdit ? "Edit Recurring Income or Cost" : "New Group Recurring Income or Cost" },
        content,
        buttons: [
          { action: "ok", label: isEdit ? "Save" : "Add", default: true, callback: () => finish(true) },
          { action: "cancel", label: "Cancel", callback: () => finish(false) }
        ],
        rejectClose: false
      }, () => finish(false)).render(true);
    });
    if (!clicked) return null;
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    const periodDays = Math.max(1, Number(periodEl.value) || 30);
    return { type, description, amount, periodDays };
  }

  async _action_add_group_recurring() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    const result = await this._openGroupRecurringDialog(null);
    if (!result) return;
    if (!result.description || !result.amount) { ui.notifications.warn("Enter a description and amount."); return; }
    const data = getFinanceData(this.doc);
    data.recurring = data.recurring || [];
    // lastAppliedDay starts at today, not null — see the matching comment
    // in ship-app.mjs's _action_add_ship_cost for why null would let a
    // large time jump right after creation silently charge nothing.
    data.recurring.push({ id: uid(), ...result, lastAppliedDay: gameDayIndex() });
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }

  async _action_edit_group_recurring(btn) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    const data = getFinanceData(this.doc);
    const row = (data.recurring || []).find(r => r.id === btn.dataset.id);
    if (!row) return;
    const result = await this._openGroupRecurringDialog(row);
    if (!result) return;
    if (!result.description || !result.amount) { ui.notifications.warn("Enter a description and amount."); return; }
    Object.assign(row, result);
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }

  async _action_remove_group_recurring(btn) {
    if (!canEdit(this.doc)) return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Remove Recurring Entry" }, content: "<p>Remove this recurring income or cost? This cannot be undone.</p>" });
    if (!ok) return;
    const data = getFinanceData(this.doc);
    data.recurring = (data.recurring || []).filter(r => r.id !== btn.dataset.id);
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }
}
