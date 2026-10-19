import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldGrid, parseWorldSize, renderWorldMapSvg } from "../scripts/world-map-grid.mjs";
import { generateAndSaveWorldMap, registerWorldMapGenButton, exportWorldMapData, importWorldMapData } from "../scripts/world-map-gen.mjs";

for (let size = 1; size <= 12; size++) {
  test(`size ${size}: closed globe topology and equilateral net`, () => {
    const grid = buildWorldGrid(size);
    assert.equal(grid.faces.length, 20);
    assert.equal(grid.cells.length, 10 * size * size + 2);
    assert.equal(grid.cells.filter(c => c.pentagon).length, 12);
    const cells = new Map(grid.cells.map(c => [c.id, c]));
    const appearances = new Map();
    for (const face of grid.faces) {
      assert.equal(face.fragments.length, (size + 1) * (size + 2) / 2);
      for (let i = 0; i < 3; i++) {
        const a = face.vertices[i], b = face.vertices[(i + 1) % 3];
        assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - grid.side) < 1e-8);
      }
      for (const f of face.fragments) appearances.set(f.cellId, (appearances.get(f.cellId) || 0) + 1);
    }
    for (const cell of grid.cells) {
      assert.equal(cell.neighbors.size, cell.pentagon ? 5 : 6);
      for (const id of cell.neighbors) assert.ok(cells.get(id).neighbors.has(cell.id));
      assert.equal(appearances.get(cell.id), cell.pentagon ? 5 : cell.id.includes("/") ? 2 : 1);
    }
    // Connected surface, including the polar cuts and east/west seam.
    const visited = new Set(), queue = [grid.cells[0].id];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (visited.has(id)) continue;
      visited.add(id); queue.push(...cells.get(id).neighbors);
    }
    assert.equal(visited.size, grid.cells.length);
    const edges = grid.cells.reduce((sum, c) => sum + c.neighbors.size, 0) / 2;
    assert.equal(grid.cells.length - edges + 20 * size * size, 2);
  });
}

test("numeric and extended-hex sizes, zero and malformed values", () => {
  for (const [input, expected] of [[4, 4], ["8", 8], ["10", 10], ["a", 10], ["B", 11], ["C", 12]]) {
    assert.equal(parseWorldSize(input), expected);
  }
  for (const input of [undefined, null, "", "?", "I", "O", -1, 1.2, NaN, true, 34, "-1"]) {
    assert.throws(() => parseWorldSize(input));
  }
  assert.equal(buildWorldGrid(0), null);
});

test("SVG is deterministic, clipped, white and XML escaped", () => {
  const grid = buildWorldGrid(5);
  const svg = renderWorldMapSvg(grid, '<World & "name">');
  assert.equal(svg, renderWorldMapSvg(grid, '<World & "name">'));
  assert.ok(svg.includes('&lt;World &amp; &quot;name&quot;&gt;'));
  assert.ok(svg.includes('clip-path="url(#mapBounds)"'));
  assert.ok(svg.includes('World hex: 1,000 km'));
  assert.ok(!svg.includes("undefined") && !svg.includes("NaN"));
  assert.equal((svg.match(/clipPath id="(?:north|south|middle)/g) || []).length, 20);
});

function setup(size = 5) {
  const calls = { upload: 0, update: 0, directory: 0, browse: 0, info: [], error: [] };
  globalThis.game = { user: { isGM: true } };
  globalThis.ui = { notifications: {
    info: text => calls.info.push(text), error: text => calls.error.push(text)
  } };
  const picker = {
    async createDirectory() { calls.directory++; }, async browse() { calls.browse++; },
    async upload() { calls.upload++; return { path: "maps/generated.svg" }; }
  };
  globalThis.foundry = { utils: { randomID: () => "unique" }, applications: { apps: { FilePicker: { implementation: picker } } } };
  const actor = { id: "actor1", name: "Example", type: "world", system: { world: { uwp: { size, atmosphere: 6, hydrographics: 5 }, map: "original.svg" } },
    async update(data) {
      calls.update++; Object.assign(this.system.world, { map: data["system.world.map"] });
      if (data["flags.traveller-trading.worldMap"]) this.flags = { "traveller-trading": { worldMap: data["flags.traveller-trading.worldMap"] } };
    } };
  return { calls, actor, picker };
}

test("Foundry saves only successful uploads; zero, bad UWP and storage failures preserve maps", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const size of [0, undefined, "?"]) {
      const { actor, calls } = setup(size);
      if (size === undefined) delete actor.system.world.uwp.size;
      assert.equal(await generateAndSaveWorldMap(actor), null);
      assert.equal(calls.upload, 0); assert.equal(calls.update, 0);
      assert.equal(actor.system.world.map, "original.svg");
    }
    let context = setup(0);
    await generateAndSaveWorldMap(context.actor, { quietSkip: true });
    assert.equal(context.calls.info.length, 0);
    context = setup("A");
    assert.equal(await generateAndSaveWorldMap(context.actor), "maps/generated.svg");
    assert.equal(context.calls.update, 1);
    for (const failure of ["missingPath", "upload", "directory"]) {
      context = setup();
      if (failure === "missingPath") context.picker.upload = async () => ({});
      if (failure === "upload") context.picker.upload = async () => { throw new Error("Storage unavailable"); };
      if (failure === "directory") {
        context.picker.createDirectory = async () => { throw new Error("Permission denied"); };
        context.picker.browse = async () => { throw new Error("Missing folder"); };
      }
      assert.equal(await generateAndSaveWorldMap(context.actor), null);
      assert.equal(context.calls.update, 0); assert.equal(context.calls.error.length, 1);
    }
    context = setup();
    context.picker.createDirectory = async () => { throw new Error("Already exists"); };
    assert.ok(await generateAndSaveWorldMap(context.actor));
    game.user.isGM = false;
    assert.equal(await generateAndSaveWorldMap(context.actor), null);
    assert.equal(context.calls.update, 1);
  } finally { console.error = originalError; }
});

