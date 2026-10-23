# Import lore bundles (1.25.0)

A **lore bundle** is a JSON file (`*.tt-lore.json`) of referee notes for one
sector, taken from one source such as a regional guide, a sourcebook, a
campaign book or a hooks collection. An external tool produces bundles; this
module imports them as GM-only journals that are linked to your World actors.

Three GM-only entries are added under **Game Settings › Configure Settings ›
Traveller Trading**:

- **Import Lore Bundle** (button: *Import Lore*)
- **Remove Lore Source** (button: *Remove Source*)
- **Hooks & Rumours Tracker** (button: *Open Tracker*). Once hooks have been
  imported, the tracker can also be opened from the Traveller Trading
  sidebar tab.

Re-importing is safe:

- a new or revised bundle only updates what has changed;
- document IDs never change, so existing links keep working;
- your own Notes pages and hook statuses are never touched.

## What gets created

```
Journal
└─ Trojan Reach                      folder, one per sector
   ├─ Gazetteer                      folder
   │  └─ Tlaiowaha (K)               one journal entry per subsector
   │      ├─ Overview                subsector blocks
   │      ├─ Asim                    one page per world, alphabetical
   │      ├─ Asim — Notes            your page, created on demand only
   │      └─ Drinax …
   ├─ Reference                      folder (or the bundle's own folder name)
   │  └─ The Aslan Hierate           reference journal, pages from the bundle
   └─ Hooks & Rumours                index page + hook status
Lore Import Log                      one dated page per import, last 20 kept
```

All imported journals use default ownership **None**, so players can't see
them. To share a page, reveal it yourself in the usual way.

The importer always finds documents by an internal key, never by their name.
You can rename journals and pages, and move entries into other folders; a
re-import won't rename or move them back.

Each page is rebuilt from its stored blocks, one section per source. Sections
are ordered by the source's `order`. A world page also shows:

- the Traveller Map UWP, plus any alternative UWP each source gives;
- a link to the World actor;
- the hooks that target that world;
- an "Also mentioned in" line for hooks elsewhere that cross-reference it.

## Importing

1. Open **Import Lore Bundle** and click **Choose Lore Bundle…**. The file is
   validated first. Any HTML outside the allowed tag list is removed, and
   the window lists what was stripped.
2. A **dry run** is always shown before anything is written. It covers:
   - how many entries and pages would be created, updated or left unchanged;
   - how many blocks and hooks would be added, changed, left unchanged or
     orphaned;
   - World actors to link, create or that weren't found;
   - pages you've edited by hand;
   - links that can't be resolved.

   Open **Details** for the full lists.
3. Choose your options:
   - **Create missing world actors from Traveller Map** (on by default).
     Fetches each missing world and imports it the same way Import Worlds
     does. If this is off, or a fetch fails, the world's page is still
     created, and the actor is linked on a later import.
   - **Remove orphaned blocks and hooks from this source** (off by default).
     An orphan is a block or hook from this source that's no longer in the
     bundle. With this option off, orphans are kept and listed.
   - **Generate world maps for newly created actors** (off by default).
4. Click **Apply Import**. A progress line is shown while it runs. The final
   report appears in the window and is also saved to the **Lore Import Log**
   journal.

If a bundle's `bundleVersion` is lower than one you've already imported from
the same source, the dry run warns you, and you'll be asked to confirm
before it's applied.

### Your own edits

Keep your own notes on the **Notes** page. You can open or create one from
the World sheet's **Notes** button. The importer never deletes or rewrites
Notes pages.

If you edit an imported page directly, the next dry run lists it under
manual edits. When you apply, your edited HTML is first copied to that
page's Notes page under a dated heading, and only then is the page
overwritten. Nothing you've written is lost silently.

### World actors

The importer writes only the actor flag `flags.traveller-trading.lore`:

```js
{ pageUuid, journalUuid, uwpAlt: [{ source, uwp, note }], sources: [sourceKeys] }
```

It never writes the actor's description or its UWP fields. Import Worlds
overwrites those every time it runs, and lore stored there would be lost.
Each source's entries are merged, so importing one source never removes
another source's alternative UWP.

On a World sheet, the GM sees two buttons below the map buttons:

- **Lore** opens the linked page.
- **Notes** opens the world's Notes page, creating it if needed.

## Hooks & Rumours

The Hooks & Rumours entry stores two things separately:

- **Hook content** comes from bundles and is replaced on each import.
- **Hook status** (unused, seeded, used or discarded, plus a note) is yours.
  Importing a bundle never writes it, and removing a source keeps it.

Every rendered hook shows a status badge. The GM also gets a dropdown next to
the badge for changing the status in place.

The tracker window lists every hook. You can:

- filter by subsector, status and source;
- search the hook text and your notes;
- click a hook to open its target page;
- change its status and note inline.

## Removing a source

**Remove Lore Source** lists every source that has been imported, and shows
a dry run of removing the one you pick. When applied, it:

- deletes that source's blocks, alternative UWPs and hooks;
- re-renders the pages that are affected;
- deletes pages left with no content;
- deletes entries left with no pages.

Notes pages are always kept, and so is any entry that still holds a Notes
page. Hook statuses are kept too, so re-importing the source later restores
everything as it was.

## Bundle format (v1)

