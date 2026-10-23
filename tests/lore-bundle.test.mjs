import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateBundle, normalizeBundle, sanitizeHtml, hashFnv1a, planLoreImport, planRemoveSource, listLoreSources,
  resolveLoreLinks, finalizePageContent, buildActorLore, mergeBlocks, renderPageHtml, safeKey, unsafeKey, loreKeys, MAX_LORE_BYTES
} from "../scripts/lore-bundle.mjs";

const FIXTURE_TEXT = readFileSync(new URL("./fixtures/sample.tt-lore.json", import.meta.url), "utf8");
const raw = () => JSON.parse(FIXTURE_TEXT);
const fixture = () => validateBundle(FIXTURE_TEXT).bundle;
const SECTOR = "Trojan Reach";

// Simulates what lore-import.mjs does with a plan: create documents (pass
// 1), then resolve links against the real UUIDs and write content + flags
// (pass 2), then link actors. Returns the index the next plan would see.
let nextId = 0;
const newId = () => `id${String(++nextId).padStart(6, "0")}`;
function applyPlan(plan, index = {}) {
  const next = structuredClone({ entries: {}, pages: {}, notes: {}, actors: {}, sources: {}, ...index });
  for (const e of plan.entries) {
    if (e.op === "create") {
      const id = newId();
      next.entries[e.key] = { id, uuid: `JournalEntry.${id}`, name: e.name, flag: structuredClone(e.flag), pageCount: 0 };
    } else if (e.op === "update") next.entries[e.key].flag = structuredClone(e.flag);
  }
  for (const p of plan.pages) {
    if (p.op !== "create") continue;
    const entry = next.entries[p.entryKey];
    const id = newId();
    next.pages[p.key] = { id, uuid: `${entry.uuid}.JournalEntryPage.${id}`, entryKey: p.entryKey, name: p.name, sort: p.sort, flag: structuredClone(p.flag), contentHash: null };
    entry.pageCount++;
  }
  const uuidFor = key => next.pages[key]?.uuid || next.entries[key]?.uuid;
  for (const p of plan.pages) {
    if (p.op === "unchanged") continue;
    if (p.op === "delete") { delete next.pages[p.key]; next.entries[p.entryKey].pageCount--; continue; }
    const { content, renderedHash } = finalizePageContent(p.rawHtml, uuidFor);
    Object.assign(next.pages[p.key], { flag: { ...structuredClone(p.flag), renderedHash }, contentHash: hashFnv1a(content), content });
  }
  for (const e of plan.entries) {
    if (e.op !== "delete") continue;
    delete next.entries[e.key];
    for (const [key, p] of Object.entries(next.pages)) if (p.entryKey === e.key) delete next.pages[key];
  }
  for (const a of plan.actors || []) {
    if (a.op === "update" && plan.kind === "import") {
      next.actors[a.key].lore = buildActorLore(next.actors[a.key].lore, { pageUuid: uuidFor(a.pageKey), journalUuid: uuidFor(a.entryKey), source: a.source, uwpAlt: a.uwpAlt });
    } else if (a.op === "update" || a.op === "clear") next.actors[a.key].lore = a.lore;
  }
  if (plan.kind === "import") next.sources[plan.source.key] = { bundleVersion: plan.bundleVersion };
  return next;
}

function actorIndex() {
  return {
    actors: {
      [loreKeys.world(SECTOR, "2223")]: { id: "actDrinax", uuid: "Actor.actDrinax", name: "Drinax", uwp: "A43645A-E", subsector: "Tlaiowaha", subsectorLetter: "K", lore: null },
      [loreKeys.world(SECTOR, "2123")]: { id: "actAsim", uuid: "Actor.actAsim", name: "Asim", uwp: "C000000-0", subsector: "Tlaiowaha", subsectorLetter: "K", lore: null }
    }
  };
}

function deepKeys(value, out = new Set()) {
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out); }
  return out;
}

// --- validation -------------------------------------------------------------

test("fixture validates and normalizes", () => {
  const { bundle, stripped } = validateBundle(FIXTURE_TEXT);
  assert.equal(bundle.source.key, "sample");
  assert.equal(bundle.worlds.length, 2);
  assert.equal(bundle.hooks.length, 3);
  assert.deepEqual(stripped, []);
});

