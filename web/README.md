# Velon site

The public landing page for Velon: a single static page with no framework and no runtime dependencies.

## Run it

Requires Bun 1.3 or newer.

```sh
cd web
bun run build          # compiles src/main.ts to main.js
bun serve.ts 4321      # serves this folder on http://127.0.0.1:4321
```

`bun run dev` does both. `main.js` is committed, so any static host can serve the folder as it is.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The page |
| `styles.css` | All styles: tokens, sections, responsive rules |
| `src/main.ts` | Hero steps through the real screens, reveal on scroll, timeline progress, copy button |
| `main.js` | Built bundle of `src/main.ts` |
| `fonts/` | Geist and Geist Mono, Latin subsets (SIL Open Font License) |
| `shots/` | Captures of the real console from a test-bench revoke (see `DESIGN.md`) |
| `og/og.html` | Source for `og.png` (1200 × 630). Render it at that viewport to regenerate. |
| `DESIGN.md` | Concept, type, colour, grid and motion decisions |

## Before deploying

`og:image` is a relative path. Set it to the absolute URL of `og.png` on the final domain so link previews work.
