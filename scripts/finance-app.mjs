import { getFinanceDoc, getFinanceData, saveFinanceData, postTransaction, canEdit, uid } from "./data.mjs";
import { TradingWindowBase, customSelectHtml, esc, fmtCr } from "./window-base.mjs";

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

class GroupFinanceApp extends TradingWindowBase {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tt-finance-app",
      title: "Group Finance",
      classes: ["traveller-trading-window"],
      width: 620,
      height: 640,
      resizable: true
    });
  }

  async _load() {
    this.doc = await getFinanceDoc();
  }

  async close(options) {
    instance = null;
    return super.close(options);
  }

  _renderContent() {
    if (!this.doc) { this.root.innerHTML = `<p class="tt-empty">Group Finance hasn't been set up yet.</p>`; return; }
    const data = getFinanceData(this.doc);
    const editable = canEdit(this.doc);
    const transactions = (data.transactions || []).slice(0, 200);
    this.root.innerHTML = `
      <div class="tt-finance">
        <div class="tt-balance-row">
          <div class="tt-balance-label">Group Balance</div>
          <div class="tt-balance-value">${fmtCr(data.balance)}</div>
        </div>

        ${editable ? `
        <div class="tt-panel-box">
          <h3>Add / Receive Money</h3>
          <div class="tt-inline-row">
            <input type="number" id="tt-tx-amount" class="tt-input" placeholder="Amount (negative to spend)">
            <input type="text" id="tt-tx-desc" class="tt-input tt-input-wide" placeholder="Description">
            <button type="button" class="tt-btn" data-tt-action="add-transaction">Add</button>
          </div>
        </div>

        <div class="tt-panel-box">
          <h3>Recurring Income &amp; Costs</h3>
          <div class="tt-inline-row">
            <input type="text" id="tt-rec-desc" class="tt-input tt-input-wide" placeholder="Description">
            <input type="number" id="tt-rec-amount" class="tt-input" placeholder="Amount">
            <input type="number" id="tt-rec-period" class="tt-input" placeholder="Every N days" value="30">
            ${customSelectHtml("_selectRecType", [{ value: "income", label: "Income" }, { value: "cost", label: "Cost" }], "income")}
            <button type="button" class="tt-btn" data-tt-action="add-recurring">Add</button>
          </div>
          <div class="tt-recurring-list">
            ${(data.recurring || []).map(r => `
              <div class="tt-recurring-row">
                <span class="tt-badge ${r.type === "cost" ? "tt-badge-cost" : "tt-badge-income"}">${r.type === "cost" ? "Cost" : "Income"}</span>
                <span class="tt-recurring-desc">${esc(r.description)}</span>
                <span class="tt-recurring-amount">${fmtCr(r.amount)} / ${r.periodDays}d</span>
                <button type="button" class="tt-icon-btn danger" data-tt-action="remove-recurring" data-id="${r.id}">Remove</button>
              </div>`).join("") || `<p class="tt-empty">No recurring entries yet.</p>`}
          </div>
        </div>
        ` : `<p class="tt-readonly-note">You have read-only access to Group Finance.</p>`}

        <div class="tt-panel-box tt-transactions">
          <h3>Transactions</h3>
          <div class="tt-transaction-list">
            ${transactions.map(t => `
              <div class="tt-transaction-row ${t.amount < 0 ? "tt-negative" : "tt-positive"}">
                <span class="tt-tx-amount">${t.amount < 0 ? "-" : "+"}${fmtCr(Math.abs(t.amount))}</span>
                <span class="tt-tx-desc">${esc(t.description)}</span>
                <span class="tt-tx-date">${esc(t.gameDate)}</span>
              </div>`).join("") || `<p class="tt-empty">No transactions yet.</p>`}
          </div>
        </div>
      </div>`;
  }

  async _action_add_transaction() {
    const amountEl = this.root.querySelector("#tt-tx-amount");
    const descEl = this.root.querySelector("#tt-tx-desc");
    const amount = Number(amountEl.value);
    const description = descEl.value.trim();
    if (!amount || !description) { ui.notifications.warn("Enter both an amount and a description."); return; }
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    await postTransaction(this.doc, { amount, description, source: "manual" });
    this._renderContent();
  }

  async _action_add_recurring() {
    const descEl = this.root.querySelector("#tt-rec-desc");
    const amountEl = this.root.querySelector("#tt-rec-amount");
    const periodEl = this.root.querySelector("#tt-rec-period");
    const typeWrapper = this.root.querySelector('[data-tt-select-handler="_selectRecType"]');
    const type = typeWrapper.querySelector(".tt-select-opt.selected")?.dataset.ttSelectOpt || "income";
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    const periodDays = Math.max(1, Number(periodEl.value) || 30);
    if (!description || !amount) { ui.notifications.warn("Enter a description and amount."); return; }
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    const data = getFinanceData(this.doc);
    data.recurring = data.recurring || [];
    data.recurring.push({ id: uid(), description, amount, type, periodDays, lastAppliedDay: null });
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }

  async _action_remove_recurring(btn) {
    if (!canEdit(this.doc)) return;
    const data = getFinanceData(this.doc);
    data.recurring = (data.recurring || []).filter(r => r.id !== btn.dataset.id);
    await saveFinanceData(this.doc, data);
    this._renderContent();
  }
}