test("validation rejects malformed bundles with clear messages", () => {
  const cases = [
    [{ ...raw(), format: "other" }, /not a Traveller Trading lore bundle/],
    [{ ...raw(), formatVersion: 2 }, /Unsupported lore bundle formatVersion/],
    [(() => { const b = raw(); b.worlds[0].hex = "22A3"; return b; })(), /four-digit hex/],
    [(() => { const b = raw(); b.worlds[1].blocks[0].id = "sample:drinax:1"; return b; })(), /Duplicate block id "sample:drinax:1"/],
    [(() => { const b = raw(); delete b.source.key; return b; })(), /source\.key is required/],
    [(() => { const b = raw(); delete b.bundleVersion; return b; })(), /bundleVersion is required/],
    [(() => { const b = raw(); delete b.sector; return b; })(), /sector is required/],
    [(() => { const b = raw(); delete b.source; return b; })(), /source must be an object/],
    ["x".repeat(MAX_LORE_BYTES + 1), /25 MB/],
    ["not json", /not valid lore bundle JSON/]
  ];
  for (const [input, message] of cases) assert.throws(() => validateBundle(input), message);
});

test("a bundle may contain only hooks, or only journals", () => {
  const base = { format: "tt-lore-bundle", formatVersion: 1, source: { key: "only" }, bundleVersion: 1, sector: SECTOR };
  assert.equal(validateBundle({ ...base, hooks: raw().hooks }).bundle.hooks.length, 3);
  assert.equal(validateBundle({ ...base, journals: raw().journals }).bundle.journals.length, 1);
});

test("validation strips disallowed tags and reports them", () => {
  const b = raw();
  b.worlds[0].blocks[0].html = '<p onclick="x()">Hi <a href="http://x">link</a><img src=x onerror=alert(1)><script>alert(1)</script></p><td colspan="2">c</td>';
  const { bundle, stripped } = validateBundle(b);
  const html = bundle.worlds[0].blocks[0].html;
  assert.equal(html, '<p>Hi link</p><td colspan="2">c</td>');
  assert.deepEqual(stripped, [{ where: "block sample:drinax:1", tags: ["a", "img", "script"] }]);
  // An unterminated tag is escaped as text, never completed by later markup.
  assert.equal(sanitizeHtml("<p>x</p><img src=x onerror=alert(1)").html, "<p>x</p>&lt;img src=x onerror=alert(1)");
});

// --- hashing ----------------------------------------------------------------

test("the hash is deterministic and independent of key order", () => {
  const a = { b: 1, a: [1, { y: 2, x: "Ã©" }], c: null };
  const b = { c: null, a: [1, { x: "Ã©", y: 2 }], b: 1 };
  assert.equal(hashFnv1a(a), hashFnv1a(b));
  assert.equal(hashFnv1a(a), hashFnv1a(structuredClone(a)));
  assert.notEqual(hashFnv1a(a), hashFnv1a({ ...a, b: 2 }));
  assert.match(hashFnv1a("x"), /^[0-9a-f]{8}$/);
});

test("safe keys round-trip dotted ids", () => {
  for (const id of ["III.54", "a%2Eb", "plain", "x.y.z%"]) {
    assert.ok(!safeKey(id).includes("."));
    assert.equal(unsafeKey(safeKey(id)), id);
  }
});

// --- planning ---------------------------------------------------------------

test("planning against an empty index creates everything", () => {
  const plan = planLoreImport(fixture(), {});
  assert.deepEqual(plan.summary.entries, { create: 3, update: 0, unchanged: 0, delete: 0 });
  // Overview + Drinax + Asim, reference page, hooks index.
  assert.equal(plan.summary.pages.create, 5);
  assert.equal(plan.summary.pages.update + plan.summary.pages.unchanged, 0);
  assert.equal(plan.summary.blocks.added, 5);
  assert.equal(plan.summary.hooks.added, 3);
  assert.equal(plan.summary.missingActors, 2);
  const keys = plan.pages.map(p => p.key);
  assert.ok(keys.includes(loreKeys.world(SECTOR, "2223")));
  assert.ok(keys.includes(loreKeys.overview(SECTOR, "Tlaiowaha")));
  const entry = plan.entries.find(e => e.key === loreKeys.subsector(SECTOR, "Tlaiowaha"));
  assert.equal(entry.name, "Tlaiowaha (K)");
  assert.deepEqual(entry.folders.map(f => f.name), [SECTOR, "Gazetteer"]);
  // Sort order: overview 0, then worlds alphabetically spaced by 1000.
  const sorts = Object.fromEntries(plan.pages.filter(p => p.entryKey === entry.key).map(p => [p.name, p.sort]));
  assert.deepEqual(sorts, { Overview: 0, Asim: 1000, Drinax: 2000 });
});

