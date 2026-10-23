# Task: Lore bundle import for traveller-trading (target 1.25.0)

You are working in the `traveller-trading` Foundry VTT module (Foundry v13–v14, system `mgt2e`, plain ES modules, no build step). Read this whole brief before starting, then read `scripts/world-import.mjs`, `scripts/world-map-gen.mjs`, `scripts/window-base.mjs`, `scripts/main.mjs` and `tests/world-map-data.test.mjs` to pick up the existing conventions. Follow those conventions: the `MODULE_ID` constant, `TradingWindowBase` windows, settings-menu entries that open a window, `node:test` tests, and long explanatory comments where behaviour isn't obvious.

## Goal

The GM has a large body of referee notes about the Trojan Reach sector, drawn from several sources (a regional guide, sourcebooks, a campaign book and a hooks collection). An external tool turns these notes into **lore bundle** JSON files. This feature imports a bundle into Foundry as journals, linked to the existing World actors.

Re-importing must be safe and incremental:
- a new or revised bundle updates only what changed;
- document IDs never change, so links keep working;
- the GM's own notes and hook-tracking state are never touched.

## Hard rules

1. **Never write to a World actor's `system.description` or UWP fields.** The Traveller Map importer overwrites `system.description` on every re-import, so lore stored there would be lost. On actors, write only `flags.traveller-trading.lore`.
2. **Never delete or modify a document or page flagged `userNotes: true`.**
3. **Never reset hook status** (see "Hooks & Rumours tracker") when a bundle is imported.
4. **Never commit real bundles.** They contain summaries of copyrighted books, and this repo is public.
   - Add `*.tt-lore.json` to `.gitignore`, with an exception for `tests/fixtures/`.
   - The only bundle in the repo is the fictional fixture `tests/fixtures/sample.tt-lore.json` (provided alongside this brief; copy it in).
5. All imported journals default to GM-only ownership (`default: NONE`). The GM reveals pages manually.
6. Everything is GM-only: menus, buttons and writes.

## Bundle format (v1)

```jsonc
{
  "format": "tt-lore-bundle",
  "formatVersion": 1,
  "source": {
    "key": "pod",                                  // stable; [a-z0-9-]+
    "title": "Campaign book: Pirates of Drinax",   // used as the section heading on pages
    "short": "PoD",
    "order": 30                                    // sections on a page are sorted by this, ascending
  },
  "bundleVersion": 3,          // integer, increases each time this source's bundle is regenerated
  "generatedAt": "2026-10-20T12:00:00Z",
  "sector": "Trojan Reach",
  "milieu": "M1105",

  "subsectors": [
    { "name": "Tlaiowaha", "letter": "K", "blocks": [ /* Block */ ] }
  ],
  "worlds": [
    {
      "hex": "2223", "name": "Drinax", "subsector": "Tlaiowaha",
      "uwpAlt": { "uwp": "A43645A-E", "note": "PoD p.14 lists Class A; actually ruined" },  // optional
      "blocks": [ /* Block */ ]
    }
  ],
  "journals": [
    {
      "key": "ref:aslan-hierate", "title": "The Aslan Hierate", "folder": "Reference",
      "pages": [ { "key": "ref:aslan-hierate:clans", "title": "Clans", "blocks": [ /* Block */ ] } ]
    }
  ],
  "hooks": [
    {
      "id": "III.54", "label": "Rumour",
      "target": { "type": "world", "hex": "1016" },   // or {"type":"subsector","name":"Dpres"} or {"type":"journal","page":"ref:...:..."}
      "also": [ { "type": "world", "hex": "1619" } ],  // optional cross-references
      "html": "<p>…</p>"
    }
  ]
}
```

**Block**: `{ "id": "pod:drinax:1", "heading": "The Floating Palace", "html": "<p>…</p>", "cite": "pp.15-21" }`.
- `id` is unique within the bundle and stable across regenerations.
- `heading` and `cite` are optional.
- `html` is limited to `p, ul, ol, li, strong, em, h4, h5, br, table, tr, th, td, span`. Strip anything else when validating, and report it.

**Cross-links**: `html` may contain `@Lore[<key>]{label}`, where `<key>` is one of:
- `world:<Sector>:<hex>`
- `sub:<Sector>:<Subsector>`
- a journal page key.

Resolve each one to `@UUID[...]{label}` once every document exists. If a key can't be resolved, emit the bare label and list it in the report.

A bundle's fields are all optional except `format`, `formatVersion`, `source`, `bundleVersion` and `sector`. A bundle may contain only hooks, or only reference journals.

Size limit: 25 MB. Reject unknown `formatVersion` values, malformed hexes (`^\d{4}$`), duplicate block IDs and missing required fields, with clear messages (mirror the validation style in `world-map-data.mjs`).

