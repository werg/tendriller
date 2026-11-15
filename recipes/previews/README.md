# Actual starter previews

These PNGs show the six working recipes with the compiled production runtime and
the example data in each recipe's `starter.json`. They are browser screenshots,
not mockups. The facilitated-session image uses the shared display role and loads
no private participant data. The hardware image is explicitly simulated.

The capture viewport is 390 × 844 CSS pixels. `manifest.json` records the source
recipe, fixture, capture time, and fixture result for each image.

To refresh them in an environment with Playwright Chromium installed:

```sh
npm run build
npm run capture:recipes
```

Inspect all six images in `test-results/catalog/previews/`, including mobile
wrapping and chart labels, before copying the PNGs and manifest into this folder.
The capture command rejects horizontal page overflow. The Public service
workflow also uploads the originals as its `catalog-previews` artifact.

The gallery links each thumbnail to its full-size image. Keep the preview paths
in `recipes/catalog.json` aligned with these files.

The committed images were captured and inspected from the
[Public service run](https://github.com/werg/tendriller/actions/runs/43707117342)
for the workflow lifecycle follow-up.
