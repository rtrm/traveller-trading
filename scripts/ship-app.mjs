import { MODULE_ID, DEFAULT_ITEM_ICON } from "./constants.mjs";
import {
  getFinanceDoc, postTransaction, getShipData, saveShipData, deleteShipDoc, canEdit,
  getCampaignDate, gameDayIndex, uid
} from "./data.mjs";
import { PASSENGER_CATEGORIES, passengerCategoryInfo, passengerIncome, RECURRING_COST_PERIODS } from "./constants.mjs";
import { TradingWindowBase, customSelectHtml, esc, fmtCr, createDialogV2 } from "./window-base.mjs";
import { openDestinationMapApp, resolveAndRememberLocation } from "./destination-map.mjs";
import { generatePassengers } from "./passenger-gen.mjs";
import { generateFreight, LOT_SIZES } from "./freight-gen.mjs";
import { addOrMergeCargo, removeCargoQuantity } from "./cargo-utils.mjs";
import { goodByName } from "./trade-data.mjs";
import { openTradeMarketApp } from "./trade-app.mjs";
import { logDebugBlock } from "./debug-log.mjs";

// Mouse-over tooltip for a cargo row: which trade codes give a Purchase or
// Sale DM *bonus* for this good (a positive dm only — not the penalty
// codes, and not the DM values themselves, just which codes to look for on
// a world when deciding where to sell). Not tied to any particular world's
// own codes (unlike the Buy/Sell Goods table's "Buying/Selling benefits"
// columns, which only show codes the CURRENT world actually has) since
// cargo in the hold could end up sold anywhere.
function cargoTradeCodeTooltip(itemName) {
  const good = goodByName(itemName);
  if (!good) return "";
  const buyCodes = (good.purchaseDM || []).filter(d => d.dm > 0).map(d => d.code);
  const sellCodes = (good.saleDM || []).filter(d => d.dm > 0).map(d => d.code);
  const lines = [];
  if (buyCodes.length) lines.push(`Buying bonus on: ${buyCodes.join(", ")}`);
  if (sellCodes.length) lines.push(`Selling bonus on: ${sellCodes.join(", ")}`);
  return lines.join("\n");
}

const RANK = { low: 0, basic: 1, middle: 2, high: 3 };
const BERTH_RANK_ORDER = ["high", "middle", "basic", "low"]; // top to bottom, for cascading berth allocation
const NEXT_HIGHER_CATEGORY = { middle: "high", basic: "middle", low: "basic" }; // high has no tier above it
const instances = new Map(); // docId -> ShipApp

// How many berths of each category are currently occupied by non-refunded
// passengers — a passenger's own `category` field IS the berth they occupy
// (upgrading a passenger via the "↑ Upgrade" button changes this without
// touching their stored income, so this stays accurate after upgrades too).
function berthUsage(ship) {
  const used = { high: 0, middle: 0, basic: 0, low: 0 };
  for (const p of (ship.passengers || [])) {
    if (!p.refunded && used[p.category] !== undefined) used[p.category]++;
  }
  return used;
}

// Personal luggage allowance per boarded passenger, in tons — a berth-class
// perk, so it's based on `p.category` (the berth they currently occupy,
// same field berthUsage() reads) rather than whatever they originally paid.
const PASSENGER_CARGO_ALLOWANCE = { high: 1, middle: 0.1, basic: 0.01, low: 0.01 };

// Hold space taken up by every currently boarded (non-refunded) passenger's
// personal cargo allowance, rounded UP just enough that subtracting it from
// the ship's own (possibly fractional — e.g. a 30.7-ton hold) cargoSpace
// always leaves a whole-number remainder. Plain Math.ceil(raw) only does
// that when cargoSpace is itself already whole; here the allowance instead
// absorbs whatever fractional remainder the hold has, e.g. hold 30.7 with
// 2.35 tons of raw allowance rounds up to 2.7 (30.7 - 2.7 = 28), not 3.
// Zero passengers always means zero allowance — there's nothing to
// attribute the hold's own fractional remainder to in that case, so
// "remaining" is left as whatever cargoSpace already is.
function passengerCargoTons(ship) {
  let raw = 0;
  for (const p of (ship.passengers || [])) {
    if (p.refunded) continue;
    raw += PASSENGER_CARGO_ALLOWANCE[p.category] || 0;
  }
  raw = Math.round(raw * 1000) / 1000; // absorb float noise from repeated 0.1/0.01 additions
  if (raw <= 0) return 0;
  const holdSpace = Number(ship.cargoSpace) || 0;
  const allocation = holdSpace - Math.floor(holdSpace - raw);
  return Math.round(allocation * 1000) / 1000;
}

// Cascading allocation for newly-generated passengers: each category first
// fills its own remaining berths, then any overflow can spill into spare
// capacity one tier up (Middle -> High, Basic -> Middle, Low -> Basic) —
// processed top-down so a tier's own leftover berths are only known once
// its own passengers have already been seated. Returns, per category,
// {seatedOwn, upgraded, maxTake} where maxTake = seatedOwn + upgraded is
// the most of that category's generated passengers that can actually be
// boarded at all (the rest have nowhere to sit, regardless of price).
function computeBoardingPlan(ship, generatedCounts) {
  const used = berthUsage(ship);
  const berths = ship.berths || {};
  const plan = {};
  let spareInTierAbove = 0;
  for (const cat of BERTH_RANK_ORDER) {
    const ownCap = Math.max(0, (berths[cat] || 0) - (used[cat] || 0));
    const generated = generatedCounts[cat] || 0;
    const seatedOwn = Math.min(generated, ownCap);
    const overflow = generated - seatedOwn;
    const upgraded = Math.min(overflow, spareInTierAbove);
    plan[cat] = { seatedOwn, upgraded, maxTake: seatedOwn + upgraded };
    spareInTierAbove = ownCap - seatedOwn; // this tier's own leftover, available for the next (lower) tier's overflow
  }
  return plan;
}

// Drag ids a cargo-row drop handler has already claimed (see
// _action's _onDrop/_onCargoDragEnd below) — a plain module-level Set works
// because every ShipApp instance imports this same module singleton, so a
// claim made by the window that RECEIVES a drop is visible to the window
// that STARTED the drag, letting its dragend tell "handled by one of our
// own windows" apart from "landed somewhere we don't control (an actor
// sheet)" without any direct reference between the two app instances.
const claimedDragIds = new Set();
function claimDrag(dragId) {
  if (!dragId) return;
  claimedDragIds.add(dragId);
  setTimeout(() => claimedDragIds.delete(dragId), 10000);
}

