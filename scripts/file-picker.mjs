// Opens the browser's own local file chooser and resolves with the chosen
// File, or null if the user cancels. Shared by world-map JSON import
// (world-map-gen.mjs) and lore bundle import (lore-import.mjs). Kept in its
// own module, free of Foundry globals, so modules tested under Node can
// import it without pulling in window-base.mjs's ApplicationV2 subclass.
// Several files at once, or (directory: true) a whole folder via
// webkitdirectory. Resolves with an array of Files (empty if cancelled).
// Each File from a folder pick carries webkitRelativePath, starting with the
// chosen folder's own name. Browsers without folder picking fall back to an
// ordinary multi-file selection.
export function chooseFiles({ accept = "", directory = false } = {}) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.hidden = true;
    if (accept) input.accept = accept;
    if (directory && "webkitdirectory" in input) input.webkitdirectory = true;
    const finish = files => { input.remove(); resolve(files); };
    input.addEventListener("change", () => finish([...(input.files || [])]), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    document.body.append(input); input.click();
  });
}

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
