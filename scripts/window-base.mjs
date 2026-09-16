import { MODULE_ID } from "./constants.mjs";

// "Use Standard Foundry Styling" world setting, registered in main.mjs —
// off by default, so nothing changes for existing worlds until a GM opts
// in. Read here (rather than passed around) so every window can apply it
// in its own _onRender without plumbing it through every constructor.
export function standardLookEnabled() {
  try { return !!game.settings.get(MODULE_ID, "standardLook"); } catch (err) { return false; }
}

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

// Open/close behaviour for the custom dropdown markup produced by
// customSelectHtml(). Exported on its own (as well as wired into every
// TradingWindowBase below) so a standalone Foundry Dialog's content — which
// lives outside any window's #tt-root — can use the same dropdown component
// via its own `render` callback.
export function bindCustomSelects(root) {
  root.addEventListener("click", (e) => {
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
    root.querySelectorAll(".tt-select-menu.open").forEach(m => m.classList.remove("open"));
  });
}

// A safe wrapper around DialogV2 for custom multi-button dialogs whose
// content needs live-wired listeners before the user can interact with it
// (e.g. clicking a result row, not just a submit button). `content` should
// be built as a detached HTMLElement with any such listeners already
// attached — a detached node's listeners still fire normally once Foundry
// inserts it into the document, which sidesteps needing to know DialogV2's
// exact `render` callback signature. `onDismiss` fires exactly once however
// the dialog closes (a button, the window's own close control, or a caller
// explicitly calling dlg.close() after a listener already resolved
// something) — DialogV2 doesn't document a config-level close callback the
// way v1's Dialog did, so this patches the returned instance's own close()
// instead of depending on one.
export function createDialogV2(config, onDismiss) {
  const dlg = new foundry.applications.api.DialogV2(config);
  if (onDismiss) {
    const originalClose = dlg.close.bind(dlg);
    let dismissed = false;
    dlg.close = async (options) => {
      if (!dismissed) { dismissed = true; onDismiss(); }
      return originalClose(options);
    };
  }
  return dlg;
}

function bindSelectAndActionDelegation(root, controller) {
  bindCustomSelects(root);
  root.addEventListener("click", async (e) => {
    const actionBtn = e.target.closest("[data-tt-action]");
    if (actionBtn) {
      const handler = "_action_" + actionBtn.dataset.ttAction.replace(/-/g, "_");
      if (typeof controller[handler] === "function") await controller[handler](actionBtn);
    }
  });
}

// Base class for the Group Finance and Ship/Storage windows. Built on
// ApplicationV2 (not the deprecated v1 Application — Foundry has deprecated
// Application/FormApplication/Dialog v1 as of v13 ahead of their eventual
// removal) and skips HandlebarsApplicationMixin/a .hbs file entirely —
// content is built as an HTML string and assigned wholesale via a custom
// _renderHTML/_replaceHTML, the same pattern used throughout this module,
// rather than a Handlebars partial.
export class TradingWindowBase extends foundry.applications.api.ApplicationV2 {
  async _renderHTML(context, options) {
    // Reuses the "#tt-root" id (also used by the sidebar launcher) purely
    // so the module's existing scoped CSS applies here too, without needing
    // a parallel set of rules for window content.
    return `<div id="tt-root"><p class="tt-empty">Loading…</p></div>`;
  }

  async _replaceHTML(result, content, options) {
    content.innerHTML = result;
  }

  async _onRender(context, options) {
    // "#tt-root" is always a descendant of this.element (the full app
    // frame, header included) since _replaceHTML injects it into the
    // window-content container passed in as `content` above — no ambiguity
    // here the way v1's raw _renderInner() return value once had.
    this.root = this.element.querySelector("#tt-root");
    this.root.classList.toggle("tt-standard-look", standardLookEnabled());
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
