# HANDY DANDIES — Project Conventions

A three.js scene rendering a field of rigged hand instances that each point
at the cursor. See `docs/PROJECT_SUMMARY.txt` for the fuller objective/scope,
`docs/CODE_SUMMARY.txt` for how the code is structured.

The dev panel follows the workspace-wide standard in the parent `CLAUDE.md`
§12 — this file only covers what's specific to this project, not a
restatement of §12 itself.

## File map

Multi-file structure (not a single-file exception): `index.html` (entry
point, import map) + `src/main.js` (all real logic) + `src/style.css` +
`src/devpanel/devPanel.js` (generic dev-panel engine, reused verbatim from
HANDO — do not fork it; add controls via `main.js`'s own `DEV_GROUPS`
instead). The rigged hand asset lives at
`data/processed/HAND3D/Hand2.glb`, copied from HANDO's own
`data/HAND3D/HAND-021/Hand2.glb`. `data/raw/`, `scripts/{active,archive}/`,
`logs/`, `results/`, `tests/` are empty standard-skeleton folders, not yet
used. See `docs/CODE_SUMMARY.txt` for the full architecture writeup.

## Untouchable systems

None formally designated yet.

## Dev-panel prompt shorthand (how the user specs dev controls)

Uses the workspace-standard `*DC*`/`*D*` notation (parent `CLAUDE.md` §12g).
A bare `*D*` with no group context goes into whichever existing collapsible
group fits best (per §12g); create a new group only if none fit.

## Dev-panel behavior (project-specific judgment calls under §12)

All project-specific settings (Field Layout, Cursor Tracking, Camera,
Lighting, Toon Shading, Outline, Background, Debug) are shared across
Desktop/Mobile/Landscape — none are per-device yet, since the CURSOR-
TRACKING mechanic itself has no touch-input equivalent (same convention
DOTFLICKO used for its own mouse-only interaction). Note this is separate
from the CAMERA's own pan/zoom, which DOES have full mobile touch support
via OrbitControls — that's just not exposed as dev-panel settings, it's
built into the interaction itself. Position/size sliders (spacing, camera
position, target depth) use plain world units or a "x Field Radius"
multiplier, not %vmin — this is a three.js world-space scene, not a 2D CSS
layout, so §12a's %/vmin-vs-px guidance doesn't directly apply. **Save
Settings now uses the git-tracked settings log (§12l upgrade), added
2026-09-15** — `api/save-settings.js` (a Vercel serverless function,
ported near-verbatim from HANDO's own) writes through to
`data/processed/dev-panel-settings.json`. Requires `GITHUB_TOKEN` and
`DEV_PANEL_SAVE_SECRET` set on this project's own Vercel project (see
README.md's own setup section for exact values/steps) — without both
set, Save/Reset surface a clear "Server not configured" error rather
than silently falling back to localStorage (this is `devPanel.js`'s own
documented single-tier design, not a bug).

Camera/lighting/target-plane framing is derived from the field's bounding
size exactly ONCE (the first hand build) and frozen after that — direct
request that Field Layout changes never affect camera view scale. Don't
reintroduce a live recompute of camera position from field size without
re-confirming that's actually wanted.

## Gotchas

- `three/addons/utils/SkeletonUtils.js` (three@0.169.0, pinned in
  `index.html`'s import map) exports `clone`/`retarget`/`retargetClip`
  directly — NOT a `SkeletonUtils` namespace object. `import {
  SkeletonUtils } from '...'` throws a SyntaxError at module-load time.
  Use `import { clone as cloneSkeletal } from
  'three/addons/utils/SkeletonUtils.js'`.
- `initDevPanel()` can fire a restored control's `onChange` synchronously
  before scene objects (`camera`, `keyLight`, etc.) exist yet in `main.js`
  — a TDZ crash. `main.js` detaches every control's `onChange` into a
  `Map` immediately before calling `initDevPanel()` and reattaches them
  right after; any new `DEV_GROUPS` control added later is automatically
  covered by this same block. See `docs/CODE_SUMMARY.txt`'s own GOTCHAS
  for the full detail and HANDO's precedent for this exact mitigation.
- A local static server / ES-module imports can serve a stale cached copy
  of `main.js` even after reloading — a hard reload of the page's own URL
  isn't always enough for a multi-file ES-module app. Bump a cache-busting
  query string on the top-level navigation (e.g. `index.html?t=2`) if a
  fix doesn't appear to take effect. Separately, this workspace's own
  `read_console_messages` browser tool can report a STALE, already-fixed
  console error as if it were still current — cross-check against a fresh
  screenshot/network request before trusting a lingering console error.
- `depthTest: false` on both hand materials (required to make cursor-
  distance render ordering actually visible — three.js's normal depth-
  tested compositing otherwise always lets real camera depth win over
  `renderOrder`) means a single hand's OWN internal self-occlusion now
  relies on front-face culling + triangle submission order, not a real
  depth test. `depthWrite` stays ON so the depth buffer still ends up
  populated (whichever hand visually won at each pixel). See
  `docs/CODE_SUMMARY.txt`'s own GOTCHAS for the full detail.
- `window.innerWidth`/`innerHeight` can read 0 at script-parse time in this
  dev environment, permanently zero-sizing the renderer/`EffectComposer`/
  `OutlinePass` unless self-healed every frame — `main.js`'s `animate()`
  compares `renderer.getSize()` against the current window size and
  re-applies the full resize on any mismatch. Separately (a DIFFERENT
  issue, not fixed by that self-heal): this session's own browser-
  automation tool reports `document.hidden`/`innerWidth === 0` whenever
  queried via its JS-execution path, even on a freshly-foregrounded tab,
  while a screenshot on the same tab at the same moment renders correctly
  — a characteristic of that tool, not a page bug. See
  `docs/CODE_SUMMARY.txt`'s own GOTCHAS for the full detail on both.
- A quaternion conjugation of the form `W * delta * W^-1` (used in
  `applyCurlToSkeleton()`'s curl-axis math) is ALWAYS identity when
  `delta` is exactly identity, regardless of `W` — silently discarding
  whatever `W` was meant to contribute. Any test methodology that only
  checks self-consistency across a range of `delta` values (e.g.
  comparing a finger's orientation relative to the wrist at 2 different
  wristSplay values) can pass at 0.0000° even when the formula is
  absolutely wrong, because a systematically-biased-but-self-consistent
  formula satisfies that kind of test too. Confirmed live 2026-09-15: the
  prior "corrected" formula passed every relative-to-wrist invariance
  test run against it this whole session, yet was still wrong — it just
  happened that every test case used a nonzero wristSplay, so the
  delta=identity degenerate case (e.g. the "Fist" pose, wristSplay=0)
  was never exercised until a real saved pose hit it in production. When
  verifying a conjugation-based fix, always test the degenerate case
  (delta=identity) explicitly, not just a range of nonzero deltas — see
  CHANGELOG.txt's 2026-09-15 entry for the full fix.