```jsonc
{
  "format": "tt-lore-bundle",          // required
  "formatVersion": 1,                  // required; other versions are rejected
  "source": {                          // required
    "key": "pod",                      // required, [a-z0-9-]+, stable
    "title": "Campaign book: Pirates of Drinax",   // section heading on pages
    "short": "PoD",                    // label on badges and alternative UWPs
    "order": 30                        // sections sort by this, ascending
  },
  "bundleVersion": 3,                  // required integer; raise it on each regeneration
  "generatedAt": "2026-10-20T12:00:00Z",
  "sector": "Trojan Reach",            // required; must match Traveller Map's name
  "milieu": "M1105",                   // preferred milieu when matching actors
  "subsectors": [ { "name": "Tlaiowaha", "letter": "K", "blocks": [ /* Block */ ] } ],
  "worlds": [ {
    "hex": "2223", "name": "Drinax", "subsector": "Tlaiowaha",
    "uwpAlt": { "uwp": "A43645A-E", "note": "PoD p.14 lists Class A" },   // optional
    "blocks": [ /* Block */ ]
  } ],
  "journals": [ {
    "key": "ref:aslan-hierate", "title": "The Aslan Hierate", "folder": "Reference",
    "pages": [ { "key": "ref:aslan-hierate:clans", "title": "Clans", "blocks": [ /* Block */ ] } ]
  } ],
  "hooks": [ {
    "id": "III.54", "label": "Rumour",
    "target": { "type": "world", "hex": "1016" },  // or {"type":"subsector","name":"…"} / {"type":"journal","page":"<page key>"}
    "also": [ { "type": "world", "hex": "1619" } ], // optional cross-references
    "html": "<p>…</p>"
  } ]
}
```

A **Block** looks like this:

```json
{ "id": "pod:drinax:1", "heading": "The Floating Palace", "html": "<p>…</p>", "cite": "pp.15-21" }
```

- `id` must be unique within the bundle, and should stay the same when the
  bundle is regenerated.
- `heading` and `cite` are optional.
- `html` may only use these tags: `p`, `ul`, `ol`, `li`, `strong`, `em`,
  `h4`, `h5`, `br`, `table`, `tr`, `th`, `td` and `span`. Any other tag, and
  any attribute, is removed (except `colspan` and `rowspan` on table cells).
  Removed tags are reported.

Everything except `format`, `formatVersion`, `source`, `bundleVersion` and
`sector` is optional, so a bundle can contain only hooks or only reference
journals.

**Cross-links.** Block and hook HTML can use `@Lore[<key>]{label}`, where
`<key>` is one of:

- `world:<Sector>:<hex>`
- `sub:<Sector>:<Subsector>`
- a journal page key.

Each one becomes a normal `@UUID[…]{label}` link once the page it points to
exists. A key that can't be resolved is shown as the plain label, and it's
listed in the dry run and the report.

The importer rejects a bundle, with a message saying what's wrong, if:

- it's over 25 MB;
- it isn't JSON;
- `format` is wrong, or `formatVersion` isn't supported;
- a required field is missing;
- a hex isn't four digits;
- a block id, world hex, journal key, page key or hook id is duplicated.

**Copyright.** Real bundles summarise published books, so never commit them
to a public repository. This repository's `.gitignore` excludes
`*.tt-lore.json`; the only exception is the fictional test fixture
`tests/fixtures/sample.tt-lore.json`.

## Stored data

Each importer page keeps its source data in
`flags.traveller-trading.lore`:

```js
{
  key, sector, kind: "world" | "subsector" | "journal" | "hooks",
  blocks: { [blockKey]: { id, source, order, heading, html, cite, hash } },
  sources: { [sourceKey]: { bundleVersion, title, short, order } },
  uwpAlt: { [sourceKey]: { uwp, note } },      // world pages
  hex,                                          // world pages
  renderedHash,                                 // hash of the HTML the importer last wrote
  storedHash                                    // hash of that HTML as Foundry saved it, if different
}
```

Block and hook map keys are the IDs with `.` escaped as `%2E`, and `%` as
`%25`. This is needed because Foundry would otherwise split a dotted ID
such as `III.54` into nested objects. Each record still holds its original
`id`.

The hashes are FNV-1a, 32-bit, over canonical JSON (keys sorted). A page
counts as edited by hand when the hash of its current content matches
neither `storedHash` nor `renderedHash`. `storedHash` is only set when
Foundry normalises the HTML as it saves it, so that normalisation isn't
mistaken for a manual edit.

The Hooks & Rumours entry keeps `lore.hooks` (content) and `hookState`
(status), both keyed by escaped hook ID. The Lore Import Log entry keeps
`lore.sources`, a registry of the latest version imported from each source.

## Verification

The tests run under Node's built-in test runner:

```sh
node --test tests/lore-bundle.test.mjs
```

They cover:

- validation failures and HTML stripping;
- planning against an empty index;
- idempotency: re-planning against the result of an import gives zero
  changes;
- a change to one block updating exactly one page;
- sources being kept apart, and sections following `source.order`;
- orphans;
- the warning for a lower bundle version;
- link resolution;
- `hookState` never appearing in a planned write;
- manual-edit detection;
- hash determinism;
- removing a source.

Then check these by hand in Foundry:

1. In a fresh world, run Import Worlds for the Trojan Reach sector, then
   import the fixture. The journals, pages and actor links all appear, and
   the Lore button works.
2. Re-import the same file. The dry run shows no changes.
3. Edit one block in the fixture and re-import. Only that page changes, and
   its UUID stays the same.
4. Edit an imported page by hand, then re-import. Your edit is preserved on
   the Notes page.
5. Mark a hook as "used", then re-import. The status is kept.
6. Run Import Worlds for the sector again. The lore pages and the actors'
   lore flags are kept.
7. Remove Lore Source for the fixture's source. Its blocks are removed, and
   the Notes pages remain.
