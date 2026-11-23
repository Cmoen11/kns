---
name: update-screenshots
description: Retake the README screenshots in docs/img/ (and refresh the README text around them) from the browser dev build with the mock backend. Use when asked to update, refresh or retake the screenshots or images in the repo, after UI changes that make them stale, or when adding a new screenshot to the README.
---

# Update the README screenshots

The screenshots in `docs/img/` are taken by `scripts/screenshots.mjs`: Playwright drives the
browser dev build (`pnpm dev`, mock backend, no cluster) with the keyboard, one scene per image.
Dark mode is the house style.

## Retake them

1. `pnpm install --frozen-lockfile` if `node_modules` is missing.
2. Run the script from the repo root:

   ```bash
   node scripts/screenshots.mjs
   ```

   It reuses a running dev server on http://localhost:1420 or starts one and stops it again.
   Useful options: shot names to retake only some (`node scripts/screenshots.mjs why env`),
   `--out <dir>` to write somewhere else first, `--scale 1` for smaller files while iterating,
   `--light` for light mode (not for the README).
3. **Look at every image** with the Read tool before committing. A scene can "pass" and still show
   the wrong thing (a key that now does something else, a toast over the content, a view that
   replaced the list instead of opening beside it). A failed scene writes `<name>.failed.png`
   next to the output; look at it, fix the scene, and do not commit the `.failed.png`.

## When a scene is wrong

Scenes live in the `scenes` object in `scripts/screenshots.mjs`. They use only what a person
would: `d.cmd("pods shop")` for the `:` command bar, `d.leader("r")` for `Ctrl+.` then a key,
`d.key("Shift+W")` (uppercase keys need `Shift+`), `d.key("+")` before a key to open the view
beside the current pane, `d.row(text)` to put the table cursor on a row, `d.until(text)` to wait
for mock data that churns (pod statuses change over time).

Default keys are in `src/actions/keymap-data.ts`; check there when a key stopped working.

## Adding a screenshot

1. Add a scene to `scenes` (the key is the file name, `docs/img/<key>.png`), with a comment that
   matches the README caption.
2. Reference it from `README.md` as `![caption](docs/img/<key>.png)`.

## README text around the images

When retaking because the UI changed, also re-read the README captions and the feature lists next
to each image and correct anything the new images contradict (names, counts, keys). Counts of MCP
tools come from the generated table in `docs/tools.md`.

## Commit

Commit the PNGs together with any script or README change, e.g.
`docs: retake README screenshots`.
