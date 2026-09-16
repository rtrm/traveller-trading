import { TRADE_GOODS_FOLDER, DEFAULT_ITEM_ICON } from "./constants.mjs";
import { getFinanceDoc, postTransaction, getShipData, saveShipData, canEdit } from "./data.mjs";
import { TradingWindowBase, esc, fmtCr } from "./window-base.mjs";
import { resolveLocation, pickLocationCandidate } from "./destination-map.mjs";
import { fetchWorldInfo } from "./travel-roll-utils.mjs";
import { addOrMergeCargo, removeCargoQuantity, cargoSpaceUsage } from "./cargo-utils.mjs";
import {
  TRADE_CODES, describeUwp, worldTradeCodes, generateMarket, rollPriceOffer, typicalPriceRange,
  rollLocalBrokerSkill, goodByName, goodByD66
} from "./trade-data.mjs";
import { logDebugBlock, fmtTonsRoll, fmtPriceOffer, fmtRerolls } from "./debug-log.mjs";

const instances = new Map(); // `${docId}:${mode}` -> TradeMarketApp

export function openTradeMarketApp({ docId, mode }) {
  const key = `${docId}:${mode}`;
  const existing = instances.get(key);
  if (existing && existing.rendered) { existing.bringToTop(); return existing; }
  const app = new TradeMarketApp(docId, mode);
  instances.set(key, app);
  app.render(true);
  return app;
}

export function closeTradeMarketAppsIfOpen(docId) {
  for (const [key, app] of Array.from(instances.entries())) {
    if (key.startsWith(`${docId}:`)) app.close();
  }
}

// Finds the standard Trade Goods Item (created via the module's own "Check /
// Create Trade Goods" settings menu) matching a good's name, so a
// speculative-trade purchase links to the same Item a manual drag-and-drop
// would — giving it an icon and letting addOrMergeCargo's dedup match a
// later top-up of the same good.
function findTradeGoodItem(name) {
  return game.items.find(i => i.name === name && i.folder?.name === TRADE_GOODS_FOLDER);
}

