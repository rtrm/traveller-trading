import { MODULE_ID, DEFAULT_ITEM_ICON } from "./constants.mjs";
import {
  getFinanceDoc, postTransaction, getShipData, saveShipData, deleteShipDoc, canEdit,
  getCampaignDate, gameDayIndex, uid
} from "./data.mjs";
import { PASSENGER_CATEGORIES, passengerCategoryInfo, passengerIncome, RECURRING_COST_PERIODS } from "./constants.mjs";
import { TradingWindowBase, customSelectHtml, esc, fmtCr } from "./window-base.mjs";

const RANK = { low: 0, basic: 1, middle: 2, high: 3 };
const instances = new Map(); // docId -> ShipApp

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

// Merges a dragged/dropped quantity into an existing cargo row for the same
// item (matched by its source Item's uuid and current price/ton) rather
// than piling up a separate row per drop, so the hold's total stays a
// single accurate line per good.
function addOrMergeCargo(ship, { itemName, unitValue, img, sourceUuid, quantity }) {
  ship.cargo = ship.cargo || [];
  const existing = sourceUuid && ship.cargo.find(c => c.sourceUuid === sourceUuid && Number(c.unitValue) === Number(unitValue));
  if (existing) {
    existing.quantity = (Number(existing.quantity) || 0) + quantity;
    if (img && !existing.img) existing.img = img;
  } else {
    ship.cargo.push({ id: uid(), itemName, quantity, unitValue, notes: "", sourceUuid, img: img || DEFAULT_ITEM_ICON });
  }
}

// Reduces a cargo row by the given quantity, dropping the row entirely once
// it hits zero (used both for the "remove" button and for the source side
// of a cargo transfer).
function removeCargoQuantity(ship, cargoId, quantity) {
  ship.cargo = ship.cargo || [];
  const row = ship.cargo.find(c => c.id === cargoId);
  if (!row) return;
  row.quantity = (Number(row.quantity) || 0) - quantity;
  if (row.quantity <= 0) ship.cargo = ship.cargo.filter(c => c.id !== cargoId);
}

// A single-field numeric Dialog, wrapped in the shared "#tt-root" id so the
// module's scoped CSS reaches it (Dialog content renders outside any
// window's own #tt-root — see the matching note in finance-app.mjs).
// Resolves null on cancel or an empty/zero entry, so callers can treat
// falsy as "nothing to do" uniformly.
async function promptQuantity({ title, label, defaultValue, max }) {
  const content = `
    <div id="tt-root">
      <div class="tt-field">
        <label>${esc(label)}</label>
        <input type="number" id="tt-dlg-qty" min="0" ${max != null ? `max="${max}"` : ""} value="${defaultValue}">
      </div>
    </div>`;
  const result = await Dialog.prompt({
    title,
    content,
    label: "Confirm",
    callback: (html) => Math.max(0, Number(html[0].querySelector("#tt-dlg-qty").value) || 0),
    rejectClose: false
  });
  return result || null;
}

