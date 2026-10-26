# Developing Pixelline

Pixelline is an [Electron](https://www.electronjs.org/) app written in TypeScript, with no UI framework. The image engine, file formats and UI are all in this repository.

## Setup

You need [Node.js](https://nodejs.org/) 22 and Git. Then:

```
git clone https://github.com/LucasHeh47/pixelline.git
cd pixelline
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app with hot reload |
| `npm start` | Builds, then runs the production app |
| `npm test` | Runs the test suite (Vitest) |
| `npm run typecheck` | Type-checks the app and the Electron code |
| `npm run build` | Builds `dist/` (UI) and `dist-electron/` (main + preload) |
| `npm run dist` | Builds the Windows installer and portable exe into `release/` |

## Project layout

| Path | Contents |
| --- | --- |
| `src/core/` | The image engine, with no UI: rasters, layers, the document and its undo history, blending, painting, selections, fills, shapes, transforms, filters, colour reduction, upscalers, palettes and document operations |
| `src/core/io/` | PNG, OpenRaster (`.ora`) and Photoshop (`.psd`) files |
| `src/ui/` | The interface: the app shell, menus (`titleBar.ts`), commands and shortcuts (`commands.ts`), tool bar, options bar, status bar and start page |
| `src/ui/canvas/` | The canvas: zoom, pan, compositing on the GPU, overlays |
| `src/ui/tools/` | One class per tool (`Tool` in `tool.ts`) |
| `src/ui/panels/` | Navigator, Color, Swatches, Layers and History |
| `src/ui/dialogs/` | New image, image and canvas size, filters with live preview, colour tools, export |
| `src/ui/settings/schema.ts` | Every setting, with the code that applies it |
| `electron/` | Main process (windows, files, clipboard, updates) and the preload bridge |
| `tests/` | Unit tests for the engine and file formats |

## How it fits together

- **Every change goes through an `Edit`** (`src/core/document.ts`). Before pixels change, the edit saves the 64×64 tiles they're in; when it's committed it keeps only tiles that really changed. Non-pixel changes record their own undo and redo.
- **Layers store only the area they use** and grow when painted outside it, so moving a layer never cuts anything off at the image edge.
- **Painting** builds a coverage map for the whole stroke and recomputes it from the original pixels, so a stroke never gets more opaque than its opacity setting where it crosses itself.
- **The canvas** keeps each layer as a GPU canvas, updated only where pixels changed, and composites them into one image-sized canvas only in the changed area. Zooming and scrolling just redraw that one image.
- **Tools** get pointer events in image coordinates and draw their previews on the canvas overlay (`Tool.overlay`), or show changed pixels without touching the layer through `view.previews`.

## Testing in the app

`npm start` runs the production build. Use a separate profile so tests don't touch your own settings and recent files:

```
npx electron . --user-data-dir=%TEMP%\pixelline-test
```

`PIXELLINE_OPEN=<path>` opens an image at startup, and `PIXELLINE_SCREENSHOT=<path>` saves a screenshot and quits (for smoke tests).

## Releases

- Pushing to `develop` publishes a development build (a pre-release like `v0.1.1-beta.12`) for people on the Developer branch.
- Pushing a version tag (`v0.1.1`) on `main` builds and publishes a regular release, with notes from `CHANGELOG.md`.
