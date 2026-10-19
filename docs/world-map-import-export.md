# Import and export world maps (1.24.0)

On a World actor's Map tab, the GM now has **Export Map Data** and
**Import Map Data** alongside the two generation buttons.

- **Export Map Data** downloads a `world-map.json` file containing the current
  map's cells. Export does not reroll terrain or upload a file to Forge.
- **Import Map Data** opens a local JSON file picker. The file must describe
  the same UWP world size as the target actor. After validation, the module
  renders and uploads a new SVG, then updates the actor's map and saved data
  together. No UWP fields are changed, and no terrain is regenerated.
- Canceling the picker leaves the map unchanged. Invalid files, incompatible
  versions, size mismatches and failed uploads report an error and preserve
  the current map and serialized data. The file size limit is 5 MB.

Both blank and terrain maps can be exported and restored. Existing maps from
the corrected grid releases (1.21.10 onward) are supported: the module reads
their existing SVG cell identities and colors. Older terrain SVGs retain the
same visible terrain, but their ice cells' underlying liquid/land classification
is unknown. Ordinary PNG/WebP images and unrelated SVGs cannot be converted
into map data by this feature.

Newly generated and imported maps store data in the actor flag
`flags.traveller-trading.worldMap`, together with the image path it belongs to.
The same JSON is embedded as inert SVG metadata, so the SVG remains portable.
If the image has been replaced manually, export reads that current image
rather than silently exporting a stale actor flag.

## Data format

The top-level fields are:

| Field | Meaning |
| --- | --- |
| `format` | `traveller-trading-world-map` |
| `version` | Data format version, currently `2`; version `1` files remain supported |
| `geometryVersion` | Canonical grid identity version, currently `1` |
| `worldName` | Source world's display name |
| `size` | Numeric UWP world size |
| `hexScaleKm` | `1000` |
| `kind` | `blank` or `surface` |
| `uwp` | Source atmosphere/hydrographics metadata, or `null` |
| `cells` | One record per unique globe cell, excluding repeated fragments |

Each cell record has `id`, `terrain`, `surface` and `features`. Blank maps use `null`
terrain and surface. Terrain keys use the module's terrain palette; surface
is `water` or `land` (or `null` for legacy ice). `features` is a list of catalogue
keys such as `starport`, `city`, `town`, `dome` and `arcology`. Version 2 also
supports the desktop editor's optional generation `profile`. Neighbor sets, coordinates,
polygons, SVG markup and custom palette colors are never imported. The module
rebuilds geometry from size and validates every cell against that geometry.
Unrecognized properties are discarded. Unsupported versions are rejected
rather than guessed. Feature annotations and the expanded T5 terrain palette
are rendered in Foundry and preserved on re-export. Update the module to
1.24.0+ before importing edited desktop files; older importers reject version 2.

The exported module functions are `serializeWorldMap(grid, worldName)`,
`deserializeWorldMap(dataOrJson)` (returns `{grid, data}`),
`exportWorldMapData(actor)` (returns clean data), and
`importWorldMapData(actor, dataOrJson)` (returns the saved image path or `null`).
Import uses the target actor's name as the rendered map label.

## Verification

The Node test suite checks lossless blank/terrain round trips across sizes
1, 4, 5, 8 and 12, identical restored SVG rendering, version/size/cell validation,
XML escaping, legacy recovery, actor persistence, and failure preservation.

An optional real-browser check is available after installing Playwright and
Chromium:

```sh
node tests/world-map-browser.mjs
```

`PLAYWRIGHT_MODULE` can identify an existing Playwright package, and
`CHROME_EXECUTABLE` can select a locally installed Chrome executable. The test
uses an isolated headless browser and mocked Foundry storage; it checks actual
JSON download, browser XML parsing, older SVG recovery, file-picker import,
and cancellation. It does not connect to Forge or a live game.

For Forge acceptance, export an existing generated world map, reroll it, then
import the exported JSON. Verify the original terrain returns on both sides
of the map seams. Repeat for a blank map and try a different-size file; the
latter must leave the current map unchanged.
