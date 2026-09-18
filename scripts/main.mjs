import { MODULE_ID } from "./constants.mjs";
import { registerTradeGoodsSettings } from "./trade-goods.mjs";
import { registerPermissionsSettings } from "./permissions.mjs";
import { registerTransactionLog } from "./logging.mjs";
import { resetDebugLog } from "./debug-log.mjs";
import { LauncherController } from "./panel.mjs";
import { getFinanceDoc, processRecurring } from "./data.mjs";
import { refreshGroupFinanceApp, registerFinanceSettings, closeGroupFinanceAppIfOpen } from "./finance-app.mjs";
import { refreshShipApp, closeShipAppIfOpen } from "./ship-app.mjs";
import { closeTradeMarketAppsIfOpen, checkPendingSupplierSearches } from "./trade-app.mjs";
import { registerDestinationMapSettings, registerPreferredSectorChoices } from "./destination-map.mjs";
import { migrateSupplierSearches } from "./supplier-search.mjs";

Hooks.once("init", () => {
  registerTradeGoodsSettings();
  registerPermissionsSettings();
  registerDestinationMapSettings();
  registerFinanceSettings();

  // "Use Standard Foundry Styling" — off by default, so nothing changes for
  // existing worlds until a GM opts in. Read via window-base.mjs's
  // standardLookEnabled() by every window's own _onRender, and applied here
  // to the sidebar launcher (which isn't a window at all, just a controller
  // mounted into Foundry's own sidebar DOM) on change.
  game.settings.register(MODULE_ID, "standardLook", {
    name: "Use Standard Foundry Styling",
    hint: "Replace this module's custom dark/gold theme with Foundry's own default window/button styling.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => {
      const controller = game.modules.get(MODULE_ID)?.controller;
      controller?.root?.classList.toggle("tt-standard-look", !!value);
    }
  });
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

  registerTransactionLog();
  registerPreferredSectorChoices();
  resetDebugLog();

  // Catch up on any recurring income/costs accumulated since the world was
  // last open, same approach as the Drinax Tracker's Standing drift.
  if (game.user.isGM) {
    getFinanceDoc().then(doc => { if (doc) processRecurring(doc); });
    // Wipe any supplier/buyer/broker search left over from an older search
    // mechanic BEFORE sweeping for due ones, so nothing resolves under the
    // wrong rules — see migrateSupplierSearches' own comment.
    migrateSupplierSearches().then(() => checkPendingSupplierSearches());
  }
});

// Re-check recurring income/costs, plus any due supplier/buyer/broker
// searches, whenever the GM advances the mgt2e campaign date — so both stay
// current even if nobody has a window open when the wait concludes.
Hooks.on("updateSetting", (setting) => {
  if (setting.key === "mgt2e.currentYear" || setting.key === "mgt2e.currentDay") {
    if (game.user.isGM) {
      getFinanceDoc().then(doc => { if (doc) processRecurring(doc); });
      checkPendingSupplierSearches();
    }
  }
});

function refreshLauncher() {
  const controller = game.modules.get(MODULE_ID)?.controller;
  if (controller?.mounted) controller.refresh();
}

// Live-sync: refresh the launcher list, plus any open Group Finance/ship
// window, whenever the underlying JournalEntry changes from any client (a
// co-GM, a purser, a merchant...).
Hooks.on("updateJournalEntry", (doc) => {
  const kind = doc.getFlag(MODULE_ID, "kind");
  if (!kind) return;
  refreshLauncher();
  if (kind === "finance") refreshGroupFinanceApp();
  else refreshShipApp(doc.id);
});
Hooks.on("deleteJournalEntry", (doc) => {
  if (!doc.getFlag(MODULE_ID, "kind")) return;
  refreshLauncher();
  closeShipAppIfOpen(doc.id);
  closeTradeMarketAppsIfOpen(doc.id);
});