## Foundry structure produced

```
Journal
└─ Trojan Reach                      (folder; one per sector)
   ├─ Gazetteer                      (folder)
   │  ├─ Tlaiowaha (K)               JournalEntry  key sub:Trojan Reach:Tlaiowaha
   │  │   ├─ Overview                page  key sub:Trojan Reach:Tlaiowaha:overview
   │  │   ├─ Asim                    page  key world:Trojan Reach:2123
   │  │   ├─ Asim — Notes            page  userNotes:true (created on demand, never by import)
   │  │   └─ Drinax …
   │  └─ … one entry per subsector
   ├─ Reference                      (folder; journals[].folder, default "Reference")
   │  └─ The Aslan Hierate           JournalEntry key ref:aslan-hierate, pages per journals[].pages
   └─ Hooks & Rumours                JournalEntry key hooks:Trojan Reach (index page + tracker state)
```

- **Identity.** Documents are always found by `flags.traveller-trading.lore.key`, never by name. Renaming in Foundry is allowed and survives re-import; the importer doesn't rename existing documents.
- **Page sort order.**
  - Overview: 0.
  - World pages: alphabetical by world name, spaced by 1000.
  - Each Notes page: its world's sort value + 1.
- **Page content.** A page is `text` type, rendered entirely from its stored blocks:
  - Sources are sorted by `order`. Each becomes `<section class="tt-lore-src" data-tt-src="pod"><h3>{source.title}</h3>…</section>`.
  - Each block becomes `<div class="tt-lore-block" data-tt-block="{id}">`, containing an optional `<h4>heading</h4>`, the html, and an optional `<p class="tt-lore-cite">cite</p>`.
  - A world page also gets:
    - a "Hooks & Rumours" section listing the hooks that target that world (each as `<div class="tt-hook" data-tt-hook="III.54">`);
    - an "Also mentioned in" line for `also` references;
    - a header line with the UWP, plus any `uwpAlt` values marked with their source;
    - a link to the World actor.
- **Page flag.** Stored on each page:

  ```js
  flags["traveller-trading"].lore = {
    key, sector, kind: "world"|"subsector"|"journal",
    blocks: { [blockId]: { source, order, heading, html, cite, hash } },
    sources: { [sourceKey]: { bundleVersion, title, order } },
    renderedHash    // hash of the HTML the importer last wrote
  }
  ```
- **Manual edits.** If a page's current `text.content` hash differs from `renderedHash`, the GM has edited an importer-owned page.
  - The dry run flags it.
  - On apply, copy the edited HTML to that world's Notes page (creating it if needed) under a dated heading, then overwrite.
  - Nothing the GM wrote is ever lost silently.
- **Hash.** Use FNV-1a 32-bit over canonical JSON, written as a sync pure function so it runs in both Node and the browser.

## World actor link

For each `worlds[]` entry, find the actor using `travellerMapData.sector === bundle.sector && travellerMapData.hex === hex`, preferring the milieu that matches `bundle.milieu`. Then:

- Set `flags.traveller-trading.lore = { pageUuid, journalUuid, uwpAlt: [{source, uwp, note}], sources: [keys] }`. Merge per source; don't overwrite other sources' entries.
- If no actor exists, the dialog has an option, **"Create missing world actors from Traveller Map"**, on by default.
  - It uses the existing `fetchSingleWorldRow` and `importWorldRows`.
  - You'll need to export `fetchSectorMetadata` from `world-import.mjs`. Fetch the metadata once per import.
- If the option is off or the fetch fails, still create the page, record the miss in the report, and link on a later import.
- **World sheet button.** Add a GM-only "Lore" button on the World sheet, next to the existing map buttons. Reuse the `renderActorSheet` pattern in `world-map-gen.mjs`, but put it in its own registration function. It opens the linked page, or a notification if there is none. A second button, "Notes", opens or creates the world's Notes page.

## Import flow

New settings menu, **"Import Lore Bundle"**, registered in `main.mjs` the same way as Import Worlds. It opens a `TradingWindowBase` window:

1. **Choose file.** Reuse the `chooseMapFile` pattern from `world-map-gen.mjs`, generalised into a shared helper. Then validate the file and show the source, bundle version and counts.
2. **Dry run (always).** `planLoreImport(bundle, index)` returns operations, and the window shows a summary plus an expandable detail list:
   - create, update or unchanged entries and pages;
   - blocks added, changed, unchanged or orphaned (present in Foundry for this source but missing from the bundle);
   - hooks added, changed or orphaned;
   - actors to create, actors not found, manual edits detected, unresolved links;
   - a warning if `bundleVersion` is lower than the stored version for this source, which also needs an extra confirmation.
