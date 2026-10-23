# Task: Items bundle import for traveller-trading (target 1.26.0)

This extends the lore import (see `LORE_IMPORT_TASK.md` and `scripts/lore-*.mjs`). Reuse its patterns and code wherever you can:
- the shared file-chooser helper;
- the dry-run, apply and report flow;
- the FNV-1a hash;
- the Import Log journal;
- the `TradingWindowBase` windows.

Read those files first.

## Goal

An external tool converts equipment books into **items bundles**. The first one is Mongoose's *Central Supply Catalogue*. A bundle is one JSON file plus a set of transparent WebP images.

The import creates or updates mgt2e Items in a world compendium called "Central Supply Catalogue". It also uploads the images to the server; on Forge, that means the Assets Library.

Re-imports follow the same rules as lore:
- incremental and idempotent;
- the dry run always comes first;
- nothing is deleted unless the GM ticks an option;
- document IDs never change.

## Hard rules

1. Only touch compendium documents (items and folders) whose `flags.traveller-trading.itemKey` or `flags.traveller-trading.folderKey` the importer set. Leave everything else in the pack alone.
2. Never write to items on actors, or to world items outside the pack. Players and GM drag copies out of the compendium, and those copies are theirs.
3. **Never commit real bundles or their images.** Add `*.tt-items.json` to `.gitignore`, with an exception for `tests/fixtures/`. The only bundle in the repo is the fictional fixture `tests/fixtures/sample.tt-items.json`, which is provided alongside this brief.
4. GM-only: the menus, uploads and writes are all restricted to the GM.

## Bundle format (v1)

```jsonc
{
  "format": "tt-items-bundle",
  "formatVersion": 1,
  "source": { "key": "csc-2023", "title": "Central Supply Catalogue Update 2023 (Mongoose)", "short": "CSC", "order": 10 },
  "bundleVersion": 1,
  "generatedAt": "2026-10-23T15:00:00Z",
  "pack": { "name": "central-supply-catalogue", "label": "Central Supply Catalogue" },
  "assets": [ "weaponry/club.webp", "weaponry/gauss-pistol.webp" ],   // relative paths of the image files
  "items": [
    {
      "key": "csc-2023:weaponry:gauss-pistol",       // stable, unique within the bundle
      "name": "Gauss Pistol",
      "type": "weapon",                              // any mgt2e Item type: weapon, armour, augment, item, software …
      "folder": ["Weaponry", "Slug Pistols"],        // folder path inside the pack
      "img": "weaponry/gauss-pistol.webp",           // one of assets[], or null
      "page": 143,                                   // book page (informational)
      "system": { /* mgt2e system data for that type, see below */ }
    }
  ]
}
```

- **`system` is passed through.** Merge it over the system's default data for the type, so missing fields keep their defaults.
  - Weapon items set: `tl`, `weight` (kg), `cost` (Cr), `quantity`, `notes`, `description` (HTML), and `weapon.{scale, range, minRange, damage, magazine, ammo, magazineCost, characteristic, skill, parryBonus, damageBonus, damageType, attackBonus, traits}`.
  - `traits` uses mgt2e's own format: comma-separated trait IDs with optional values, e.g. `"ap 3, auto 2, zeroG"`.
- **Allowed HTML in `description`:** `p, ul, ol, li, strong, em, br, table, tr, th, td`.
- **Validation (mirror the lore bundle validator):**
  - `format` and `formatVersion` are correct;
  - item keys are unique;
  - the item type exists in `game.system.documentTypes.Item` (check this in the Foundry layer, not the pure one);
  - every `img` is listed in `assets`;
  - the file is no larger than 25 MB.

## Images

**Choosing files.** The import window has **Choose bundle** (a single `.json` file) and **Choose images folder**. The folder picker is an `<input type="file" webkitdirectory multiple>`; also accept a multi-file selection as a fallback. Match the chosen files to `assets` by their relative path: use `webkitRelativePath` with the first folder segment removed, or fall back to the bare file name.

**Upload target.** Add a world setting, "Item image folder", default `traveller-trading/items`. Files go to `<setting>/<source.key>/<asset path>`.
- Use the v13/v14 FilePicker API: `foundry.applications.apps.FilePicker.implementation`, with `createDirectory` (ignore "already exists") and `upload`.
- The source is `"forgevtt"` when `typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge`, otherwise `"data"`.
- Pass `{ notify: false }`.
- Check the exact signatures against the Foundry v13/v14 API before relying on them.

