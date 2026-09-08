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
    // Checked against a live v14.365-compatible module (Traveller Toolkit)
    // that adds real sidebar tabs the same way: these are the actual tab
    // strip and content containers, not a guess from a specific tab's
    // parentElement (which turned out to be a per-button wrapper, not the
    // shared strip — causing the dedup check below to always miss and the
    // retry loop to inject duplicate buttons/sections/listeners).
    const tabContainer = document.querySelector("#sidebar-tabs menu");
    const contentContainer = document.querySelector("#sidebar-content");
    const chatButton = document.querySelector('[data-tab="chat"][role="tab"]');
    if (!tabContainer || !contentContainer || !chatButton) return false;

    // Global-ID check, independent of which container turns out to be
    // correct, so a wrong guess can never cause repeated re-injection.
    if (document.getElementById(MODULE_ID)) return true;

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
    section.dataset.group = chatButton.dataset.group || "primary";
    section.style.height = "100%";
    section.style.overflowY = "auto";

    const mod = game.modules.get(MODULE_ID);
    const controller = new TradingController(section);
    if (mod) mod.controller = controller;

    // Never try to detect or touch whichever native section currently
    // happens to be visible — an earlier attempt assumed natives use inline
    // style.display like our own tab now does, but Foundry hides them with
    // its own class instead, so that detection silently matched the wrong
    // element (or none), leaving the real active native tab still occupying
    // flex space above ours and pushing our content out of view. Instead,
    // a CSS rule (styles/traveller-trading.css) hides every OTHER ".tab"
    // sibling purely from the presence of our own "tt-active" class, with
    // no dependency on Foundry's internal class names at all.
    activateTab = () => {
      section.classList.add("tt-active");
      button.setAttribute("aria-pressed", "true");
      controller.mount();
    };
    const deactivateTab = () => {
      section.classList.remove("tt-active");
      button.setAttribute("aria-pressed", "false");
    };

    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      activateTab();
    });
    // Capture phase, and only to clean up our own override, so Foundry's
    // own tab-switching handler for the clicked native tab still runs
    // completely normally afterward.
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
