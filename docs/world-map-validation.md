# World surface maps (1.24.0)

The Map tab generates a UWP-sized Traveller globe net, with terrain or as a
blank grid. Each triangle edge spans `size` steps of 1,000 km.
The 20 faces share logical cells, including fragments across the polar cuts
and the east/west wrap. Five-face vertices represent pentagons.

Run the automated geometry and mocked Foundry integration checks with Node 22+:

```sh
node --test --test-isolation=none tests/world-map.test.mjs tests/world-map-terrain.test.mjs tests/world-map-data.test.mjs
```

The tests check sizes 1–12, equilateral geometry, shared identities, symmetric
adjacency, connectedness, Euler's formula, and `10 * size² + 2` unique cells.
They also cover UWP decoding, SVG escaping, failed storage operations,
size-zero skips, existing folders, GM permissions, and button restoration.

Visual checks: generated sizes 1, 4, 5, 8 and 12; compare against the supplied
Traveller blank-map images and the size-5 PDF diagram. Polar gaps must be
empty, the middle band continuous, and the outer half-faces wrapped.

## Forge acceptance checks

These require a live Foundry v14 world with the mgt2e system and module enabled:

1. Update the module to 1.24.0 and reload Foundry.
2. Open a size-5 World actor's Map tab. Select **Generate / Reroll Surface Map**.
   Verify the five-column triangular net, terrain, legend, world name, scale,
   and refreshed image. Verify **Generate Blank World Map** still produces a
   white grid with no terrain legend.
3. Repeat with size 4, 8, and A. Density must change with size; hexes stay regular.
4. Generate for size 0. Verify an explanatory notification and no map replacement.
5. Import worlds, a subsector, or a sector with surface-map generation selected.
   Size-zero worlds must import successfully without a surface map.
6. Open the sheet as a non-GM. The generation button must be absent.
7. If storage is unavailable, verify the error, preserved map and enabled button;
   the remainder of a batch import must continue.

Existing maps are replaced only by explicitly requested generation. Each
successful generation uploads a new file so browser caches cannot show the old
image. Older generated files are retained; this release does not delete assets.

## Terrain generation

Surface maps use the same unique-cell graph as the blank grid. Region growth
crosses triangle cuts, poles and the east/west wrap. Every drawing fragment of
a cell uses that cell's terrain color. The triangular geometry is unchanged;
the terrain legend sits below the net.

Hydrographics 0–A sets surface-liquid coverage to the nearest whole unique
cell: `round(cellCount * hydrographics / 10)`. Polar ice retains its underlying
water/land classification. Hydrographics 0 produces no ocean, ice or forest;
A produces an entirely liquid/ice surface. This is a coverage approximation,
since pentagons and hexagons are counted as individual cells, not spherical area.

Atmospheres 4–9 and D/E support illustrative plains, forests and deserts.
Atmospheres 0–1 use barren land, 2–3 desert, and A–C/F wasteland. Land receives
clustered mountain ranges and adjacent hills. Oceans and forests also grow
as regions rather than independent per-cell noise.

UWP alone does not determine climate, seasons, axial tilt or liquid chemistry.
The small polar caps on wet temperate worlds and other terrain distributions
are illustrative defaults, not a full T5 simulation or canonical world geography.
No local or terrain-hex detail is generated.

The generation API accepts `{ blank: true }` to retain blank maps. Surface
generation is the default, including optional generation during imports.
Reroll uses fresh randomness; tests inject a repeatable random sequence.
Atmosphere and hydrographics accept numeric values or extended-hex strings;
missing/invalid values report an error before uploading or replacing a map.

Additional acceptance checks: Eauhti (`B540489-B`) should have no water or
forest; a wet atmosphere-6 world should have oceans and coherent land regions;
a hydrographics-A world should have no exposed land. Reroll must change
geography without changing the grid. Compare both sides of polar cuts and the
left/right map edges for matching cell colors.

## Forge import diagnostics

Version 1.21.11 shares successful map-folder preparation across the browser
session. A batch no longer repeats folder creation/browsing for every world.
Concurrent map requests share preparation; failed preparation is retryable,
and upload failures invalidate the cache so the next attempt rechecks storage.
Each map still requires its own upload, so large imports can still trigger
Forge's sustained API activity warnings. Those warnings alone do not establish
an upload failure.

The supplied console log also reports `setProperty is not defined` from
`ForgeVTT.mjs:629`, inside Forge's `preUpdateActor` hook. The triggering stack
includes an mgt2e actor-creation follow-up update (`mgt2.mjs:829`). This is
separate from the successful map uploads and is not fixed by reducing map
storage calls. Foundry v14 documents the utility as `foundry.utils.setProperty`:
https://foundryvtt.com/api/functions/foundry.utils.setProperty.html

If that error persists, provide Forge support with the error and stack, the
Foundry build, and mgt2e version (the supplied log shows 0.23.2.0). This module
does not replace Forge hooks or restore obsolete global utility aliases.