test("planning the same bundle against the index it produced gives zero changes", () => {
  const bundle = fixture();
  const first = planLoreImport(bundle, actorIndex());
  const index = applyPlan(first, actorIndex());
  const second = planLoreImport(bundle, index);
  assert.equal(second.changeCount, 0, JSON.stringify(second.summary));
  assert.ok(second.pages.every(p => p.op === "unchanged"));
  assert.ok(second.entries.every(e => e.op === "unchanged"));
  assert.ok(second.actors.every(a => a.op === "unchanged"));
  assert.equal(second.summary.manualEdits, 0);
  // A third pass after applying the no-op plan is still a no-op.
  assert.equal(planLoreImport(bundle, applyPlan(second, index)).changeCount, 0);
});

test("changing one block gives exactly one block update and one page update", () => {
  const index = applyPlan(planLoreImport(fixture(), actorIndex()), actorIndex());
  const changed = raw();
  changed.worlds[1].blocks[0].html = "<p>Revised text.</p>";
  const plan = planLoreImport(validateBundle(changed).bundle, index);
  assert.equal(plan.summary.blocks.changed, 1);
  assert.equal(plan.summary.blocks.added + plan.summary.blocks.removed + plan.summary.blocks.orphaned, 0);
  assert.equal(plan.summary.pages.update, 1);
  assert.equal(plan.summary.pages.create, 0);
  assert.equal(plan.summary.entries.update + plan.summary.entries.create, 0);
  assert.equal(plan.summary.actors.update, 0);
  assert.equal(plan.summary.hooks.changed + plan.summary.hooks.added, 0);
  assert.equal(plan.pages.find(p => p.op === "update").key, loreKeys.world(SECTOR, "2123"));
  assert.equal(plan.changeCount, 2);
  // The page keeps its document identity (applyPlan only creates on "create").
  const after = applyPlan(plan, index);
  assert.equal(after.pages[loreKeys.world(SECTOR, "2123")].uuid, index.pages[loreKeys.world(SECTOR, "2123")].uuid);
});

test("a second source adds sections without changing the first source's blocks", () => {
  const index = applyPlan(planLoreImport(fixture(), actorIndex()), actorIndex());
  const other = {
    format: "tt-lore-bundle", formatVersion: 1, bundleVersion: 1, sector: SECTOR,
    source: { key: "guide", title: "Regional guide", short: "RG", order: 10 },
    worlds: [{ hex: "2223", name: "Drinax", subsector: "Tlaiowaha", uwpAlt: { uwp: "B43645A-E" }, blocks: [{ id: "guide:drinax:1", html: "<p>Guide text.</p>" }] }]
  };
  const plan = planLoreImport(validateBundle(other).bundle, index);
  assert.equal(plan.summary.blocks.added, 1);
  assert.equal(plan.summary.blocks.changed + plan.summary.blocks.orphaned, 0);
  assert.equal(plan.summary.pages.update, 1);
  const page = plan.pages.find(p => p.key === loreKeys.world(SECTOR, "2223"));
  const prior = index.pages[page.key].flag.blocks;
  for (const [key, block] of Object.entries(prior)) assert.deepEqual(page.flag.blocks[key], block);
  // Section order follows source.order (guide = 10 before sample = 50).
  assert.ok(page.rawHtml.indexOf('data-tt-src="guide"') < page.rawHtml.indexOf('data-tt-src="sample"'));
  assert.ok(page.rawHtml.includes("B43645A-E") && page.rawHtml.includes("X436000-0"));
  // The actor link merges per source.
  const actor = plan.actors.find(a => a.hex === "2223");
  assert.deepEqual(actor.lore.sources, ["guide", "sample"]);
  assert.deepEqual(actor.lore.uwpAlt.map(a => a.source), ["guide", "sample"]);
  // Re-importing the first source afterwards leaves the second source alone.
  const both = applyPlan(plan, index);
  assert.equal(planLoreImport(fixture(), both).changeCount, 0);
});

