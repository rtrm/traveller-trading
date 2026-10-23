# Import items bundles (2.1.0)

An **items bundle** is one JSON file (`*.tt-items.json`) plus a folder of
transparent WebP images, made by an external tool from an equipment book.
The first one is Mongoose's *Central Supply Catalogue*. This module imports
a bundle into a world compendium of mgt2e Items, and uploads the images to
your server. On the Forge, the images go to your Assets Library.

Two GM-only entries are added under **Game Settings › Configure Settings ›
Traveller Trading**:

- **Import Items Bundle** (button: *Import Items*)
- **Item image folder**: where images are uploaded. The default is
  `traveller-trading/items`. Each source gets its own sub-folder, so an
  image ends up at `<folder>/<source key>/<asset path>`.

Re-importing follows the same rules as lore import:

- it only changes what has changed;
- it always shows a dry run first;
- it never deletes anything unless you tick the option to;
- items keep their IDs, so links to them keep working.

## What gets created

- **A compendium** called `world.<pack name>`, with the bundle's label (for
  example "Central Supply Catalogue"). It's created on first import if it
  doesn't exist. If the compendium is locked, it's unlocked while the import
  writes, then locked again.
- **Folders** inside the compendium, following each item's `folder` path.
- **One Item per bundle entry.** Each item's image points at its uploaded
  file. An item with no image uses the item type's default icon.

The importer recognises its own items and folders by internal keys
(`flags.traveller-trading.itemKey` and `folderKey`), never by name. Anything
else in the compendium is left alone, including items and folders you add
yourself. A folder of the importer's that also holds something of yours is
never removed.

Copies of items that you or your players drag onto actors, or into the
world's Items directory, belong to you. The importer never writes to them.

## Importing

1. Open **Import Items Bundle**.
2. Click **Choose bundle…** and pick the `.tt-items.json` file. It's
   validated first, and any description HTML outside the allowed tags is
   removed and reported.
3. Click **Choose images folder…** and pick the bundle's images folder. If
   your browser can't pick folders, use **…or image files** and select the
   images themselves.

   Files are matched to the bundle's asset paths by their path inside the
   folder you chose. If a path doesn't match, a file is matched by its
   name, as long as no other asset has the same name. The window shows how
   many images matched.

   You can skip this step on a re-import if all the images are already
   uploaded.
4. Review the **dry run**:
   - items to create, update, leave unchanged or orphan;
   - items that were edited in Foundry;
   - images to upload, already uploaded, or missing;
   - item types that the mgt2e system doesn't define.

   Open **Details** for the full lists.
5. Choose your options:
   - **Re-upload images that already exist** (off by default). Normally an
     image already on the server isn't uploaded again, which keeps
     re-imports fast.
   - **Remove orphaned items from this source** (off by default). An orphan
     is an item from this source that's no longer in the bundle. With the
     option on, orphans are deleted, along with any of the importer's
     folders that are left empty. With it off, orphans are kept and listed.
6. Click **Apply Import**. Images upload one at a time with a counter, then
   the items are written in batches. A report appears in the window and is
   also saved to the **Import Log** journal.

   That journal is shared with lore imports. Worlds that already have a
   "Lore Import Log" keep using it under that name.

If a bundle's `bundleVersion` is lower than one you've already imported from
the same source, the dry run warns you, and you'll be asked to confirm.

### Missing images

An asset is **missing** if you didn't choose its file and it isn't already on
the server.

- A new item with a missing image gets the type's default icon.
- An existing item with a missing image keeps the image it has now.
- Missing images are listed in the dry run and in the report.

Choose the images and import again to fill them in.

### Items edited in Foundry

If someone edits an imported item in the compendium, the next dry run lists
it under **Edited in Foundry**. On apply, a copy of the edited item is first
saved to the world's Items directory, in a folder named
`<source short> edits (backup)` such as "CSC edits (backup)". Only then is
the compendium item overwritten. Nothing is lost silently.

The backup copy is an ordinary world Item, and the importer never touches it
again. Moving an item to a different compendium folder doesn't count as an
edit.

### Item data

Each item's `system` data from the bundle is merged over the mgt2e defaults
for its type. Any field the bundle leaves out gets its default value, both
when the item is created and when it's updated.

An ordinary update can't change an item's type. If a bundle changes one,
the report says so; delete the compendium item and re-import to recreate it.

## Bundle format (v1)