// "tt reset" chat trigger (plain text, deliberately no leading "/") —
// deletes Group Finance and every starship/storage JournalEntry this
// module owns (cargo, passengers, transactions, and supplier searches all
// live as flags on those same documents, so deleting the documents is a
// complete reset). Confirmed live (2026-09) that a leading "/" routes the
// message through Foundry's OWN built-in command validator first, which
// rejects any unrecognized "/word" outright ("is not a valid chat message
// command") before any module's "chatMessage" hook gets a chance to
// intercept it — registering a genuinely new slash-verb needs a
// different, more involved mechanism than a plain hook. Plain (non-"/")
// text never goes through that validator, so this hook reliably sees it.
// Returning false stops the text being posted as a normal chat message,
// and any other input is left alone (returning true) so this can never
// interfere with real chat, rolls, or other modules' own commands.
async function resetAllData() {
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Reset Traveller Trading Data" },
    content: "<p>Delete Group Finance and every starship/storage location tracked by Traveller Trading &mdash; all cargo, passengers, transactions, and supplier searches? This cannot be undone.</p>"
  });
  if (!ok) return;
  closeGroupFinanceAppIfOpen();
  const docs = game.journal.filter(j => !!j.getFlag(MODULE_ID, "kind"));
  for (const doc of docs) await doc.delete();
  ui.notifications.info("Traveller Trading data has been reset.");
}

Hooks.on("chatMessage", (chatLog, message) => {
  if (message.trim().toLowerCase() !== "tt reset") return true;
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can reset Traveller Trading data.");
    return false;
  }
  resetAllData();
  return false;
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
// internally for tabs it doesn't know about. The tab itself is just a
// launcher/directory list; Group Finance and each ship/storage open as
// their own separate windows (see finance-app.mjs / ship-app.mjs).
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

    const section = document.createElement("section");
    section.id = MODULE_ID;
    section.className = "tab";
    section.dataset.tab = MODULE_ID;
    section.dataset.group = chatButton.dataset.group || "primary";
    section.style.height = "100%";
    section.style.overflowY = "auto";

    const mod = game.modules.get(MODULE_ID);
    const controller = new LauncherController(section);
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
    let weConsiderOurselvesActive = false;
    activateTab = () => {
      // Expand for both sidebar icon clicks and the module's public open API.
      ui.sidebar.expand();
      weConsiderOurselvesActive = true;
      section.classList.add("tt-active");
      button.setAttribute("aria-pressed", "true");
      controller.mount();
    };
    const deactivateTab = () => {
      weConsiderOurselvesActive = false;
      section.classList.remove("tt-active");
      button.setAttribute("aria-pressed", "false");
    };

    // Foundry's sidebar keeps rendering asynchronously for a while after it
    // first appears (each native tab's own content, e.g. chat messages,
    // renders in via a later _onFirstRender/#renderTabs step) — and clicking
    // our tab during that window was observed to add "tt-active" only for
    // it to disappear again moments later, with nothing in this module ever
    // removing it. Rather than guess exactly when that settling finishes,
    // self-heal: if anything strips our own active class while we still
    // consider ourselves the active tab, put it straight back.
    new MutationObserver(() => {
      if (weConsiderOurselvesActive && !section.classList.contains("tt-active")) {
        section.classList.add("tt-active");
      }
    }).observe(section, { attributes: true, attributeFilter: ["class"] });

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
    // Insert before the Settings tab (always present, always last among the
    // "real" tabs) rather than at the very end of the strip — grouping with
    // the other content tabs instead of trailing after Settings and the
    // collapse/expand toggle, which is where an appendChild fallback (the
    // previous approach — insert before whatever `[data-action=
    // "toggleExpanded"]` matches — was silently landing every time, since
    // that selector doesn't match anything in this Foundry version) ends up
    // looking like a stray icon separated from the rest by extra spacing.
    // insertBefore's reference node must be a DIRECT child of tabContainer,
    // not just any descendant — querySelector happily finds a match nested
    // inside some wrapper, but passing that straight to insertBefore then
    // throws "not a child of this node" (confirmed live, 2026-09-18). Walk
    // up from the match to whichever ancestor actually is tabContainer's
    // direct child before using it as the reference.
    let settingsButton = tabContainer.querySelector('[data-tab="settings"][role="tab"]');
    while (settingsButton && settingsButton.parentElement !== tabContainer) settingsButton = settingsButton.parentElement;
    try {
      if (settingsButton) tabContainer.insertBefore(button, settingsButton);
      else tabContainer.appendChild(button);
    } catch (insertErr) {
      // Never let a positioning quirk leave the tab entirely un-added —
      // the earlier version of this bug did exactly that, and worse, left
      // `section` (already appended above) orphaned with no button at all,
      // since the getElementById dedup guard then made every later retry
      // think injection had already fully succeeded.
      console.warn("Traveller Trading | Could not position sidebar tab precisely, appending instead.", insertErr);
      tabContainer.appendChild(button);
    }
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