test("sheet button restores state after a failed generation", async () => {
  const { actor, picker } = setup();
  let render;
  globalThis.Hooks = { on: (name, fn) => { assert.equal(name, "renderActorSheet"); render = fn; } };
  globalThis.HTMLElement = class {};
  const buttons = [];
  globalThis.document = { createElement: tag => {
    if (tag === "div") return { dataset: {}, append() {} };
    const button = { dataset: {}, style: {}, addEventListener: (name, fn) => { button.click = fn; } };
    buttons.push(button); return button;
  } };
  const root = new HTMLElement();
  root.querySelector = () => ({ parentElement: { querySelector: () => null }, insertAdjacentElement() {} });
  registerWorldMapGenButton(); render({ actor }, root);
  picker.upload = async () => { throw new Error("Offline"); };
  const originalError = console.error; console.error = () => {};
  try { await buttons[0].click({ preventDefault() {} }); }
  finally { console.error = originalError; }
  assert.ok(buttons.every(button => button.disabled === false));
  assert.equal(buttons[0].textContent, "Generate / Reroll Surface Map");
  assert.equal(buttons[1].textContent, "Generate Blank World Map");
  assert.equal(buttons[2].textContent, "Export Map Data");
  assert.equal(buttons[3].textContent, "Import Map Data");
});

test("generated map exports from saved data, and imports without rerolling or changing UWP", async () => {
  const { actor, calls } = setup();
  await generateAndSaveWorldMap(actor);
  const data = await exportWorldMapData(actor);
  const originalUwp = structuredClone(actor.system.world.uwp);
  const before = calls.upload;
  actor.name = "Imported world";
  assert.ok(await importWorldMapData(actor, JSON.stringify(data)));
  const exported = await exportWorldMapData(actor);
  assert.deepEqual(exported.cells, data.cells);
  assert.equal(exported.worldName, "Imported world");
  assert.deepEqual(actor.system.world.uwp, originalUwp);
  assert.equal(calls.upload, before + 1);
});

test("bad imports and size mismatches preserve saved map and data; non-GMs cannot import", async () => {
  const { actor, calls } = setup();
  await generateAndSaveWorldMap(actor);
  const data = await exportWorldMapData(actor);
  const saved = structuredClone(actor.flags);
  const uploads = calls.upload;
  const originalError = console.error; console.error = () => {};
  try {
    assert.equal(await importWorldMapData(actor, "bad JSON"), null);
    actor.system.world.uwp.size = 4;
    assert.equal(await importWorldMapData(actor, data), null);
    actor.system.world.uwp.size = 5;
    game.user.isGM = false;
    assert.equal(await importWorldMapData(actor, data), null);
  } finally { console.error = originalError; }
  assert.equal(calls.upload, uploads);
  assert.deepEqual(actor.flags, saved);
  assert.equal(actor.system.world.map, "maps/generated.svg");
});

test("failed map import upload preserves image and serialized actor state", async () => {
  const { actor, picker } = setup();
  await generateAndSaveWorldMap(actor);
  const data = await exportWorldMapData(actor);
  const saved = structuredClone(actor.flags);
  picker.upload = async () => { throw new Error("Storage unavailable"); };
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await importWorldMapData(actor, data), null); }
  finally { console.error = originalError; }
  assert.deepEqual(actor.flags, saved);
  assert.equal(actor.system.world.map, "maps/generated.svg");
});

test("desktop-edited terrain and settlements import into the actor and uploaded SVG", async () => {
  const { actor, picker } = setup();
  await generateAndSaveWorldMap(actor);
  const data = await exportWorldMapData(actor);
  data.cells[0].terrain = "cropland"; data.cells[0].surface = "land";
  data.cells[0].features = ["starport", "city", "dome", "arcology"];
  data.profile = { uwp: "B565489-B", tradeCodes: ["Ni"], habitableZone: true, resourceCount: 0 };
  let svg;
  picker.upload = async (source, path, file) => { svg = await file.text(); return { path: "maps/edited.svg" }; };
  assert.equal(await importWorldMapData(actor, data), "maps/edited.svg");
  for (const key of data.cells[0].features) assert.ok(svg.includes(`data-feature="${key}"`));
  const exported = await exportWorldMapData(actor);
  assert.deepEqual(exported.cells, data.cells);
  assert.deepEqual(exported.profile, data.profile);
});