// A single-field numeric Dialog, wrapped in the shared "#tt-root" id so the
// module's scoped CSS reaches it (Dialog content renders outside any
// window's own #tt-root — see the matching note in finance-app.mjs).
// Resolves null on cancel or an empty/zero entry, so callers can treat
// falsy as "nothing to do" uniformly.
async function promptQuantity({ title, label, defaultValue, max }) {
  const content = document.createElement("div");
  content.innerHTML = `
    <div id="tt-root">
      <div class="tt-field">
        <label>${esc(label)}</label>
        <input type="number" id="tt-dlg-qty" min="0" ${max != null ? `max="${max}"` : ""} value="${defaultValue}">
      </div>
    </div>`;
  // Read from the LIVE rendered form (button.form) inside the button's
  // own callback, not from this detached `content` element — DialogV2
  // stringifies `content` and rebuilds fresh DOM from it, so this element
  // is never actually shown (confirmed via Foundry's own DialogV2 docs,
  // 2026-09-16).
  return new Promise(resolve => {
    let resolved = false;
    const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
    createDialogV2({
      window: { title },
      content,
      buttons: [
        {
          action: "ok", label: "Confirm", default: true,
          callback: (event, button) => {
            const value = Math.max(0, Number(button.form.querySelector("#tt-dlg-qty")?.value) || 0) || null;
            finish(value);
            return value;
          }
        },
        { action: "cancel", label: "Cancel", callback: () => { finish(null); return null; } }
      ],
      rejectClose: false
    }, () => finish(null)).render(true);
  });
}

export function openShipApp(docId) {
  const existing = instances.get(docId);
  if (existing && existing.rendered) { existing.bringToFront(); return existing; }
  const app = new ShipApp(docId);
  instances.set(docId, app);
  app.render(true);
  return app;
}

export function refreshShipApp(docId) {
  instances.get(docId)?._renderContent();
}

export function closeShipAppIfOpen(docId) {
  instances.get(docId)?.close();
}

class ShipApp extends TradingWindowBase {
  constructor(docId, options) {
    super(options);
    this.docId = docId;
    this.shipTab = "config"; // reset to "cargo" for storage in _renderContent — storage has no config/passengers tabs
    // Set synchronously (game.journal.get is not async) so the window's
    // initial title, read by Foundry before _load() ever runs, is already
    // correct instead of momentarily showing the generic fallback.
    this.doc = game.journal.get(docId);
  }

  static DEFAULT_OPTIONS = {
    classes: ["traveller-trading-window"],
    window: { resizable: true },
    position: { width: 680, height: 680 }
  };

  get id() { return `tt-ship-app-${this.docId}`; }

  get title() {
    const name = this.doc?.name?.replace(/^Starship: |^Storage: /, "");
    return name || "Starship / Storage";
  }

  async _load() {
    this.doc = game.journal.get(this.docId);
  }

  async close(options) {
    instances.delete(this.docId);
    return super.close(options);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("dragenter", (e) => e.preventDefault());
    this.root.addEventListener("dragover", (e) => e.preventDefault());
    this.root.addEventListener("drop", (e) => this._onDrop(e));
    this.root.addEventListener("dragstart", (e) => this._onCargoDragStart(e));
    this.root.addEventListener("dragend", (e) => this._onCargoDragEnd(e));
    this.root.addEventListener("change", async (e) => {
      const field = e.target.closest("[data-tt-field]");
      if (field) { await this._onFieldChange(field); return; }
      const cargoField = e.target.closest("[data-tt-cargo-field]");
      if (cargoField) { await this._onCargoFieldChange(cargoField); return; }
      const passField = e.target.closest("[data-tt-pass-field]");
      if (passField) { await this._onPassengerFieldChange(passField); return; }
      const freightField = e.target.closest("[data-tt-freight-field]");
      if (freightField) { await this._onFreightFieldChange(freightField); return; }
    });
  }

  _renderContent() {
    this.doc = game.journal.get(this.docId);
    if (!this.doc) { this.close(); return; }
    // Application only reads the title getter when the outer chrome first
    // renders; patch the header text directly so a renamed ship/storage
    // updates its window title without a disruptive full re-render.
    const titleEl = this.element?.querySelector(".window-title");
    if (titleEl) titleEl.textContent = this.title;
    const kind = this.doc.getFlag(MODULE_ID, "kind");
    const isStorage = kind === "storage";
    if (isStorage && !["cargo", "costs"].includes(this.shipTab)) this.shipTab = "cargo";
    const tabs = isStorage
      ? [["cargo", "Cargo"], ["costs", "Costs"]]
      : [["cargo", "Cargo"], ["passengers", "Passengers"], ["costs", "Costs"], ["config", "Configuration"]];
    const tabsHtml = `<div class="tt-subtabs">${tabs.map(([id, label]) =>
      `<button type="button" class="tt-subtab ${this.shipTab === id ? "active" : ""}" data-tt-action="ship-tab" data-tt-shiptab="${id}">${label}</button>`
    ).join("")}</div>`;
    // Storage locations don't travel, so they have no Current Location/
    // Destination of their own (the config tab is hidden for them too, for
    // the same reason).
    const locBarHtml = isStorage ? "" : this._locationBarHtml(this.doc);
    const body = this._shipTabHtml(this.doc);
    this.root.innerHTML = `<div class="tt-ship">${locBarHtml}${tabsHtml}<div class="tt-ship-body">${body}</div></div>`;
  }

  // Current Location/Destination and their Set/Arrive actions, shown above
  // the tabs (not just on the Configuration tab) so they stay visible and
  // reachable no matter which tab a GM is looking at. One row to keep the
  // vertical footprint small.
  _locationBarHtml(doc) {
    const ship = getShipData(doc);
    const editable = canEdit(doc);
    const dis = editable ? "" : "disabled";
    return `
      <div class="tt-locbar">
        <label>Current Location</label>
        <input type="text" ${dis} class="tt-input" data-tt-field="ship.location" value="${esc(ship.location || "")}" placeholder="e.g. Drinax">
        <label>Destination</label>
        <input type="text" ${dis} class="tt-input" data-tt-field="ship.destination" value="${esc(ship.destination || "")}" placeholder="e.g. Overnale">
        ${editable ? `
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="choose-destination">Set</button>
        <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="arrive" ${ship.destination ? "" : "disabled"}>Arrive</button>` : ""}
      </div>`;
  }

