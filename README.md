# Spiral Stair — 28 Stormont Road (DIAXIS)

Web 3D presentation of the basement → ground-floor spiral stair: guided tour, construction sequence,
rotating section, exploded view, eye-level walk-through and night mode. Vite + three.js.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173 (also on the local network, e.g. for phones)
```

Node 18+ required.

## Updating the model

The browser does not read the `.3dm` directly. The Rhino model is **baked** into a compact web model
(render meshes only, ~4 MB instead of ~90 MB):

1. In Rhino 7, save `STAIR.3dm` with render meshes (not "Save Small"). Keep it next to this folder
   (`../STAIR.3dm`) or pass a path.
2. `npm run bake` (or `npm run bake -- path/to/model.3dm`)
   → writes `public/model/stair.json` + `public/model/stair.bin`.
   `npm run dev` / `npm run build` re-bake automatically when the `.3dm` is newer.
3. If layers were renamed or added, update `public/config/layers.json` (no code changes needed):
   - `stairGroups` — construction layers of the stair (Rhino layer paths, finish, colours, specs)
   - `contextLayers` — the building (shown with **Building** / in the tour)
   - `sequence` — steps of the construction sequence (order, motion, duration, camera)
   - `hiddenLayers`, `stairOnlyExclude` — what never shows / what only shows with the building

## Build & deploy

```bash
npm run build        # → dist/ (static, ~9 MB)
npm run preview      # check the build locally
```

`dist/` can be hosted on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages).
**This is a copyright construction model: deploy behind access control** (password-protected site,
private repository + protected deployment, or an authenticated host).

## Structure

| Path | |
|---|---|
| `src/main.js` | UI, modes, tour timeline, construction sequence, explode, walk, section, night |
| `src/model.js` | loads the baked model, sorts meshes into layers / groups, solids & materials |
| `src/materials.js` | procedural finishes (micro-cement, oak, plywood, plasterboard, steel …) |
| `src/scene.js` | renderer, camera, lights, AO / bloom post, adaptive resolution |
| `src/person.js` | scale figure and walking path |
| `scripts/bake-model.mjs` | `.3dm` → web model |
| `public/config/layers.json` | layer mapping and sequence |
| `public/models/person/` | scale figure (Mixamo, see LICENSE.md) |

## Performance notes

- Baked model: ~4 MB download, no WebAssembly parser.
- Shadows are re-rendered only when parts move or appear, not while the camera orbits.
- Pixel ratio adapts to the measured frame rate (lower on slow devices, full on fast ones).
- Phones: half-resolution AO, fewer real step lights at night.
