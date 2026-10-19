import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldGrid, renderWorldMapSvg } from "../scripts/world-map-grid.mjs";
import { generateWorldTerrain, TERRAIN_STYLES } from "../scripts/world-map-terrain.mjs";
import { serializeWorldMap, deserializeWorldMap, recoverWorldMapData, embedWorldMapData, MAX_MAP_BYTES } from "../scripts/world-map-data.mjs";
import { MAP_FEATURES } from "../scripts/world-map-features.mjs";

function sample(size = 5, blank = false) {
  const grid = buildWorldGrid(size);
  if (!blank) generateWorldTerrain(grid, { atmosphere: 6, hydrographics: 7 }, { random: () => 0.42 });
  return { grid, data: serializeWorldMap(grid, 'World <&> "name"') };
}

for (const size of [1, 4, 5, 8, 12]) {
  for (const blank of [true, false]) test(`size ${size} ${blank ? "blank" : "surface"}: lossless JSON round trip`, () => {
    const { grid, data } = sample(size, blank);
    const restored = deserializeWorldMap(JSON.stringify(data));
    assert.deepEqual(restored.data, data);
    assert.equal(renderWorldMapSvg(restored.grid, data.worldName), renderWorldMapSvg(grid, data.worldName));
    assert.ok(restored.grid.cells.every(cell => cell.neighbors instanceof Set));
    assert.ok(!JSON.stringify(data).includes('"neighbors"'));
  });
}

test("invalid, future and corrupted map files are rejected", () => {
  const { data } = sample();
  for (const input of ["bad JSON", "[]", "null", "x".repeat(MAX_MAP_BYTES + 1),
    { ...data, format: "other" }, { ...data, version: 99 }, { ...data, geometryVersion: 99 },
    { ...data, size: 0 }, { ...data, size: "5" }, { ...data, size: 4 },
    { ...data, hexScaleKm: 100 }, { ...data, worldName: null }, { ...data, kind: "unknown" },
    { ...data, cells: data.cells.slice(1) },
    { ...data, cells: data.cells.map((cell, i) => i === 1 ? data.cells[0] : cell) },
    { ...data, cells: data.cells.map((cell, i) => i === 0 ? { ...cell, id: "unknown" } : cell) },
    { ...data, cells: data.cells.map((cell, i) => i === 0 ? { ...cell, terrain: "<script>" } : cell) },
    { ...data, cells: data.cells.map((cell, i) => i === 0 ? { ...cell, surface: "invalid" } : cell) },
    { ...data, uwp: { atmosphere: 16, hydrographics: 7 } },
    { ...data, kind: "blank" }
  ]) assert.throws(() => deserializeWorldMap(input));
});

test("normalization drops untrusted fields and does not retain input references", () => {
  const { data } = sample();
  const restored = deserializeWorldMap({ ...data, polygons: "untrusted", palette: { ocean: "red" } });
  assert.equal(restored.data.polygons, undefined);
  assert.equal(restored.data.palette, undefined);
  data.cells[0].terrain = "invalid";
  assert.notEqual(restored.data.cells[0].terrain, "invalid");
});

test("version 1 maps upgrade without losing terrain", () => {
  const { data } = sample();
  data.version = 1;
  for (const cell of data.cells) delete cell.features;
  const restored = deserializeWorldMap(data).data;
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.cells.map(c => c.terrain), data.cells.map(c => c.terrain));
  assert.ok(restored.cells.every(c => c.features.length === 0));
});

test("edited terrain and all supported annotations survive Foundry rendering and round trips", () => {
  const { grid } = sample();
  const cell = grid.cells[0];
  cell.terrain = "cropland"; cell.surface = "land";
  cell.features = Object.keys(MAP_FEATURES);
  const data = serializeWorldMap(grid, "Edited world");
  const restored = deserializeWorldMap(JSON.stringify(data));
  assert.deepEqual(restored.data, data);
  assert.ok(renderWorldMapSvg(restored.grid).includes('data-feature="starport"'));
  for (const features of [["unknown"], ["city", "city"], ["<script>"], "city"]) {
    const bad = structuredClone(data); bad.cells[0].features = features;
    assert.throws(() => deserializeWorldMap(bad));
  }
});

test("embedded metadata escapes XML and preserves JSON content", () => {
  const { grid, data } = sample();
  const svg = embedWorldMapData(renderWorldMapSvg(grid), data);
  const match = svg.match(/<metadata id="tt-world-map-data">(.*?)<\/metadata>/s);
  assert.ok(match);
  assert.ok(!match[1].includes("<"));
  const json = match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  assert.deepEqual(JSON.parse(json), data);
});

for (const blank of [true, false]) test(`legacy ${blank ? "blank" : "terrain"} SVG recovery preserves visible map`, () => {
  const { grid } = sample(5, blank);
  const cells = new Map(grid.cells.map(cell => [cell.id, cell]));
  const polygons = grid.faces.flatMap(face => face.fragments.map(fragment => ({
    id: fragment.cellId, fill: blank ? null : TERRAIN_STYLES[cells.get(fragment.cellId).terrain].color
  })));
  const data = recoverWorldMapData(polygons, "Legacy");
  assert.equal(data.size, 5);
  const restored = deserializeWorldMap(data).grid;
  assert.equal(renderWorldMapSvg(restored, "Legacy"), renderWorldMapSvg(grid, "Legacy"));
  assert.throws(() => recoverWorldMapData([{ id: "bad", fill: "red" }], "Other image"));
  assert.throws(() => recoverWorldMapData([], "Empty"));
  assert.throws(() => recoverWorldMapData([...polygons, { ...polygons[0], fill: "#317ba3" === polygons[0].fill ? "#dfc48b" : "#317ba3" }], "Inconsistent"));
});
