export function esc(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
export function fmtCr(n) {
  const v = Number(n) || 0;
  return `Cr${v.toLocaleString()}`;
}

export function customSelectHtml(handler, items, selected, extraClass) {
  const selectedItem = items.find(it => it.value === selected) || { label: "" };
  const opts = items.map(it => `<div class="tt-select-opt ${it.value === selected ? "selected" : ""}" data-tt-select-opt="${esc(it.value)}">${esc(it.label)}</div>`).join("");
  return `<div class="tt-select ${extraClass || ""}" data-tt-select-handler="${handler}">
    <button type="button" class="tt-select-btn" data-tt-select-toggle>${esc(selectedItem.label)}</button>
    <div class="tt-select-menu">${opts}</div>
  </div>`;
}

function bindSelectAndActionDelegation(root, controller) {
  root.addEventListener("click", async (e) => {
    const selectToggle = e.target.closest("[data-tt-select-toggle]");
    if (selectToggle) {
      const menu = selectToggle.nextElementSibling;
      const wasOpen = menu.classList.contains("open");
      root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
      if (!wasOpen) menu.classList.add("open");
      return;
    }
    const selectOpt = e.target.closest("[data-tt-select-opt]");
    if (selectOpt) {
      const wrapper = selectOpt.closest(".tt-select");
      wrapper.querySelector("[data-tt-select-toggle]").textContent = selectOpt.textContent;
      wrapper.querySelectorAll("[data-tt-select-opt]").forEach(o => o.classList.toggle("selected", o === selectOpt));
      wrapper.querySelector(".tt-select-menu").classList.remove("open");
      return;
    }
    const actionBtn = e.target.closest("[data-tt-action]");
    if (actionBtn) {
      const handler = "_action_" + actionBtn.dataset.ttAction.replace(/-/g, "_");
      if (typeof controller[handler] === "function") await controller[handler](actionBtn);
      return;
    }
    root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
  });
}

// Base class for the Group Finance and Ship/Storage windows. Uses plain
// Application (v1, not V2) and skips renderTemplate/a .hbs file entirely —
// content is built as an HTML string and assigned wholesale, the same
// pattern used throughout this module, rather than a Handlebars partial.
export class TradingWindowBase extends Application {
  async _renderInner() {
    // Reuses the "#tt-root" id (also used by the sidebar launcher) purely
    // so the module's existing scoped CSS applies here too, without needing
    // a parallel set of rules for window content.
    return $('<div id="tt-root"><p class="tt-empty">Loading…</p></div>');
  }

  activateListeners(html) {
    super.activateListeners(html);
    // Application passes the whole outer window element here (header +
    // window-content), not just what _renderInner returned — our content
    // has to be found as a descendant, not assumed to be html[0] itself.
    this.root = html[0].querySelector("#tt-root");
    bindSelectAndActionDelegation(this.root, this);

    this._outsideClickHandler = (e) => {
      if (!e.target.closest(".tt-select")) {
        this.root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
      }
    };
    document.addEventListener("click", this._outsideClickHandler);

    this._load().then(() => this._renderContent());
  }

  async close(options) {
    if (this._outsideClickHandler) document.removeEventListener("click", this._outsideClickHandler);
    return super.close(options);
  }
}
