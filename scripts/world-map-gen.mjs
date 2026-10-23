import { MODULE_ID } from "./constants.mjs";
import { buildWorldGrid, parseWorldSize, renderWorldMapSvg } from "./world-map-grid.mjs";
import { generateWorldTerrain } from "./world-map-terrain.mjs";
import { serializeWorldMap, deserializeWorldMap, embedWorldMapData, recoverWorldMapData, MAX_MAP_BYTES } from "./world-map-data.mjs";
import { chooseFile } from "./file-picker.mjs";

// Forge routes directory operations through its remote API. Share preparation
// across the session, including concurrent requests, instead of repeating two
// creates (and often two browses) for every actor in a sector import.
const preparedMapDirectories = new WeakMap();

async function prepareMapDirectory(picker, source, dir) {
  let preparation = preparedMapDirectories.get(picker);
  if (!preparation) {
    preparation = (async () => {
      for (const path of [`worlds/${MODULE_ID}`, dir]) {
        try { await picker.createDirectory(source, path); }
        catch (error) {
          // Do not hide permissions/storage errors unless the folder exists.
          try { await picker.browse(source, path); }
          catch { throw error; }
        }
      }
    })();
    preparedMapDirectories.set(picker, preparation);
  }
  try { await preparation; }
  catch (error) {
    preparedMapDirectories.delete(picker);
    throw error;
  }
}

// Preserve the actor/image interface; geometry has no Foundry dependencies.
export async function generateAndSaveWorldMap(actor, { quietSkip = false, blank = false } = {}) {
  if (!game.user.isGM) return null;
  try {
    const size = parseWorldSize(actor.system?.world?.uwp?.size);
    if (size === 0) {
      if (!quietSkip) ui.notifications.info(`${actor.name}: size 0 has no globe surface map.`);
      return null;
    }
    const grid = buildWorldGrid(size);
    if (!blank) generateWorldTerrain(grid, actor.system.world.uwp);
    return await saveWorldMap(actor, grid);
  } catch (error) {
    console.error("Traveller Trading | World map generation failed", error);
    ui.notifications.error(`Couldn't generate a ${blank ? "blank" : "surface"} map for ${actor.name}: ${error.message || String(error)}`);
    return null;
  }
}

async function saveWorldMap(actor, grid) {
  const data = serializeWorldMap(grid, actor.name);
  const svg = embedWorldMapData(renderWorldMapSvg(grid, actor.name), data);
  const picker = foundry.applications.apps.FilePicker.implementation;
  const source = "data";
  const dir = `worlds/${MODULE_ID}/maps`;
  await prepareMapDirectory(picker, source, dir);
  // A fresh path refreshes the sheet image after replacing an old map.
  const filename = `${actor.id}-${data.kind}-${foundry.utils.randomID()}.svg`;
  const file = new File([svg], filename, { type: "image/svg+xml" });
  let result;
  try {
    result = await picker.upload(source, dir, file, {}, { notify: false });
    if (!result?.path) throw new Error("Upload returned no path. Check the map folder and storage permissions.");
  } catch (error) {
    // The user may have removed the folder, or storage may have recovered
    // since a failed upload. Recheck it on the next attempt.
    preparedMapDirectories.delete(picker);
    throw error;
  }
  // Keep image and serialized state together in a single document update.
  await actor.update({ "system.world.map": result.path,
    [`flags.${MODULE_ID}.worldMap`]: { path: result.path, data } });
  return result.path;
}

export async function exportWorldMapData(actor) {
  const path = actor.system?.world?.map;
  const saved = actor.flags?.[MODULE_ID]?.worldMap;
  if (path && saved?.path === path && saved?.data) return deserializeWorldMap(saved.data).data;
  if (!path || !/\.svg(?:[?#]|$)/i.test(path)) throw new Error("No map data is available. Generate a map first; ordinary images cannot be exported as map JSON.");
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Couldn't read the existing map (${response.status}).`);
  const svg = await response.text();
  if (svg.length > MAX_MAP_BYTES * 4) throw new Error("The existing SVG is too large to read as map data.");
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("The existing map SVG is invalid.");
  const metadata = doc.querySelector("metadata#tt-world-map-data");
  if (metadata) return deserializeWorldMap(metadata.textContent).data;
  return recoverWorldMapData([...doc.querySelectorAll("polygon[data-cell]")].map(polygon => ({
    id: polygon.getAttribute("data-cell"), fill: polygon.getAttribute("fill")
  })), actor.name);
}

export async function importWorldMapData(actor, input) {
  if (!game.user.isGM) return null;
  try {
    const { grid } = deserializeWorldMap(input);
    const size = parseWorldSize(actor.system?.world?.uwp?.size);
    if (size !== grid.size) throw new Error(`This map is size ${grid.size}, but ${actor.name} is size ${size}. Choose a matching world; importing does not change its UWP.`);
    return await saveWorldMap(actor, grid);
  } catch (error) {
    console.error("Traveller Trading | World map import failed", error);
    ui.notifications.error(`Couldn't import map for ${actor.name}: ${error.message || String(error)}`);
    return null;
  }
}

function downloadMap(data, actor) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(actor.name || "world").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80)}-world-map.json`;
  document.body.append(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function registerWorldMapGenButton() {
  Hooks.on("renderActorSheet", (app, html) => {
    const actor = app.actor || app.document;
    if (!actor || actor.type !== "world" || !game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const img = root.querySelector('img[data-edit="system.world.map"]');
    if (!img || img.parentElement.querySelector("[data-tt-gen-map]")) return;
    const container = document.createElement("div");
    container.dataset.ttGenMap = "1";
    const buttons = [];
    const actions = [
      { label: "Generate / Reroll Surface Map", run: () => generateAndSaveWorldMap(actor) },
      { label: "Generate Blank World Map", run: () => generateAndSaveWorldMap(actor, { blank: true }) },
      { label: "Export Map Data", run: async () => downloadMap(await exportWorldMapData(actor), actor) },
      { label: "Import Map Data", run: async () => {
        const file = await chooseFile();
        if (!file) return;
        if (file.size > MAX_MAP_BYTES) throw new Error("Map data exceeds the 5 MB limit.");
        await importWorldMapData(actor, await file.text());
      } }
    ];
    for (const { label, run } of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.ttGenMap = "1";
      btn.textContent = label;
      btn.style.cssText = "margin-top:8px;";
      btn.addEventListener("click", async event => {
        event.preventDefault();
        for (const button of buttons) button.disabled = true;
        btn.textContent = "Working…";
        try { await run(); }
        catch (error) {
          console.error(`Traveller Trading | ${label} failed`, error);
          ui.notifications.error(`${label}: ${error.message || String(error)}`);
        }
        finally {
          for (const button of buttons) button.disabled = false;
          btn.textContent = label;
        }
      });
      buttons.push(btn);
      container.append(btn);
    }
    img.insertAdjacentElement("afterend", container);
  });
}
