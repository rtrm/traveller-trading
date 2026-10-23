import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateItemsBundle, planItemsImport, itemHash, docHash, matchAssetFiles, folderKey, MAX_ITEMS_BYTES } from "../scripts/items-bundle.mjs";

const FIXTURE_TEXT = readFileSync(new URL("./fixtures/sample.tt-items.json", import.meta.url), "utf8");
const raw = () => JSON.parse(FIXTURE_TEXT);
const fixture = () => validateItemsBundle(FIXTURE_TEXT).bundle;
const ALL_ASSETS = ["test/blaster.webp"];

// Simulates what items-import.mjs does with a plan: uploads, folders,
// creates/updates (recording the document hash), and orphan deletion.
// Returns the index the next plan would see.
let nextId = 0;
const newId = () => `i${String(++nextId).padStart(15, "0")}`;
function applyPlan(plan, index = {}) {
  const next = structuredClone({ items: {}, folders: {}, assets: {}, sources: {}, ...index });
  for (const a of plan.assets) if (a.status === "upload") next.assets[a.path] = `uploads/${plan.source.key}/${a.path}`;
  for (const f of plan.folders) {
    if (f.op === "create") next.folders[f.key] = { id: newId(), name: f.name, foreignCount: 0 };
    if (f.op === "delete") delete next.folders[f.key];
  }
  for (const i of plan.items) {
    if (i.op === "delete") { delete next.items[i.key]; continue; }
    if (i.op !== "create" && i.op !== "update") continue;
    const img = i.img.kind === "asset" ? next.assets[i.img.path] : i.img.kind === "keep" ? next.items[i.key].img : "icons/default.svg";
    const doc = { name: i.name, type: i.type, img, system: structuredClone(i.system) };
    const id = i.op === "create" ? newId() : next.items[i.key].id;
    const hash = docHash(doc);
    next.items[i.key] = { id, uuid: `Compendium.world.pack.Item.${id}`, ...doc, folderKey: i.folderKey, flag: { ...i.flag, docHash: hash }, currentDocHash: hash };
  }
  next.sources[plan.source.key] = { bundleVersion: plan.bundleVersion };
  return next;
}

// --- validation -------------------------------------------------------------

test("fixture validates", () => {
  const { bundle, stripped } = validateItemsBundle(FIXTURE_TEXT);
  assert.equal(bundle.items.length, 3);
  assert.equal(bundle.pack.name, "tt-test-items");
  assert.deepEqual(stripped, []);
});

test("validation rejects malformed bundles with clear messages", () => {
  const cases = [
    [{ ...raw(), format: "tt-lore-bundle" }, /not a Traveller Trading items bundle/],
    [{ ...raw(), formatVersion: 2 }, /Unsupported items bundle formatVersion/],
    [(() => { const b = raw(); b.items[1].key = b.items[0].key; return b; })(), /Duplicate item key/],
    [(() => { const b = raw(); b.items[1].img = "test/other.webp"; return b; })(), /not listed in assets/],
    [(() => { const b = raw(); b.assets.push("../escape.webp"); return b; })(), /plain relative path/],
    [(() => { const b = raw(); delete b.source.key; return b; })(), /source\.key is required/],
    [(() => { const b = raw(); delete b.pack; return b; })(), /pack is required/],
    ["x".repeat(MAX_ITEMS_BYTES + 1), /25 MB/],
    ["{", /not valid items bundle JSON/]
  ];
  for (const [input, message] of cases) assert.throws(() => validateItemsBundle(input), message);
});

test("description HTML is limited to the allowed tags", () => {
  const b = raw();
  b.items[0].system.description = '<p>Ok <span style="x">span</span> <a href="x">link</a></p><h4>Head</h4>';
  const { bundle, stripped } = validateItemsBundle(b);
  assert.equal(bundle.items[0].system.description, "<p>Ok span link</p>Head");
  assert.deepEqual(stripped, [{ where: "item sample-items:test:blaster", tags: ["a", "h4", "span"] }]);
});

