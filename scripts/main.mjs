import { MODULE_ID } from "./constants.mjs";
import { registerTradeGoodsSettings } from "./trade-goods.mjs";
import { TravellerTradingPanel } from "./panel.mjs";
import { getFinanceDoc, processRecurring } from "./data.mjs";

Hooks.once("init", () => {
  registerTradeGoodsSettings();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  const openPanel = () => {
    if (!mod.app) mod.app = new TravellerTradingPanel();
    mod.app.render(true);
  };
  if (mod) mod.api = { open: openPanel };

  // Catch up on any recurring income/costs accumulated since the world was
  // last open, same approach as the Drinax Tracker's Standing drift.
  if (game.user.isGM) {
    getFinanceDoc().then(doc => { if (doc) processRecurring(doc); });
  }
});

// Re-check recurring income/costs whenever the GM advances the mgt2e
// campaign date, so it stays current even if nobody has the panel open.
Hooks.on("updateSetting", (setting) => {
  if (setting.key === "mgt2e.currentYear" || setting.key === "mgt2e.currentDay") {
    if (game.user.isGM) getFinanceDoc().then(doc => { if (doc) processRecurring(doc); });
  }
});

// Live-sync: refresh an open panel whenever the Finance or any ship/storage
// JournalEntry changes, from any client (a co-GM, a purser, a merchant...).
Hooks.on("updateJournalEntry", (doc) => {
  if (!doc.getFlag(MODULE_ID, "kind")) return;
  const app = game.modules.get(MODULE_ID)?.app;
  if (app?.rendered) {
    app.shipDocs = game.journal.filter(j => {
      const k = j.getFlag(MODULE_ID, "kind");
      return k === "ship" || k === "storage";
    }).sort((a, b) => a.name.localeCompare(b.name));
    app._renderPanel();
  }
});
Hooks.on("deleteJournalEntry", (doc) => {
  if (!doc.getFlag(MODULE_ID, "kind")) return;
  const app = game.modules.get(MODULE_ID)?.app;
  if (app?.rendered) {
    if (app.view.type === "ship" && app.view.id === doc.id) app.view = { type: "finance" };
    app.shipDocs = game.journal.filter(j => {
      const k = j.getFlag(MODULE_ID, "kind");
      return k === "ship" || k === "storage";
    }).sort((a, b) => a.name.localeCompare(b.name));
    app._renderPanel();
  }
});

// Adds an icon into the real sidebar tab strip, in the same spot as Chat,
// Combat, Journal, Settings, etc. Foundry v13/v14 doesn't currently expose a
// documented, reliable way for a module to register a full in-place-swapping
// tab (even the "Traveller Toolkit" module doesn't use the official
// CONFIG.ui.sidebar.TABS API for this, and falls back to a popout window in
// places) — so clicking this icon opens the panel as its own window, the
// same reliable approach already used by the Drinax Tracker and Name
// Generator modules, rather than trying to swap sidebar content in place.
//
// Rather than guess the tab strip's container markup (it changed again in
// v14 — real tabs are plain <button class="ui-control plain icon fa-solid
// fa-*"> elements, not the older <a class="item"> pattern), this finds the
// real Chat tab button and inserts a sibling matching its exact structure,
// so it's correct regardless of what the container itself looks like.
function addSidebarIcon() {
  try {
    const chatTab = document.querySelector('[data-tab="chat"][role="tab"]');
    const container = chatTab?.parentElement;
    if (!container || container.querySelector(`[data-tab="${MODULE_ID}"]`)) return;

    const item = document.createElement("button");
    item.type = "button";
    item.className = "ui-control plain icon fa-solid fa-money-bill-trend-up";
    item.dataset.action = "tab";
    item.dataset.tab = MODULE_ID;
    item.dataset.group = chatTab.dataset.group || "primary";
    item.dataset.tooltip = "Traveller Trading";
    item.setAttribute("role", "tab");
    item.setAttribute("aria-pressed", "false");
    item.setAttribute("aria-label", "Traveller Trading");
    item.setAttribute("aria-controls", MODULE_ID);
    item.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      game.modules.get(MODULE_ID)?.api?.open();
    });
    container.appendChild(item);
  } catch (err) {
    console.warn("Traveller Trading | Could not add sidebar icon, use the macro instead.", err);
  }
}
Hooks.once("renderSidebar", addSidebarIcon);
// renderSidebar can fire before the tab strip itself is fully populated in
// some load orders; a short-lived retry covers that without needing to
// depend on exactly when the Chat button appears.
Hooks.once("ready", () => setTimeout(addSidebarIcon, 500));
