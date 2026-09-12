# HANDY DANDIES — a field of hands that point at your cursor

A three.js browser scene filled with a grid of rigged 3D hand models. Each
hand independently rotates to point toward the cursor's position — cursor
near the top of the browser tilts every hand upward (showing their
undersides), cursor near the bottom tilts them downward (showing their
tops/backs). The camera pans on click-drag and zooms on scroll/pinch
(desktop + mobile), independent of the field's own layout. Cel-shaded
(toon) material with a choice of 2 outline techniques. No backend, no
build step — a static page, reusing HANDO's rigged hand asset, dev-panel
engine, and shader code.

See `docs/PROJECT_SUMMARY.txt` for the current state (objective, scope,
current state, recent decisions, known limitations, next action — the part
that changes often) and `docs/PROJECT_PROGRESS.md` for what's being worked
on right now. This README stays a short pointer, not a duplicate of either —
don't let real content drift into this file instead of those.

## How to run it

**Must be served over HTTP — opening `index.html` directly as a bare
`file://` does NOT work.** The page uses ES modules (`import`) and fetches
the GLB model via `fetch()`, both of which browsers block from resolving
relative paths under `file://` (no real origin to resolve against). Serve
the folder with any static file server — `.claude/launch.json` has 3
ready-made `python3 -m http.server` configs on ports 8420/8421/8422 — then
open `http://localhost:<port>` in a browser. Append `?dev=1` (or just run
on localhost/127.0.0.1, which the dev panel already treats as dev mode) to
see the dev panel.

## Project structure

```
HANDY DANDIES/
├── index.html                 <entry point: import map (three.js via CDN) + canvas>
├── src/
│   ├── main.js                <scene setup, model loading/instancing, cursor-tracking>
│   ├── style.css               <page + dev-panel chrome styling>
│   └── devpanel/devPanel.js   <generic dev-panel engine, reused verbatim from HANDO>
├── data/processed/HAND3D/
│   └── Hand2.glb               <rigged hand model, copied from HANDO's own asset>
├── docs/                      <README (pointer only — this file), PROJECT_SUMMARY.txt,
│                               CODE_SUMMARY.txt, PROJECT_PROGRESS.md, CHANGELOG.txt>
├── scripts/{active,archive}, data/raw/, logs/, results/, tests/   <empty, standard skeleton>
```

## Known limitations

See `docs/PROJECT_SUMMARY.txt`'s Known Limitations section for the current,
maintained list — not duplicated here to avoid drift between two copies of
the same information.

## Roadmap

No formal roadmap is tracked separately. See `docs/PROJECT_PROGRESS.md` for
what's currently being worked on and what's next, and `docs/CHANGELOG.txt`
for the full history of what's been built.