**What to upload.** List the target folder first (`browse`). Upload an asset only if it's missing there, or if the GM ticks **"Re-upload images that already exist"** (off by default). Re-imports are fast because nothing is uploaded twice.

**Image paths on items.** An item's `img` becomes the uploaded file's server path.
- If an asset wasn't chosen and isn't already on the server, keep the item's current `img`. On create, use the type's default icon. List these in the report.
- Items with `img: null` use the type's default icon.

**Progress.** Upload in sequence with a progress counter; around 200 files of about 40 KB each is fine.

## Compendium

- **Find or create the pack.** Find the world pack `world.<pack.name>`, or create it with `CompendiumCollection.createCompendium({ type: "Item", label, name, package: "world" })`. Unlock it while writing, then restore its locked state afterwards.
- **Folders.** Create folders inside the pack from each item's `folder` path, with `Folder.create({...}, { pack })`. Give each one `flags.traveller-trading.folderKey = "<source.key>:<path joined by '/'>"` and find them by that key, never by name.
- **Item identity.** Items are identified by `flags.traveller-trading.itemKey`, and also store:

  ```js
  flags["traveller-trading"].item = { source, bundleVersion, hash, page }
  ```
  `hash` is FNV-1a over canonical JSON of `{name, type, folder, img (asset path), system}`.
- **Upsert.** An unchanged hash means no write. A changed hash means `update` the document in place, keeping its `_id`. Write in batches with `createDocuments` and `updateDocuments` and `{ pack }`, about 50 at a time.
- **Orphans.** An item flagged with this `source` but missing from the bundle is listed as orphaned. It's deleted only if the GM ticks "Remove orphaned items from this source" (off by default). Folders left empty by that are removed too.
- **Manual edits.** If someone edited a pack item in Foundry, its current data no longer hashes to the stored hash. The dry run flags it. On apply, overwrite it but keep the edited copy as a world Item in a folder named "CSC edits (backup)", so nothing is lost silently.

## UI

New settings menu, **"Import Items Bundle"**. It opens a window with the same flow as the lore import:

1. choose the bundle and images, then validate;
2. **dry run:**
   - items to create, update, leave unchanged or orphan;
   - edited items detected;
   - images to upload, already present or missing;
   - unknown item types;
   - a lower `bundleVersion` than the one stored needs an extra confirmation;
3. options:
   - re-upload existing images (off);
   - remove orphans (off);
4. apply, with progress;
5. report, also written to the Import Log journal.

## Code layout

- `scripts/items-bundle.mjs`: pure functions only, no Foundry globals. It holds `validateItemsBundle`, `planItemsImport(bundle, index)` and `itemHash`, and reuses `hashFnv1a` from `lore-bundle.mjs`.
- `scripts/items-import.mjs`: the Foundry layer: settings, window, uploads, pack, folders and documents.
- `docs/items-import.md`: user documentation and a format reference.
- Bump `module.json` to 1.26.0.

## Tests (`tests/items-bundle.test.mjs`)

- Validation rejects:
  - a wrong `format`;
  - a future `formatVersion`;
  - duplicate keys;
  - an `img` not listed in `assets`;
  - oversize input.
- Planning against an empty index creates every item and folder.
- Planning the same bundle against the index it produced gives zero changes.
- Changing one item's `system.weapon.damage` gives exactly one update.
- An item missing from a re-import is reported as orphaned, and removed only when the option is on.
- A hash mismatch is detected as a manual edit.
- The hash is independent of key order.
- The asset plan uploads only missing files unless re-upload is on.

## Manual acceptance checks (list them in the PR)

1. Import the fixture. The pack, folders and items appear, with images on the items.
2. Re-import it. The dry run shows zero item changes and zero uploads.
3. Change one value in the fixture and re-import. Only that item updates, and its UUID is unchanged.
4. Edit an item in the pack and re-import. The edit is kept in the backup folder.
5. Drag an item onto a Traveller and edit the copy, then re-import. The actor's copy is untouched.
6. On Forge, confirm the images land in the Assets Library under the configured folder.
7. Roll an attack with an imported weapon, checking a Destructive (DD) weapon too. Damage and traits behave as normal.