test("a missing block is reported as an orphan and removed only when asked", () => {
  const index = applyPlan(planLoreImport(fixture(), actorIndex()), actorIndex());
  const smaller = raw();
  smaller.worlds[0].blocks.pop();
  const bundle = validateBundle(smaller).bundle;
  const keep = planLoreImport(bundle, index);
  assert.deepEqual(keep.blocks.orphaned, [{ page: loreKeys.world(SECTOR, "2223"), id: "sample:drinax:2" }]);
  assert.equal(keep.summary.blocks.removed, 0);
  assert.ok(keep.pages.every(p => p.op === "unchanged"));
  const remove = planLoreImport(bundle, index, { removeOrphans: true });
  assert.equal(remove.summary.blocks.removed, 1);
  const page = remove.pages.find(p => p.key === loreKeys.world(SECTOR, "2223"));
  assert.equal(page.op, "update");
  assert.ok(!page.flag.blocks[safeKey("sample:drinax:2")]);
  assert.deepEqual(page.deletions, [{ field: "blocks", key: safeKey("sample:drinax:2") }]);
});

test("a lower bundleVersion produces a warning that needs confirmation", () => {
  const b = raw(); b.bundleVersion = 5;
  const index = applyPlan(planLoreImport(validateBundle(b).bundle, {}), {});
  b.bundleVersion = 4;
  const plan = planLoreImport(validateBundle(b).bundle, index);
  assert.equal(plan.needsConfirm, true);
  assert.equal(plan.storedVersion, 5);
  assert.match(plan.warnings.join("\n"), /version 4 .* version 5/);
  b.bundleVersion = 6;
  assert.equal(planLoreImport(validateBundle(b).bundle, index).needsConfirm, false);
});

test("@Lore links resolve to UUIDs; unresolved links fall back to the label", () => {
  const plan = planLoreImport(fixture(), {});
  assert.deepEqual(plan.unresolved, [{ page: loreKeys.world(SECTOR, "2123"), key: loreKeys.world(SECTOR, "9999"), label: "Nowhere" }]);
  const index = applyPlan(plan, {});
  const drinax = index.pages[loreKeys.world(SECTOR, "2223")].content;
  assert.ok(drinax.includes(`@UUID[${index.pages[loreKeys.world(SECTOR, "2123")].uuid}]{Asim}`));
  assert.ok(drinax.includes(`@UUID[${index.pages["ref:test-reference:page-1"].uuid}]{the reference page}`));
  assert.ok(!drinax.includes("@Lore["));
  const asim = index.pages[loreKeys.world(SECTOR, "2123")].content;
  assert.ok(asim.includes("Unresolvable link: Nowhere."));
  const direct = resolveLoreLinks("@Lore[a]{A} @Lore[b]{B}", new Map([["a", "X.1"]]));
  assert.equal(direct.html, "@UUID[X.1]{A} B");
  assert.deepEqual(direct.unresolved, [{ key: "b", label: "B" }]);
});

test("hookState is absent from every planned write", () => {
  const index = applyPlan(planLoreImport(fixture(), actorIndex()), actorIndex());
  const hooksKey = loreKeys.hooks(SECTOR);
  index.entries[hooksKey].hookState = { [safeKey("T.1")]: { status: "used" } };
  for (const plan of [planLoreImport(fixture(), index), planLoreImport(fixture(), index, { removeOrphans: true }), planRemoveSource(index, "sample")]) {
    assert.ok(!deepKeys(plan).has("hookState"));
  }
});

test("hooks render on their target pages and the index page", () => {
  const plan = planLoreImport(fixture(), actorIndex());
  const drinax = plan.pages.find(p => p.key === loreKeys.world(SECTOR, "2223")).rawHtml;
  assert.ok(drinax.includes('<div class="tt-hook" data-tt-hook="T.1">'));
  const asim = plan.pages.find(p => p.key === loreKeys.world(SECTOR, "2123")).rawHtml;
  assert.match(asim, /Also mentioned in:.*@Lore\[world:Trojan Reach:2223\]\{Hook T\.1 \(Drinax\)\}/);
  assert.ok(drinax.includes("@UUID[Actor.actDrinax]{Drinax}"));
  const indexPage = plan.pages.find(p => p.key === loreKeys.hooksIndex(SECTOR)).rawHtml;
  for (const id of ["T.1", "T.2", "T.3"]) assert.ok(indexPage.includes(`data-tt-hook="${id}"`));
  assert.ok(indexPage.indexOf("<h3>Reference</h3>") < indexPage.indexOf("<h3>Tlaiowaha</h3>"));
});

