# Changelog

## 0.2.1

- **Giant brushes are smooth.** A 256 px pencil took about 170 ms per mouse move on a 4000×3000 image (a few frames a second), and a 1000 px brush about 33 ms. Strokes now only work out the pixels that changed, once per move: about 6 ms and 8–13 ms. The result is the same, pixel for pixel. The eraser, clone stamp and retouch brush get faster too.
- **Hovering a brush over a big image** no longer redraws the whole image on every mouse move.
- **Checking for updates** no longer says something went wrong when there's no new regular release yet.

## 0.2.0

- **Shading and dithering inks.** The pencil and brush have an **Ink** setting:
  - **Shade** makes each pixel you paint a darker shade of itself (right-click for lighter). Shades drift toward blue and yellow, like hand-picked pixel-art ramps, or step through the Swatches palette;
  - **Dither** paints a checkerboard, 25%, 75% or line pattern, with one colour or both.
- **Animated textures** (Minecraft water, lava, fire…). The new **Animation** panel:
  - plays the frames stacked in the image, at Minecraft's timing;
  - adds, copies, moves and deletes frames;
  - shows the previous frame faintly while you draw (onion skin).
  - Saving as PNG writes the **.png.mcmeta** next to it, and opening a PNG reads it back.
- **Retouch brush (R):** blur, sharpen, lighten, darken, add or remove colour just where you paint. The right button does the opposite.
- **Curves (Ctrl+M)** with a curve editor over the image's histogram, and presets. Also **Auto tone (Ctrl+Shift+L)** and **Gradient map**.
- **Colours:**
  - pick a colour from anywhere on screen;
  - the Color panel shows hue-shifted **shades** of the colour, and can add them to the palette;
  - a live **Colours in this image** palette.
- **Batch process a folder (File menu):** resize, upscale, recolour to a palette, apply a filter or convert every image in a folder, subfolders included, into another folder. Made for whole resource packs; .mcmeta and other files come along.
- **Export tiles:** saves each tile of an atlas or sprite sheet as its own PNG.
- **Snap to the tile grid (Ctrl+Shift+;):** selections grow to whole tiles and moves go tile by tile.
- **Right-click menu on the canvas** for the selection and move tools: copy, paste, crop, transform and more.
- **Navigator previews:** the image at actual size, or tiled 3×3 to check seams.
- **Safety copies:** unsaved images are copied every couple of minutes. If Pixelline closes unexpectedly, the start page offers to recover them.
- The start page has tips, and an app switcher (top left) opens Gridline, Frameline (the new video editor) and Baseline, the new home app for the suite. Baseline can also start a new image in Pixelline.

## 0.1.0

The first version of Pixelline: an image editor for pixel art, game textures and photos.

- **Tools:** move, free transform, rectangle and ellipse select, lasso, magic wand, crop, pencil (pixel-perfect), brush, eraser, clone stamp, fill bucket, gradient, shapes, text, eyedropper, hand and zoom.
- **Pixel art and textures:**
  - seamless tile preview where painting wraps around the edges, mirror painting, pixel grid and tile grid;
  - built-in palettes (Minecraft dyes, PICO-8, DawnBringer 16, Sweetie 16, Endesga 32, Game Boy…), palettes made from an image, `.gpl`/`.pal`/`.hex`/`.txt` import and export;
  - Turn into pixel art, Reduce colours (with dithering), Upscale pixel art (Scale2x/Scale3x), Replace colour;
  - new-image sizes for Minecraft blocks, items, skins, pack icons, GUIs and paintings.
- **Layers:** blend modes, opacity, locks, lock transparent pixels, drag to reorder, merge down, merge visible, flatten, new layer from the selection.
- **Selections:** add, subtract and intersect; feather, grow, shrink, invert, reselect; select a layer's pixels or a colour.
- **Adjustments and filters** with a live preview, and Repeat last filter (Ctrl+F).
- **Image:** image size, canvas size, crop, trim, reveal all, rotate, flip, duplicate.
- **Files:** PNG (exact, small paletted files for pixel art), JPEG, WebP, GIF and BMP; layered OpenRaster (`.ora`) and Photoshop (`.psd`). Export as PNG, JPEG or WebP at any scale.
- **Workspace:**
  - several images in tabs;
  - Navigator, Color, Swatches, Layers and History panels;
  - a start page with recent files;
  - command search (Ctrl+K);
  - dark and light themes;
  - settings.