class TradeMarketApp extends TradingWindowBase {
  constructor(docId, mode, options) {
    super(options);
    this.docId = docId;
    this.mode = mode; // "buy" | "sell"
    this.doc = game.journal.get(docId);
    this.shipLocation = "";
    this.world = null;
    this.loadError = "";
    this.worldCodes = new Set();
    this.market = null;      // buy mode: { codes, pop, popMod, entries, rollLog }
    this.priceOffers = null; // buy mode: Map(goodName -> offer)
    this.sellRows = null;    // sell mode: [{ good, rows, totalQty, offer }]
    this.useBroker = false;
    this.brokerRoll = null;  // { dice, sum, skill }
    this.blackMarket = false; // buy mode only
    this.counterpartSkill = 2;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["traveller-trading-window"],
      width: 860,
      height: 680,
      resizable: true
    });
  }

  get id() { return `tt-trade-app-${this.mode}-${this.docId}`; }

  get title() {
    const name = this.doc?.name?.replace(/^Starship: |^Storage: /, "");
    return `${this.mode === "buy" ? "Buy Goods" : "Sell Goods"} — ${name || ""}`;
  }

  async close(options) {
    instances.delete(`${this.docId}:${this.mode}`);
    return super.close(options);
  }

  activateListeners(html) {
    super.activateListeners(html);
    this.root.addEventListener("change", (e) => {
      if (e.target.matches("[data-tt-counterpart-skill]")) {
        this.counterpartSkill = Math.max(0, Number(e.target.value) || 0);
        this._rollMarket();
        this._renderContent();
      }
    });
  }

  async _load() {
    this.doc = game.journal.get(this.docId);
    if (!this.doc) return;
    const ship = getShipData(this.doc);
    this.shipLocation = ship.location || "";
    await this._resolveWorld();
    if (this.world) this._rollMarket();
  }

  async _resolveWorld() {
    this.loadError = "";
    this.world = null;
    if (!this.shipLocation.trim()) { this.loadError = "Set a Current Location on the Configuration tab first."; return; }
    const candidates = await resolveLocation(this.shipLocation);
    if (!candidates.length) { this.loadError = `Couldn't find "${this.shipLocation}" on Traveller Map.`; return; }
    let picked = candidates[0];
    if (candidates.length > 1) {
      picked = await pickLocationCandidate(candidates);
      if (!picked) { this.loadError = "No location selected."; return; }
    }
    try {
      this.world = await fetchWorldInfo(picked.sector, picked.hex);
      if (!this.world) this.loadError = `Couldn't find ${picked.sector} ${picked.hex} on Traveller Map.`;
    } catch (err) {
      console.warn("Traveller Trading | Trade market world lookup failed", err);
      this.loadError = "Couldn't reach Traveller Map.";
    }
  }

  _currentBrokerSkill(ship) {
    if (this.useBroker && this.brokerRoll) return { skill: this.brokerRoll.skill, bonus: 2 };
    return { skill: Number(ship?.skills?.broker) || 0, bonus: 0 };
  }

  _rollMarket() {
    if (!this.world) return;
    const ship = getShipData(this.doc);
    this.brokerRoll = this.useBroker ? rollLocalBrokerSkill() : null;
    const { skill, bonus } = this._currentBrokerSkill(ship);

    if (this.mode === "buy") {
      this.market = generateMarket(this.world, { blackMarket: this.blackMarket });
      this.priceOffers = new Map();
      for (const entry of this.market.entries) {
        const offer = rollPriceOffer({
          mode: "purchase", good: entry.good, worldCodes: this.market.codes,
          brokerSkill: skill, brokerBonus: bonus, counterpartSkill: this.counterpartSkill
        });
        this.priceOffers.set(entry.good.name, offer);
      }
      this._logMarketRoll();
    } else {
      this.worldCodes = worldTradeCodes(this.world);
      const byGood = new Map();
      for (const row of (ship.cargo || [])) {
        const good = goodByName(row.itemName);
        if (!good || !good.price) continue;
        if (!byGood.has(good.name)) byGood.set(good.name, { good, rows: [] });
        byGood.get(good.name).rows.push(row);
      }
      this.sellRows = Array.from(byGood.values()).map(({ good, rows }) => {
        const offer = rollPriceOffer({
          mode: "sale", good, worldCodes: this.worldCodes,
          brokerSkill: skill, brokerBonus: bonus, counterpartSkill: this.counterpartSkill
        });
        const totalQty = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
        return { good, totalQty, offer };
      }).sort((a, b) => a.good.name.localeCompare(b.good.name));
      this._logSellRoll();
    }
  }

  // ---- Logging (session debug log) ---------------------------------------
  _logMarketRoll() {
    const lines = [];
    lines.push(`World: ${this.world.Name} (${this.world.Sector} ${this.world.Hex}) UWP ${this.world.UWP} Zone ${this.world.Zone || "G"}`);
    lines.push(`Trade codes: ${[...this.market.codes].join(", ") || "none"}`);
    lines.push(`Population ${this.market.pop ?? "?"} -> quantity DM ${this.market.popMod >= 0 ? "+" : ""}${this.market.popMod}`);
    lines.push(`Black market: ${this.blackMarket ? "yes" : "no"}`);
    if (this.useBroker && this.brokerRoll) lines.push(`Local broker/fixer: Broker ${this.brokerRoll.skill} (2D6=[${this.brokerRoll.dice.join("+")}]/3)`);
    for (const r of this.market.rollLog) {
      if (r.note) {
        lines.push(`${r.note}${r.code != null ? ` -> D66 ${r.code} = ${goodByD66(r.code)?.name}` : ""}`);
        lines.push(...fmtRerolls(r.rerolls));
      } else {
        lines.push(`Good "${r.good}" (${r.source}):`);
        lines.push(fmtTonsRoll("tons", r.tonsRoll));
      }
    }
    for (const entry of this.market.entries) {
      lines.push(`Offer "${entry.good.name}":`);
      lines.push(...fmtPriceOffer(this.priceOffers.get(entry.good.name)));
    }
    logDebugBlock(`Speculative Trade — Market rolled at ${this.world.Name}`, lines);
  }

  _logSellRoll() {
    const lines = [];
    lines.push(`World: ${this.world.Name} (${this.world.Sector} ${this.world.Hex}) UWP ${this.world.UWP} Zone ${this.world.Zone || "G"}`);
    lines.push(`Trade codes: ${[...this.worldCodes].join(", ") || "none"}`);
    if (this.useBroker && this.brokerRoll) lines.push(`Local broker: Broker ${this.brokerRoll.skill} (2D6=[${this.brokerRoll.dice.join("+")}]/3)`);
    for (const row of this.sellRows) {
      lines.push(`Offer "${row.good.name}" (${row.totalQty}t in hold):`);
      lines.push(...fmtPriceOffer(row.offer));
    }
    logDebugBlock(`Speculative Trade — Sale offers rolled at ${this.world.Name}`, lines);
  }

  // ---- Rendering ----------------------------------------------------------
  _worldHeaderHtml() {
    if (this.loadError) return `<p class="tt-empty">${esc(this.loadError)}</p>`;
    if (!this.world) return `<p class="tt-empty">Loading…</p>`;
    const w = this.world;
    const uwpParts = describeUwp(w.UWP) || [];
    const codes = this.mode === "buy" ? this.market?.codes : this.worldCodes;
    const codeChips = [...(codes || [])].sort().map(c =>
      `<span class="tt-badge" title="${esc(TRADE_CODES[c] || c)}">${esc(c)} ${esc(TRADE_CODES[c] || "")}</span>`
    ).join(" ");
    const zoneLabel = w.Zone === "A" ? "Amber" : (w.Zone === "R" ? "Red" : "Green");
    return `
      <div class="tt-panel-box">
        <h3>${esc(w.Name || "(unnamed)")} — ${esc(w.Sector || "")} ${esc(w.Hex || "")}</h3>
        <div class="tt-mono" style="margin-bottom:8px;">${esc(w.UWP || "")}</div>
        <div class="tt-inline-row" style="margin-bottom:8px;">
          ${uwpParts.map(p => `<span class="tt-badge">${esc(p.label)}: ${esc(p.value)}</span>`).join(" ")}
          <span class="tt-badge">Zone: ${zoneLabel}</span>
        </div>
        <div class="tt-inline-row">${codeChips || `<span class="tt-source-name">No trade codes</span>`}</div>
      </div>`;
  }

  _controlsHtml(editable) {
    const brokerNote = this.useBroker && this.brokerRoll
      ? `<p class="tt-hint">Local ${this.blackMarket ? "fixer" : "broker"}: Broker ${this.brokerRoll.skill} (2D6=[${this.brokerRoll.dice.join("+")}]/3), +2 negotiation DM, ${this.blackMarket ? "20" : "10"}% fee on completed deals.</p>`
      : "";
    return `
      <div class="tt-inline-row" style="margin-bottom:6px;">
        <label class="tt-field-checkbox" style="margin:0;"><input type="checkbox" data-tt-action="toggle-broker" ${this.useBroker ? "checked" : ""} ${editable ? "" : "disabled"}> Hire local ${this.blackMarket ? "fixer" : "broker"}</label>
        ${this.mode === "buy" ? `<label class="tt-field-checkbox" style="margin:0;"><input type="checkbox" data-tt-action="toggle-blackmarket" ${this.blackMarket ? "checked" : ""} ${editable ? "" : "disabled"}> Black market</label>` : ""}
        <label style="font-size:12.5px;color:var(--text-muted);">Counterpart Broker</label>
        <input type="number" class="tt-input" style="width:60px;" data-tt-counterpart-skill value="${this.counterpartSkill}" min="0" ${editable ? "" : "disabled"}>
        ${editable ? `<button type="button" class="tt-btn" data-tt-action="reroll-market">${this.mode === "buy" ? "Reroll Market" : "Reroll Offers"}</button>` : ""}
      </div>
      ${brokerNote}`;
  }

  _dmCodesHtml(dmList, codes) {
    const matched = dmList.filter(d => codes.has(d.code));
    return matched.length ? matched.map(d => `${d.code} ${d.dm >= 0 ? "+" : ""}${d.dm}`).join(", ") : "—";
  }

  _buyTableHtml(editable, usage) {
    const codes = this.market.codes;
    const rows = this.market.entries.map(entry => {
      const offer = this.priceOffers.get(entry.good.name);
      const range = typicalPriceRange({
        mode: "purchase", good: entry.good, worldCodes: codes,
        brokerSkill: offer.brokerSkill, brokerBonus: offer.brokerBonus, counterpartSkill: offer.counterpartSkill
      });
      const maxQty = Math.max(0, Math.min(entry.availableTons, usage.remaining));
      return `
        <tr>
          <td>${esc(entry.good.name)}${entry.good.illegal ? ` <span class="tt-badge" style="color:var(--red);">illegal</span>` : ""}</td>
          <td class="tt-mono">${entry.availableTons}</td>
          <td class="tt-mono">${fmtCr(entry.good.price)}</td>
          <td class="tt-mono">${fmtCr(range.low)}&ndash;${fmtCr(range.high)}</td>
          <td class="tt-mono" style="color:var(--gold);">${fmtCr(offer.unitPrice)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(entry.good.purchaseDM, codes)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(entry.good.saleDM, codes)}</td>
          <td><input type="number" class="tt-cell-input" data-tt-buy-qty="${esc(entry.good.name)}" min="0" max="${maxQty}" value="0" style="width:70px;" ${editable && maxQty > 0 ? "" : "disabled"}></td>
          <td>${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="buy-good" data-name="${esc(entry.good.name)}" ${maxQty > 0 ? "" : "disabled"}>Buy</button>` : ""}</td>
        </tr>`;
    }).join("");
    return `
      <div class="tt-cargo-summary">Hold space: ${usage.used} / ${usage.total} tons (${usage.remaining} free)</div>
      <table class="tt-table">
        <thead><tr><th>Good</th><th>Available (t)</th><th>Base Cr/t</th><th>Typical Cr/t</th><th>Offered Cr/t</th><th>Buying benefits</th><th>Selling benefits</th><th>Qty (t)</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="tt-empty">No goods on offer.</td></tr>`}</tbody>
      </table>`;
  }

  _sellTableHtml(editable) {
    const codes = this.worldCodes;
    const rows = (this.sellRows || []).map(row => {
      const range = typicalPriceRange({
        mode: "sale", good: row.good, worldCodes: codes,
        brokerSkill: row.offer.brokerSkill, brokerBonus: row.offer.brokerBonus, counterpartSkill: row.offer.counterpartSkill
      });
      return `
        <tr>
          <td>${esc(row.good.name)}</td>
          <td class="tt-mono">${row.totalQty}</td>
          <td class="tt-mono">${fmtCr(row.good.price)}</td>
          <td class="tt-mono">${fmtCr(range.low)}&ndash;${fmtCr(range.high)}</td>
          <td class="tt-mono" style="color:var(--teal);">${fmtCr(row.offer.unitPrice)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(row.good.purchaseDM, codes)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(row.good.saleDM, codes)}</td>
          <td><input type="number" class="tt-cell-input" data-tt-sell-qty="${esc(row.good.name)}" min="0" max="${row.totalQty}" value="0" style="width:70px;" ${editable ? "" : "disabled"}></td>
          <td>${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="sell-good" data-name="${esc(row.good.name)}">Sell</button>` : ""}</td>
        </tr>`;
    }).join("");
    return `
      <table class="tt-table">
        <thead><tr><th>Good</th><th>In Hold (t)</th><th>Base Cr/t</th><th>Typical Cr/t</th><th>Offered Cr/t</th><th>Buying benefits</th><th>Selling benefits</th><th>Qty (t)</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="tt-empty">No recognized trade goods in the hold.</td></tr>`}</tbody>
      </table>`;
  }

  _renderContent() {
    const titleEl = this.element?.[0]?.querySelector(".window-title");
    if (titleEl) titleEl.textContent = this.title;

    if (!this.doc) { this.root.innerHTML = `<p class="tt-empty">This starship/storage no longer exists.</p>`; return; }
    const editable = canEdit(this.doc);
    let body = "";
    if (!this.loadError && this.world) {
      if (this.mode === "buy") {
        const ship = getShipData(this.doc);
        body = this._buyTableHtml(editable, cargoSpaceUsage(ship));
      } else {
        body = this._sellTableHtml(editable);
      }
    }
    this.root.innerHTML = `
      <div class="tt-trade">
        <p class="tt-hint">${this.mode === "buy"
          ? `Goods on offer from a supplier at the ship's current location, with all DMs already applied. "Typical" is a representative price band, not the best/worst possible roll.`
          : `Sale offers for recognized trade goods currently in the hold. Browsing costs nothing — nothing sells until you click Sell.`}</p>
        ${this._worldHeaderHtml()}
        ${!this.loadError && this.world ? this._controlsHtml(editable) : ""}
        ${body}
      </div>`;
  }

  // ---- Actions --------------------------------------------------------------
  async _action_toggle_broker(btn) {
    if (!canEdit(this.doc)) return;
    this.useBroker = btn.checked;
    this._rollMarket();
    this._renderContent();
  }

  async _action_toggle_blackmarket(btn) {
    if (!canEdit(this.doc)) return;
    this.blackMarket = btn.checked;
    this._rollMarket();
    this._renderContent();
  }

  async _action_reroll_market() {
    if (!canEdit(this.doc)) return;
    await this._resolveWorld();
    if (this.world) this._rollMarket();
    this._renderContent();
  }

  async _action_buy_good(btn) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const name = btn.dataset.name;
    const input = this.root.querySelector(`[data-tt-buy-qty="${CSS.escape(name)}"]`);
    const requested = Math.max(0, Number(input?.value) || 0);
    if (!requested) return;
    const entry = this.market.entries.find(e => e.good.name === name);
    const offer = this.priceOffers.get(name);
    if (!entry || !offer) return;

    const ship = getShipData(this.doc);
    const usage = cargoSpaceUsage(ship);
    const finalQty = Math.min(requested, entry.availableTons, usage.remaining);
    if (finalQty <= 0) { ui.notifications.warn("Not enough hold space or market stock."); return; }

    const goodsCost = finalQty * offer.unitPrice;
    const brokerFee = this.useBroker ? Math.round(goodsCost * (this.blackMarket ? 0.2 : 0.1)) : 0;
    const totalCost = goodsCost + brokerFee;

    const sourceItem = findTradeGoodItem(name);
    addOrMergeCargo(ship, {
      itemName: name, unitValue: offer.unitPrice,
      img: sourceItem?.img || DEFAULT_ITEM_ICON, sourceUuid: sourceItem?.uuid || null,
      quantity: finalQty
    });
    await saveShipData(this.doc, ship);

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: -totalCost,
      description: `${ship.name}: Bought ${finalQty}t ${name} @ Cr${offer.unitPrice}/t at ${this.world.Name}${brokerFee ? ` (incl. Cr${brokerFee} broker fee)` : ""}`,
      source: `ship:${this.docId}`
    });

    entry.availableTons -= finalQty;

    logDebugBlock(`Speculative Trade — BUY ${finalQty}t ${name} at ${this.world.Name}`, [
      ...fmtPriceOffer(offer),
      `  Quantity bought: ${finalQty}t x Cr${offer.unitPrice} = Cr${goodsCost}${brokerFee ? ` + Cr${brokerFee} broker fee = Cr${totalCost}` : ""}`
    ]);

    this._renderContent();
  }

  async _action_sell_good(btn) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const name = btn.dataset.name;
    const input = this.root.querySelector(`[data-tt-sell-qty="${CSS.escape(name)}"]`);
    const requested = Math.max(0, Number(input?.value) || 0);
    if (!requested) return;
    const row = this.sellRows.find(r => r.good.name === name);
    if (!row) return;
    const finalQty = Math.min(requested, row.totalQty);
    if (finalQty <= 0) return;

    const ship = getShipData(this.doc);
    let remaining = finalQty;
    for (const c of (ship.cargo || []).filter(c => c.itemName === name)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(c.quantity) || 0);
      removeCargoQuantity(ship, c.id, take);
      remaining -= take;
    }
    await saveShipData(this.doc, ship);

    const proceeds = finalQty * row.offer.unitPrice;
    const brokerFee = this.useBroker ? Math.round(proceeds * 0.1) : 0;
    const netProceeds = proceeds - brokerFee;

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: netProceeds,
      description: `${ship.name}: Sold ${finalQty}t ${name} @ Cr${row.offer.unitPrice}/t at ${this.world.Name}${brokerFee ? ` (after Cr${brokerFee} broker fee)` : ""}`,
      source: `ship:${this.docId}`
    });

    logDebugBlock(`Speculative Trade — SELL ${finalQty}t ${name} at ${this.world.Name}`, [
      ...fmtPriceOffer(row.offer),
      `  Quantity sold: ${finalQty}t x Cr${row.offer.unitPrice} = Cr${proceeds}${brokerFee ? ` - Cr${brokerFee} broker fee = Cr${netProceeds}` : ""}`
    ]);

    row.totalQty -= finalQty;
    if (row.totalQty <= 0) this.sellRows = this.sellRows.filter(r => r !== row);
    this._renderContent();
  }
}