// --- hashing ----------------------------------------------------------------

test("the item hash is independent of key order", () => {
  const item = fixture().items[0];
  const reordered = { system: { weapon: Object.fromEntries(Object.entries(item.system.weapon).reverse()), ...item.system }, img: item.img, folder: item.folder, type: item.type, name: item.name };
  assert.equal(itemHash(reordered), itemHash(item));
  assert.notEqual(itemHash({ ...item, name: "Other" }), itemHash(item));
});

// --- planning ---------------------------------------------------------------

test("planning against an empty index creates every item and folder", () => {
  const plan = planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS });
  assert.equal(plan.summary.items.create, 3);
  assert.deepEqual(plan.folders.map(f => [f.op, f.key]), [
    ["create", "sample-items:Test Weapons"],
    ["create", "sample-items:Test Weapons/Heavy"],
    ["create", "sample-items:Test Weapons/Melee"],
    ["create", "sample-items:Test Weapons/Pistols"]
  ]);
  assert.equal(plan.folders[1].parentKey, folderKey("sample-items", ["Test Weapons"]));
  assert.equal(plan.summary.assets.upload, 1);
  const blaster = plan.items.find(i => i.key === "sample-items:test:blaster");
  assert.deepEqual(blaster.img, { kind: "asset", path: "test/blaster.webp", url: "pending:test/blaster.webp" });
  assert.deepEqual(plan.items.find(i => i.key === "sample-items:test:stick").img, { kind: "default" });
});

test("planning the same bundle against the index it produced gives zero changes", () => {
  const bundle = fixture();
  const index = applyPlan(planItemsImport(bundle, {}, { chosenAssets: ALL_ASSETS }), {});
  for (const chosenAssets of [ALL_ASSETS, []]) {
    const plan = planItemsImport(bundle, index, { chosenAssets });
    assert.equal(plan.changeCount, 0, JSON.stringify(plan.summary));
    assert.ok(plan.items.every(i => i.op === "unchanged"));
    assert.equal(plan.summary.assets.upload, 0);
    assert.equal(plan.summary.assets.present, 1);
  }
});

test("changing one weapon's damage gives exactly one update", () => {
  const index = applyPlan(planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS }), {});
  const b = raw();
  b.items[2].system.weapon.damage = "3D6";
  const plan = planItemsImport(validateItemsBundle(b).bundle, index, { chosenAssets: ALL_ASSETS });
  assert.equal(plan.summary.items.update, 1);
  assert.equal(plan.changeCount, 1);
  const update = plan.items.find(i => i.op === "update");
  assert.equal(update.key, "sample-items:test:stick");
  assert.equal(update.id, index.items["sample-items:test:stick"].id);
  assert.deepEqual(update.reasons, ["changed in bundle"]);
});

test("a missing item is orphaned, and removed only when asked", () => {
  const index = applyPlan(planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS }), {});
  const b = raw();
  b.items.pop(); // the stick, alone in its Melee folder
  const bundle = validateItemsBundle(b).bundle;
  const keep = planItemsImport(bundle, index);
  assert.deepEqual(keep.orphaned.map(o => o.key), ["sample-items:test:stick"]);
  assert.equal(keep.changeCount, 0);
  const remove = planItemsImport(bundle, index, { removeOrphans: true });
  assert.deepEqual(remove.items.filter(i => i.op === "delete").map(i => i.key), ["sample-items:test:stick"]);
  assert.deepEqual(remove.folders.filter(f => f.op === "delete").map(f => f.key), ["sample-items:Test Weapons/Melee"]);
  // A folder holding something the importer didn't create is kept.
  index.folders["sample-items:Test Weapons/Melee"].foreignCount = 1;
  assert.equal(planItemsImport(bundle, index, { removeOrphans: true }).summary.folders.delete, 0);
  // Removing, then re-planning, is a no-op.
  index.folders["sample-items:Test Weapons/Melee"].foreignCount = 0;
  assert.equal(planItemsImport(bundle, applyPlan(remove, index), { removeOrphans: true }).changeCount, 0);
});

