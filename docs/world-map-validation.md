# Blank world maps (1.21.10)

The Map tab now generates a blank, UWP-sized Traveller globe net. Terrain
generation is deferred. Each triangle edge spans `size` steps of 1,000 km.
The 20 faces share logical cells, including fragments across the polar cuts
and the east/west wrap. Five-face vertices represent pentagons.

Run the automated geometry and mocked Foundry integration checks with Node 22+:

```sh
node --test --test-isolation=none tests/world-map.test.mjs
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

1. Update the module to 1.21.10 and reload Foundry.
2. Open a size-5 World actor's Map tab. Select **Generate Blank World Map**.
   Verify the five-column triangular net, world name, scale, and refreshed image.
3. Repeat with size 4, 8, and A. Density must change with size; hexes stay regular.
4. Generate for size 0. Verify an explanatory notification and no map replacement.
5. Import worlds, a subsector, or a sector with blank-map generation selected.
   Size-zero worlds must import successfully without a surface map.
6. Open the sheet as a non-GM. The generation button must be absent.
7. If storage is unavailable, verify the error, preserved map and enabled button;
   the remainder of a batch import must continue.

Existing maps are replaced only by explicitly requested generation. Each
successful generation uploads a new file so browser caches cannot show the old
image. Older generated files are retained; this release does not delete assets.