```jsonc
{
  "format": "tt-items-bundle",           // required
  "formatVersion": 1,                    // required; other versions are rejected
  "source": { "key": "csc-2023", "title": "Central Supply Catalogue Update 2023 (Mongoose)", "short": "CSC", "order": 10 },
  "bundleVersion": 1,                    // required integer; raise it on each regeneration
  "generatedAt": "2026-10-23T15:00:00Z",
  "pack": { "name": "central-supply-catalogue", "label": "Central Supply Catalogue" },   // required
  "assets": [ "weaponry/club.webp", "weaponry/gauss-pistol.webp" ],                       // image paths
  "items": [ {
    "key": "csc-2023:weaponry:gauss-pistol",   // required, unique, stable across regenerations
    "name": "Gauss Pistol",
    "type": "weapon",                          // an mgt2e Item type
    "folder": ["Weaponry", "Slug Pistols"],    // folder path inside the compendium
    "img": "weaponry/gauss-pistol.webp",       // one of assets, or null
    "page": 143,                               // book page (informational)
    "system": { /* mgt2e system data, merged over the type's defaults */ }
  } ]
}
```

**Field rules:**

- `source.key` uses only `a-z`, `0-9` and `-`.
- `pack.name` uses only `a-z`, `0-9`, `-` and `_`.
- Asset paths must be plain relative image paths: no leading `/`, no `..`,
  no `\` and no drive letters.
- Every `img` must be listed in `assets`.
- Folder names must not contain `/`.

**Weapon items** set `tl`, `weight` (kg), `cost` (Cr), `quantity`, `notes`
and `description` (HTML), plus these `weapon` fields: `scale`, `range`,
`minRange`, `damage`, `magazine`, `ammo`, `magazineCost`, `characteristic`,
`skill`, `parryBonus`, `damageBonus`, `damageType`, `attackBonus` and
`traits`.

`traits` uses mgt2e's own format: comma-separated trait IDs, each with an
optional value, such as `"ap 3, auto 2, zeroG"`.

**Description HTML** may only use `p`, `ul`, `ol`, `li`, `strong`, `em`,
`br`, `table`, `tr`, `th` and `td`. Anything else is removed and reported.

The importer rejects a bundle, with a message saying what's wrong, if:

- it's over 25 MB;
- it isn't JSON;
- `format` is wrong, or `formatVersion` isn't supported;
- an item key or asset is duplicated;
- an `img` isn't listed in `assets`;
- an asset path is unsafe.

Item types are checked against the mgt2e system when the dry run is built.
Items of an unknown type are skipped and reported. They aren't treated as
orphans, so nothing is deleted because of them.

**Copyright.** Real bundles and their images come from published books, so
never commit them to a public repository. This repository's `.gitignore`
excludes `*.tt-items.json`. The only bundle in the repository is the
fictional fixture `tests/fixtures/sample.tt-items.json`, with its image in
`tests/fixtures/images/`.

## Stored data

Each imported item keeps two flags:

```js
flags["traveller-trading"].itemKey = "<item key>"
flags["traveller-trading"].item = { source, bundleVersion, hash, page, asset, docHash }
```

- `hash` is FNV-1a (32-bit) over canonical JSON of
  `{name, type, folder, img, system}` from the bundle. Here `img` is the
  asset path, not the server URL. If an item's `hash` is unchanged, the
  import doesn't write to it.
- `docHash` covers the item as Foundry stored it after the import wrote it:
  its name, type, image and system data. If they no longer match `docHash`
  on the next import, the item was edited in Foundry.
- Each importer folder in the compendium carries
  `flags.traveller-trading.folderKey = "<source key>:<folder path joined by />"`.
- The Import Log journal keeps `itemSources`, which records the latest
  version imported from each source.

## Verification

The tests run under Node's built-in test runner:

```sh
node --test tests/items-bundle.test.mjs
```

They cover:

- validation failures and HTML stripping;
- hash order-independence;
- planning against an empty index;
- idempotency: re-planning against the result of an import gives zero
  changes;
- a change to one weapon's damage giving exactly one update;
- orphans and empty folders;
- manual-edit detection;
- which images get uploaded;
- missing images;
- unknown types;
- the warning for a lower bundle version;
- matching chosen files to assets.

Then check these by hand in Foundry:

1. Import the fixture (`tests/fixtures/sample.tt-items.json` with the
   `tests/fixtures/images` folder). The compendium, folders and items
   appear, and the Test Blaster has its image.
2. Re-import it. The dry run shows zero item changes and zero uploads.
3. Change one value in the fixture and re-import. Only that item updates,
   and its UUID stays the same.
4. Edit an item in the compendium, then re-import. The edit is kept in the
   "TEST edits (backup)" folder.
5. Drag an item onto a Traveller, edit the copy, then re-import. The actor's
   copy is untouched.
6. On the Forge, check that the images are in the Assets Library under
   `traveller-trading/items/sample-items/`.
7. Roll attacks with the imported weapons, including the Destructive Test
   Big Gun. Damage and traits behave as normal.
