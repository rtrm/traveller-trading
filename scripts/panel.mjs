import { MODULE_ID } from "./constants.mjs";
import { getShipDocs, createShipDoc } from "./data.mjs";
import { esc } from "./window-base.mjs";
import { openGroupFinanceApp } from "./finance-app.mjs";
import { openShipApp } from "./ship-app.mjs";

// Mounted into the real sidebar tab strip (see main.mjs) as a simple
// launcher/directory list, matching how every other sidebar tab behaves:
// entries here just open the relevant document in its own window, rather
// than embedding Group Finance / ship details in the sidebar itself.
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
      <div id="tt-root">
        <div class="tt-header">
          <p class="tt-title">Traveller <span>Trading</span></p>
        </div>
        <ol class="tt-launcher-list" data-tt-launcher-list></ol>
      </div>`;
    this.root = this.host.querySelector("#tt-root");
    this.root.addEventListener("click", (e) => this._onClick(e));
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
    this.refresh();
    openShipApp(doc.id);
  }

  _renderList() {
    const list = this.root?.querySelector("[data-tt-launcher-list]");
    if (!list) return;
    let html = `
      <li class="tt-launcher-item" data-tt-open="finance">
        <span class="tt-launcher-icon">💰</span>
        <span class="tt-launcher-name">Group Finance</span>
      </li>`;
    for (const doc of this.shipDocs) {
      const kind = doc.getFlag(MODULE_ID, "kind");
      const icon = kind === "storage" ? "📦" : "🚀";
      html += `
      <li class="tt-launcher-item" data-tt-open="${doc.id}">
        <span class="tt-launcher-icon">${icon}</span>
        <span class="tt-launcher-name">${esc(doc.name.replace(/^Starship: |^Storage: /, ""))}</span>
      </li>`;
    }
    if (game.user.isGM) {
      html += `
      <li class="tt-launcher-item tt-launcher-add" data-tt-add="ship">
        <span class="tt-launcher-icon">➕🚀</span>
        <span class="tt-launcher-name">Add Starship</span>
      </li>
      <li class="tt-launcher-item tt-launcher-add" data-tt-add="storage">
        <span class="tt-launcher-icon">➕📦</span>
        <span class="tt-launcher-name">Add Storage Location</span>
      </li>`;
    }
    list.innerHTML = html;
  }
}
