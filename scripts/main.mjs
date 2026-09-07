import { MODULE_ID } from "./constants.mjs";
import { registerTradeGoodsSettings } from "./trade-goods.mjs";
import { registerPermissionsSettings } from "./permissions.mjs";
import { TradingController } from "./panel.mjs";
import { getFinanceDoc, processRecurring, getShipDocs } from "./data.mjs";

Hooks.once("init", () => {
  registerTradeGoodsSettings();
  registerPermissionsSettings();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      // Activates the sidebar tab if it's been injected yet; otherwise this
      // is a no-op (the injection itself runs off "renderSidebar"/"ready").
      open: () => activateTab?.()
    };
  }

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

function refreshController() {
  const mod = game.modules.get(MODULE_ID);
  const controller = mod?.controller;
  if (!controller?.mounted) return;
  controller.shipDocs = getShipDocs();
  controller._renderPanel();
}

// Live-sync: refresh the panel whenever the Finance or any ship/storage
// JournalEntry changes, from any client (a co-GM, a purser, a merchant...).
Hooks.on("updateJournalEntry", (doc) => {
  if (!doc.getFlag(MODULE_ID, "kind")) return;
  refreshController();
});
Hooks.on("deleteJournalEntry", (doc) => {
  if (!doc.getFlag(MODULE_ID, "kind")) return;
  const controller = game.modules.get(MODULE_ID)?.controller;
  if (controller?.mounted && controller.view.type === "ship" && controller.view.id === doc.id) {
    controller.view = { type: "finance" };
  }
  refreshController();
});

// ---------------------------------------------------------------------------
// Sidebar integration. Foundry v13/v14 doesn't expose a documented, reliable
// way for a module to register into CONFIG.ui.sidebar.TABS (even the
// "Traveller Toolkit" module doesn't use that API, instead injecting DOM
// directly and falling back to a popout window in places) — so this injects
// a real tab button (matching the exact markup of the actual Chat tab
// button, confirmed via live inspection) plus a real content section as a
// sibling of Chat's, and manages showing/hiding it itself rather than
// depending on however Foundry's own tab-switching happens to work
// internally for tabs it doesn't know about.
// ---------------------------------------------------------------------------
let activateTab = null;

function injectSidebarTab() {
  try {
    const chatButton = document.querySelector('[data-tab="chat"][role="tab"]');
    const chatSection = document.getElementById("chat");
    if (!chatButton || !chatSection) return false;

    const tabContainer = chatButton.parentElement;
    const contentContainer = chatSection.parentElement;
    if (!tabContainer || !contentContainer || tabContainer.querySelector(`[data-tab="${MODULE_ID}"]`)) {
      return !!(tabContainer && tabContainer.querySelector(`[data-tab="${MODULE_ID}"]`));
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-control plain icon fa-solid fa-money-bill-trend-up";
    button.dataset.action = "tab";
    button.dataset.tab = MODULE_ID;
    button.dataset.group = chatButton.dataset.group || "primary";
    button.dataset.tooltip = "Traveller Trading";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Traveller Trading");
    button.setAttribute("aria-controls", MODULE_ID);
    button.style.marginTop = "4px";

    const section = document.createElement("section");
    section.id = MODULE_ID;
    section.className = "tab";
    section.dataset.tab = MODULE_ID;
    section.dataset.group = chatSection.dataset.group || "primary";
    section.style.display = "none";
    section.style.height = "100%";
    section.style.overflowY = "auto";

    const mod = game.modules.get(MODULE_ID);
    const controller = new TradingController(section);
    if (mod) mod.controller = controller;

    const allTabButtons = () => Array.from(tabContainer.children).filter(el => el.dataset && el.dataset.tab);
    const allSections = () => Array.from(contentContainer.children).filter(el => el.dataset && el.dataset.tab);

    activateTab = () => {
      allSections().forEach(s => { s.style.display = (s === section) ? "" : "none"; });
      allTabButtons().forEach(b => b.setAttribute("aria-pressed", b === button ? "true" : "false"));
      controller.mount();
    };
    const deactivateTab = () => { section.style.display = "none"; button.setAttribute("aria-pressed", "false"); };

    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      activateTab();
    });
    // Capture phase so this still runs even if Foundry's own tab-switching
    // handler stops the event from propagating further.
    tabContainer.addEventListener("click", (ev) => {
      const clicked = ev.target.closest("[data-tab]");
      if (clicked && clicked !== button) deactivateTab();
    }, true);

    contentContainer.appendChild(section);
    tabContainer.appendChild(button);
    return true;
  } catch (err) {
    console.warn("Traveller Trading | Could not add sidebar tab, use the macro instead.", err);
    return false;
  }
}

Hooks.once("renderSidebar", () => injectSidebarTab());
// renderSidebar can fire before the tab strip/content area are fully
// populated in some load orders; a short-lived retry covers that without
// needing to depend on exactly when the Chat elements appear.
Hooks.once("ready", () => {
  if (injectSidebarTab()) return;
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (injectSidebarTab() || attempts > 20) clearInterval(interval);
  }, 250);
});
