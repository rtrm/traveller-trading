// Optional browser integration check. Install Playwright + Chromium first.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.route("http://map-test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="sheet"><img data-edit="system.world.map"></div>' });
    if (path.startsWith("/scripts/") && /^\/scripts\/[\w-]+\.mjs$/.test(path)) {
      return route.fulfill({ contentType: "application/javascript", body: await readFile(new URL(`..${path}`, import.meta.url), "utf8") });
    }
    if (path === "/legacy.svg" || path === "/metadata.svg") {
      return route.fulfill({ contentType: "image/svg+xml", body: await page.evaluate(p => p === "/legacy.svg" ? window.legacySvg : window.uploadedSvg, path) });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto("http://map-test/");
  await page.evaluate(async () => {
    const api = await import("/scripts/world-map-gen.mjs");
    window.mapApi = api;
    window.uploads = 0; window.errors = []; window.uploadedSvg = "";
    window.game = { user: { isGM: true } };
    window.ui = { notifications: { error: message => errors.push(message), info() {} } };
    window.foundry = { utils: { randomID: () => String(uploads) }, applications: { apps: { FilePicker: { implementation: {
      async createDirectory() {}, async browse() {},
      async upload(source, dir, file) { uploads++; window.uploadedSvg = await file.text(); return { path: "/metadata.svg" }; }
    } } } } };
    window.actor = { id: "test", name: "Browser world", type: "world", flags: {},
      system: { world: { uwp: { size: 5, atmosphere: 6, hydrographics: 7 }, map: "" } },
      async update(change) {
        this.system.world.map = change["system.world.map"];
        this.flags["traveller-trading"] = { worldMap: change["flags.traveller-trading.worldMap"] };
      }
    };
    window.Hooks = { on(name, fn) { fn({ actor }, document.querySelector("#sheet")); } };
    api.registerWorldMapGenButton();
  });
  assert.equal(await page.getByRole("button").count(), 4);
  await page.getByRole("button", { name: "Generate / Reroll Surface Map", exact: true }).click();
  await page.waitForFunction(() => uploads === 1 && !document.querySelector("button").disabled);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Map Data", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "Browser-world-world-map.json");
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.cells.length, 252);
  // Exercise the real DOMParser metadata path, then the older SVG recovery.
  const recovered = await page.evaluate(async () => {
    actor.flags = {};
    const metadata = await mapApi.exportWorldMapData(actor);
    window.legacySvg = uploadedSvg.replace(/<metadata.*?<\/metadata>/s, "");
    actor.system.world.map = "/legacy.svg";
    const legacy = await mapApi.exportWorldMapData(actor);
    return { metadata, legacy };
  });
  assert.deepEqual(recovered.metadata.cells, exported.cells);
  assert.deepEqual(recovered.legacy.cells.map(c => c.terrain), exported.cells.map(c => c.terrain));
  const fileChooserEvent = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import Map Data", exact: true }).click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles({ name: "map.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForFunction(() => uploads === 2 && !document.querySelector("button").disabled);
  const imported = await page.evaluate(() => actor.flags["traveller-trading"].worldMap.data);
  assert.deepEqual(imported.cells, exported.cells);
  const cancelEvent = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import Map Data", exact: true }).click();
  await cancelEvent;
  await page.locator('input[type="file"]').dispatchEvent("cancel");
  await page.waitForFunction(() => !document.querySelector("button").disabled);
  assert.equal(await page.evaluate(() => uploads), 2);
  assert.deepEqual(await page.evaluate(() => errors), []);
  console.log("Browser checks passed: four buttons, JSON download, metadata and legacy SVG export, file import, cancellation.");
} finally { await browser.close(); }