test("a renderedHash mismatch is detected as a manual edit", () => {
  const index = applyPlan(planLoreImport(fixture(), {}), {});
  const key = loreKeys.world(SECTOR, "2223");
  index.pages[key].contentHash = hashFnv1a("<p>GM rewrote this</p>");
  const plan = planLoreImport(fixture(), index);
  assert.deepEqual(plan.manualEdits, [key]);
  assert.equal(plan.pages.find(p => p.key === key).op, "update");
  // Foundry normalizing saved HTML is not a manual edit once storedHash records it.
  index.pages[key].flag.storedHash = index.pages[key].contentHash;
  assert.equal(planLoreImport(fixture(), index).changeCount, 0);
});

test("merging keeps other sources' blocks untouched", () => {
  const existing = { a: { id: "a", source: "x", order: 0, html: "A", hash: "1" } };
  const r = mergeBlocks(existing, "y", [{ id: "b", heading: "", html: "B", cite: "" }]);
  assert.deepEqual(r.blocks.a, existing.a);
  assert.deepEqual(r.added, ["b"]);
});

test("a world page added later slots in alphabetically without moving existing pages", () => {
  const index = applyPlan(planLoreImport(fixture(), {}), {});
  const later = raw();
  later.worlds.push({ hex: "2224", name: "Bertram", subsector: "Tlaiowaha", blocks: [{ id: "sample:bertram:1", html: "<p>B</p>" }] });
  const plan = planLoreImport(validateBundle(later).bundle, index);
  const created = plan.pages.find(p => p.op === "create");
  assert.equal(created.name, "Bertram");
  assert.ok(created.sort > 1000 && created.sort < 2000);
  const asimSort = index.pages[loreKeys.world(SECTOR, "2123")].sort;
  assert.equal(plan.pages.find(p => p.key === loreKeys.world(SECTOR, "2123")).sort, asimSort);
});

test("removing a source deletes its blocks and empty pages but keeps Notes pages", () => {
  let index = applyPlan(planLoreImport(fixture(), actorIndex()), actorIndex());
  const subKey = loreKeys.subsector(SECTOR, "Tlaiowaha");
  // A GM Notes page in the subsector entry keeps that entry alive.
  index.notes[loreKeys.world(SECTOR, "2223")] = { id: "notes1", uuid: "x", entryKey: subKey };
  index.entries[subKey].pageCount++;
  assert.deepEqual(listLoreSources(index).map(s => s.key), ["sample"]);
  const plan = planRemoveSource(index, "sample");
  assert.equal(plan.summary.blocksRemoved, 5);
  assert.equal(plan.summary.hooksRemoved, 3);
  assert.ok(!plan.entries.some(e => e.op === "delete" && e.key === subKey));
  assert.ok(plan.entries.some(e => e.op === "delete" && e.key === "ref:test-reference"));
  assert.ok(!plan.entries.some(e => e.key === loreKeys.hooks(SECTOR) && e.op === "delete"));
  assert.ok(plan.pages.some(p => p.op === "delete" && p.key === loreKeys.world(SECTOR, "2223")));
  assert.equal(plan.summary.actorsCleared, 2);
  index = applyPlan(plan, index);
  assert.deepEqual(listLoreSources(index), []);
  assert.ok(index.entries[subKey]);
});

test("renderPageHtml wraps blocks in source sections", () => {
  const html = renderPageHtml({ kind: "journal", blocks: { a: { id: "a", source: "s", order: 0, heading: "H", html: "<p>x</p>", cite: "p.1" } }, sources: { s: { title: "Src", order: 1 } } });
  assert.equal(html, '<section class="tt-lore-src" data-tt-src="s"><h3>Src</h3><div class="tt-lore-block" data-tt-block="a"><h4>H</h4><p>x</p><p class="tt-lore-cite">p.1</p></div></section>');
  assert.ok(normalizeBundle(raw()).bundle);
});
