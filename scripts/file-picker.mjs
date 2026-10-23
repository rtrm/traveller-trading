// Opens the browser's own local file chooser and resolves with the chosen
// File, or null if the user cancels. Shared by world-map JSON import
// (world-map-gen.mjs) and lore bundle import (lore-import.mjs). Kept in its
// own module, free of Foundry globals, so modules tested under Node can
// import it without pulling in window-base.mjs's ApplicationV2 subclass.
export function chooseFile({ accept = ".json,application/json" } = {}) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept; input.hidden = true;
    const finish = file => { input.remove(); resolve(file); };
    input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input); input.click();
  });
}