test("default actor generation uploads terrain; explicit blank generation needs only size", async () => {
  const { actor, picker } = setup();
  const uploaded = [];
  picker.upload = async (source, dir, file) => {
    uploaded.push({ name: file.name, svg: await file.text() });
    return { path: "maps/generated.svg" };
  };
  assert.ok(await generateAndSaveWorldMap(actor));
  assert.ok(uploaded[0].name.includes("-surface-"));
  assert.ok(uploaded[0].svg.includes('data-terrain="ocean"'));
  delete actor.system.world.uwp.hydrographics;
  delete actor.system.world.uwp.atmosphere;
  assert.ok(await generateAndSaveWorldMap(actor, { blank: true }));
  assert.ok(uploaded[1].name.includes("-blank-"));
  assert.ok(!uploaded[1].svg.includes("data-terrain="));
});

test("invalid terrain UWP preserves an existing actor map without uploading", async () => {
  const { actor, calls } = setup();
  actor.system.world.uwp.hydrographics = "?";
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await generateAndSaveWorldMap(actor), null); }
  finally { console.error = originalError; }
  assert.equal(calls.upload, 0);
  assert.equal(calls.update, 0);
  assert.equal(actor.system.world.map, "original.svg");
});

test("sector-sized map batch prepares folders once and still uploads each map", async () => {
  const { actor, calls } = setup(1);
  for (let i = 0; i < 80; i++) assert.ok(await generateAndSaveWorldMap(actor));
  assert.equal(calls.directory, 2);
  assert.equal(calls.browse, 0);
  assert.equal(calls.upload, 80);
  assert.equal(calls.update, 80);
});

test("concurrent maps share folder preparation", async () => {
  const { actor, calls } = setup(1);
  await Promise.all(Array.from({ length: 5 }, () => generateAndSaveWorldMap(actor)));
  assert.equal(calls.directory, 2);
  assert.equal(calls.upload, 5);
});

test("failed folder preparation and upload can recover on next attempt", async () => {
  const originalError = console.error; console.error = () => {};
  try {
    const { actor, calls, picker } = setup(1);
    const create = picker.createDirectory, browse = picker.browse, upload = picker.upload;
    picker.createDirectory = async () => { throw new Error("Offline"); };
    picker.browse = async () => { throw new Error("Offline"); };
    assert.equal(await generateAndSaveWorldMap(actor), null);
    picker.createDirectory = create; picker.browse = browse;
    assert.ok(await generateAndSaveWorldMap(actor));
    assert.equal(calls.directory, 2);
    picker.upload = async () => { throw new Error("Folder removed"); };
    assert.equal(await generateAndSaveWorldMap(actor), null);
    picker.upload = upload;
    assert.ok(await generateAndSaveWorldMap(actor));
    assert.equal(calls.directory, 4);
    assert.equal(calls.update, 2);
  } finally { console.error = originalError; }
});

test("batch imports continue after size zero and upload failure", async () => {
  const { calls, picker } = setup();
  foundry.applications.api = { ApplicationV2: class {} };
  game.folders = []; game.actors = [];
  globalThis.Folder = { async create(data) {
    const folder = { ...data, id: String(game.folders.length), folder: data.folder ? { id: data.folder } : null };
    game.folders.push(folder); return folder;
  } };
  globalThis.Actor = { async create(data) {
    const actor = { ...data, id: String(game.actors.length), items: [],
      getFlag(module, key) { return this.flags[module]?.[key]; },
      async update(update) { calls.update++; this.system.world.map = update["system.world.map"]; }
    };
    game.actors.push(actor); return actor;
  } };
  picker.upload = async () => {
    calls.upload++;
    if (calls.upload === 1) throw new Error("First upload failed");
    return { path: "maps/last.svg" };
  };
  const { importWorldRows } = await import("../scripts/world-import.mjs");
  const rows = [
    { Hex: "0101", Name: "Belt", UWP: "X000000-0" },
    { Hex: "0102", Name: "Failure", UWP: "B540489-B" },
    { Hex: "0103", Name: "Success", UWP: "BA40489-B" }
  ];
  let progress = 0;
  const originalError = console.error; console.error = () => {};
  try {
    assert.deepEqual(await importWorldRows(rows, { name: "Test", subsectors: [] }, "M1105", {
      generateMaps: true, onProgress: () => progress++
    }), { created: 3, updated: 0 });
  } finally { console.error = originalError; }
  assert.equal(progress, 3); assert.equal(calls.upload, 2);
  assert.equal(game.actors[0].system.world.map, undefined);
  assert.equal(game.actors[1].system.world.map, undefined);
  assert.equal(game.actors[2].system.world.map, "maps/last.svg");
});
