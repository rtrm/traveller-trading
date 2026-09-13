import { MODULE_ID } from "./constants.mjs";
import {
  getFinanceDoc, getFinanceData, saveFinanceData, postTransaction, canEdit, uid,
  getCampaignDate, gameDayIndex, formatGameDate, dayIndexToGameDate, getShipDocs, getShipData
} from "./data.mjs";
import { TradingWindowBase, customSelectHtml, bindCustomSelects, esc, fmtCr } from "./window-base.mjs";

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
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tt-finance-app",
      classes: ["traveller-trading-window"],
      width: 680,
      height: 680,
      resizable: true
    });
  }

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
    const titleEl = this.element?.[0]?.querySelector(".window-title");
    if (titleEl) titleEl.textContent = this.title;

    if (!this.doc) { this.root.innerHTML = `<p class="tt-empty">Group Finance hasn't been set up yet.</p>`; return; }
    const data = getFinanceData(this.doc);
    const editable = canEdit(this.doc);
    const transactions = (data.transactions || []).slice(0, 200);
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
          <h3>Transactions</h3>
          ${this._transactionsTableHtml(transactions)}
        </div>
      </div>`;
  }

  // ---- Add Transaction dialog --------------------------------------------
  async _action_add_transaction() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    // Wrapped in the same "#tt-root" id the sidebar/window content uses —
    // Dialog content renders outside any window's own #tt-root, so without
    // it the module's scoped CSS variables and .tt-field/.tt-select rules
    // would never reach this form.
    const content = `
      <div id="tt-root">
        <div class="tt-field">
          <label>Type</label>
          ${customSelectHtml("txType", [{ value: "income", label: "Income" }, { value: "payment", label: "Payment" }], "income")}
        </div>
        <div class="tt-field"><label>Description</label><input type="text" id="tt-dlg-desc" placeholder="What is this transaction for?"></div>
        <div class="tt-field"><label>Amount</label><input type="number" id="tt-dlg-amount" min="0"></div>
      </div>`;
    const result = await Dialog.prompt({
      title: "Add Transaction",
      content,
      label: "Add",
      render: (html) => bindCustomSelects(html[0]),
      callback: (html) => {
        const root = html[0];
        const type = root.querySelector('[data-tt-select-handler="txType"] .tt-select-opt.selected')?.dataset.ttSelectOpt || "income";
        const description = root.querySelector("#tt-dlg-desc").value.trim();
        const amount = Math.abs(Number(root.querySelector("#tt-dlg-amount").value)) || 0;
        return { type, description, amount };
      },
      rejectClose: false
    });
    if (!result) return;
    if (!result.description || !result.amount) { ui.notifications.warn("Enter both an amount and a description."); return; }
    const signed = result.type === "payment" ? -result.amount : result.amount;
    await postTransaction(this.doc, { amount: signed, description: result.description, source: "manual" });
    this._renderContent();
  }

  // ---- Group recurring income/cost dialog (add + edit) -------------------
  async _openGroupRecurringDialog(existing) {
    const isEdit = !!existing;
    const content = `
      <div id="tt-root">
        <div class="tt-field">
          <label>Type</label>
          ${customSelectHtml("recType", [{ value: "income", label: "Income" }, { value: "cost", label: "Cost" }], existing?.type || "income")}
        </div>
        <div class="tt-field"><label>Description</label><input type="text" id="tt-dlg-desc" value="${esc(existing?.description || "")}"></div>
        <div class="tt-field"><label>Amount</label><input type="number" id="tt-dlg-amount" min="0" value="${existing ? Math.abs(existing.amount) : ""}"></div>
        <div class="tt-field"><label>Every N days</label><input type="number" id="tt-dlg-period" min="1" value="${existing?.periodDays || 30}"></div>
      </div>`;
    return Dialog.prompt({
      title: isEdit ? "Edit Recurring Income or Cost" : "New Group Recurring Income or Cost",
      content,
      label: isEdit ? "Save" : "Add",
      render: (html) => bindCustomSelects(html[0]),
      callback: (html) => {
        const root = html[0];
        const type = root.querySelector('[data-tt-select-handler="recType"] .tt-select-opt.selected')?.dataset.ttSelectOpt || "income";
        const description = root.querySelector("#tt-dlg-desc").value.trim();
        const amount = Math.abs(Number(root.querySelector("#tt-dlg-amount").value)) || 0;
        const periodDays = Math.max(1, Number(root.querySelector("#tt-dlg-period").value) || 30);
        return { type, description, amount, periodDays };
      },
      rejectClose: false
    });
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
    const ok = await Dialog.confirm({ title: "Remove Recurring Entry", content: "<p>Remove this recurring income or cost? This cannot be undone.</p>" });
    if (!ok) return;
    const data = getFinanceData(this.doc);
    data.recurring = (data.recurring || []).filter(r => r.id !== btn.dataset.id);
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }
}
