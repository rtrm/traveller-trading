import { MODULE_ID } from "./constants.mjs";
import {
  getFinanceDoc, getFinanceData, saveFinanceData, postTransaction, processRecurring,
  getShipDocs, createShipDoc, deleteShipDoc, getShipData, saveShipData, canEdit,
  getCampaignDate, uid
} from "./data.mjs";
import { PASSENGER_CATEGORIES, passengerCategoryInfo, passengerIncome, RECURRING_COST_PERIODS } from "./constants.mjs";

function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function fmtCr(n) {
  const v = Number(n) || 0;
  return `Cr${v.toLocaleString()}`;
}
const RANK = { low: 0, basic: 1, middle: 2, high: 3 };

export class TravellerTradingPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "traveller-trading-panel",
      title: "Traveller Trading",
      template: `modules/${MODULE_ID}/templates/panel.hbs`,
      width: 900,
      height: 700,
      resizable: true,
      classes: ["tt-window"]
    });
  }

  constructor(options = {}) {
    super(options);
    this.view = { type: "finance" };
    this.shipTab = "config";
    this.financeDoc = null;
    this.shipDocs = [];
  }

  getData() { return {}; }

  async _loadAll() {
    this.financeDoc = await getFinanceDoc();
    if (this.financeDoc) await processRecurring(this.financeDoc);
    this.shipDocs = getShipDocs();
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0].querySelector("#tt-root");
    this.root = root;

    if (this._outsideClickHandler) document.removeEventListener("click", this._outsideClickHandler);
    this._outsideClickHandler = (e) => {
      if (!e.target.closest(".tt-select")) {
        root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
      }
    };
    document.addEventListener("click", this._outsideClickHandler);

    root.addEventListener("dragover", (e) => e.preventDefault());
    root.addEventListener("drop", (e) => this._onDrop(e));

    this._bindDelegatedEvents(root);

    this._loadAll().then(() => this._render());
  }

  // ---------------------------------------------------------------------
  // Delegated events cover the whole panel, since nav/tab content is
  // regenerated wholesale on every state change (same approach as the
  // Drinax Tracker and Name Generator modules).
  // ---------------------------------------------------------------------
  _bindDelegatedEvents(root) {
    root.addEventListener("click", async (e) => {
      const navBtn = e.target.closest("[data-tt-nav]");
      if (navBtn) {
        const nav = navBtn.dataset.ttNav;
        if (nav === "finance") this.view = { type: "finance" };
        else if (nav === "add-ship") { await this._promptAddShip(false); return; }
        else if (nav === "add-storage") { await this._promptAddShip(true); return; }
        else this.view = { type: "ship", id: nav };
        this.shipTab = "config";
        this._render();
        return;
      }

      const shipTabBtn = e.target.closest("[data-tt-shiptab]");
      if (shipTabBtn) { this.shipTab = shipTabBtn.dataset.ttShiptab; this._render(); return; }

      const selectToggle = e.target.closest("[data-tt-select-toggle]");
      if (selectToggle) {
        const menu = selectToggle.nextElementSibling;
        const wasOpen = menu.classList.contains("open");
        root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
        if (!wasOpen) menu.classList.add("open");
        return;
      }
      const selectOpt = e.target.closest("[data-tt-select-opt]");
      if (selectOpt) {
        const wrapper = selectOpt.closest(".tt-select");
        wrapper.querySelector("[data-tt-select-toggle]").textContent = selectOpt.textContent;
        wrapper.querySelectorAll("[data-tt-select-opt]").forEach(o => o.classList.toggle("selected", o === selectOpt));
        wrapper.querySelector(".tt-select-menu").classList.remove("open");
        return;
      }

      const actionBtn = e.target.closest("[data-tt-action]");
      if (actionBtn) {
        const handler = "_action_" + actionBtn.dataset.ttAction.replace(/-/g, "_");
        if (typeof this[handler] === "function") await this[handler](actionBtn);
        return;
      }

      root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
    });

    root.addEventListener("change", async (e) => {
      const field = e.target.closest("[data-tt-field]");
      if (field) { await this._onFieldChange(field); return; }
      const cargoField = e.target.closest("[data-tt-cargo-field]");
      if (cargoField) { await this._onCargoFieldChange(cargoField); return; }
      const passField = e.target.closest("[data-tt-pass-field]");
      if (passField) { await this._onPassengerFieldChange(passField); return; }
    });
  }

  async _onCargoFieldChange(el) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!doc || !canEdit(doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(doc);
    const row = (ship.cargo || []).find(c => c.id === el.dataset.id);
    if (!row) return;
    row[el.dataset.ttCargoField] = Number(el.value) || 0;
    await saveShipData(doc, ship);
    this._render();
  }

  async _onPassengerFieldChange(el) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!doc || !canEdit(doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(doc);
    const row = (ship.passengers || []).find(p => p.id === el.dataset.id);
    if (!row) return;
    row[el.dataset.ttPassField] = el.value;
    await saveShipData(doc, ship);
    this._render();
  }

  async _promptAddShip(isStorage) {
    const label = isStorage ? "storage location" : "starship";
    const name = await new Promise(resolve => {
      new Dialog({
        title: `Add ${isStorage ? "Storage" : "Starship"}`,
        content: `<div class="tt-field"><label>Name of the ${label}</label><input type="text" id="tt-new-name" placeholder="e.g. ${isStorage ? "Warehouse 7" : "Far Trader"}"></div>`,
        buttons: {
          ok: {
            label: "Add",
            callback: (html) => resolve((html[0] || html).querySelector("#tt-new-name").value.trim())
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "ok"
      }).render(true);
    });
    if (!name) return;
    const doc = await createShipDoc(name, isStorage);
    this.shipDocs = getShipDocs();
    this.view = { type: "ship", id: doc.id };
    this.shipTab = "config";
    this._render();
  }

  // ---------------------------------------------------------------------
  // Drag/drop: dropping an Item onto the Cargo tab adds a cargo line.
  // ---------------------------------------------------------------------
  async _onDrop(event) {
    event.preventDefault();
    if (this.view.type !== "ship" || this.shipTab !== "cargo") return;
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (err) { return; }
    if (!data?.uuid || data.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;

    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!doc || !canEdit(doc)) { ui.notifications.warn("You don't have permission to edit this cargo hold."); return; }
    const ship = getShipData(doc);
    ship.cargo = ship.cargo || [];
    const unitValue = item.system?.cargo?.price ?? 0;
    ship.cargo.push({ id: uid(), itemName: item.name, quantity: 1, unitValue, notes: "", sourceUuid: item.uuid });
    await saveShipData(doc, ship);
    this._render();
  }

  // ---------------------------------------------------------------------
  // Field edits (inputs/textareas/checkboxes with data-tt-field="path")
  // ---------------------------------------------------------------------
  async _onFieldChange(el) {
    const path = el.dataset.ttField;
    const value = el.type === "checkbox" ? el.checked : (el.dataset.ttNumeric === "true" ? Number(el.value) || 0 : el.value);

    if (path.startsWith("ship.")) {
      const doc = this.shipDocs.find(d => d.id === this.view.id);
      if (!doc || !canEdit(doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
      const ship = getShipData(doc);
      foundry.utils.setProperty(ship, path.replace(/^ship\./, ""), value);
      await saveShipData(doc, ship);
      // Config/cargo numeric edits don't need a full re-render to feel responsive,
      // but keep it simple and consistent with the rest of the module.
      this._render();
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  _render() {
    this._renderNav();
    const content = this.root.querySelector("[data-tt-content]");
    if (this.view.type === "finance") {
      content.innerHTML = this._financeHtml();
    } else {
      const doc = this.shipDocs.find(d => d.id === this.view.id);
      if (!doc) { this.view = { type: "finance" }; content.innerHTML = this._financeHtml(); this._renderNav(); return; }
      content.innerHTML = this._shipHtml(doc);
    }
  }

  _renderNav() {
    const nav = this.root.querySelector("[data-tt-nav-row]");
    const isFinanceActive = this.view.type === "finance";
    let html = `<button type="button" class="tt-nav-btn ${isFinanceActive ? "active" : ""}" data-tt-nav="finance">💰 Group Finance</button>`;
    for (const doc of this.shipDocs) {
      const kind = doc.getFlag(MODULE_ID, "kind");
      const icon = kind === "storage" ? "📦" : "🚀";
      const active = this.view.type === "ship" && this.view.id === doc.id;
      html += `<button type="button" class="tt-nav-btn ${active ? "active" : ""}" data-tt-nav="${doc.id}">${icon} ${esc(doc.name.replace(/^Starship: |^Storage: /, ""))}</button>`;
    }
    if (game.user.isGM) {
      html += `<button type="button" class="tt-nav-btn tt-nav-add" data-tt-nav="add-ship" title="Add starship">+🚀</button>`;
      html += `<button type="button" class="tt-nav-btn tt-nav-add" data-tt-nav="add-storage" title="Add storage location">+📦</button>`;
    }
    nav.innerHTML = html;
  }

  _customSelectHtml(handler, items, selected, extraClass) {
    const selectedItem = items.find(it => it.value === selected) || { label: "" };
    const opts = items.map(it => `<div class="tt-select-opt ${it.value === selected ? "selected" : ""}" data-tt-select-opt="${esc(it.value)}">${esc(it.label)}</div>`).join("");
    return `<div class="tt-select ${extraClass || ""}" data-tt-select-handler="${handler}">
      <button type="button" class="tt-select-btn" data-tt-select-toggle>${esc(selectedItem.label)}</button>
      <div class="tt-select-menu">${opts}</div>
    </div>`;
  }

  // =======================================================================
  // FINANCE
  // =======================================================================
  _financeHtml() {
    const data = getFinanceData(this.financeDoc);
    const editable = canEdit(this.financeDoc);
    const transactions = (data.transactions || []).slice(0, 200);
    return `
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
            ${this._customSelectHtml("_selectRecType", [{ value: "income", label: "Income" }, { value: "cost", label: "Cost" }], "income")}
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

  async _action_add_transaction(btn) {
    const amountEl = this.root.querySelector("#tt-tx-amount");
    const descEl = this.root.querySelector("#tt-tx-desc");
    const amount = Number(amountEl.value);
    const description = descEl.value.trim();
    if (!amount || !description) { ui.notifications.warn("Enter both an amount and a description."); return; }
    if (!canEdit(this.financeDoc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    await postTransaction(this.financeDoc, { amount, description, source: "manual" });
    this._render();
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
    if (!canEdit(this.financeDoc)) { ui.notifications.warn("You don't have permission to edit Group Finance."); return; }
    const data = getFinanceData(this.financeDoc);
    data.recurring = data.recurring || [];
    data.recurring.push({ id: uid(), description, amount, type, periodDays, lastAppliedDay: null });
    await saveFinanceData(this.financeDoc, data);
    this._render();
  }

  async _action_remove_recurring(btn) {
    if (!canEdit(this.financeDoc)) return;
    const data = getFinanceData(this.financeDoc);
    data.recurring = (data.recurring || []).filter(r => r.id !== btn.dataset.id);
    await saveFinanceData(this.financeDoc, data);
    this._render();
  }

  // =======================================================================
  // SHIP / STORAGE
  // =======================================================================
  _shipHtml(doc) {
    const kind = doc.getFlag(MODULE_ID, "kind");
    const isStorage = kind === "storage";
    let tabsHtml = "";
    if (!isStorage) {
      const tabs = [["cargo", "Cargo"], ["passengers", "Passengers"], ["costs", "Costs"], ["config", "Configuration"]];
      tabsHtml = `<div class="tt-subtabs">${tabs.map(([id, label]) =>
        `<button type="button" class="tt-subtab ${this.shipTab === id ? "active" : ""}" data-tt-shiptab="${id}">${label}</button>`
      ).join("")}</div>`;
    }
    const body = isStorage ? this._storageCargoHtml(doc) : this._shipTabHtml(doc);
    return `<div class="tt-ship">${tabsHtml}<div class="tt-ship-body">${body}</div></div>`;
  }

  _shipTabHtml(doc) {
    if (this.shipTab === "cargo") return this._cargoHtml(doc);
    if (this.shipTab === "passengers") return this._passengersHtml(doc);
    if (this.shipTab === "costs") return this._costsHtml(doc);
    return this._configHtml(doc);
  }

  // ---- Configuration ----------------------------------------------------
  _configHtml(doc) {
    const ship = getShipData(doc);
    const editable = canEdit(doc);
    const dis = editable ? "" : "disabled";
    return `
      <div class="tt-config">
        <div class="tt-field"><label>Name</label><input type="text" ${dis} data-tt-field="ship.name" value="${esc(ship.name)}"></div>
        <div class="tt-field"><label>Type</label><input type="text" ${dis} data-tt-field="ship.type" value="${esc(ship.type)}" placeholder="e.g. Far Trader"></div>
        <div class="tt-field tt-field-checkbox"><label><input type="checkbox" ${dis} data-tt-field="ship.armed" ${ship.armed ? "checked" : ""}> Armed</label></div>
        <div class="tt-field"><label>Total Cargo Space (tons)</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.cargoSpace" value="${ship.cargoSpace || 0}"></div>
        <h4>Berths</h4>
        <div class="tt-inline-row">
          <div class="tt-field"><label>High</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.berths.high" value="${ship.berths?.high || 0}"></div>
          <div class="tt-field"><label>Middle</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.berths.middle" value="${ship.berths?.middle || 0}"></div>
          <div class="tt-field"><label>Basic</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.berths.basic" value="${ship.berths?.basic || 0}"></div>
          <div class="tt-field"><label>Low</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.berths.low" value="${ship.berths?.low || 0}"></div>
        </div>
        <h4>Skills</h4>
        <div class="tt-inline-row">
          <div class="tt-field"><label>Steward</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.steward" value="${ship.skills?.steward || 0}"></div>
          <div class="tt-field"><label>Broker</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.broker" value="${ship.skills?.broker || 0}"></div>
          <div class="tt-field"><label>Streetwise</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.streetwise" value="${ship.skills?.streetwise || 0}"></div>
          <div class="tt-field"><label>Admin</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.admin" value="${ship.skills?.admin || 0}"></div>
        </div>
        ${game.user.isGM ? `<button type="button" class="tt-btn tt-btn-ghost" style="margin-top:16px;" data-tt-action="delete-ship" data-id="${doc.id}">Delete this ${doc.getFlag(MODULE_ID, "kind") === "storage" ? "storage location" : "starship"}</button>` : ""}
      </div>`;
  }

  async _action_delete_ship(btn) {
    const ok = await Dialog.confirm({ title: "Delete", content: "<p>Delete this entry? This cannot be undone.</p>" });
    if (!ok) return;
    await deleteShipDoc(btn.dataset.id);
    this.shipDocs = getShipDocs();
    this.view = { type: "finance" };
    this._render();
  }

  // ---- Cargo --------------------------------------------------------------
  _cargoHtml(doc) {
    const ship = getShipData(doc);
    const isStorage = doc.getFlag(MODULE_ID, "kind") === "storage";
    const editable = canEdit(doc);
    const cargo = ship.cargo || [];
    const totalValue = cargo.reduce((s, c) => s + (Number(c.quantity) || 0) * (Number(c.unitValue) || 0), 0);
    const totalTons = cargo.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const spaceLine = isStorage
      ? `${totalTons} tons stored`
      : `Cargo space used: ${totalTons} / ${ship.cargoSpace || 0} tons`;
    return `
      <div class="tt-cargo">
        <p class="tt-hint">Drag an Item from the Items directory here to add it to the hold.</p>
        <div class="tt-cargo-summary">${spaceLine} &middot; Total value: ${fmtCr(totalValue)}</div>
        <table class="tt-table">
          <thead><tr><th>Item</th><th>Qty (t)</th><th>Base Value / t</th><th>Total Base Value</th><th></th></tr></thead>
          <tbody>
            ${cargo.map(c => `
              <tr>
                <td>${esc(c.itemName)}</td>
                <td><input type="number" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-cargo-field="quantity" data-id="${c.id}" value="${c.quantity}"></td>
                <td><input type="number" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-cargo-field="unitValue" data-id="${c.id}" value="${c.unitValue}"></td>
                <td>${fmtCr((Number(c.quantity) || 0) * (Number(c.unitValue) || 0))}</td>
                <td>${editable ? `<button type="button" class="tt-icon-btn danger" data-tt-action="remove-cargo" data-id="${c.id}">Remove</button>` : ""}</td>
              </tr>`).join("") || `<tr><td colspan="5" class="tt-empty">No cargo yet.</td></tr>`}
          </tbody>
        </table>
        <div class="tt-field"><label>Notes</label><textarea ${editable ? "" : "disabled"} data-tt-field="ship.cargoNotes" rows="3">${esc(ship.cargoNotes)}</textarea></div>
      </div>`;
  }

  _storageCargoHtml(doc) {
    return this._cargoHtml(doc);
  }

  async _action_remove_cargo(btn) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const ship = getShipData(doc);
    ship.cargo = (ship.cargo || []).filter(c => c.id !== btn.dataset.id);
    await saveShipData(doc, ship);
    this._render();
  }

  // ---- Passengers -----------------------------------------------------
  _passengersHtml(doc) {
    const ship = getShipData(doc);
    const editable = canEdit(doc);
    const passengers = ship.passengers || [];
    const berths = ship.berths || {};
    const usedByCategory = { high: 0, middle: 0, basic: 0, low: 0 };
    for (const p of passengers) if (!p.refunded && usedByCategory[p.category] !== undefined) usedByCategory[p.category]++;

    const berthSummary = PASSENGER_CATEGORIES.map(c =>
      `<span class="tt-berth-chip" style="color:${c.color}">${usedByCategory[c.id]}/${berths[c.id] || 0} ${c.label}</span>`
    ).join(" ");

    return `
      <div class="tt-passengers">
        <div class="tt-berth-summary">${berthSummary}</div>
        ${editable ? `
        <div class="tt-panel-box">
          <h3>Add Passenger</h3>
          <div class="tt-inline-row">
            <input type="text" id="tt-pass-name" class="tt-input" placeholder="Name">
            <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="generate-passenger-name">Generate Name</button>
            ${this._customSelectHtml("_selectPassCategory", PASSENGER_CATEGORIES.map(c => ({ value: c.id, label: c.label })), "basic")}
            <input type="number" id="tt-pass-parsecs" class="tt-input" placeholder="Parsecs" min="1" max="6" value="1">
            <input type="text" id="tt-pass-destination" class="tt-input tt-input-wide" placeholder="Destination">
            <button type="button" class="tt-btn" data-tt-action="add-passenger">Add</button>
          </div>
        </div>` : ""}
        <table class="tt-table">
          <thead><tr><th>Name</th><th>Description</th><th>Category</th><th>Income</th><th>Destination</th><th></th></tr></thead>
          <tbody>
            ${passengers.map(p => this._passengerRowHtml(p, editable)).join("") || `<tr><td colspan="6" class="tt-empty">No passengers yet.</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  _passengerRowHtml(p, editable) {
    const cat = passengerCategoryInfo(p.category);
    const upgradeOptions = PASSENGER_CATEGORIES.filter(c => RANK[c.id] > RANK[p.category]);
    return `
      <tr class="${p.refunded ? "tt-refunded" : ""}" style="border-left: 3px solid ${cat.color};">
        <td>${esc(p.name)}</td>
        <td><input type="text" ${editable && !p.refunded ? "" : "disabled"} class="tt-cell-input" data-tt-pass-field="description" data-id="${p.id}" value="${esc(p.description)}"></td>
        <td><span class="tt-badge" style="color:${cat.color}">${cat.label}</span></td>
        <td>${fmtCr(p.income)}${p.refunded ? " (refunded)" : ""}</td>
        <td><input type="text" ${editable && !p.refunded ? "" : "disabled"} class="tt-cell-input" data-tt-pass-field="destination" data-id="${p.id}" value="${esc(p.destination)}"></td>
        <td>
          ${editable && !p.refunded ? `<button type="button" class="tt-icon-btn danger" data-tt-action="refund-passenger" data-id="${p.id}">Refund</button>` : ""}
          ${editable && !p.refunded && upgradeOptions.length ? upgradeOptions.map(o =>
            `<button type="button" class="tt-icon-btn" data-tt-action="upgrade-passenger" data-id="${p.id}" data-to="${o.id}">&uarr; ${o.label.replace(" Passenger", "")}</button>`).join("") : ""}
        </td>
      </tr>`;
  }

  async _action_generate_passenger_name(btn) {
    const nameGen = game.modules.get("traveller-name-generator");
    const nameEl = this.root.querySelector("#tt-pass-name");
    if (nameGen?.active && typeof nameGen.api?.generateName === "function") {
      nameEl.value = nameGen.api.generateName();
    } else {
      ui.notifications.info("The Traveller Name Generator module isn't active — enter a name manually.");
    }
  }

  async _action_add_passenger() {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const nameEl = this.root.querySelector("#tt-pass-name");
    const parsecsEl = this.root.querySelector("#tt-pass-parsecs");
    const destEl = this.root.querySelector("#tt-pass-destination");
    const catWrapper = this.root.querySelector('[data-tt-select-handler="_selectPassCategory"]');
    const category = catWrapper.querySelector(".tt-select-opt.selected")?.dataset.ttSelectOpt || "basic";
    const name = nameEl.value.trim();
    const parsecs = Math.max(1, Math.min(6, Number(parsecsEl.value) || 1));
    const destination = destEl.value.trim();
    if (!name) { ui.notifications.warn("Enter a passenger name."); return; }

    const catInfo = passengerCategoryInfo(category);
    const income = passengerIncome(parsecs, category);
    const ship = getShipData(doc);
    ship.passengers = ship.passengers || [];
    ship.passengers.push({
      id: uid(), name, description: catInfo.label, category, parsecs, destination,
      income, refunded: false, realTime: new Date().toISOString(), gameDate: getCampaignDate()
    });
    await saveShipData(doc, ship);

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: income,
      description: `${ship.name}: Passage - ${name} (${catInfo.label}, ${parsecs}pc) to ${destination || "?"}`,
      source: `ship:${doc.id}`
    });

    this._render();
  }

  async _action_refund_passenger(btn) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const ship = getShipData(doc);
    const p = (ship.passengers || []).find(x => x.id === btn.dataset.id);
    if (!p || p.refunded) return;
    const ok = await Dialog.confirm({ title: "Refund Passenger", content: `<p>Refund ${esc(p.name)}'s fare of ${fmtCr(p.income)}?</p>` });
    if (!ok) return;
    p.refunded = true;
    await saveShipData(doc, ship);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, { amount: -p.income, description: `${ship.name}: Refund - ${p.name}`, source: `ship:${doc.id}` });
    this._render();
  }

  async _action_upgrade_passenger(btn) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const ship = getShipData(doc);
    const p = (ship.passengers || []).find(x => x.id === btn.dataset.id);
    if (!p || RANK[btn.dataset.to] <= RANK[p.category]) return;
    p.category = btn.dataset.to;
    p.description = passengerCategoryInfo(p.category).label;
    await saveShipData(doc, ship);
    this._render();
  }

  // ---- Costs ------------------------------------------------------------
  _costsHtml(doc) {
    const ship = getShipData(doc);
    const editable = canEdit(doc);
    const recurring = (ship.costs && ship.costs.recurring) || [];
    const hasStarport = recurring.some(c => c.period === "starport");
    return `
      <div class="tt-costs">
        ${editable ? `
        <div class="tt-panel-box">
          <h3>Add Running Cost</h3>
          <div class="tt-inline-row">
            <input type="text" id="tt-cost-desc" class="tt-input tt-input-wide" placeholder="Description">
            <input type="number" id="tt-cost-amount" class="tt-input" placeholder="Amount">
            ${this._customSelectHtml("_selectCostPeriod", RECURRING_COST_PERIODS, "30")}
            <button type="button" class="tt-btn" data-tt-action="add-ship-cost">Add</button>
          </div>
        </div>` : ""}
        <table class="tt-table">
          <thead><tr><th>Description</th><th>Amount</th><th>Period</th><th></th></tr></thead>
          <tbody>
            ${recurring.map(c => `
              <tr>
                <td>${esc(c.description)}</td>
                <td>${fmtCr(c.amount)}</td>
                <td>${esc(RECURRING_COST_PERIODS.find(p => p.id === c.period)?.label || c.period)}</td>
                <td>${editable ? `<button type="button" class="tt-icon-btn danger" data-tt-action="remove-ship-cost" data-id="${c.id}">Remove</button>` : ""}</td>
              </tr>`).join("") || `<tr><td colspan="4" class="tt-empty">No running costs yet.</td></tr>`}
          </tbody>
        </table>
        ${editable && hasStarport ? `<button type="button" class="tt-btn" data-tt-action="pay-starport">Pay Starport Costs</button>` : ""}

        ${editable ? `
        <div class="tt-panel-box" style="margin-top:18px;">
          <h3>One-off Cost</h3>
          <div class="tt-inline-row">
            <input type="text" id="tt-oneoff-desc" class="tt-input tt-input-wide" placeholder="Description">
            <input type="number" id="tt-oneoff-amount" class="tt-input" placeholder="Amount">
            <button type="button" class="tt-btn" data-tt-action="add-oneoff-cost">Pay</button>
          </div>
        </div>` : ""}
      </div>`;
  }

  async _action_add_ship_cost() {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const descEl = this.root.querySelector("#tt-cost-desc");
    const amountEl = this.root.querySelector("#tt-cost-amount");
    const periodWrapper = this.root.querySelector('[data-tt-select-handler="_selectCostPeriod"]');
    const period = periodWrapper.querySelector(".tt-select-opt.selected")?.dataset.ttSelectOpt || "30";
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    if (!description || !amount) { ui.notifications.warn("Enter a description and amount."); return; }
    const ship = getShipData(doc);
    ship.costs = ship.costs || { recurring: [] };
    ship.costs.recurring = ship.costs.recurring || [];
    ship.costs.recurring.push({ id: uid(), description, amount, period, lastAppliedDay: null });
    await saveShipData(doc, ship);
    this._render();
  }

  async _action_remove_ship_cost(btn) {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const ship = getShipData(doc);
    ship.costs.recurring = (ship.costs.recurring || []).filter(c => c.id !== btn.dataset.id);
    await saveShipData(doc, ship);
    this._render();
  }

  async _action_pay_starport() {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const ship = getShipData(doc);
    const starportCosts = (ship.costs?.recurring || []).filter(c => c.period === "starport");
    if (!starportCosts.length) return;
    const financeDoc = await getFinanceDoc();
    for (const c of starportCosts) {
      await postTransaction(financeDoc, { amount: -Math.abs(c.amount), description: `${ship.name}: ${c.description} (Starport)`, source: `ship:${doc.id}` });
    }
    ui.notifications.info(`Paid ${starportCosts.length} starport cost(s) for ${ship.name}.`);
    this._render();
  }

  async _action_add_oneoff_cost() {
    const doc = this.shipDocs.find(d => d.id === this.view.id);
    if (!canEdit(doc)) return;
    const descEl = this.root.querySelector("#tt-oneoff-desc");
    const amountEl = this.root.querySelector("#tt-oneoff-amount");
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    if (!description || !amount) { ui.notifications.warn("Enter a description and amount."); return; }
    const ship = getShipData(doc);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, { amount: -amount, description: `${ship.name}: ${description}`, source: `ship:${doc.id}` });
    this._render();
  }
}