  _shipTabHtml(doc) {
    if (this.shipTab === "cargo") return this._cargoHtml(doc);
    if (this.shipTab === "passengers") return this._passengersHtml(doc);
    if (this.shipTab === "costs") return this._costsHtml(doc);
    return this._configHtml(doc);
  }

  async _action_ship_tab(btn) {
    this.shipTab = btn.dataset.ttShiptab;
    this._renderContent();
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
        <div class="tt-field"><label>Jump Rating</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.jumpRating" min="0" max="6" value="${ship.jumpRating ?? 2}"></div>
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
          <div class="tt-field"><label>Carouse</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.carouse" value="${ship.skills?.carouse || 0}"></div>
          <div class="tt-field"><label>Streetwise</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.streetwise" value="${ship.skills?.streetwise || 0}"></div>
          <div class="tt-field"><label>Admin</label><input type="number" ${dis} data-tt-numeric="true" data-tt-field="ship.skills.admin" value="${ship.skills?.admin || 0}"></div>
        </div>
        ${game.user.isGM ? `<button type="button" class="tt-btn tt-btn-ghost" style="margin-top:16px;" data-tt-action="delete-ship">Delete this ${isStorageKind(doc) ? "storage location" : "starship"}</button>` : ""}
      </div>`;
  }

  async _action_arrive() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    if (!ship.destination) return;
    ship.location = ship.destination;
    ship.destination = "";
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  // Resolves the ship's free-text Current Location to a sector/hex (via
  // Traveller Map, disambiguating if the name matches more than one
  // world), then opens the jump-range map centered on it. Picking a
  // system there saves it as the Destination.
  async _action_choose_destination() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const origin = await resolveAndRememberLocation(this.doc, "location");
    if (!origin) return;
    openDestinationMapApp({
      docId: this.docId,
      originSector: origin.sector,
      originHex: origin.hex,
      initialJump: ship.jumpRating ?? 2,
      shipJumpRating: ship.jumpRating,
      onPick: async ({ sector, hex, name }) => {
        const freshShip = getShipData(this.doc);
        freshShip.destination = `${name} (${sector} ${hex})`;
        await saveShipData(this.doc, freshShip);
        this._renderContent();
      }
    });
  }

  async _action_delete_ship() {
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Delete" }, content: "<p>Delete this entry? This cannot be undone.</p>" });
    if (!ok) return;
    await deleteShipDoc(this.docId);
    this.close();
  }

  // ---- Cargo --------------------------------------------------------------
  _cargoHtml(doc) {
    const ship = getShipData(doc);
    const isStorage = doc.getFlag(MODULE_ID, "kind") === "storage";
    const editable = canEdit(doc);
    const cargo = ship.cargo || [];
    const freight = isStorage ? [] : (ship.freight || []);
    const totalValue = cargo.reduce((s, c) => s + (Number(c.quantity) || 0) * (Number(c.unitValue) || 0), 0);
    const cargoTons = cargo.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const freightTons = freight.reduce((s, f) => s + (Number(f.tons) || 0), 0);
    const passengerCargo = isStorage ? 0 : passengerCargoTons(ship);
    const totalTons = cargoTons + freightTons + passengerCargo;
    const spaceBreakdown = [
      freightTons ? `${freightTons} freight` : null,
      passengerCargo ? `${passengerCargo} passenger cargo` : null
    ].filter(Boolean).join(", ");
    const spaceLine = isStorage
      ? `${totalTons} tons stored`
      : `Cargo space used: ${totalTons} / ${ship.cargoSpace || 0} tons${spaceBreakdown ? ` (incl. ${spaceBreakdown})` : ""}`;
    const freightTotalFare = freight.reduce((s, f) => s + (Number(f.fare) || 0), 0);
    return `
      <div class="tt-cargo">
        <p class="tt-hint">Drag an Item here from the Items directory, an actor's inventory, or another ship/warehouse to add it to the hold. Drag a row out to move it elsewhere.</p>
        <div class="tt-cargo-summary">${spaceLine} &middot; Total value: ${fmtCr(totalValue)}</div>
        <table class="tt-table">
          <thead><tr><th>Item</th><th>Qty (t)</th><th>Base Value / t</th><th>Total Base Value</th><th></th></tr></thead>
          <tbody>
            ${cargo.map(c => `
              <tr>
                <td class="tt-cargo-item">
                  <div class="tt-cargo-drag" data-tt-cargo-row data-id="${c.id}" ${editable ? 'draggable="true"' : ""} title="${esc(cargoTradeCodeTooltip(c.itemName))}">
                    <img class="tt-cargo-icon" src="${esc(c.img || DEFAULT_ITEM_ICON)}" alt="">
                    <span>${esc(c.itemName)}</span>
                  </div>
                </td>
                <td><input type="number" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-cargo-field="quantity" data-id="${c.id}" value="${c.quantity}"></td>
                <td><input type="number" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-cargo-field="unitValue" data-id="${c.id}" value="${c.unitValue}"></td>
                <td>${fmtCr((Number(c.quantity) || 0) * (Number(c.unitValue) || 0))}</td>
                <td>${editable ? `<button type="button" class="tt-icon-btn danger" data-tt-action="remove-cargo" data-id="${c.id}">Remove</button>` : ""}</td>
              </tr>`).join("") || `<tr><td colspan="5" class="tt-empty">No cargo yet.</td></tr>`}
          </tbody>
        </table>
        <div class="tt-field"><label>Notes</label><textarea ${editable ? "" : "disabled"} data-tt-field="ship.cargoNotes" rows="3">${esc(ship.cargoNotes)}</textarea></div>
        ${!isStorage ? `
        <div class="tt-panel-box" style="margin-top:16px;">
          <h3>Freight</h3>
          <p class="tt-hint">Rolls Major/Minor/Incidental cargo lots for the current trip (Current Location &rarr; Destination on the Configuration tab) — same trip basis as Generate Passengers. Payment is on delivery.</p>
          <div class="tt-inline-row">
            ${editable ? `<button type="button" class="tt-btn" data-tt-action="generate-freight">Generate Freight</button>` : ""}
            ${editable && freight.length ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="deliver-freight">Deliver All Freight (${fmtCr(freightTotalFare)})</button>` : ""}
          </div>
          <table class="tt-table" style="margin-top:10px;">
            <thead><tr><th>Lot</th><th>Tons</th><th>Notes</th><th>Fare (on delivery)</th><th>Destination</th><th></th></tr></thead>
            <tbody>
              ${freight.map(f => this._freightRowHtml(f, editable)).join("") || `<tr><td colspan="6" class="tt-empty">No freight aboard.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="tt-panel-box">
          <h3>Speculative Trade</h3>
          <p class="tt-hint">Buy or sell trade goods at the ship's Current Location (Configuration tab). Find a supplier/buyer first (Average Broker/Streetwise/Online check, per the core rules), then negotiate prices once one's found.</p>
          <div class="tt-inline-row">
            <button type="button" class="tt-btn" data-tt-action="open-buy-goods" ${ship.location ? "" : "disabled"}>Buy Goods</button>
            <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="open-sell-goods" ${ship.location ? "" : "disabled"}>Sell Goods</button>
            ${ship.location ? "" : `<span class="tt-source-name">Set a Current Location first.</span>`}
          </div>
        </div>` : ""}
      </div>`;
  }

  async _action_open_buy_goods() {
    openTradeMarketApp({ docId: this.docId, mode: "buy" });
  }

  async _action_open_sell_goods() {
    openTradeMarketApp({ docId: this.docId, mode: "sell" });
  }

  _freightRowHtml(f, editable) {
    return `
      <tr>
        <td>${esc(f.sizeLabel || f.sizeId)}</td>
        <td class="tt-mono">${f.tons}</td>
        <td><input type="text" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-freight-field="notes" data-id="${f.id}" value="${esc(f.notes || "")}"></td>
        <td class="tt-mono">${fmtCr(f.fare)}</td>
        <td><input type="text" ${editable ? "" : "disabled"} class="tt-cell-input" data-tt-freight-field="destination" data-id="${f.id}" value="${esc(f.destination || "")}"></td>
        <td>${editable ? `<button type="button" class="tt-icon-btn danger" data-tt-action="remove-freight" data-id="${f.id}">Remove</button>` : ""}</td>
      </tr>`;
  }

  async _onFreightFieldChange(el) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const row = (ship.freight || []).find(f => f.id === el.dataset.id);
    if (!row) return;
    row[el.dataset.ttFreightField] = el.value;
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _action_remove_freight(btn) {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    ship.freight = (ship.freight || []).filter(f => f.id !== btn.dataset.id);
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  // Freight is paid on delivery, not on loading — this posts one combined
  // payment for everything currently aboard, then clears the manifest.
  async _action_deliver_freight() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const freight = ship.freight || [];
    if (!freight.length) return;
    const total = freight.reduce((s, f) => s + (Number(f.fare) || 0), 0);
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Deliver Freight" }, content: `<p>Deliver all ${freight.length} freight lot(s) and collect ${fmtCr(total)}?</p>` });
    if (!ok) return;
    ship.freight = [];
    await saveShipData(this.doc, ship);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: total,
      description: `${ship.name}: Freight delivered (${freight.length} lot${freight.length === 1 ? "" : "s"})`,
      source: `ship:${this.docId}`
    });
    logDebugBlock(`Freight delivered by ${ship.name}`, [
      ...freight.map(f => `  ${f.sizeLabel || f.sizeId} ${f.tons}t -> ${f.destination || "?"}: Cr${f.fare}`),
      `Total: Cr${total}`
    ]);
    this._renderContent();
  }

  // Rolls Major/Minor/Incidental freight lots for the ship's current trip,
  // then lets the GM pick which whole lots to load (capped by remaining
  // hold space, shared with regular cargo and anything already aboard).
  async _action_generate_freight() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const endpoints = await this._resolveTripEndpoints();
    if (!endpoints) return;
    const { origin, destination } = endpoints;
    const ship = getShipData(this.doc);

    let generation;
    try {
      generation = await generateFreight({
        skills: ship.skills,
        originSector: origin.sector, originHex: origin.hex,
        destSector: destination.sector, destHex: destination.hex
      });
    } catch (err) {
      ui.notifications.warn(err.message || "Couldn't generate freight.");
      return;
    }

    logDebugBlock(`Freight generated: ${generation.origin.Name} -> ${generation.destination.Name}`, [
      `Distance ${generation.distanceParsecs}pc, rate Cr${generation.ratePerTon}/ton`,
      ...["major", "minor", "incidental"].map(sizeId => {
        const r = generation.results[sizeId];
        return `  ${LOT_SIZES[sizeId].label}: roll ${r.roll} -> ${r.diceCount}D6 -> lots [${r.lots.join(", ")}]`;
      })
    ]);

    const cargoTons = (ship.cargo || []).reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const freightTons = (ship.freight || []).reduce((s, f) => s + (Number(f.tons) || 0), 0);
    const availableSpace = Math.max(0, (ship.cargoSpace || 0) - cargoTons - freightTons - passengerCargoTons(ship));

    const selectedLots = await this._showFreightGenerationResults(generation, availableSpace);
    if (!selectedLots || !selectedLots.length) return;

    const freshShip = getShipData(this.doc);
    freshShip.freight = freshShip.freight || [];
    for (const lot of selectedLots) {
      freshShip.freight.push({
        id: uid(),
        sizeId: lot.sizeId,
        sizeLabel: LOT_SIZES[lot.sizeId]?.label || lot.sizeId,
        tons: lot.tons,
        fare: lot.tons * generation.ratePerTon,
        notes: "",
        destination: generation.destination.Name || "",
        realTime: new Date().toISOString(),
        gameDate: getCampaignDate()
      });
    }
    await saveShipData(this.doc, freshShip);
    const totalTons = selectedLots.reduce((s, l) => s + l.tons, 0);
    ui.notifications.info(`Loaded ${selectedLots.length} freight lot(s), ${totalTons} tons. Payment due on delivery.`);
    logDebugBlock(`Freight loaded aboard ${freshShip.name}`, [
      `Lots: ${selectedLots.map(l => `${LOT_SIZES[l.sizeId]?.label || l.sizeId} ${l.tons}t`).join(", ")} = ${totalTons}t total`
    ]);
    this._renderContent();
  }

  // Shows every generated lot (flattened across all three size categories)
  // as a checkbox row with a live running total against available hold
  // space — checkboxes that would push the total over capacity are
  // disabled rather than letting the GM confirm an overloaded hold, since
  // a lot can only be taken whole or not at all. Resolves with the
  // selected lots, or null if cancelled.
  _showFreightGenerationResults(generation, availableSpace) {
    const { origin, destination, distanceParsecs, ratePerTon, results } = generation;
    const flatLots = [];
    for (const sizeId of ["major", "minor", "incidental"]) {
      (results[sizeId]?.lots || []).forEach((tons, idx) => flatLots.push({ key: `${sizeId}-${idx}`, sizeId, tons }));
    }
    return new Promise(resolve => {
      let resolved = false;
      const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
      const rows = flatLots.map(lot => `
        <tr>
          <td><input type="checkbox" data-tt-freight-lot data-key="${lot.key}" data-tons="${lot.tons}"></td>
          <td>${esc(LOT_SIZES[lot.sizeId]?.label || lot.sizeId)}</td>
          <td class="tt-mono">${lot.tons}</td>
          <td class="tt-mono">${fmtCr(lot.tons * ratePerTon)}</td>
        </tr>`).join("");
      const content = document.createElement("div");
      content.innerHTML = `
        <div id="tt-root">
          <p class="tt-hint">${esc(origin.Name || "")} &rarr; ${esc(destination.Name || "")}, ${distanceParsecs} parsec${distanceParsecs === 1 ? "" : "s"}. Rate: ${fmtCr(ratePerTon)}/ton. A lot must be taken whole or not at all.</p>
          <p class="tt-hint" data-tt-freight-space-status></p>
          <div style="max-height:320px;overflow-y:auto;">
            <table class="tt-table">
              <thead><tr><th></th><th>Lot</th><th>Tons</th><th>Fare</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4" class="tt-empty">No freight lots generated.</td></tr>`}</tbody>
            </table>
          </div>
        </div>`;
      // The running-total/auto-disable behaviour needs listeners on the
      // ACTUAL rendered checkboxes, not on this detached `content` element
      // — DialogV2 stringifies `content` and rebuilds fresh DOM from it,
      // so listeners attached here would never fire (confirmed via
      // Foundry's own DialogV2 docs, 2026-09-16). Wire them up after
      // render, against the dialog's own live `.element` instead. Final
      // selections are read the same way, inside the button's own
      // callback via `button.form`.
      const dlg = createDialogV2({
        window: { title: "Generate Freight" },
        content,
        buttons: [
          {
            action: "confirm", label: "Load Selected Freight", default: true,
            callback: (event, button) => {
              const checked = Array.from(button.form.querySelectorAll("[data-tt-freight-lot]")).filter(cb => cb.checked);
              const value = checked.map(cb => flatLots.find(l => l.key === cb.dataset.key)).filter(Boolean);
              finish(value);
              return value;
            }
          },
          { action: "cancel", label: "Cancel", callback: () => { finish(null); return null; } }
        ],
        rejectClose: false
      }, () => finish(null));
      dlg.render(true).then(() => {
        const root = dlg.element;
        const status = root.querySelector("[data-tt-freight-space-status]");
        const checkboxes = Array.from(root.querySelectorAll("[data-tt-freight-lot]"));
        const updateStatus = () => {
          const used = checkboxes.filter(cb => cb.checked).reduce((s, cb) => s + Number(cb.dataset.tons), 0);
          if (status) status.textContent = `Selected: ${used} / ${availableSpace} tons`;
          checkboxes.forEach(cb => {
            if (!cb.checked) cb.disabled = (used + Number(cb.dataset.tons)) > availableSpace;
          });
        };
        checkboxes.forEach(cb => cb.addEventListener("change", updateStatus));
        updateStatus();
      });
    });
  }

  // Accepts a drop anywhere in the window, regardless of which tab is
  // currently showing — the drop is always cargo, so it's always handled
  // and the view switches to the Cargo tab to show the result.
  async _onDrop(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (err) { return; }
    if (!data?.uuid || data.type !== "Item") return;
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to add cargo here."); return; }

    if (data.ttCargo) {
      // One of our own cargo rows, dragged from another (or this) ship/
      // warehouse window — claimed immediately (before any await) so the
      // dragging window's dragend handler knows not to also treat this as
      // a drop it doesn't control.
      claimDrag(data.ttCargo.dragId);
      if (data.ttCargo.docId === this.docId) return; // dropped back on its own hold
      const sourceDoc = game.journal.get(data.ttCargo.docId);
      if (!sourceDoc) return;
      const available = Number(data.ttCargo.quantity) || 0;
      const amount = await promptQuantity({
        title: "Move Cargo",
        label: `Move how many tons of ${data.ttCargo.itemName} (of ${available} available)?`,
        defaultValue: available,
        max: available
      });
      if (!amount) return;
      const moved = Math.min(amount, available);
      const sourceShip = getShipData(sourceDoc);
      removeCargoQuantity(sourceShip, data.ttCargo.cargoId, moved);
      await saveShipData(sourceDoc, sourceShip);
      const destShip = getShipData(this.doc);
      addOrMergeCargo(destShip, { itemName: data.ttCargo.itemName, unitValue: data.ttCargo.unitValue, img: data.ttCargo.img, sourceUuid: data.uuid, quantity: moved });
      await saveShipData(this.doc, destShip);
      this.shipTab = "cargo";
      this._renderContent();
      return;
    }

    // A fresh Item — from the Items directory/a compendium, or an actor's
    // own inventory (in which case this is also a move: the carried amount
    // is removed from the actor once added here).
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const fromActor = !!item.actor;
    const carriedByActor = Number(item.system?.quantity) || 1;
    const amount = await promptQuantity({
      title: "Add Cargo",
      label: fromActor
        ? `How many tons of ${item.name} (of ${carriedByActor} carried) are being moved to the hold?`
        : `How many tons of ${item.name} are being carried?`,
      defaultValue: fromActor ? carriedByActor : 1,
      max: fromActor ? carriedByActor : undefined
    });
    if (!amount) return;
    const finalAmount = fromActor ? Math.min(amount, carriedByActor) : amount;
    const unitValue = item.system?.cargo?.price ?? 0;
    const ship = getShipData(this.doc);
    addOrMergeCargo(ship, { itemName: item.name, unitValue, img: item.img, sourceUuid: item.uuid, quantity: finalAmount });
    await saveShipData(this.doc, ship);

    if (fromActor) {
      const remaining = carriedByActor - finalAmount;
      if (remaining > 0) await item.update({ "system.quantity": remaining });
      else await item.delete();
    }

    this.shipTab = "cargo";
    this._renderContent();
  }

  // Cargo rows are draggable so they can be moved to another ship/
  // warehouse window, or to an actor sheet — the payload doubles as a
  // standard Foundry Item drag (so a foreign drop target like an actor
  // sheet handles it natively) and carries our own transfer details in
  // ttCargo (read only by _onDrop above).
  _onCargoDragStart(event) {
    const row = event.target.closest("[data-tt-cargo-row]");
    if (!row) { event.preventDefault(); return; }
    const ship = getShipData(this.doc);
    const c = (ship.cargo || []).find(x => x.id === row.dataset.id);
    if (!c) { event.preventDefault(); return; }
    const dragId = uid();
    row.dataset.ttDragId = dragId;
    const payload = {
      type: "Item",
      uuid: c.sourceUuid,
      ttCargo: { dragId, docId: this.docId, cargoId: c.id, quantity: Number(c.quantity) || 0, unitValue: Number(c.unitValue) || 0, itemName: c.itemName, img: c.img }
    };
    event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copyMove";
  }

  // The one direction we can't handle deterministically on drop: dropping
  // a cargo row onto an actor sheet (or anywhere else outside our own
  // windows) creates something there via Foundry's own native Item-drop
  // handling, which gives us no completion callback. dragend is the only
  // signal left, so — unless another of our own windows already claimed
  // this drag via _onDrop above — this asks the GM to confirm how much
  // actually left the hold, rather than guessing.
  async _onCargoDragEnd(event) {
    const row = event.target.closest("[data-tt-cargo-row]");
    if (!row) return;
    const dragId = row.dataset.ttDragId;
    delete row.dataset.ttDragId;
    if (!dragId) return;
    // Yield one microtask: an internal drop's claim happens synchronously
    // at the top of _onDrop, before it shows its own quantity dialog, and
    // drop always fires before dragend — so the claim is already recorded
    // by the time we check, whichever window it landed on.
    await Promise.resolve();
    if (claimedDragIds.has(dragId)) return;
    if (event.dataTransfer.dropEffect === "none") return; // dropped nowhere valid
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    const c = (ship.cargo || []).find(x => x.id === row.dataset.id);
    if (!c) return;
    const amount = await promptQuantity({
      title: "Remove Cargo",
      label: `Remove how many tons of ${c.itemName} (of ${c.quantity}) from this hold? (Cancel if nothing was actually transferred.)`,
      defaultValue: c.quantity,
      max: c.quantity
    });
    if (!amount) return;
    removeCargoQuantity(ship, c.id, Math.min(amount, c.quantity));
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _action_remove_cargo(btn) {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    ship.cargo = (ship.cargo || []).filter(c => c.id !== btn.dataset.id);
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _onCargoFieldChange(el) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const row = (ship.cargo || []).find(c => c.id === el.dataset.id);
    if (!row) return;
    row[el.dataset.ttCargoField] = Number(el.value) || 0;
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  // ---- Passengers -----------------------------------------------------
  _passengersHtml(doc) {
    const ship = getShipData(doc);
    const editable = canEdit(doc);
    const passengers = ship.passengers || [];
    const berths = ship.berths || {};
    const usedByCategory = berthUsage(ship);

    const berthSummary = PASSENGER_CATEGORIES.map(c =>
      `<span class="tt-berth-chip" style="color:${c.color}">${usedByCategory[c.id]}/${berths[c.id] || 0} ${c.label}</span>`
    ).join(" ");

    return `
      <div class="tt-passengers">
        <div class="tt-berth-summary">${berthSummary}</div>
        ${editable && passengers.length ? `
        <div class="tt-inline-row" style="margin:8px 0 4px;">
          <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="disembark-passengers">Disembark All Passengers</button>
        </div>` : ""}
        ${editable ? `
        <div class="tt-panel-box">
          <h3>Trade Passengers</h3>
          <p class="tt-hint">Rolls 2D6 per category (High/Middle/Basic/Low) using the ship's Steward skill, the current location's and destination's UWP/zone, distance, and the best of Broker/Carouse/Streetwise — same as picking a destination, based on Current Location and Destination on the Configuration tab.</p>
          <button type="button" class="tt-btn" data-tt-action="generate-passengers">Generate Passengers</button>
        </div>
        <div class="tt-panel-box">
          <h3>Add Passenger</h3>
          <div class="tt-inline-row">
            <input type="text" id="tt-pass-name" class="tt-input" placeholder="Name">
            <button type="button" class="tt-btn tt-btn-ghost" data-tt-action="generate-passenger-name">Generate Name</button>
            ${customSelectHtml("_selectPassCategory", PASSENGER_CATEGORIES.map(c => ({ value: c.id, label: c.label })), "basic")}
            <input type="number" id="tt-pass-parsecs" class="tt-input" placeholder="Parsecs" min="1" max="6" value="1">
            <input type="text" id="tt-pass-destination" class="tt-input tt-input-wide" placeholder="Destination">
            <button type="button" class="tt-btn" data-tt-action="add-passenger">Add</button>
          </div>
        </div>` : ""}
        <table class="tt-table">
          <thead><tr><th>Name</th><th>Notes</th><th>Category</th><th>Income</th><th>Destination</th><th></th></tr></thead>
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

  async _onPassengerFieldChange(el) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const row = (ship.passengers || []).find(p => p.id === el.dataset.id);
    if (!row) return;
    row[el.dataset.ttPassField] = el.value;
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _action_generate_passenger_name() {
    const nameGen = game.modules.get("traveller-name-generator");
    const nameEl = this.root.querySelector("#tt-pass-name");
    if (nameGen?.active && typeof nameGen.api?.generateName === "function") {
      nameEl.value = nameGen.api.generateName();
    } else {
      ui.notifications.info("The Traveller Name Generator module isn't active — enter a name manually.");
    }
  }

  // Resolves the ship's Current Location and Destination fields (via
  // Traveller Map, disambiguating either one if the name matches more than
  // one world) — shared by both Generate Passengers and Generate Freight,
  // which both roll against the same trip. Returns null (after already
  // warning the user) if either field is unset, unresolvable, or the
  // disambiguation dialog is cancelled.
  async _resolveTripEndpoints() {
    const origin = await resolveAndRememberLocation(this.doc, "location");
    if (!origin) return null;
    const destination = await resolveAndRememberLocation(this.doc, "destination");
    if (!destination) return null;
    return { origin, destination };
  }

  // Rolls all four passenger categories for the ship's current trip, then
  // lets the GM choose how many of each to actually board before creating
  // the records and posting one combined payment.
  async _action_generate_passengers() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const endpoints = await this._resolveTripEndpoints();
    if (!endpoints) return;
    const { origin, destination } = endpoints;
    const ship = getShipData(this.doc);

    let generation;
    try {
      generation = await generatePassengers({
        skills: ship.skills,
        originSector: origin.sector, originHex: origin.hex,
        destSector: destination.sector, destHex: destination.hex
      });
    } catch (err) {
      ui.notifications.warn(err.message || "Couldn't generate passengers.");
      return;
    }

    logDebugBlock(`Passengers generated: ${generation.origin.Name} -> ${generation.destination.Name}`, [
      `Distance ${generation.distanceParsecs}pc`,
      ...BERTH_RANK_ORDER.map(cat => {
        const r = generation.results[cat];
        return `  ${passengerCategoryInfo(cat).label}: roll ${r.roll} -> ${r.diceCount}D6 -> ${r.count} available`;
      })
    ]);

    const generatedCounts = Object.fromEntries(BERTH_RANK_ORDER.map(c => [c, generation.results[c].count]));
    const plan = computeBoardingPlan(ship, generatedCounts);

    const taken = await this._showPassengerGenerationResults(generation, plan);
    if (!taken) return;

    const { origin: originWorld, destination: destWorld, distanceParsecs } = generation;
    const freshShip = getShipData(this.doc);
    freshShip.passengers = freshShip.passengers || [];
    let totalIncome = 0;
    const parts = [];
    for (const category of BERTH_RANK_ORDER) {
      const total = Math.max(0, Math.min(taken[category] || 0, plan[category].maxTake));
      if (!total) continue;
      const fare = passengerIncome(distanceParsecs, category);
      const catInfo = passengerCategoryInfo(category);
      // Fills the category's own berths first, then any remainder occupies
      // spare berths one tier up (per computeBoardingPlan) at THIS
      // category's fare — same as the existing "↑ Upgrade" button, which
      // also changes only the berth (category) and never the paid income.
      const seatedOwn = Math.min(total, plan[category].seatedOwn);
      const upgraded = total - seatedOwn;
      const upgradeBerth = NEXT_HIGHER_CATEGORY[category];

      for (let i = 0; i < seatedOwn; i++) {
        freshShip.passengers.push({
          id: uid(), name: this._generatedPassengerName(category), description: catInfo.label,
          category, parsecs: distanceParsecs, destination: destWorld.Name || "",
          income: fare, refunded: false, realTime: new Date().toISOString(), gameDate: getCampaignDate()
        });
      }
      for (let i = 0; i < upgraded; i++) {
        freshShip.passengers.push({
          id: uid(), name: this._generatedPassengerName(category), description: passengerCategoryInfo(upgradeBerth).label,
          category: upgradeBerth, parsecs: distanceParsecs, destination: destWorld.Name || "",
          income: fare, refunded: false, realTime: new Date().toISOString(), gameDate: getCampaignDate()
        });
      }

      totalIncome += fare * total;
      parts.push(upgraded ? `${seatedOwn} ${catInfo.label} + ${upgraded} ${catInfo.label} upgraded to ${passengerCategoryInfo(upgradeBerth).label}` : `${total} ${catInfo.label}`);
    }
    if (!parts.length) return; // nothing taken, nothing to save or pay

    await saveShipData(this.doc, freshShip);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: totalIncome,
      description: `${freshShip.name}: Passengers boarded (${parts.join(", ")}) - ${originWorld.Name} to ${destWorld.Name}`,
      source: `ship:${this.docId}`
    });
    logDebugBlock(`Passengers boarded ${freshShip.name}`, [
      `${parts.join(", ")} - ${originWorld.Name} to ${destWorld.Name}`,
      `Total income: Cr${totalIncome}`
    ]);
    this._renderContent();
  }

  // Clears the whole manifest (boarded and refunded alike) once everyone's
  // reached the destination — their fares were already posted to Group
  // Finance when they boarded, so this doesn't touch money, just frees up
  // every berth for the next leg. Use Refund beforehand for anyone who
  // shouldn't have been carried.
  async _action_disembark_passengers() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    if (!(ship.passengers || []).length) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Disembark All Passengers" },
      content: "<p>Clear this ship's entire passenger manifest? This frees all berths but does not refund anyone — use Refund first for anyone who shouldn't have been carried.</p>"
    });
    if (!ok) return;
    ship.passengers = [];
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  _generatedPassengerName(category) {
    const nameGen = game.modules.get("traveller-name-generator");
    if (nameGen?.active && typeof nameGen.api?.generateName === "function") {
      try { return nameGen.api.generateName(); } catch (err) { /* fall through to the generic label below */ }
    }
    return passengerCategoryInfo(category).label;
  }

  // Shows the roll results per category alongside how many can actually be
  // boarded given berth capacity — own berths first, then any spare
  // capacity one tier up per computeBoardingPlan — and lets the GM pick how
  // many of each to take (capped at that boardable count) before resolving
  // with those totals, or null if cancelled.
  _showPassengerGenerationResults(generation, plan) {
    const { origin, destination, distanceParsecs, results } = generation;
    const rows = PASSENGER_CATEGORIES.map(c => {
      const r = results[c.id];
      const fare = passengerIncome(distanceParsecs, c.id);
      const p = plan[c.id];
      const upgradeNote = p.upgraded > 0
        ? `<br><span class="tt-source-name">incl. ${p.upgraded} upgraded to ${passengerCategoryInfo(NEXT_HIGHER_CATEGORY[c.id]).label}</span>`
        : "";
      return `
        <tr>
          <td><span class="tt-badge" style="color:${c.color}">${c.label}</span></td>
          <td class="tt-mono">${r.roll} (${r.diceCount}D6)</td>
          <td class="tt-mono">${r.count}</td>
          <td class="tt-mono">${p.maxTake}${upgradeNote}</td>
          <td class="tt-mono">${fmtCr(fare)}</td>
          <td><input type="number" class="tt-cell-input" data-tt-take="${c.id}" min="0" max="${p.maxTake}" value="${p.maxTake}" style="width:60px;"></td>
        </tr>`;
    }).join("");
    const content = document.createElement("div");
    content.innerHTML = `
      <div id="tt-root">
        <p class="tt-hint">${esc(origin.Name || "")} &rarr; ${esc(destination.Name || "")}, ${distanceParsecs} parsec${distanceParsecs === 1 ? "" : "s"}. "Can board" is capped by remaining berths — own category first, then any spare berths one tier up (paying this category's fare).</p>
        <table class="tt-table">
          <thead><tr><th>Category</th><th>Roll</th><th>Generated</th><th>Can Board</th><th>Fare</th><th>Take</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    // Read from the LIVE rendered form (button.form) inside the button's
    // own callback, not from this detached `content` element — DialogV2
    // stringifies `content` and rebuilds fresh DOM from it, so this
    // element is never actually shown (confirmed via Foundry's own
    // DialogV2 docs, 2026-09-16).
    return new Promise(resolve => {
      let resolved = false;
      const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
      createDialogV2({
        window: { title: "Generate Passengers" },
        content,
        buttons: [
          {
            action: "confirm", label: "Board Selected Passengers", default: true,
            callback: (event, button) => {
              const taken = {};
              for (const c of PASSENGER_CATEGORIES) {
                const el = button.form.querySelector(`[data-tt-take="${c.id}"]`);
                taken[c.id] = Math.max(0, Math.min(plan[c.id].maxTake, Number(el?.value) || 0));
              }
              finish(taken);
              return taken;
            }
          },
          { action: "cancel", label: "Cancel", callback: () => { finish(null); return null; } }
        ],
        rejectClose: false
      }, () => finish(null)).render(true);
    });
  }

  async _action_add_passenger() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
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
    const ship = getShipData(this.doc);
    ship.passengers = ship.passengers || [];
    ship.passengers.push({
      id: uid(), name, description: catInfo.label, category, parsecs, destination,
      income, refunded: false, realTime: new Date().toISOString(), gameDate: getCampaignDate()
    });
    await saveShipData(this.doc, ship);

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: income,
      description: `${ship.name}: Passage - ${name} (${catInfo.label}, ${parsecs}pc) to ${destination || "?"}`,
      source: `ship:${this.docId}`
    });

    this._renderContent();
  }

  async _action_refund_passenger(btn) {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    const p = (ship.passengers || []).find(x => x.id === btn.dataset.id);
    if (!p || p.refunded) return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Refund Passenger" }, content: `<p>Refund ${esc(p.name)}'s fare of ${fmtCr(p.income)}?</p>` });
    if (!ok) return;
    p.refunded = true;
    await saveShipData(this.doc, ship);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, { amount: -p.income, description: `${ship.name}: Refund - ${p.name}`, source: `ship:${this.docId}` });
    this._renderContent();
  }

  async _action_upgrade_passenger(btn) {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    const p = (ship.passengers || []).find(x => x.id === btn.dataset.id);
    if (!p || RANK[btn.dataset.to] <= RANK[p.category]) return;
    p.category = btn.dataset.to;
    p.description = passengerCategoryInfo(p.category).label;
    await saveShipData(this.doc, ship);
    this._renderContent();
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
            ${customSelectHtml("_selectCostPeriod", RECURRING_COST_PERIODS, "30")}
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
    if (!canEdit(this.doc)) return;
    const descEl = this.root.querySelector("#tt-cost-desc");
    const amountEl = this.root.querySelector("#tt-cost-amount");
    const periodWrapper = this.root.querySelector('[data-tt-select-handler="_selectCostPeriod"]');
    const period = periodWrapper.querySelector(".tt-select-opt.selected")?.dataset.ttSelectOpt || "30";
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    if (!description || !amount) { ui.notifications.warn("Enter a description and amount."); return; }
    const ship = getShipData(this.doc);
    ship.costs = ship.costs || { recurring: [] };
    ship.costs.recurring = ship.costs.recurring || [];
    // lastAppliedDay starts at today, not null — processRecurring's
    // "just-created" fallback stamps a null entry to the current day and
    // charges nothing for that call, so if this same call is also the one
    // that has to catch up a large time jump (nothing else runs
    // processRecurring in between), starting from null would silently
    // swallow the whole jump instead of charging for it.
    ship.costs.recurring.push({ id: uid(), description, amount, period, lastAppliedDay: gameDayIndex() });
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _action_remove_ship_cost(btn) {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    ship.costs.recurring = (ship.costs.recurring || []).filter(c => c.id !== btn.dataset.id);
    await saveShipData(this.doc, ship);
    this._renderContent();
  }

  async _action_pay_starport() {
    if (!canEdit(this.doc)) return;
    const ship = getShipData(this.doc);
    const starportCosts = (ship.costs?.recurring || []).filter(c => c.period === "starport");
    if (!starportCosts.length) return;
    const financeDoc = await getFinanceDoc();
    for (const c of starportCosts) {
      await postTransaction(financeDoc, { amount: -Math.abs(c.amount), description: `${ship.name}: ${c.description} (Starport)`, source: `ship:${this.docId}` });
    }
    ui.notifications.info(`Paid ${starportCosts.length} starport cost(s) for ${ship.name}.`);
    this._renderContent();
  }

  async _action_add_oneoff_cost() {
    if (!canEdit(this.doc)) return;
    const descEl = this.root.querySelector("#tt-oneoff-desc");
    const amountEl = this.root.querySelector("#tt-oneoff-amount");
    const description = descEl.value.trim();
    const amount = Math.abs(Number(amountEl.value)) || 0;
    if (!description || !amount) { ui.notifications.warn("Enter a description and amount."); return; }
    const ship = getShipData(this.doc);
    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, { amount: -amount, description: `${ship.name}: ${description}`, source: `ship:${this.docId}` });
    this._renderContent();
  }

  // ---- Field edits (config + notes) --------------------------------------
  async _onFieldChange(el) {
    const path = el.dataset.ttField;
    if (!path.startsWith("ship.")) return;
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const value = el.type === "checkbox" ? el.checked : (el.dataset.ttNumeric === "true" ? Number(el.value) || 0 : el.value);
    const ship = getShipData(this.doc);
    foundry.utils.setProperty(ship, path.replace(/^ship\./, ""), value);
    await saveShipData(this.doc, ship);
    this._renderContent();
  }
}

function isStorageKind(doc) {
  return doc.getFlag(MODULE_ID, "kind") === "storage";
}
