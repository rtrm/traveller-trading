import { MODULE_ID } from "./constants.mjs";
import { getShipDocs, createShipDoc, deleteShipDoc } from "./data.mjs";
import { esc, standardLookEnabled, createDialogV2 } from "./window-base.mjs";
import { openGroupFinanceApp } from "./finance-app.mjs";
import { openShipApp, closeShipAppIfOpen } from "./ship-app.mjs";

// Sibling Traveller modules whose sidebar icon this launcher's footer also
// surfaces when they're installed and active — each exposes a no-arg
// `game.modules.get(id).api.open()`, the same convention this module's own
// main.mjs uses for its public API.
const RELATED_MODULES = [
  { id: "drinax-tracker", title: "Pirates of Drinax Tracker", icon: "fa-skull-crossbones" },
  { id: "traveller-name-generator", title: "Traveller Name Generator", icon: "fa-dice" }
];

// Mounted into the real sidebar tab strip (see main.mjs) as a simple
// launcher/directory list, matching how every other sidebar tab behaves:
// entries here just open the relevant document in its own window, rather
// than embedding Group Finance / ship details in the sidebar itself. Uses
// Foundry's own directory/list class names (directory-list, directory-item,
// document-name) so it picks up the same look as Actors/Items/Journal
// directories from Foundry's own CSS, instead of a from-scratch style.
export class LauncherController {
  constructor(hostElement) {
    this.host = hostElement;
    this.shipDocs = [];
    this.mounted = false;
  }

  async mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.innerHTML = `
      <div id="tt-root" class="directory flexcol">
        <header class="directory-header">
          <h3 class="tt-launcher-title">Traveller Trading</h3>
        </header>
        <ol class="directory-list" data-tt-launcher-list></ol>
        <footer class="directory-footer">
          <ol class="directory-list" data-tt-launcher-footer></ol>
        </footer>
      </div>`;
    this.root = this.host.querySelector("#tt-root");
    this.root.classList.toggle("tt-standard-look", standardLookEnabled());
    this.root.addEventListener("click", (e) => this._onClick(e));

    // Deferred one tick: mount() runs SYNCHRONOUSLY inside the sidebar
    // button's own click handler, while that click is still bubbling
    // toward document. A listener attached to an ancestor (ContextMenu
    // attaches one to document, to detect "click outside the menu, close
    // it") DURING a bubbling event's dispatch still fires for that SAME
    // event once bubbling reaches it — standard DOM behavior. Not
    // actually the cause of the first-click-swallowed bug (that turned
    // out to be pointer-events, see traveller-trading.css), but
    // constructing this after the current event has fully dispatched is
    // still worth keeping to avoid that same-event delivery entirely.
    setTimeout(() => {
      // jQuery: false opts into v14's future default (and silences the v13
      // deprecation warning) — condition/callback below receive a plain
      // HTMLElement rather than a jQuery-wrapped one.
      new foundry.applications.ux.ContextMenu(this.root, ".directory-item[data-tt-open]", [
        {
          name: "Delete",
          icon: '<i class="fa-solid fa-trash"></i>',
          condition: (el) => game.user.isGM && el.dataset.ttOpen !== "finance",
          callback: async (el) => {
            const id = el.dataset.ttOpen;
            const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Delete" }, content: "<p>Delete this entry? This cannot be undone.</p>" });
            if (!ok) return;
            await deleteShipDoc(id);
            closeShipAppIfOpen(id);
            this.refresh();
          }
        }
      ], { jQuery: false });
    }, 0);

    this.refresh();
  }

  unmount() {}

  refresh() {
    this.shipDocs = getShipDocs();
    this._renderList();
  }

  async _onClick(e) {
    const item = e.target.closest("[data-tt-open]");
    if (item) {
      const id = item.dataset.ttOpen;
      if (id === "finance") openGroupFinanceApp();
      else openShipApp(id);
      return;
    }
    const addBtn = e.target.closest("[data-tt-add]");
    if (addBtn) { await this._promptAddShip(addBtn.dataset.ttAdd === "storage"); return; }
    const moduleBtn = e.target.closest("[data-tt-open-module]");
    if (moduleBtn) { game.modules.get(moduleBtn.dataset.ttOpenModule)?.api?.open?.(); return; }
  }

  async _promptAddShip(isStorage) {
    const label = isStorage ? "storage location" : "starship";
    const content = document.createElement("div");
    content.innerHTML = `<div class="tt-field"><label>Name of the ${label}</label><input type="text" id="tt-new-name" placeholder="e.g. ${isStorage ? "Warehouse 7" : "Far Trader"}"></div>`;
    // Read from the LIVE rendered form (button.form) inside the button's
    // own callback, not from this detached `content` element — DialogV2
    // stringifies `content` and rebuilds fresh DOM from it, so this
    // element is never actually shown (confirmed via Foundry's own
    // DialogV2 docs, 2026-09-16).
    const name = await new Promise(resolve => {
      let resolved = false;
      const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
      createDialogV2({
        window: { title: `Add ${isStorage ? "Storage" : "Starship"}` },
        content,
        buttons: [
          {
            action: "ok", label: "Add", default: true,
            callback: (event, button) => {
              const value = button.form.querySelector("#tt-new-name")?.value.trim() || null;
              finish(value);
              return value;
            }
          },
          { action: "cancel", label: "Cancel", callback: () => { finish(null); return null; } }
        ],
        rejectClose: false
      }, () => finish(null)).render(true);
    });
    if (!name) return;
    const doc = await createShipDoc(name, isStorage);
    this.refresh();
    openShipApp(doc.id);
  }

  _renderList() {
    const list = this.root?.querySelector("[data-tt-launcher-list]");
    const footer = this.root?.querySelector("[data-tt-launcher-footer]");
    if (!list || !footer) return;
    let html = `
      <li class="directory-item tt-launcher-item" data-tt-open="finance">
        <span class="tt-launcher-icon">💰</span>
        <div class="document-name">Group Finance</div>
      </li>`;
    for (const doc of this.shipDocs) {
      const kind = doc.getFlag(MODULE_ID, "kind");
      const icon = kind === "storage" ? "📦" : "🚀";
      html += `
      <li class="directory-item tt-launcher-item" data-tt-open="${doc.id}">
        <span class="tt-launcher-icon">${icon}</span>
        <div class="document-name">${esc(doc.name.replace(/^Starship: |^Storage: /, ""))}</div>
      </li>`;
    }
    list.innerHTML = html;

    let footerHtml = "";
    if (game.user.isGM) {
      footerHtml += `
      <li class="directory-item tt-launcher-item tt-launcher-add" data-tt-add="ship">
        <span class="tt-launcher-icon">➕🚀</span>
        <div class="document-name">Add Starship</div>
      </li>
      <li class="directory-item tt-launcher-item tt-launcher-add" data-tt-add="storage">
        <span class="tt-launcher-icon">➕📦</span>
        <div class="document-name">Add Storage Location</div>
      </li>`;
    }
    for (const mod of RELATED_MODULES) {
      if (!game.modules.get(mod.id)?.active) continue;
      footerHtml += `
      <li class="directory-item tt-launcher-item tt-launcher-add" data-tt-open-module="${mod.id}">
        <span class="tt-launcher-icon"><i class="fa-solid ${mod.icon}"></i></span>
        <div class="document-name">${esc(mod.title)}</div>
      </li>`;
    }
    footer.innerHTML = footerHtml;
  }
}
