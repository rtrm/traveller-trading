import { TRADE_GOODS_FOLDER, DEFAULT_ITEM_ICON } from "./constants.mjs";
import { getFinanceDoc, postTransaction, getShipData, saveShipData, canEdit, gameDayIndex } from "./data.mjs";
import { TradingWindowBase, esc, fmtCr } from "./window-base.mjs";
import { resolveLocation, pickLocationCandidate } from "./destination-map.mjs";
import { fetchWorldInfo } from "./travel-roll-utils.mjs";
import { addOrMergeCargo, removeCargoQuantity, cargoSpaceUsage } from "./cargo-utils.mjs";
import {
  TRADE_CODES, describeUwp, worldTradeCodes, rollPriceOffer, typicalPriceRange,
  goodByName, worldStarportClass, starportSearchDM, worldTechLevelValue
} from "./trade-data.mjs";
import { worldKeyFor, attemptDM, startSearch, finalizeSearch, resolveDueSearches } from "./supplier-search.mjs";
import { logDebugBlock, fmtPriceOffer } from "./debug-log.mjs";

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

// Sweeps for any supplier/buyer/broker searches whose wait has elapsed
// (see supplier-search.mjs), announces each outcome (a chat message
// everyone sees, plus a real Dialog popup on the GM's own client — the only
// client that runs this sweep), and refreshes any open trade window
// affected. Call this at "ready" (catch-up) and whenever the mgt2e
// campaign date changes (see main.mjs).
export async function checkPendingSupplierSearches() {
  const resolved = await resolveDueSearches();
  for (const { doc, mode, kind, record } of resolved) {
    const shipName = doc.name.replace(/^Starship: |^Storage: /, "");
    const purpose = kind === "contact" ? (mode === "buy" ? "supplier" : "buyer") : (record.blackMarket ? "fixer" : "local broker");
    let detail = "";
    if (record.success) {
      if (kind === "contact") {
        const count = mode === "buy" ? (record.market?.entries?.length || 0) : Object.keys(record.priceOffers || {}).length;
        detail = mode === "buy" ? ` ${count} good(s) are available to buy.` : ` ${count} good(s) in the hold have a buyer.`;
      } else {
        detail = ` They offer Broker ${record.broker.skill}.${record.broker.doubleCrosser ? " (Roll of natural 2 — they may be an informer, agent, or double-crosser!)" : ""}`;
      }
    }
    const message = record.success
      ? `<b>${esc(shipName)}</b>: your search for a ${purpose} at ${esc(record.world.Name)} was <b>successful</b>!${detail}`
      : `<b>${esc(shipName)}</b>: your search for a ${purpose} at ${esc(record.world.Name)} was <b>unsuccessful</b>.`;

    ChatMessage.create({ content: `<div>${message}</div>`, speaker: { alias: "Traveller Trading" } });
    if (game.user.isGM) {
      foundry.applications.api.DialogV2.prompt({
        window: { title: record.success ? "Search Successful" : "Search Unsuccessful" },
        content: `<div id="tt-root"><p>${message}</p></div>`,
        ok: { label: "OK" },
        rejectClose: false
      });
    }

    const app = instances.get(`${doc.id}:${mode}`);
    if (app?.rendered) app._renderContent();
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

// The "Find a Supplier" dialog (core rulebook p.241): the player picks a
// check type, sees the DMs that should apply (Starport size, previous
// attempts this month, and the rushed-search penalty if they check that
// box), then reports their own already-DM-adjusted total — this module
// never does that arithmetic for them, it only tells them what applies.
function showFindDialog({ title, purposeLabel, checkOptions, starportDM, priorDM }) {
  const dmLines = [
    `Starport DM: ${starportDM >= 0 ? "+" : ""}${starportDM}`,
    priorDM ? `Previous attempts here this month: ${priorDM}` : null,
    `Rushed search (if checked below): -2`
  ].filter(Boolean).join(" &middot; ");
  // Built as a detached element (rather than an HTML string) so the
  // callback below can read values directly off this same reference —
  // DialogV2's button.form (the <form> it wraps content in) turned out not
  // reliable to query through in practice, so this no longer depends on it
  // at all. DialogV2 requires the element passed as `content` itself to
  // have no attributes ("config.content element must have no attributes"),
  // so the actual "#tt-root" scoping div is nested one level inside it.
  const content = document.createElement("div");
  content.innerHTML = `
    <div id="tt-root">
      <p class="tt-hint">Average (8+) check to find a ${esc(purposeLabel)}.</p>
      <div class="tt-field">
        <label>Check Type</label>
        ${checkOptions.map((o, i) => `<label style="display:block;margin-bottom:4px;font-size:12.5px;"><input type="radio" name="tt-check-type" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}> ${esc(o.label)}</label>`).join("")}
      </div>
      <p class="tt-hint">DMs to apply: ${dmLines}</p>
      <div class="tt-field tt-field-checkbox"><label><input type="checkbox" id="tt-rush"> Rush the search (DM-2, resolves in 1D6&times;10 hours instead of the normal wait)</label></div>
      <div class="tt-field"><label>Your total (already-modified) check result</label><input type="number" id="tt-result" placeholder="e.g. 9"></div>
    </div>`;
  return foundry.applications.api.DialogV2.wait({
    window: { title },
    content,
    buttons: [
      {
        action: "ok", label: "Attempt Search", default: true,
        callback: () => {
          const checkType = content.querySelector('input[name="tt-check-type"]:checked')?.value || checkOptions[0].value;
          const rushed = content.querySelector("#tt-rush").checked;
          const result = content.querySelector("#tt-result").value;
          return result === "" ? null : { checkType, rushed, result: Number(result) };
        }
      },
      { action: "cancel", label: "Cancel", callback: () => null }
    ],
    rejectClose: false
  });
}

// A lighter dialog for a BROKER search: no check-type or player roll, since
// finding a broker isn't the Traveller's own skill check — it's rolled
// automatically using the prospective broker's own 2D/3 skill (see
// supplier-search.mjs's startSearch). Only "rush" is still a player choice.
function showBrokerSearchDialog({ title, purposeLabel, starportDM, priorDM }) {
  const dmLines = [
    `Starport DM: ${starportDM >= 0 ? "+" : ""}${starportDM}`,
    priorDM ? `Previous attempts here this month: ${priorDM}` : null,
    `Rushed search (if checked below): -2`
  ].filter(Boolean).join(" &middot; ");
  const content = document.createElement("div");
  content.innerHTML = `
    <div id="tt-root">
      <p class="tt-hint">Canvassing the local network for a ${esc(purposeLabel)} — this search is rolled automatically using the prospective ${esc(purposeLabel)}'s own skill, not a player check.</p>
      <p class="tt-hint">DMs applied: ${dmLines}</p>
      <div class="tt-field tt-field-checkbox"><label><input type="checkbox" id="tt-rush"> Rush the search (DM-2, resolves in 1D6&times;10 hours instead of the normal wait)</label></div>
    </div>`;
  return foundry.applications.api.DialogV2.wait({
    window: { title },
    content,
    buttons: [
      { action: "ok", label: "Start Search", default: true, callback: () => ({ rushed: content.querySelector("#tt-rush").checked }) },
      { action: "cancel", label: "Cancel", callback: () => null }
    ],
    rejectClose: false
  });
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
    this.useBroker = false;
    this.blackMarket = false;
    this.counterpartSkill = 2;
  }

  static DEFAULT_OPTIONS = {
    classes: ["traveller-trading-window"],
    window: { resizable: true },
    position: { width: 880, height: 700 }
  };

  get id() { return `tt-trade-app-${this.mode}-${this.docId}`; }

  get title() {
    const name = this.doc?.name?.replace(/^Starship: |^Storage: /, "");
    return `${this.mode === "buy" ? "Buy Goods" : "Sell Goods"} — ${name || ""}`;
  }

  async close(options) {
    instances.delete(`${this.docId}:${this.mode}`);
    return super.close(options);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.root.addEventListener("change", (e) => {
      if (e.target.matches("[data-tt-counterpart-skill]")) {
        this.counterpartSkill = Math.max(0, Number(e.target.value) || 0);
      }
    });
  }

  async _load() {
    this.doc = game.journal.get(this.docId);
    if (!this.doc) return;
    const ship = getShipData(this.doc);
    this.shipLocation = ship.location || "";
    await this._resolveWorld();
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

  _record(ship, kind) { return ship.supplierSearches?.[this.mode]?.[kind] || null; }

  // A record only counts if it's for the world the ship is CURRENTLY at —
  // one at a different world (the ship moved on) is left in place (in case
  // the ship returns later) but ignored for display/trading purposes.
  _relevantRecord(ship, kind) {
    const record = this._record(ship, kind);
    if (!record || !this.world) return null;
    return record.worldKey === worldKeyFor(this.world) ? record : null;
  }

  // `blackMarket` here reflects the FOUND broker's own record (fixed at the
  // moment they were found), not the live Black Market checkbox — otherwise
  // toggling that checkbox after finding a legitimate broker would relabel
  // them as a fixer and charge the wrong fee.
  _currentBrokerSkill(ship) {
    const brokerRecord = this._relevantRecord(ship, "broker");
    if (this.useBroker && brokerRecord?.status === "found" && brokerRecord.broker) {
      return { skill: brokerRecord.broker.skill, bonus: 2, blackMarket: brokerRecord.blackMarket };
    }
    return { skill: Number(ship?.skills?.broker) || 0, bonus: 0, blackMarket: false };
  }

  // ---- Search flow ----------------------------------------------------------
  async _runSearch(kind) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    if (!this.world) return;
    const ship = getShipData(this.doc);
    const worldKey = worldKeyFor(this.world);
    const sp = worldStarportClass(this.world.UWP);
    const starportDM = starportSearchDM(sp);
    const priorDM = attemptDM(ship, worldKey);
    const purposeLabel = kind === "contact" ? (this.mode === "buy" ? "supplier" : "buyer") : (this.blackMarket ? "fixer" : "local broker");
    const titleLabel = `${purposeLabel[0].toUpperCase()}${purposeLabel.slice(1)}`;

    let input;
    if (kind === "broker") {
      // No player check — see startSearch's broker branch: this is rolled
      // automatically using the prospective broker's own skill.
      const rush = await showBrokerSearchDialog({ title: `Find a ${titleLabel}`, purposeLabel, starportDM, priorDM });
      if (!rush) return;
      input = { checkType: this.blackMarket ? "streetwise" : "broker", rushed: rush.rushed, result: null };
    } else {
      const tl = worldTechLevelValue(this.world.UWP);
      const checkOptions = this.blackMarket
        ? [{ value: "streetwise", label: "Streetwise (EDU or SOC) — black market" }]
        : [
            { value: "broker", label: "Broker (EDU or SOC)" },
            ...(tl !== null && tl >= 8 ? [{ value: "online", label: "Online (Admin, EDU only) — TL8+ world" }] : [])
          ];
      input = await showFindDialog({ title: `Find a ${titleLabel}`, purposeLabel, checkOptions, starportDM, priorDM });
      if (!input) return;
    }

    const record = startSearch(ship, this.mode, kind, {
      checkType: input.checkType, blackMarket: this.blackMarket, rushed: input.rushed,
      playerResult: input.result, world: this.world, starportDM, priorAttemptDM: priorDM
    });

    logDebugBlock(`Search started: ${purposeLabel} at ${this.world.Name} (${this.mode})`, [
      `Check: ${input.checkType}, rushed: ${input.rushed}`,
      `DMs shown: starport ${starportDM >= 0 ? "+" : ""}${starportDM}, previous attempts ${priorDM}`,
      kind === "broker"
        ? `Auto-roll (broker's own skill): 2D6=[${record.autoRoll.dice.join("+")}]=${record.autoRoll.diceSum} + skill ${record.autoRoll.skill} = ${record.autoRoll.total} -> ${record.success ? "SUCCESS" : "FAILURE"}`
        : `Player-reported total: ${input.result} -> ${record.success ? "SUCCESS" : "FAILURE"}`,
      `Wait roll: [${record.waitRolls.join("+")}]${record.rushed ? " x10" : ""} ${record.waitUnit} -> ${record.waitDays} day(s)`
    ]);

    if (record.waitDays <= 0) {
      finalizeSearch(record, ship, this.mode); // logs its own resolution detail
    }

    await saveShipData(this.doc, ship);

    if (record.resolved) {
      ui.notifications.info(record.success ? `Search successful! You found a ${purposeLabel}.` : `Search unsuccessful.`);
    } else {
      ui.notifications.info(`Searching for a ${purposeLabel}... check back in ${record.waitDays} day${record.waitDays === 1 ? "" : "s"}.`);
    }
    this._renderContent();
  }

  async _action_find_contact() { await this._runSearch("contact"); }
  async _action_find_broker() { await this._runSearch("broker"); }

  async _action_toggle_broker(btn) {
    if (!canEdit(this.doc)) return;
    this.useBroker = btn.checked;
    this._renderContent();
  }

  async _action_toggle_blackmarket(btn) {
    if (!canEdit(this.doc)) return;
    this.blackMarket = btn.checked;
    this._renderContent();
  }

  // Re-rolls just the price offers for an already-found contact, using
  // whatever broker/counterpart settings are currently selected — the
  // goods and quantities on offer (or, when selling, what's in the hold)
  // don't change; this represents renegotiating with the same contact.
  async _action_reroll_prices() {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const ship = getShipData(this.doc);
    const record = this._relevantRecord(ship, "contact");
    if (!record || record.status !== "found") return;
    const { skill, bonus } = this._currentBrokerSkill(ship);

    if (this.mode === "buy") {
      const codes = new Set(record.market.codes);
      const offers = {};
      for (const entry of record.market.entries) {
        const good = goodByName(entry.goodName);
        offers[good.name] = rollPriceOffer({ mode: "purchase", good, worldCodes: codes, brokerSkill: skill, brokerBonus: bonus, counterpartSkill: this.counterpartSkill });
      }
      record.priceOffers = offers;
    } else {
      const codes = new Set(record.worldCodes);
      const offers = {};
      const seen = new Set();
      for (const row of (ship.cargo || [])) {
        const good = goodByName(row.itemName);
        if (!good || !good.price || seen.has(good.name)) continue;
        seen.add(good.name);
        offers[good.name] = rollPriceOffer({ mode: "sale", good, worldCodes: codes, brokerSkill: skill, brokerBonus: bonus, counterpartSkill: this.counterpartSkill });
      }
      record.priceOffers = offers;
    }
    await saveShipData(this.doc, ship);
    logDebugBlock(`Speculative Trade — Prices renegotiated at ${record.world.Name}`, [
      `Broker skill ${skill}${bonus ? ` + local broker bonus ${bonus}` : ""}, counterpart Broker ${this.counterpartSkill}`,
      ...Object.entries(record.priceOffers).flatMap(([name, offer]) => [`Offer "${name}":`, ...fmtPriceOffer(offer)])
    ]);
    this._renderContent();
  }

  // ---- Rendering ----------------------------------------------------------
  _worldHeaderHtml() {
    if (this.loadError) return `<p class="tt-empty">${esc(this.loadError)}</p>`;
    if (!this.world) return `<p class="tt-empty">Loading…</p>`;
    const w = this.world;
    const uwpParts = describeUwp(w.UWP) || [];
    const codes = worldTradeCodes(w);
    const codeChips = [...codes].sort().map(c =>
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

  _searchSectionHtml(ship, editable) {
    const contact = this._relevantRecord(ship, "contact");
    const contactLabel = this.mode === "buy" ? "Supplier" : "Buyer";
    const brokerLabel = this.blackMarket ? "Fixer" : "Local Broker";

    let contactHtml;
    if (!contact) {
      contactHtml = editable ? `<button type="button" class="tt-btn" data-tt-action="find-contact">Find a ${contactLabel}</button>` : `<p class="tt-hint">No ${contactLabel.toLowerCase()} found yet.</p>`;
    } else if (contact.status === "searching") {
      const nowIdx = gameDayIndex() ?? contact.resolveDayIndex;
      const daysLeft = Math.max(0, contact.resolveDayIndex - nowIdx);
      contactHtml = `<p class="tt-hint">Searching for a ${contactLabel.toLowerCase()}… ${daysLeft > 0 ? `results expected in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : "concluding…"}</p>`;
    } else if (contact.status === "failed") {
      contactHtml = `
        <p class="tt-hint">Your last search for a ${contactLabel.toLowerCase()} here was unsuccessful.</p>
        ${editable ? `<button type="button" class="tt-btn" data-tt-action="find-contact">Find a ${contactLabel}</button>` : ""}`;
    } else {
      contactHtml = editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="find-contact">Search for Another ${contactLabel}</button>` : "";
    }

    const broker = this._relevantRecord(ship, "broker");
    let brokerHtml;
    if (!broker) {
      brokerHtml = editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="find-broker">Find a ${brokerLabel}</button>` : "";
    } else if (broker.status === "searching") {
      const nowIdx = gameDayIndex() ?? broker.resolveDayIndex;
      const daysLeft = Math.max(0, broker.resolveDayIndex - nowIdx);
      brokerHtml = `<p class="tt-hint">Searching for a ${brokerLabel.toLowerCase()}… ${daysLeft > 0 ? `results expected in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : "concluding…"}</p>`;
    } else if (broker.status === "failed") {
      brokerHtml = `
        <p class="tt-hint">Your last search for a ${brokerLabel.toLowerCase()} here was unsuccessful.</p>
        ${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="find-broker">Find a ${brokerLabel}</button>` : ""}`;
    } else {
      const b = broker.broker;
      const foundLabel = broker.blackMarket ? "fixer" : "local broker";
      brokerHtml = `
        <label class="tt-field-checkbox" style="margin:0 0 4px;"><input type="checkbox" data-tt-action="toggle-broker" ${this.useBroker ? "checked" : ""} ${editable ? "" : "disabled"}> Use this ${foundLabel} (Broker ${b.skill}, +2 DM, ${broker.blackMarket ? "20" : "10"}% fee)</label>
        ${b.doubleCrosser ? `<p class="tt-hint" style="color:var(--red);">Rolled a natural 2 — they may be an informer, government agent, or double-crosser.</p>` : ""}
        ${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="find-broker">Find a Different ${brokerLabel}</button>` : ""}`;
    }

    return `
      <div class="tt-panel-box">
        <h3>${esc(contactLabel)}</h3>
        ${contactHtml}
      </div>
      <div class="tt-panel-box">
        <h3>${esc(brokerLabel)}</h3>
        ${brokerHtml}
      </div>`;
  }

  _controlsHtml(editable, contact) {
    return `
      <div class="tt-inline-row" style="margin-bottom:6px;">
        ${this.mode === "buy" ? `<label class="tt-field-checkbox" style="margin:0;"><input type="checkbox" data-tt-action="toggle-blackmarket" ${this.blackMarket ? "checked" : ""} ${editable ? "" : "disabled"}> Black market</label>` : ""}
        <label style="font-size:12.5px;color:var(--text-muted);">Counterpart Broker</label>
        <input type="number" class="tt-input" style="width:60px;" data-tt-counterpart-skill value="${this.counterpartSkill}" min="0" ${editable ? "" : "disabled"}>
        ${editable && contact?.status === "found" ? `<button type="button" class="tt-btn" data-tt-action="reroll-prices">Reroll Prices</button>` : ""}
      </div>`;
  }

  _dmCodesHtml(dmList, codes) {
    const matched = dmList.filter(d => codes.has(d.code));
    return matched.length ? matched.map(d => `${d.code} ${d.dm >= 0 ? "+" : ""}${d.dm}`).join(", ") : "—";
  }

  _buyTableHtml(editable, usage, record) {
    const codes = new Set(record.market.codes);
    const rows = record.market.entries.map(entry => {
      const good = goodByName(entry.goodName);
      const offer = record.priceOffers[good.name];
      const range = typicalPriceRange({
        mode: "purchase", good, worldCodes: codes,
        brokerSkill: offer.brokerSkill, brokerBonus: offer.brokerBonus, counterpartSkill: offer.counterpartSkill
      });
      const maxQty = Math.max(0, Math.min(entry.availableTons, usage.remaining));
      return `
        <tr>
          <td>${esc(good.name)}${good.illegal ? ` <span class="tt-badge" style="color:var(--red);">illegal</span>` : ""}</td>
          <td class="tt-mono">${entry.availableTons}</td>
          <td class="tt-mono">${fmtCr(good.price)}</td>
          <td class="tt-mono">${fmtCr(range.low)}&ndash;${fmtCr(range.high)}</td>
          <td class="tt-mono" style="color:var(--gold);">${fmtCr(offer.unitPrice)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(good.purchaseDM, codes)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(good.saleDM, codes)}</td>
          <td><input type="number" class="tt-cell-input" data-tt-buy-qty="${esc(good.name)}" min="0" max="${maxQty}" value="0" style="width:70px;" ${editable && maxQty > 0 ? "" : "disabled"}></td>
          <td>${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="buy-good" data-name="${esc(good.name)}" ${maxQty > 0 ? "" : "disabled"}>Buy</button>` : ""}</td>
        </tr>`;
    }).join("");
    return `
      <div class="tt-cargo-summary">Hold space: ${usage.used} / ${usage.total} tons (${usage.remaining} free)</div>
      <table class="tt-table">
        <thead><tr><th>Good</th><th>Available (t)</th><th>Base Cr/t</th><th>Typical Cr/t</th><th>Offered Cr/t</th><th>Buying benefits</th><th>Selling benefits</th><th>Qty (t)</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="tt-empty">No goods on offer.</td></tr>`}</tbody>
      </table>`;
  }

  _sellTableHtml(editable, ship, record) {
    const codes = new Set(record.worldCodes);
    const rows = Object.entries(record.priceOffers).map(([name, offer]) => {
      const good = goodByName(name);
      if (!good) return "";
      const totalQty = (ship.cargo || []).filter(c => c.itemName === name).reduce((s, c) => s + (Number(c.quantity) || 0), 0);
      if (totalQty <= 0) return "";
      const range = typicalPriceRange({
        mode: "sale", good, worldCodes: codes,
        brokerSkill: offer.brokerSkill, brokerBonus: offer.brokerBonus, counterpartSkill: offer.counterpartSkill
      });
      return `
        <tr>
          <td>${esc(good.name)}</td>
          <td class="tt-mono">${totalQty}</td>
          <td class="tt-mono">${fmtCr(good.price)}</td>
          <td class="tt-mono">${fmtCr(range.low)}&ndash;${fmtCr(range.high)}</td>
          <td class="tt-mono" style="color:var(--teal);">${fmtCr(offer.unitPrice)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(good.purchaseDM, codes)}</td>
          <td class="tt-source-name">${this._dmCodesHtml(good.saleDM, codes)}</td>
          <td><input type="number" class="tt-cell-input" data-tt-sell-qty="${esc(good.name)}" min="0" max="${totalQty}" value="0" style="width:70px;" ${editable ? "" : "disabled"}></td>
          <td>${editable ? `<button type="button" class="tt-btn tt-btn-ghost" data-tt-action="sell-good" data-name="${esc(good.name)}">Sell</button>` : ""}</td>
        </tr>`;
    }).join("");
    return `
      <table class="tt-table">
        <thead><tr><th>Good</th><th>In Hold (t)</th><th>Base Cr/t</th><th>Typical Cr/t</th><th>Offered Cr/t</th><th>Buying benefits</th><th>Selling benefits</th><th>Qty (t)</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="tt-empty">The buyer isn't interested in anything currently in the hold.</td></tr>`}</tbody>
      </table>`;
  }

  _renderContent() {
    const titleEl = this.element?.querySelector(".window-title");
    if (titleEl) titleEl.textContent = this.title;

    if (!this.doc) { this.root.innerHTML = `<p class="tt-empty">This starship/storage no longer exists.</p>`; return; }
    const editable = canEdit(this.doc);
    const ship = getShipData(this.doc);
    const contact = this._relevantRecord(ship, "contact");

    let body = "";
    if (!this.loadError && this.world && contact?.status === "found") {
      if (this.mode === "buy") body = this._buyTableHtml(editable, cargoSpaceUsage(ship), contact);
      else body = this._sellTableHtml(editable, ship, contact);
    }

    this.root.innerHTML = `
      <div class="tt-trade">
        <p class="tt-hint">${this.mode === "buy"
          ? `Find a supplier before goods go on offer, per the core rules. Once found, prices are shown with all DMs applied — "Typical" is a representative band, not the best/worst possible roll.`
          : `Find a buyer before sale offers appear. Browsing costs nothing — nothing sells until you click Sell.`}</p>
        ${this._worldHeaderHtml()}
        ${!this.loadError && this.world ? this._controlsHtml(editable, contact) : ""}
        ${!this.loadError && this.world ? this._searchSectionHtml(ship, editable) : ""}
        ${body}
      </div>`;
  }

  // ---- Buy / Sell actions ----------------------------------------------------
  async _action_buy_good(btn) {
    if (!canEdit(this.doc)) { ui.notifications.warn("You don't have permission to edit this."); return; }
    const name = btn.dataset.name;
    const input = this.root.querySelector(`[data-tt-buy-qty="${CSS.escape(name)}"]`);
    const requested = Math.max(0, Number(input?.value) || 0);
    if (!requested) return;

    const ship = getShipData(this.doc);
    const record = this._relevantRecord(ship, "contact");
    if (!record || record.status !== "found") return;
    const entry = record.market.entries.find(e => e.goodName === name);
    const offer = record.priceOffers[name];
    if (!entry || !offer) return;

    const usage = cargoSpaceUsage(ship);
    const finalQty = Math.min(requested, entry.availableTons, usage.remaining);
    if (finalQty <= 0) { ui.notifications.warn("Not enough hold space or market stock."); return; }

    const goodsCost = finalQty * offer.unitPrice;
    const brokerCtx = this._currentBrokerSkill(ship);
    const brokerFee = this.useBroker ? Math.round(goodsCost * (brokerCtx.blackMarket ? 0.2 : 0.1)) : 0;
    const totalCost = goodsCost + brokerFee;

    const sourceItem = findTradeGoodItem(name);
    addOrMergeCargo(ship, {
      itemName: name, unitValue: offer.unitPrice,
      img: sourceItem?.img || DEFAULT_ITEM_ICON, sourceUuid: sourceItem?.uuid || null,
      quantity: finalQty
    });
    entry.availableTons -= finalQty;
    await saveShipData(this.doc, ship);

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: -totalCost,
      description: `${ship.name}: Bought ${finalQty}t ${name} @ Cr${offer.unitPrice}/t at ${record.world.Name}${brokerFee ? ` (incl. Cr${brokerFee} broker fee)` : ""}`,
      source: `ship:${this.docId}`
    });

    logDebugBlock(`Speculative Trade — BUY ${finalQty}t ${name} at ${record.world.Name}`, [
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

    const ship = getShipData(this.doc);
    const record = this._relevantRecord(ship, "contact");
    if (!record || record.status !== "found") return;
    const offer = record.priceOffers[name];
    if (!offer) return;
    const inHold = (ship.cargo || []).filter(c => c.itemName === name).reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const finalQty = Math.min(requested, inHold);
    if (finalQty <= 0) return;

    let remaining = finalQty;
    for (const c of (ship.cargo || []).filter(c => c.itemName === name)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(c.quantity) || 0);
      removeCargoQuantity(ship, c.id, take);
      remaining -= take;
    }
    await saveShipData(this.doc, ship);

    const proceeds = finalQty * offer.unitPrice;
    const brokerCtx = this._currentBrokerSkill(ship);
    const brokerFee = this.useBroker ? Math.round(proceeds * (brokerCtx.blackMarket ? 0.2 : 0.1)) : 0;
    const netProceeds = proceeds - brokerFee;

    const financeDoc = await getFinanceDoc();
    await postTransaction(financeDoc, {
      amount: netProceeds,
      description: `${ship.name}: Sold ${finalQty}t ${name} @ Cr${offer.unitPrice}/t at ${record.world.Name}${brokerFee ? ` (after Cr${brokerFee} broker fee)` : ""}`,
      source: `ship:${this.docId}`
    });

    logDebugBlock(`Speculative Trade — SELL ${finalQty}t ${name} at ${record.world.Name}`, [
      ...fmtPriceOffer(offer),
      `  Quantity sold: ${finalQty}t x Cr${offer.unitPrice} = Cr${proceeds}${brokerFee ? ` - Cr${brokerFee} broker fee = Cr${netProceeds}` : ""}`
    ]);

    this._renderContent();
  }
}
