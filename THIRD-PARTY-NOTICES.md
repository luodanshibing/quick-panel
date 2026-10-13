# Third-party notices

Quick Panel has **no runtime dependencies**. It bundles no third-party library code,
no build output, and no vendored assets: `main.js` only uses the Obsidian plugin API
(`obsidian` module) plus standard renderer globals.

| Component | Where it comes from | License |
|---|---|---|
| Obsidian plugin API | Provided by the Obsidian application at runtime; not bundled here | Obsidian's own terms |
| [Lucide](https://lucide.dev) icon set | Rendered by Obsidian's own `setIcon()` / `getIconIds()`, which ship with the app; no icon files are copied into this plugin | ISC |

Icons shown on a tile are resolved at runtime against the icon set already present in
your Obsidian installation. This plugin does not redistribute that icon set.
