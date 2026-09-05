# Twig brand assets

The user supplied `twig-logo.png` in this conversation. This is the original
1254×1254 PNG, preserved byte for byte. No generated replacement, tracing,
retouching or background removal was used.

| Asset | Purpose |
| --- | --- |
| `design/twig-logo.png` | Original artwork and source for every derivative |
| `build/icon.png` | 1024×1024 PNG: Linux/window icon and macOS development Dock |
| `build/icon.icns` | macOS bundle icon, up to 1024×1024 |
| `build/icon.ico` | Windows icon, 256×256 PNG in ICO container |
| `renderer/public/twig-logo.png` | 128×128 copy for the workspace header and favicon |

Copies preserve the entire image, its aspect ratio and alpha channel. Only
resizing and platform encoding differ. The small UI image avoids decoding the
full-resolution source on each workspace load.

The source's deep green, mint, lime and ivory inspired the surfaces, accent and
lane colors in `TOKENS.md`. Light mode darkens foreground greens for contrast.
Error color keeps its semantic purpose, independent of the logo palette.

## Regenerate copies (macOS)

From `modules/git_desk`, with dependencies installed:

```sh
sips -z 1024 1024 design/twig-logo.png --out build/icon.png
sips -z 128 128 design/twig-logo.png --out renderer/public/twig-logo.png
```

Use the `app-builder` binary included in `electron-builder` dependencies to
encode platform formats. Its path is exported as `appBuilderPath` by
`app-builder-bin`; on this arm64 Mac:

```sh
node_modules/app-builder-bin/mac/app-builder_arm64 icon --format icns --input build/icon.png --root . --out build
node_modules/app-builder-bin/mac/app-builder_arm64 icon --format ico --input build/icon.png --root . --out build
```

Generated assets are committed, so normal builds on any OS need no image tools.
`package.json` points electron-builder to the platform assets; installer builds
remain part of M5. `BrowserWindow.icon` covers Windows/Linux and
`app.dock.setIcon` applies the supplied logo to the macOS development app.
