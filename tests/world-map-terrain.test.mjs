import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldGrid, renderWorldMapSvg } from "../scripts/world-map-grid.mjs";
import { generateWorldTerrain, TERRAIN_STYLES } from "../scripts/world-map-terrain.mjs";

function seeded(seed = 12345) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

for (const size of [1, 4, 5, 8, 10, 12]) {
  for (const hydrographics of [0, 1, 5, 9, 10]) {
    test(`size ${size}, hydrographics ${hydrographics}: exact liquid coverage and complete terrain`, () => {
      const grid = generateWorldTerrain(buildWorldGrid(size), { atmosphere: 6, hydrographics }, { random: seeded() });
      assert.equal(grid.cells.filter(c => c.surface === "water").length, Math.round(grid.cells.length * hydrographics / 10));
      assert.ok(grid.cells.every(c => TERRAIN_STYLES[c.terrain]));
      assert.ok(grid.cells.every(c => c.latitude >= 0 && c.latitude <= 1));
      assert.ok(grid.cells.filter(c => c.surface === "water").every(c => ["ocean", "ice"].includes(c.terrain)));
      if (hydrographics === 0) assert.ok(grid.cells.every(c => !["ocean", "ice", "forest"].includes(c.terrain)));
      if (hydrographics === 10) assert.ok(grid.cells.every(c => ["ocean", "ice"].includes(c.terrain)));
    });
  }
}

test("same random sequence reproduces terrain; rerolls vary geography", () => {
  const make = seed => generateWorldTerrain(buildWorldGrid(8), { atmosphere: "6", hydrographics: "7" }, { random: seeded(seed) });
  const terrain = grid => grid.cells.map(c => [c.surface, c.terrain]);
  assert.deepEqual(terrain(make(1)), terrain(make(1)));
  assert.notDeepEqual(terrain(make(1)), terrain(make(2)));
});

test("dry vacuum and exotic atmospheres have no forests or forced ice", () => {
  for (const atmosphere of [0, 1, 2, 3, "A", "B", "C", "F"]) {
    const grid = generateWorldTerrain(buildWorldGrid(5), { atmosphere, hydrographics: 0 }, { random: seeded() });
    assert.ok(grid.cells.every(c => !["forest", "plains", "tundra", "ice", "ocean"].includes(c.terrain)));
  }
});

test("one ocean seed makes a connected region across the net's cuts", () => {
  const grid = generateWorldTerrain(buildWorldGrid(2), { atmosphere: 6, hydrographics: 9 }, { random: seeded(9) });
  const byId = new Map(grid.cells.map(c => [c.id, c]));
  const water = grid.cells.filter(c => c.surface === "water");
  const visited = new Set(), queue = [water[0]];
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    if (visited.has(cell.id)) continue;
    visited.add(cell.id);
    queue.push(...[...cell.neighbors].map(id => byId.get(id)).filter(c => c.surface === "water"));
  }
  assert.equal(visited.size, water.length);
  assert.ok(water.some(c => c.id.startsWith("N:")));
  assert.ok(water.some(c => c.id.startsWith("S:")));
});

test("every SVG fragment of a cell has the same terrain fill, including wrapping", () => {
  const grid = generateWorldTerrain(buildWorldGrid(5), { atmosphere: 6, hydrographics: 6 }, { random: seeded() });
  const svg = renderWorldMapSvg(grid, "Terrain world");
  const byId = new Map(grid.cells.map(c => [c.id, c]));
  let fragments = 0;
  for (const match of svg.matchAll(/<polygon data-cell="([^"]+)" points="[^"]+" fill="([^"]+)"/g)) {
    assert.equal(match[2], TERRAIN_STYLES[byId.get(match[1]).terrain].color);
    fragments++;
  }
  assert.ok(fragments > grid.cells.length);
  assert.ok(svg.includes('data-terrain="ocean"'));
  assert.ok(svg.includes('clip-path="url(#mapBounds)"'));
});

test("invalid UWP terrain fields fail before altering the grid", () => {
  for (const uwp of [{}, { atmosphere: 6 }, { atmosphere: "?", hydrographics: 5 },
    { atmosphere: 16, hydrographics: 5 }, { atmosphere: 6, hydrographics: "B" }]) {
    const grid = buildWorldGrid(4);
    assert.throws(() => generateWorldTerrain(grid, uwp));
    assert.ok(grid.cells.every(c => c.terrain === undefined));
  }
});

test("rendering a blank grid remains available without terrain or a legend", () => {
  const svg = renderWorldMapSvg(buildWorldGrid(4), "Blank");
  assert.ok(!svg.includes("data-terrain="));
  assert.ok(svg.includes('fill="white"'));
});
