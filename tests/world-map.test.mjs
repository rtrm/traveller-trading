import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldGrid, parseWorldSize, renderWorldMapSvg } from "../scripts/world-map-grid.mjs";
import { generateAndSaveWorldMap, registerWorldMapGenButton } from "../scripts/world-map-gen.mjs";

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
  const calls = { upload: 0, update: 0, info: [], error: [] };
  globalThis.game = { user: { isGM: true } };
  globalThis.ui = { notifications: {
    info: text => calls.info.push(text), error: text => calls.error.push(text)
  } };
  const picker = {
    async createDirectory() {}, async browse() {},
    async upload() { calls.upload++; return { path: "maps/generated.svg" }; }
  };
  globalThis.foundry = { utils: { randomID: () => "unique" }, applications: { apps: { FilePicker: { implementation: picker } } } };
  const actor = { id: "actor1", name: "Example", type: "world", system: { world: { uwp: { size }, map: "original.svg" } },
    async update(data) { calls.update++; Object.assign(this.system.world, { map: data["system.world.map"] }); } };
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
  let render, click;
  globalThis.Hooks = { on: (name, fn) => { assert.equal(name, "renderActorSheet"); render = fn; } };
  globalThis.HTMLElement = class {};
  const button = { dataset: {}, style: {}, addEventListener: (name, fn) => { click = fn; } };
  globalThis.document = { createElement: () => button };
  const root = new HTMLElement();
  root.querySelector = () => ({ parentElement: { querySelector: () => null }, insertAdjacentElement() {} });
  registerWorldMapGenButton(); render({ actor }, root);
  picker.upload = async () => { throw new Error("Offline"); };
  const originalError = console.error; console.error = () => {};
  try { await click({ preventDefault() {} }); }
  finally { console.error = originalError; }
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Generate Blank World Map");
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
