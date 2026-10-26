# Pixelline user guide

## The window

| Part | What it's for |
| --- | --- |
| **Menus** (File, Edit, Image, Layer, Select, Filter, View, Help) | Every command. **Ctrl+K** searches all of them by name. |
| **Options bar** (under the menus) | Settings for the current tool: size, opacity, mode… They're remembered. |
| **Tool bar** (left) | The tools, the mirror and seamless-tile switches, and the primary and secondary colours. |
| **Image tabs** (above the image) | Each open image. Drag to reorder; middle-click to close. |
| **Panels** (right) | Navigator, Color, Swatches, Layers and History. Click a panel's title to fold it; drag the column's left edge to make it wider. **Tab** hides them all. |
| **Status bar** (bottom) | Zoom (type a value), image size, the pixel under the pointer and its colour, the selection size. |

Move around with **Space+drag** (or the middle mouse button) and zoom with the **mouse wheel**. **Ctrl+0** fits the image on screen and **Ctrl+1** shows it at 100%.

## Tools

| Tool | Key | Notes |
| --- | --- | --- |
| Move | V | Drags the layer, or the selected pixels. Arrow keys nudge (Shift: 10 pixels). |
| Rectangle / ellipse select | M | Shift adds, Alt subtracts. Drag inside a selection to move its outline. |
| Lasso | L | Free or polygon (click points, Enter or double-click to finish). |
| Magic wand | W | Selects similar colours; turn off "Contiguous" to select a colour everywhere. |
| Crop | C | Drag, adjust the edges, then Enter. |
| Pencil | N | Hard pixels. **Pixel perfect** removes the doubled corners on curves. |
| Brush | B | Soft or hard, with flow, smoothing and pen pressure. |
| Eraser | E | Pixel or soft. |
| Clone stamp | S | Alt+click to choose where to copy from, then paint. |
| Retouch brush | R | Blur, sharpen, lighten, darken, add or remove colour where you paint. The right button does the opposite. |
| Fill bucket | G | Tolerance, contiguous or everywhere, all layers. |
| Gradient | Shift+G | Linear, radial, angle, diamond, reflected. Bands and dithering make pixel-art gradients. |
| Shapes | U | Rectangle, ellipse, line; outline, fill or both. Shift keeps it square. |
| Text | T | Click, type, then Ctrl+Enter or click elsewhere. Turn off **Smooth edges** for crisp pixel text. Each text becomes its own layer. |
| Eyedropper | I | Alt+click picks colours with any paint tool too. |
| Hand, Zoom | H, Z | |

With any painting tool:
- left-click paints with the primary colour and right-click with the secondary one;
- **Shift+click** draws a straight line from the last point;
- **[** and **]** change the size;
- **X** swaps the colours and **D** resets them to black and white.

## Pixel art and textures

