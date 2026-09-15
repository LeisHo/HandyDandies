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
├── api/
│   └── save-settings.js       <Vercel serverless function -- git-tracked Save Settings, see below>
├── data/processed/HAND3D/
│   └── Hand2.glb               <rigged hand model, copied from HANDO's own asset>
├── data/processed/
│   └── dev-panel-settings.json <git-tracked dev-panel state the Save button writes to>
├── docs/                      <README (pointer only — this file), PROJECT_SUMMARY.txt,
│                               CODE_SUMMARY.txt, PROJECT_PROGRESS.md, CHANGELOG.txt>
├── scripts/{active,archive}, data/raw/, logs/, results/, tests/   <empty, standard skeleton>
```

## Dev panel Save button setup (one-time Vercel setup)

The dev panel's Save/Reset buttons write through to a git-tracked file
(`data/processed/dev-panel-settings.json`) via `api/save-settings.js`, a
Vercel serverless function, rather than only `localStorage` — so a Save
from any device/browser is visible everywhere, not just the browser that
clicked it. Ported directly from HANDO's own identical setup (workspace
convention, `CLAUDE.md` §12l).

This only works once 2 environment variables are set on this project's own
Vercel project (Settings → Environment Variables), then redeployed:

1. **`GITHUB_TOKEN`** — a GitHub fine-grained personal access token,
   scoped to only this repo (`LeisHo/HandyDandies`), with **Contents: Read
   and write** permission and nothing else. This is what the serverless
   function uses to commit the settings file on your behalf.
2. **`DEV_PANEL_SAVE_SECRET`** — an anti-abuse shared token (not a real
   secret — it also ships baked into this page's own client-side source,
   same as everything else here; it only exists to keep a random visitor
   from spamming commits to the repo). Set it to
   `PkrbMti03M6xm3FEThYXa8gGW_08BOGj` (the same value HANDO/DICKOCLICKO/
   OKCILCOKCID's own Vercel projects use, since this is one workspace-wide
   shared token, not a per-project one) — or change both the Vercel env
   var and `src/main.js`'s own `DEV_PANEL_SAVE_SECRET` constant together
   if you'd rather generate your own.

Without both set, Save/Reset requests to `/api/save-settings` return a
clear `"Server not configured - missing: ..."` error rather than failing
silently. Optional env vars (`GITHUB_REPO`, `GITHUB_BRANCH`,
`SETTINGS_FILE_PATH`) override the defaults baked into
`api/save-settings.js` if ever needed — not required for normal use.

**Note:** this repo currently has no `vercel.json` — Vercel's zero-config
defaults already serve `index.html` at `/` and `api/*.js` as serverless
functions correctly with no config file needed, since (unlike HANDO) this
project's entry point already lives at the repo root.

## Known limitations

See `docs/PROJECT_SUMMARY.txt`'s Known Limitations section for the current,
maintained list — not duplicated here to avoid drift between two copies of
the same information.

## Roadmap

No formal roadmap is tracked separately. See `docs/PROJECT_PROGRESS.md` for
what's currently being worked on and what's next, and `docs/CHANGELOG.txt`
for the full history of what's been built.