export function openShipApp(docId) {
  const existing = instances.get(docId);
  if (existing && existing.rendered) { existing.bringToTop(); return existing; }
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

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["traveller-trading-window"],
      width: 680,
      height: 680,
      resizable: true
    });
  }

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

  activateListeners(html) {
    super.activateListeners(html);
    this.root.addEventListener("dragenter", (e) => {
      console.log(`Traveller Trading | dragenter on "${this.doc?.name}"`);
      e.preventDefault();
    });
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
    });
  }

  _renderContent() {
    this.doc = game.journal.get(this.docId);
    if (!this.doc) { this.close(); return; }
    // Application only reads the title getter when the outer chrome first
    // renders; patch the header text directly so a renamed ship/storage
    // updates its window title without a disruptive full re-render.
    const titleEl = this.element?.[0]?.querySelector(".window-title");
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
    const body = this._shipTabHtml(this.doc);
    this.root.innerHTML = `<div class="tt-ship">${tabsHtml}<div class="tt-ship-body">${body}</div></div>`;
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
        ${game.user.isGM ? `<button type="button" class="tt-btn tt-btn-ghost" style="margin-top:16px;" data-tt-action="delete-ship">Delete this ${isStorageKind(doc) ? "storage location" : "starship"}</button>` : ""}
      </div>`;
  }

  async _action_delete_ship() {
    const ok = await Dialog.confirm({ title: "Delete", content: "<p>Delete this entry? This cannot be undone.</p>" });
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
    const totalValue = cargo.reduce((s, c) => s + (Number(c.quantity) || 0) * (Number(c.unitValue) || 0), 0);
    const totalTons = cargo.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const spaceLine = isStorage
      ? `${totalTons} tons stored`
      : `Cargo space used: ${totalTons} / ${ship.cargoSpace || 0} tons`;
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
                  <div class="tt-cargo-drag" data-tt-cargo-row data-id="${c.id}" ${editable ? 'draggable="true"' : ""}>
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
      </div>`;
  }

  // Accepts a drop anywhere in the window, regardless of which tab is
  // currently showing — the drop is always cargo, so it's always handled
  // and the view switches to the Cargo tab to show the result.
  async _onDrop(event) {
    event.preventDefault();
    console.log(`Traveller Trading | drop received on "${this.doc?.name}" (${this.docId})`);
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (err) {
      console.log("Traveller Trading | drop ignored: payload wasn't JSON", err);
      return;
    }
    console.log("Traveller Trading | drop payload", data);
    if (!data?.uuid || data.type !== "Item") { console.log("Traveller Trading | drop ignored: not an Item-shaped payload"); return; }
    if (!canEdit(this.doc)) {
      console.log(`Traveller Trading | drop blocked: no edit permission on "${this.doc?.name}"`);
      ui.notifications.warn("You don't have permission to add cargo here.");
      return;
    }

    if (data.ttCargo) {
      // One of our own cargo rows, dragged from another (or this) ship/
      // warehouse window — claimed immediately (before any await) so the
      // dragging window's dragend handler knows not to also treat this as
      // a drop it doesn't control.
      claimDrag(data.ttCargo.dragId);
      if (data.ttCargo.docId === this.docId) { console.log("Traveller Trading | drop ignored: dropped back on its own hold"); return; }
      const sourceDoc = game.journal.get(data.ttCargo.docId);
      if (!sourceDoc) { console.log(`Traveller Trading | drop ignored: source doc ${data.ttCargo.docId} not found`); return; }
      const available = Number(data.ttCargo.quantity) || 0;
      const amount = await promptQuantity({
        title: "Move Cargo",
        label: `Move how many tons of ${data.ttCargo.itemName} (of ${available} available)?`,
        defaultValue: available,
        max: available
      });
      if (!amount) { console.log("Traveller Trading | move cancelled or zero quantity entered"); return; }
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
    if (!item) { console.log(`Traveller Trading | drop ignored: fromUuid("${data.uuid}") resolved to nothing`); return; }
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
    if (!amount) { console.log("Traveller Trading | add cargo cancelled or zero quantity entered"); return; }
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
    if (!c) { console.log(`Traveller Trading | dragstart: row id ${row.dataset.id} not found in cargo`); event.preventDefault(); return; }
    const dragId = uid();
    row.dataset.ttDragId = dragId;
    const payload = {
      type: "Item",
      uuid: c.sourceUuid,
      ttCargo: { dragId, docId: this.docId, cargoId: c.id, quantity: Number(c.quantity) || 0, unitValue: Number(c.unitValue) || 0, itemName: c.itemName, img: c.img }
    };
    console.log(`Traveller Trading | dragstart: dragging ${c.quantity}t of "${c.itemName}" from "${this.doc?.name}"`, payload);
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
    console.log(`Traveller Trading | dragend: dropEffect="${event.dataTransfer.dropEffect}", claimed=${claimedDragIds.has(dragId)}`);
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
            ${customSelectHtml("_selectPassCategory", PASSENGER_CATEGORIES.map(c => ({ value: c.id, label: c.label })), "basic")}
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
    const ok = await Dialog.confirm({ title: "Refund Passenger", content: `<p>Refund ${esc(p.name)}'s fare of ${fmtCr(p.income)}?</p>` });
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