3. **Options:**
   - create missing actors (on);
   - remove orphaned blocks from this source (**off**; when off, orphans stay in place and are listed);
   - generate world maps for newly created actors (off).
4. **Apply.**
   - Pass 1: create or update folders, entries and pages, with blocks stored in flags.
   - Pass 2: resolve `@Lore` links, render HTML, write content and `renderedHash`, and update actor flags.
   - Batch embedded-document writes in groups of about 50 and show progress.
   - The import must be **idempotent**: applying the same bundle twice gives zero changes the second time.
5. **Report.** Show the final counts, and also write them as a page to the "Lore Import Log" JournalEntry, one dated page per import, keeping the last 20.

Second menu entry, **"Remove Lore Source"**:
- It lists the sources found in stored page flags.
- It removes all blocks belonging to the chosen source, and re-renders the affected pages.
- It deletes pages and entries that become empty, but never Notes pages; an entry that still holds a Notes page is kept.
- Show a dry run first.

## Hooks & Rumours tracker

- **Content vs state.** Hook content comes from bundles and is stored in the hooks JournalEntry's flag, in `lore.hooks[id]`. Hook state is stored separately, in `flags.traveller-trading.hookState[id] = { status: "unused"|"seeded"|"used"|"discarded", note, updatedAt }`. Importing never writes `hookState`.
- **Index page.** The hooks entry has one index page listing every hook, grouped by subsector, each linking to its target page.
- **Status badges.** Add a `renderJournalEntryPageTextSheet` hook (check the v13/v14 hook name, and fall back to a generic `renderJournalEntryPageSheet` if needed). It decorates every `[data-tt-hook]` element with a status badge, and for the GM, a small dropdown to change status. Badges reflect the stored state without re-rendering page HTML.
- **Tracker window.** Add an entry to the sidebar launcher if that fits the existing panel; otherwise add a settings menu. It's a `TradingWindowBase` window that lists hooks, with:
  - filters for subsector, status and source;
  - a text search;
  - click a hook to open its target page;
  - set status and note inline.

## Code layout

- `scripts/lore-bundle.mjs`: **pure functions only, no Foundry globals.** It contains `validateBundle`, `normalizeBundle`, `hashFnv1a`, `renderPageHtml`, `planLoreImport`, `resolveLoreLinks` and `mergeBlocks`. The `index` passed to `planLoreImport` is a plain-object snapshot of existing lore documents, built by the Foundry layer.
- `scripts/lore-import.mjs`: the Foundry layer. It holds the menus, windows, document creation and updates, the actor linking and the sheet buttons.
- `scripts/lore-hooks.mjs`: the tracker window and page decoration.
- `styles/traveller-trading.css`: styles for `.tt-lore-*`, `.tt-hook` and the status badges. Respect the existing `tt-standard-look` toggle.
- `docs/lore-import.md`: user documentation, in the same style as `docs/world-map-import-export.md`, including the bundle format reference.
- Bump `module.json` to 1.25.0.

## Tests (`tests/lore-bundle.test.mjs`, `node --test`)

Using `tests/fixtures/sample.tt-lore.json` plus variants built in the test:

- Validation rejects:
  - a wrong `format`;
  - a future `formatVersion`;
  - a bad hex;
  - duplicate block IDs;
  - a missing `source.key`;
  - oversize input.
- Validation strips disallowed tags and reports them.
- Planning against an empty index creates everything.
- Planning the same bundle against the index it produced gives zero changes (the idempotency test).
- Changing one block's HTML gives exactly one block update and one page update, and nothing else.
- A second source's bundle adds sections without changing the first source's blocks. Section order follows `source.order`.
- A block missing from a re-import is reported as an orphan. It is removed only when the option is on.
- A lower `bundleVersion` produces a warning.
- `@Lore` links resolve to UUIDs. Unresolved links fall back to the label and are reported.
- `hookState` is absent from every planned write.
- A `renderedHash` mismatch is detected as a manual edit.
- The hash is deterministic and independent of key order.

## Manual acceptance checks in Foundry (list these in the PR description)

1. In a fresh world, Import Worlds (sector Trojan Reach), then import the fixture. Journals, pages and actor links all appear, and the Lore button works.
2. Re-import the same file. The dry run shows zero changes.
3. Edit one block in the fixture and re-import. Only that page changes, and its UUID is unchanged.
4. Edit an importer page by hand and re-import. The edit is preserved on the Notes page.
5. Mark a hook as "used" and re-import. The status survives.
6. Re-run Import Worlds for the sector. The lore pages and actor lore flags survive.
7. Remove Lore Source on the fixture source. Its blocks go, and Notes pages remain.

## Out of scope

Don't build:
- PDF parsing;
- bundle generation;
- automatic player reveal;
- compendium packs (possible later: "export lore to a world compendium");
- changes to the trade or finance features.