test("a document hash mismatch is detected as a manual edit", () => {
  const index = applyPlan(planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS }), {});
  index.items["sample-items:test:blaster"].currentDocHash = docHash({ name: "Renamed by GM", type: "weapon", img: null, system: {} });
  const plan = planItemsImport(fixture(), index, { chosenAssets: ALL_ASSETS });
  assert.deepEqual(plan.manualEdits.map(m => m.key), ["sample-items:test:blaster"]);
  assert.equal(plan.items.find(i => i.key === "sample-items:test:blaster").op, "update");
  assert.equal(plan.summary.items.update, 1);
});

test("the asset plan uploads only missing files unless re-upload is on", () => {
  const b = raw();
  b.assets.push("test/second.webp", "test/third.webp");
  const bundle = validateItemsBundle(b).bundle;
  const index = { assets: { "test/blaster.webp": "uploads/test/blaster.webp" } };
  const chosenAssets = ["test/blaster.webp", "test/second.webp"];
  const status = plan => Object.fromEntries(plan.assets.map(a => [a.path, a.status]));
  assert.deepEqual(status(planItemsImport(bundle, index, { chosenAssets })), { "test/blaster.webp": "present", "test/second.webp": "upload", "test/third.webp": "missing" });
  assert.deepEqual(status(planItemsImport(bundle, index, { chosenAssets, reupload: true })), { "test/blaster.webp": "upload", "test/second.webp": "upload", "test/third.webp": "missing" });
});

test("a missing image keeps the current one on update and is reported", () => {
  const index = applyPlan(planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS }), {});
  delete index.assets["test/blaster.webp"]; // image deleted from the server
  const b = raw(); b.items[0].system.cost = 600;
  const plan = planItemsImport(validateItemsBundle(b).bundle, index);
  const blaster = plan.items.find(i => i.key === "sample-items:test:blaster");
  assert.deepEqual(blaster.img, { kind: "keep" });
  assert.deepEqual(plan.missingImages.map(m => m.key), ["sample-items:test:blaster"]);
  // On create, a missing image falls back to the type's default icon.
  assert.deepEqual(planItemsImport(fixture(), {}).items[0].img, { kind: "default" });
});

test("unknown item types are skipped, not orphaned", () => {
  const index = applyPlan(planItemsImport(fixture(), {}, { chosenAssets: ALL_ASSETS }), {});
  const plan = planItemsImport(fixture(), index, { knownTypes: ["armour"], removeOrphans: true });
  assert.equal(plan.summary.unknownTypes, 3);
  assert.equal(plan.summary.items.skip, 3);
  assert.equal(plan.summary.items.delete, 0);
});

test("a lower bundleVersion needs confirmation", () => {
  const b = raw(); b.bundleVersion = 3;
  const index = applyPlan(planItemsImport(validateItemsBundle(b).bundle, {}, { chosenAssets: ALL_ASSETS }), {});
  b.bundleVersion = 2;
  const plan = planItemsImport(validateItemsBundle(b).bundle, index);
  assert.equal(plan.needsConfirm, true);
  assert.match(plan.warnings[0], /version 2 .* version 3/);
});

test("chosen files match assets by relative path, then by unique file name", () => {
  const assets = ["weaponry/club.webp", "armour/club.webp", "weaponry/gauss-pistol.webp"];
  const matched = matchAssetFiles(assets, [{ path: "weaponry/club.webp" }, { path: "gauss-pistol.webp" }, { path: "club.webp" }]);
  assert.deepEqual([...matched.keys()].sort(), ["weaponry/club.webp", "weaponry/gauss-pistol.webp"]);
});