- **Pixel grid** (View, Ctrl+'): lines between pixels once you zoom in far enough.
- **Tile grid** (Image → Tile grid, Ctrl+Shift+'): lines every 16 pixels, or any size. Handy for texture atlases and sprite sheets.
- **Seamless tile preview** (View, Shift+T): shows the image repeated around itself. While it's on, brushes, lines and shapes wrap around the edges, so a block texture always tiles.
- **Mirror painting** (tool bar or View): paints the mirror image too, left-right and/or top-bottom.
- **Swatches**: pick a palette from the list. Click a colour to use it, right-click it for more (secondary colour, select it on the layer, remove it). **+** adds the primary colour. The **⋯** menu makes a palette from the image, imports and exports palette files.
- **Image → Turn into pixel art**: shrinks a picture to a few pixels and limits its colours. The result opens as a new image.
- **Image → Reduce colours**: maps the layer (or the selection) to fewer colours or to a palette, with optional dithering.
- **Image → Upscale pixel art**: Scale2x/Scale3x keep pixel art sharp but round off jagged diagonals; "Blocky" just repeats pixels.
- **Edit → Replace colour**: swaps one colour for another on a layer. **Keep shading** shifts similar colours instead of flattening them.
- **Filter → Textures → Make seamless** and **Offset** help turn a photo into a tiling texture.

### Inks: shading and dithering

The pencil and brush have an **Ink** setting in the options bar:

- **Normal** paints the colour.
- **Shade** turns each pixel you paint into a darker shade of itself; the right button makes it lighter (or the other way round with **Lighter**). **Shift the colour** shades the way pixel artists do, drifting toward blue in shadows and yellow in highlights. **Use the palette** steps to the next colour of the same hue in the Swatches palette. A stroke shades each pixel once, so going back and forth in one stroke doesn't darken it further; paint again for another step.
- **Dither** paints a pattern (checkerboard, 25%, 75% or lines) that stays lined up with the image's pixels. Turn on **Both colours** to fill the gaps with the secondary colour.

The **Shades** row in the Color panel shows hue-shifted darker and lighter versions of the current colour. Click one to use it, or **Add to palette**.

### Animated textures

Open the **Animation** panel and click **Make this an animation**. The frames are stacked top to bottom, each as tall as the image is wide, like Minecraft's water, lava and fire textures.

- The preview plays the frames at Minecraft's speed. **Frame time** is in game ticks (20 per second).
- The buttons add an empty frame, duplicate the current one, move it earlier or later, or delete it.
- **Onion skin** shows the previous frame faintly over the frame you're drawing, to line up movement. Click on a frame in the image to make it the current one.
- **Blend between frames** is Minecraft's *interpolate*.
- Saving as PNG also saves the **.png.mcmeta** next to it, and opening a PNG with an .mcmeta turns its animation on. **Copy .mcmeta** puts the text on the clipboard.

### Atlases and folders

- **Snap to the tile grid** (View, Ctrl+Shift+;, or the magnet in the tool bar): rectangle selections grow to whole tiles and the Move tool moves tile by tile. It uses the tile grid size (16 when there is no grid).
- **File → Export tiles** saves each tile of the image as its own PNG in a folder. Use it to split an atlas or a sprite sheet. Empty tiles are left out.
- **File → Batch process a folder** makes the same changes to every image in a folder, subfolders included, and saves the results in another folder with the same layout:
  - trim transparent edges;
  - resize;
  - upscale pixel art;
  - apply any filter (with its last settings);
  - reduce colours to a palette;
  - save as another format.

  It's made for whole resource packs, and copies their other files (.mcmeta, .json) along.

## Photos

- **Curves** (Ctrl+M): drag the line to change tones (up brightens, down darkens, an S shape adds contrast) with the image's histogram behind it. Click to add a point, drag one off the graph to remove it. Pick **R**, **G** or **B** to change one colour.
- **Auto tone** (Ctrl+Shift+L) stretches the image to full contrast; **Fix colour casts too** also balances yellowish or bluish photos.
- **Gradient map** recolours by brightness (shadows one colour, highlights another), for moody photos or turning one material into another.
- **Retouch brush** (R) for local fixes: soften skin or a noisy patch, sharpen eyes, dodge and burn.

## Layers

- **New layer** (Ctrl+Shift+N), **Duplicate** (Ctrl+J; with a selection it copies just the selection to a new layer), **Cut to a new layer** (Ctrl+Shift+J).
- Drag layers in the panel to reorder them. Double-click a name to rename it, or the thumbnail for all its properties.
- Click the eye to hide a layer. **Alt+click** the eye shows only that layer.
- **Ctrl+click** a thumbnail to select the layer's pixels.
- **Lock transparent pixels** (/) paints only where the layer already has pixels, which is perfect for shading or recolouring a sprite.
- **Merge down** (Ctrl+E), **Merge visible** (Ctrl+Shift+E), **New layer from the whole image** (Ctrl+Alt+Shift+E), **Flatten image**.

## Selections

**Ctrl+A** selects everything, **Ctrl+D** deselects, **Ctrl+Shift+D** brings the last selection back and **Ctrl+Shift+I** inverts it. Select → Grow, Shrink and Feather change its edge. While something is selected, painting, filters and fills only change the selected area. **Delete** clears it, **Alt+Backspace** fills it with the primary colour and **Ctrl+Backspace** with the secondary one.

## Transform

**Ctrl+T** puts handles around the layer (or the selected pixels):
- drag a corner or edge to scale (Shift keeps the shape, Alt scales from the middle);
- drag outside the box to rotate (Shift snaps to 15°);
- drag inside to move.

**Quality** chooses hard pixels (pixel art) or smooth resampling (photos). Pixelline picks one for you based on the content. **Enter** applies and **Esc** cancels.

## Files

| Format | Notes |
| --- | --- |
| **PNG** | Exact pixels with transparency. Pixel art is saved as a small paletted PNG when it has 256 colours or fewer. |
| **OpenRaster (.ora)** | Pixelline's own format. Keeps layers, blend modes, locks and the tile grid. GIMP and Krita open it too. |
| **Photoshop (.psd)** | Keeps layers, blend modes and opacity. When opening, layer masks are applied, groups become plain layers, text layers become pictures and layer effects are left out (Pixelline tells you when that happens). |
| **JPEG, WebP** | Photos and small files. JPEG has no transparency. |
| GIF, BMP, ICO | Open only (the first frame of a GIF). |

**Save** (Ctrl+S) writes back to the file you opened. Saving a layered image as PNG or JPEG writes the flattened image; the layers stay while it's open.

**Export as** (Ctrl+Alt+S) saves a flattened copy as PNG, JPEG or WebP, optionally scaled. Whole-number scales (200%, 400%…) keep pixel art crisp, which is handy for sharing a 16×16 texture. The file size is shown before you save. **Copy to clipboard** puts the result on the clipboard instead.

Drop image files on the window to open them. With an image already open, you can drop them as new layers instead. Palette files dropped on the window go to the Swatches panel.

## Safety copies

Every couple of minutes, Pixelline keeps a copy of images with unsaved changes. If it closes unexpectedly, the start page shows **Unsaved work from last time**; click **Recover** to open each image again, then save it. Change how often (or turn it off) in **Settings → Files & saving**.

## The other apps

The dotted button at the top left switches to **Gridline** (spreadsheets) and **Baseline**, the home app that lists recent files from both apps and starts new ones. Apps that aren't installed link to their download page.

## Settings

Open **Settings** with the gear in the title bar or **Ctrl+,**. Among them:
- the theme, accent colour, and the background around the image;
- the checkerboard behind transparent areas, and when the pixel grid appears;
- what the mouse wheel does;
- pen pressure, and how much undo history to keep.
