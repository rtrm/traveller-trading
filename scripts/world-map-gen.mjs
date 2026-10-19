import { MODULE_ID } from "./constants.mjs";
import { buildWorldGrid, parseWorldSize, renderWorldMapSvg } from "./world-map-grid.mjs";

// Preserve the actor/image interface; geometry has no Foundry dependencies.
export async function generateAndSaveWorldMap(actor, { quietSkip = false } = {}) {
  if (!game.user.isGM) return null;
  try {
    const size = parseWorldSize(actor.system?.world?.uwp?.size);
    if (size === 0) {
      if (!quietSkip) ui.notifications.info(`${actor.name}: size 0 has no globe surface map.`);
      return null;
    }
    const svg = renderWorldMapSvg(buildWorldGrid(size), actor.name);
    const picker = foundry.applications.apps.FilePicker.implementation;
    const source = "data";
    const dir = `worlds/${MODULE_ID}/maps`;
    // Only ignore creation failures when browsing confirms an existing folder.
    for (const path of [`worlds/${MODULE_ID}`, dir]) {
      try { await picker.createDirectory(source, path); }
      catch (error) {
        try { await picker.browse(source, path); }
        catch { throw error; }
      }
    }
    // A fresh path refreshes the sheet image after replacing an old map.
    const filename = `${actor.id}-blank-${foundry.utils.randomID()}.svg`;
    const file = new File([svg], filename, { type: "image/svg+xml" });
    const result = await picker.upload(source, dir, file, {}, { notify: false });
    if (!result?.path) throw new Error("Upload returned no path. Check the map folder and storage permissions.");
    await actor.update({ "system.world.map": result.path });
    return result.path;
  } catch (error) {
    console.error("Traveller Trading | Blank world map generation failed", error);
    ui.notifications.error(`Couldn't generate a blank map for ${actor.name}: ${error.message || String(error)}`);
    return null;
  }
}

export function registerWorldMapGenButton() {
  Hooks.on("renderActorSheet", (app, html) => {
    const actor = app.actor || app.document;
    if (!actor || actor.type !== "world" || !game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const img = root.querySelector('img[data-edit="system.world.map"]');
    if (!img || img.parentElement.querySelector("[data-tt-gen-map]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.ttGenMap = "1";
    btn.textContent = "Generate Blank World Map";
    btn.style.cssText = "margin-top:8px;";
    btn.addEventListener("click", async event => {
      event.preventDefault();
      btn.disabled = true;
      btn.textContent = "Generating…";
      try { await generateAndSaveWorldMap(actor); }
      finally {
        btn.disabled = false;
        btn.textContent = "Generate Blank World Map";
      }
    });
    img.insertAdjacentElement("afterend", btn);
  });
}
