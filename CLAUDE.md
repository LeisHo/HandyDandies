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
`src/devpanel/devPanel.js` (generic dev-panel engine, reused near-verbatim
from HANDO — add controls via `main.js`'s own `DEV_GROUPS` first; only
extend devPanel.js itself for a genuinely generic, reusable control-level
capability that engine doesn't have yet, the same way HANDO added its own
'multi-select' type when IT needed ordered pose chaining. As of 2026-09-15
this copy has ONE real divergence from HANDO's: `multi-select` rows here
also support drag-to-reorder (a `.dp-ms-row-handle` icon + the same
`setupReorder()` list-picker rows/groups already use) — see the Tween
group's own CHANGELOG.txt entry for why, and diff against HANDO's copy
before assuming the 2 engines are still byte-identical). The rigged hand
asset lives at
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

**CORRECTED 2026-09-16 — Cursor Tracking is no longer part of this
"shared" list; left here as a cautionary record rather than silently
rewritten, per this file's own convention (see the dcHold correction
below).** Direct request ("for cursor tracking settings, let mobile and
desktop have different settings") reversed the original reasoning below
for that one group specifically: every Cursor Tracking control
(`trackingEnabled`, `trackingDamping`, `targetDepthFactor`,
`showTargetMarker`, `palmFacesCursor`, `palmFaceRotationOffset`) is now
`perDevice: true`. The original reasoning — the mechanic itself has no
touch-input equivalent — was true and is still true, but conflated "the
INTERACTION has no touch counterpart" with "its TUNING should be shared
across devices," which don't actually imply each other; a mouse-only
mechanic can still want a different damping/depth/rotation feel on a
small mobile viewport vs. a large desktop one, the same way this file
already drew that exact distinction for the camera's own pan/zoom below.

The remaining project-specific settings (Field Layout, Camera, Lighting,
Toon Shading, Outline, Background, Debug) are still shared across
Desktop/Mobile/Landscape — none are per-device yet. Note this is separate
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

**CORRECTED 2026-09-15 — the note that used to live here is now wrong,
left as a cautionary record rather than deleted outright.** Double Click
Hold Tween originally applied IDENTICALLY to every hand at once (no
per-hand stagger), a deliberate exception per direct request ("The tween
will apply to all hands simultaneously"), computed once per frame
(`dcHoldValues`) rather than per hand. That request was then directly
REVERSED the same day ("make the available settings of double click and
hold to match click hold... I want to also be able to select single
pose/ tween for double click hold," confirmed via 2 clarifying questions
before implementing): `dcHold` is now a literal 3rd entry in
`CLICK_HOLD_KEYS`, sharing chp/rchp's own per-hand
`startClickHoldPose()`/`updateClickHoldPoseForHand()`/`endClickHoldPose()`
machinery wholesale — genuine per-hand distance stagger, Single Pose/
Tween Mode, Loop Mode/Oscillate, all of it. The bespoke
`dcHoldTween`/`startDoubleClickHoldTween`/`endDoubleClickHoldTween`/
`updateDoubleClickHoldTween` functions this note used to point at are
retired and no longer exist. One narrow exception survived the rewrite:
Tween mode's own sequence still always starts from the default pose
specifically (not this hold's own live snapshot, unlike chp/rchp's own
Tween mode) — see `startClickHoldPose()`'s own `tweenAnchor` comment.
**Why this note is kept, not deleted:** it's the exact scenario the
GLOBAL `CLAUDE.md`'s own "don't silently execute a material architectural
change" guidance (§0a) exists for — a standing, explicitly-documented
design decision got reversed by direct request, and the reversal only
happened SAFELY because this note was here to surface it for
re-confirmation first rather than being silently copied over. See
CHANGELOG.txt's matching 2026-09-15 entry for the full account.

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
- **Pose-tuning constants shared with HANDO (`FINGER_SIGN`, `FINGER_MAX_DEG`,
  `FINGER_CURL_AXIS`, etc.) can silently drift out of sync.** HANDO
  changed `FINGER_SIGN.middle`/`.ring` from `-1` to `1` on 2026-09-14 (and
  migrated its own saved poses to match), but that change was never
  ported here, causing every real pose with nonzero curlMiddle/curlRing
  to curl those 2 fingers backward — confirmed live 2026-09-15, mistaken
  for a wrist-splay bug for a while since "Neutral"/"Neutral - Bent Back"
  (the poses used to verify the actual wrist-splay fix above) happen to
  be the only 2 saved poses with every curl value at 0, where a sign
  error is invisible. Before trusting any of this project's own finger-
  tuning constants, diff them against HANDO's current values (`grep -n
  "FINGER_SIGN\|FINGER_MAX_DEG\|FINGER_CURL_AXIS" src/main.js` in both
  projects) rather than assuming a one-time port stayed in sync — see
  CHANGELOG.txt's 2nd 2026-09-15 entry for the full account.
- **Any per-hand "current state" field seeded from a shared value at hand-
  creation time (e.g. `hand.currentBaseQuat: cloneBaseQuat.clone()` in
  `rebuildField()`) captures whatever that shared value IS AT THAT EXACT
  MOMENT — including a stale module-load-time default if cfg hasn't
  finished restoring yet when the field first builds.** A per-frame
  unconditional resync silently self-heals this within 1 frame; GATING
  that resync behind a condition that isn't unconditionally true on a
  hand's very first frame (e.g. `updateRenderOrder()`'s own
  `needsIdleRepose` performance gate, added 2026-09-15) can leave a hand
  frozen on the stale value indefinitely — confirmed live 2026-09-15: a
  real user's `hands[0].currentBaseQuat` read literal identity
  (`[0,0,0,1]`) on a fresh hard refresh, rendering every hand as its raw,
  un-posed GLB bind pose ("weird surface texture... rotation looks off"),
  while `cloneBaseQuat` itself already held the correct value — any click
  "fixed" it only as a lucky side effect (of `_wasOverriddenLastFrame` or
  the click's own independent repose), not a real fix. Any future
  performance gate added to a per-frame idle-state sync needs its own
  "has this ever actually run once for this instance" escape hatch (see
  `hand.everReposed`) — see CHANGELOG.txt's 7th 2026-09-15 entry for the
  full account.
- **This session's browser-automation tool (`mcp__Claude_Browser__*`) can
  misreport `document.hidden: true` / `window.innerWidth: 0` /
  `renderer.info.render.frame` stuck / `requestAnimationFrame` never
  firing to a page's OWN JS, even on a tab that was just explicitly
  fronted and is genuinely interactive** — confirmed live 2026-09-15 with
  an INDEPENDENT `requestAnimationFrame` probe (nothing to do with this
  app's own code) that also showed 0 increments over 2 real seconds,
  ruling out an app-level cause. `computer{action:"screenshot"}` still
  renders correctly in this same state and is what actually surfaced the
  real bug above — when investigating anything live-rendering-related,
  don't trust a JS-exec-based query (`window.innerWidth`, a manual rAF
  probe, `renderer.info`) as proof the page itself is broken; cross-check
  with a real screenshot, or bypass the render loop entirely by calling
  the relevant update function directly (e.g. `window.__debug.updateRenderOrder()`)
  and inspecting the resulting state.
- **A "skip this expensive block when nothing needs it" performance gate
  MUST preserve the original code's own mutual-exclusion invariants, not
  just its literal condition.** `updateRenderOrder()`'s idle-repose block
  used to be `if (!overridden) { ... }` -- when a 2026-09-15 performance
  fix rewrote this into `needsIdleRepose = cfg.wristSplayResponsiveEnabled
  || hand._wasOverriddenLastFrame`, it dropped `!overridden` entirely.
  `hand._wasOverriddenLastFrame` is true for every frame AFTER the first
  of any active trigger sequence, so the "only reachable when idle" gate
  became reachable DURING an active transition too -- running right after
  that frame's own `applyPoseValuesToHand()` call and immediately
  overwriting its result with `cfg`'s plain default values. Confirmed
  live: this stomped every Click-Pose/Click-Hold-Pose/Right-Click/Double-
  Click-Hold transition back to default every single frame, indistin-
  guishable from "clicking does nothing" at normal framerate -- a real
  production bug reported by the user directly, that survived 2 earlier
  rounds of investigation into a DIFFERENT real bug (the startup pose
  issue below) before being found. When rewriting a per-frame gate for
  performance, explicitly re-derive which ORIGINAL conditions it must
  still preserve, don't just wrap the new optimization's own condition in
  isolation — see CHANGELOG.txt's 8th 2026-09-15 entry for the full
  account.
- **A devPanel.js list-picker's own top-level group render order used to
  be inferred purely from array position (whichever group name is
  encountered FIRST while walking `entry.items` then `entry.pendingGroups`)
  -- fixing "put a new group at the top" by simply prepending to ONE of
  those 2 arrays only worked when EVERY group in play came from that same
  array.** Confirmed live 2026-09-15: with 2 pre-existing EMPTY groups (in
  `entry.pendingGroups`) already on screen, creating a 3rd group WITH
  items via the shift-click-multi-select-then-+Group auto-assign flow
  (which touches `entry.items`, a DIFFERENT array) still rendered at the
  BOTTOM, because `entry.pendingGroups` is unconditionally processed
  before/after `entry.items` regardless of which group was actually
  created most recently -- array position within one queue says nothing
  about recency relative to the OTHER queue. Fixed with an explicit
  `entry.groupOrder` priority list (prepended on every group creation,
  either kind, consulted as a final re-sort pass over BOTH queues'
  combined output) instead of relying on natural iteration order. When
  "newest X goes first" needs to hold across 2+ structurally different
  ways X can be created, a shared explicit order list beats trying to
  keep 2 separate arrays' own insertion order in sync.
- **This project's `devPanel.js` top-level group system is NOT built from
  `.claude/TEMPLATE_DEV_PANEL.html` and never fully matches its class
  names or DOM shape.** Confirmed 2026-09-17 while porting the template's
  own 2026-09-16/17 changes (header icon buttons, right-click-arm +
  shift-click fold-into-group, Ctrl+F search): this file uses
  `.dp-group`/`.dp-group-header`/`.dp-drag-handle`/`.dp-row`/`.dp-row-
  handle` (plain flexbox layout, handle centered via `align-items:
  center`, never absolutely positioned) where the template uses
  `.dev-section`/`.dev-section-title`/`.dev-group-drag-handle`/`.dev-
  row`/`.dev-row-drag-handle` (absolutely-positioned handle needing its
  own height-matching-formula fix, which this project never needed). It
  also has NO per-tab DOM duplication (one shared `groupsEl` for
  Desktop/Mobile/Landscape -- `switchTab()` only swaps displayed VALUES,
  never which rows/groups exist) and no built-in "Debug" group concept
  with its own anchor-ordering logic. Before porting a future template
  change here, re-verify class names and DOM shape rather than assuming
  a 1:1 port — 2 of the 4 changes reviewed this round turned out not to
  apply at all for exactly this reason. See CHANGELOG.txt's matching
  2026-09-17 entry for the full account of what was and wasn't ported.
- **`src/main.js` (441,597 bytes as of 2026-09-17) truncates at a fixed
  391,680-byte cutoff when served by a plain static server in this
  environment — and the connection resets, aborting the load.**
  Reproduced identically across 4 different static-server processes
  (different ports, `localhost` and an explicit `127.0.0.1` bind) AND
  via a plain `curl` request that never touches the browser-automation
  tool at all (`curl` exit 56, "failure receiving network data") — this
  rules out the browser tool itself as the cause; it's this sandbox's
  own network layer. Genuinely intermittent, not 100% reproducible: 1 of
  4 back-to-back `curl` retries against the exact same file succeeded
  with the correct full byte count. Only `main.js` hit this — `devPanel.js`/
  `style.css` (much smaller) never did. If a browser-preview load of
  this project silently never gets past "Loading hands…" with no JS
  error in the console (just `net::ERR_CONNECTION_RESET` on `main.js`
  itself in `read_network_requests`), this is almost certainly it, not
  a real code regression — retry the navigation a few times (or via
  `curl` first, to confirm cheaply before re-testing in the browser)
  rather than assuming the just-made change broke something. See
  CHANGELOG.txt's 2026-09-17 Delete/Undo/dynamicDevice entry for the
  full diagnostic trail (this is what blocked live-verifying that
  entry's own dynamicDevice work).
- **The "Independent from Desktop" mobile/landscape checkbox system
  (§12f-1) was deliberately NOT ported 1:1 from the template — it's a
  from-scratch redesign for this project's real architecture, confirmed
  with the user via AskUserQuestion before building (2026-09-17).** The
  template creates 3 SEPARATE DOM rows per device per control and wires
  cross-element mirroring between them; this project has exactly ONE row
  per control and 3 store slots already (`store.desktop`/`.mobile`/
  `.landscape`), so the mirroring instead lives inside `commit()`'s own
  new `ctrl.dynamicDevice` branch — no DOM-to-DOM syncing needed at all,
  and no separate "retained value while hidden" cache either (unlike the
  template's own `devDeviceValues` map), since a non-independent
  device's own store slot is already kept live-current by that same
  mirroring. **Corrected 2026-09-17, same day:** now fully live-verified
  (via an isolated standalone test harness, never committed, that
  imports the real devPanel.js with its own storage key — confirmed
  zero impact on any real project setting throughout). One real bug
  was found and fixed in the process — see the new gotcha directly
  below, and CHANGELOG.txt's matching entry, for the full verification
  trail before extending this feature further.
- **A UI-chrome refresh that only ever runs inside `if (saved) {...}`
  never runs at all for a brand-new visitor with nothing saved yet.**
  `resetSettings()`'s localStorage branch only called
  `applyStoredValues()` (the function that actually runs
  `refreshRowDisplaysForEditingTab()`) inside that conditional — every
  ORDINARY control type was unaffected since `buildRow()` already sets
  their initial DOM state directly from `ctrl.def` at construction
  time, but the 2 new dynamicDevice checkboxes (§12f-1, added earlier
  the same day) relied entirely on that later refresh call, which
  silently never ran on a fresh install. Confirmed live 2026-09-17 via
  an isolated-storage test harness (a real project's own already-saved
  localStorage masks this completely, which is exactly why the
  original same-day pass never caught it). Fixed with a plain `else`
  branch calling `refreshRowDisplaysForEditingTab()` when there's
  nothing saved yet. When adding new UI chrome whose correctness
  depends on a refresh function, verify it against a genuinely EMPTY
  storage state, not just the project's own already-populated one.
- **`devPanel.js`'s `isDevRowIndependent(tab, ctrl)` takes the CONTROL
  OBJECT as its 2nd argument, not a bare key string** (changed
  2026-09-17, same day it was added -- every one of its own 7 call
  sites was updated together). It needs `ctrl.perDevice` to compute its
  own default (an unset control defaults to independent when the
  control was already `perDevice: true`, mirrored otherwise) --
  extending or calling this function with just a key string will throw
  or silently misbehave. Retrofitting `dynamicDevice: true` onto a
  batch of existing controls (as opposed to authoring a brand-new one)
  should go through `main.js`'s own `withDynamicDevice(controls)`
  helper (wraps a `controls:` array, skips text/list-picker/multi-
  select/button types automatically) rather than hand-adding the flag
  per control -- see CHANGELOG.txt's 2026-09-17 "Click Function" entry
  for why it exists and its own isolated `node -e` unit check before
  trusting it against a new batch.
- **A list-picker item (Saved Camera/Lighting/Pose/etc.) that doesn't
  use EXACTLY the field names its own `captureCurrent()` function
  produces fails completely silently -- every mismatched field just
  falls through to its own hardcoded default, with no error, no
  console warning, nothing.** Confirmed live 2026-09-17: a Saved Camera
  authored/imported with a shorter `x`/`y`/`z`/`tx`/`ty`/`tz`/`fov`
  naming (a reasonable, natural-looking format) always snapped to the
  exact same default view on "Use," regardless of which preset was
  selected -- indistinguishable from "nothing happens" since NONE of
  `applyCameraPreset()`'s own expected keys (`cameraX`/`cameraY`/
  `cameraZ`/`cameraFov`/`targetX`/`targetY`/`targetZ`) existed on the
  item, so every single one fell back to its default simultaneously.
  Fixed for Camera specifically via `normalizeCameraPresetItem()` (an
  either-naming-accepted normalizer applied at all 3 real read sites --
  see CHANGELOG.txt's matching entry). Lighting's own preset shape
  already matched exactly, confirmed by direct comparison, so it needed
  no fix -- but the underlying risk is generic to EVERY list-picker
  control in this file (savedPoses, savedTweenSequences, etc.): before
  trusting a bug report that a saved/imported item's "Use" isn't
  working, diff the item's own field names against exactly what that
  control's `captureCurrent()` function produces, rather than assuming
  the bug is in the apply logic itself or the import/selection
  mechanism.
