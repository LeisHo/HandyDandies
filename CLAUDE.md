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

**CORRECTED 2026-09-25 — the rigged hand asset is now
`data/processed/HAND3D/HandipantsOL.glb`** (direct request to swap models).
Previous model `HandyOL.glb` and original `Hand2.glb` (copied from HANDO's own
`data/HAND3D/HAND-021/Hand2.glb`) are kept in place, unreferenced, per
this workspace's "nothing gets deleted by default" convention (parent
`CLAUDE.md` §11) — not a live fallback, just provenance. See this file's
own Gotchas for 2 real, load-bearing differences the earlier model
introduced (a 2nd skinned primitive `findSkinnedMesh()` had to be taught
to disambiguate, and a severe polycount jump that crashes the WebGL
context at this project's default field size).

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
- **Follow-up port, 2026-09-19: 3 of the template's own same-day changes
  (sticky header, header Save button, interleaved group/row order) were
  reviewed and adapted -- confirms the same "re-verify, don't 1:1 port"
  discipline above still holds.** The sticky-header fix turned out to be
  unnecessary here (this project's `.dp-header` is already a separate,
  non-scrolling flex sibling of `.dp-body`, unlike the template's own
  header, which lives INSIDE its scrollable container). The interleaved-
  order fix required real adaptation, not a copy-paste: this project's
  `captureGroup()`/`applyOrder()` use `settings`/`subgroups` field names
  (not the template's `rowKeys`/`subgroups`), and its `setupReorder()` is
  a single generic engine shared by 5 different call sites (multi-select
  rows, list-picker groups/rows, panel groups/rows) — the new
  `siblingSelector` param had to be opt-in (only the panel's own 2 calls
  pass it) so the other 3, same-type-only contexts stayed unaffected. A
  real bug was caught and fixed in this port before it shipped:
  `` `:scope > ${siblingSelector}` `` on a comma-separated selector
  (`'.dp-group, .dp-row'`) only scopes the FIRST comma-branch — the 2nd
  becomes an unscoped `.dp-row` matching the whole document, not just
  the drag target's own container. `:scope > ` has to be distributed
  across each comma-separated piece individually
  (`siblingSelector.split(',').map(s => ':scope > ' + s.trim()).join(', ')`).
  See CHANGELOG.txt's matching 2026-09-19 entry for the full account,
  including live verification of the fix.
- **2nd follow-up port, 2026-09-20: the template's own Add-Group
  common-ancestor-nesting change.** When "+ Add Group" is used with an
  active selection, the new group now nests inside the selection's own
  deepest common containing group instead of always landing at the top
  level. Same "re-verify, don't 1:1 port" discipline as the 2026-09-19
  entry above — ported `devSelectionAncestorGroupChain()`/
  `findDevSelectionCommonAncestorGroup()` with this project's own
  `.dp-group`/`.dp-group-body` class names substituted for the
  template's `.dev-section`/`.dev-section-content`. The no-selection
  fallback (this project's own bottom-of-list placement, already a
  pre-existing divergence from the template's own top-of-list
  convention) was deliberately left untouched. See CHANGELOG.txt's
  matching 2026-09-20 (3rd follow-up round) entry for full detail and
  live verification.
- **Renaming a devPanel.js group is PURELY COSMETIC — it never changes
  the group's own internal identity, which is exactly what caused a
  real data-loss incident 2026-09-19.** `openTextEditFor()` (the rename
  handler) only ever writes `textOverrides[key]` (a display-only
  override) and the visible title text; it NEVER touches
  `g.dataset.key`, which is set ONCE, at creation
  (`createGroupElement()`), and used as the group's real identity by
  `captureGroup()`/`applyOrder()` everywhere else. Any 2+ groups
  created via generic "+ Add Group" and left un-renamed at that exact
  moment all start with the literal key "New Group" — renaming them
  to different DISPLAY names afterward does nothing to separate their
  real identities, so they keep sharing ONE `textOverrides["New
  Group"]` slot (whichever rename happened most recently wins for ALL
  of them) and, before today's earlier `usedGroupEls` restore fix
  existed, would also merge their actual CONTENT together on reload.
  Confirmed as the real mechanism behind "I only see 1 called Loading
  Preview Lighting, and all my settings are within that one group" —
  3 renamed Loading Preview subgroups (Camera/Lighting/Pose) plus
  Pose's own "Thumb" subgroup all still carried key "New Group"
  underneath their custom names. Today's `addCustomGroup()` fix (whole-
  panel de-dup check, same day) prevents a NEW collision like this from
  being created going forward, but does nothing to un-collide groups
  that already collided before that fix existed — those need a real
  data repair (see CHANGELOG.txt's matching entry for exactly how this
  one was done: re-deriving the split from known settings-key lists,
  asserted against the actual merged data before writing). If a report
  ever again describes multiple distinctly-organized groups all
  showing the same name, or a group's settings looking mixed with an
  unrelated group's, check `dataset.key` collisions first — the
  DISPLAYED name is never proof of a group's real identity in this
  file.
- **A browser tab that's been open since before a devPanel.js/main.js
  fix was deployed is still running the OLD code in memory — closing
  the gap on GitHub/Vercel does not hot-reload an already-open tab.**
  Confirmed live 2026-09-19: after committing the group-merge restore
  fix (`58bec38`) and starting to verify a hand-written data repair for
  it, a NEW commit appeared on `origin/main` mid-verification — a real,
  live Save from the user's own browser tab, which had not reloaded
  since before the fix shipped. That stale tab's still-buggy in-memory
  `captureGroup()` re-merged the just-repaired groups right back
  together and overwrote the repair before it was even confirmed live.
  Caught only by re-fetching `origin/main` before finishing and noticing
  commits that weren't there minutes earlier. When a fix depends on the
  USER's own browser picking up new code (any devPanel.js/main.js
  change, not just this one), say so explicitly and tell them to hard-
  refresh BEFORE they next hit Save/Sync — don't assume a push alone is
  enough, and re-check `origin/main` immediately before finishing any
  session that hand-edits `data/processed/dev-panel-settings.json`, in
  case a concurrent live save landed while working.
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
- **The main `animate()` render loop's `if (!fieldStarted &&
  loadingPreviewRenderer)` gate is a deliberate ONE-TIME-PER-SESSION
  optimization, not a bug** -- it permanently stops calling
  `updateLoadingPreviewAnimation()`/rendering the Loading Preview the
  instant the real hand field starts (`fieldStarted = true`), and never
  resumes for the rest of that page load even if something re-enables
  the preview later. Any future feature that needs the preview to
  animate again AFTER that point (e.g. `loadingPreviewShowLive`, added
  2026-09-17) needs its OWN separate `requestAnimationFrame` loop
  (`startLoadingPreviewLiveLoop()`) rather than trying to make the main
  loop resume driving it -- don't "fix" the main loop's gate to solve
  this; it's working as designed.
- **A DOM element's visibility can be silently inherited from a parent's
  own lifecycle, even when nothing in that element's own code touches
  `display`.** `#loadingPreviewCanvas` originally lived INSIDE `#loading`
  in `index.html`, so it was hidden the instant `tryStartField()` called
  `loadingEl.classList.add('hidden')` on the real field start --
  regardless of the preview's own `loadingPreviewEnabled`/
  `loadingPreviewShowLive` flags. Fixed by moving the canvas to a
  top-level sibling immediately before `#loading` rather than a child of
  it. When a feature's visibility needs to outlive or diverge from a
  container it currently sits inside, check the container's own
  hide/show lifecycle before assuming the element's own flag is the only
  thing controlling it.
- **This project bumps `main.js?v=NNN` religiously but had never once
  bumped `style.css?v=NN` -- it stayed at `?v=12` through 2 real content
  changes this session before the gap was caught.** The static server
  serving this project always returns current disk content regardless
  of query string, but the BROWSER's own HTTP cache does not -- a tab
  that already fetched `style.css?v=12` once keeps reusing that stale
  cached response across reloads/navigations, silently masking a real
  CSS fix (confirmed live 2026-09-17: a z-index fix appeared not to be
  applied at all, `getComputedStyle().zIndex` reading `auto`, purely
  because the browser was still serving its OLD cached copy of
  `style.css?v=12` -- bumping to `?v=13` immediately fixed it). Bump
  `style.css`'s own `?v=` in `index.html` any time its actual content
  changes, the same discipline already applied to `main.js`.
- **This session's browser-automation tool can misreport
  `document.documentElement.clientWidth`/`clientHeight` as `0`, and a
  `position:fixed` element's own computed `top`/`left` as `0px`, via
  its JS-exec query path, even on a freshly-loaded, visibly-rendering
  page.** Confirmed live 2026-09-17 while debugging the Loading Preview
  z-index fix above: a brand-new, freshly-appended test `<div>` with
  plain `position:fixed;top:50%;left:50%` ALSO computed `top:0px` in
  the exact same page context, ruling out anything specific to
  `#loadingPreviewCanvas` -- yet a real screenshot taken moments later
  showed the actual preview hand correctly centered on screen. This is
  the same general class of tool quirk already documented elsewhere in
  this file (`document.hidden`/`window.innerWidth === 0` misreported the
  same way) extended to a 3rd concrete symptom (`clientWidth`/`clientHeight`
  /computed `top`/`left`) -- don't trust a JS-exec-based layout/dimension
  query as proof of a real positioning bug; cross-check with an actual
  screenshot before concluding the page itself is broken.
- **HANDO's saved camera/lighting presets are in a DIFFERENT coordinate
  frame than this project's own -- never paste one in raw.** HANDY
  DANDIES rotates every hand clone by `alignQuat` (measured once from
  this model's own bind pose, aligning wrist->fingertip to world -Z --
  see `alignQuat`'s own declaration comment); HANDO has no equivalent
  correction (its own `modelRoot` sits at the raw GLTF orientation plus
  its own separate, independently-tuned Whole-Hand Rotation sliders).
  Confirmed live 2026-09-19: applying HANDO's own "Left" camera preset
  (identical numeric values in both projects' own saved-camera lists)
  made the Loading Preview hand disappear entirely -- the camera was
  aimed at empty space, not a rendering bug. Lighting has a SECOND,
  independent mismatch on top of the rotation: HANDO's own
  `updateKeyLightPosition()` and this project's own assign X/Z to
  sin(azimuth)/cos(azimuth) OPPOSITELY (confirmed by direct source
  comparison), so a HANDO azimuth/elevation pair means a different
  actual direction here even before any rotation is applied. Use
  `convertHandoCameraPreset()`/`convertHandoLightingPreset()` (main.js)
  for any HANDO-sourced camera/lighting data -- wired automatically via
  `loadingPreviewSavedCameras`/`loadingPreviewSavedLighting`'s own
  `importTransform` hook when pasted through those 2 list-pickers'
  Import button, but do the conversion by hand (call the same 2
  functions) before using HANDO data anywhere else. Validated via a
  standalone, never-committed Node script that measures this GLB's own
  bind-pose bones directly (outside the running app) before any UI was
  built around the fix -- see CHANGELOG.txt's matching 2026-09-19 entry
  for the full derivation, including the wrist-to-fingertip-midline
  distance check that confirmed the transform.
- **This project's own `main.js`/`devpanel/devPanel.js` are large enough
  now (main.js ~500KB as of 2026-09-19) that BOTH files -- not just
  main.js -- hit this sandbox's own documented network-truncation
  gotcha on a plain static server.** Confirmed live: `devpanel/devPanel.js`
  (165KB) failed with `net::ERR_CONNECTION_RESET` 3 times in a row on
  one port before succeeding, the same failure pattern previously only
  ever seen on `main.js`. Same standing practice applies to both files
  now: retry the navigation a few times (or cross-check via `curl`
  first), don't assume a just-made change broke something just because
  either file fails to load this way. **Extended 2026-09-22: the SAME
  truncation hits the `Hand2.glb` model asset too, not just JS files.**
  Confirmed live -- `net::ERR_CONNECTION_RESET` on
  `data/processed/HAND3D/Hand2.glb` itself, resolved on a 2nd
  navigation. Nothing about this gotcha is actually JS-file-specific --
  it's this sandbox's own static-server/network layer, so ANY
  sufficiently large asset this project serves (GLB, JS, or otherwise)
  can hit it; retry the navigation the same way regardless of which
  file failed.
- **A `select` control whose `options()` reads a list-picker's own array
  needs TWO SEPARATE, easy-to-forget wiring points -- missing either one
  looks identical from the outside ("changing it does nothing").**
  (1) The list-picker itself needs its own `onChange` calling
  `safeRefreshSelectOptions('theSelectKey')`, or the `<select>`'s own
  `<option>` list never picks up a newly Saved/Imported/Deleted/Renamed
  item -- `savedPoses` has had this since early in the project (see its
  own DEV_GROUPS comment); `loadingPreviewSavedCameras`/
  `loadingPreviewSavedLighting` were missing it when first built
  (2026-09-19), confirmed live via direct report ("those options arent
  immediatly available in the drop downs"). (2) The `select` control
  ITSELF needs its own `onChange` to actually DO something with the
  newly-picked value -- `loadingPreviewCameraSelector`/
  `loadingPreviewLightingSelector` had NEITHER of these 2 things
  initially: `buildLoadingPreview()` only ever reads these selectors
  ONCE, at build time, so picking a different item from the dropdown
  updated `cfg` but never re-applied anything to the already-built
  preview -- confirmed live via direct report ("I change them and
  nothing actually changes in the preview"), and this alone plausibly
  explained an earlier, separate "wrong angle"/"180 flip" report too
  (whatever was on screen may have been stale, unrelated to whichever
  camera was actually selected at the time it was observed). When
  adding a NEW select-driven-by-a-list-picker pair, wire both directly
  by analogy to an existing working pair (`savedPoses` for #1,
  `loadingPreviewCameraSelector` itself for #2 as of this fix) rather
  than assuming either comes for free from the control types alone.
- **HANDO's own "Left" and "Right" saved cameras (`data/processed/
  dev-panel-settings.json`, BASE group) have IDENTICAL x/y/z/tx/ty/tz/
  fov coordinates in HANDO's OWN settings file -- confirmed by direct
  inspection 2026-09-19.** Not a HANDY DANDIES bug, and not something
  `convertHandoCameraPreset()` can fix -- grepped HANDO's own source for
  a model-mirroring mechanism (`scale.x=-1`/mirror/handSide concepts)
  tied to these names and found none relevant, so there's no missing
  transform step to reconstruct a Left/Right distinction that doesn't
  exist in the source data at all. If "Left" and "Right" still look
  identical after importing/converting both into
  `loadingPreviewSavedCameras`, this is almost certainly why -- check
  HANDO's own data first before assuming the conversion math is at
  fault.
- **A camera positioned at `radius * 2.4` from a hand's own bounding-
  sphere center does NOT reliably fit the whole hand inside a 35 deg-FOV
  camera -- it needs `radius * 3.326` minimum.** For a sphere of radius
  R to fully fit inside a camera's FOV at distance D: `D >= R /
  sin(FOV/2)`. At 35 deg FOV (half-FOV 17.5 deg), that's `D >=
  R*3.326`. Confirmed by direct calculation 2026-09-19 (R=22.97,
  measured earlier the same session): the OLD `R*2.4` distance made the
  hand's own bounding sphere subtend a 24.6 deg half-angle from the
  camera -- well past the 17.5 deg half-FOV, guaranteed to clip the
  outer edges (fingertips/forearm) regardless of any other framing
  detail. Both `applyLoadingPreviewCameraAutoFrame()` (Loading Preview)
  and `defaultPosePreviewCamera()` (Pose Preview) had this IDENTICAL
  formula/bug -- fixed together to `R*3.6` (~8% margin over the exact
  minimum). If a future single-hand auto-frame camera anywhere in this
  file looks cropped, check its own distance multiplier against this
  formula before assuming the bug is somewhere else (lighting, material,
  clipping planes, etc. were all considered and ruled out first this
  round).
- **`pointer-events: none` on an element silently defeats ANY
  OrbitControls (or other mouse-driven) interaction bound to it, even
  with `.enabled = true` on the controls object itself -- the DOM
  element never receives the mouse events at all, so there's nothing
  for OrbitControls to even ignore-or-not.** `#loadingPreviewCanvas` is
  `pointer-events: none` in style.css by design (so the always-on-top,
  z-index:100000 preview never steals clicks meant for the real page
  underneath it -- see that rule's own 2026-09-17 comment). Adding
  interactive Camera Edit Mode (2026-09-19) required its own onChange to
  ALSO flip `loadingPreviewCanvas.style.pointerEvents` between
  `'auto'`/`'none'` live, not just toggle `OrbitControls.enabled` --
  caught before shipping, not from a live bug report, by re-reading the
  existing CSS rule while building this feature. Any FUTURE interactive
  (click/drag/scroll) feature added to this specific canvas needs the
  same 2-part toggle, not just one or the other.
- **This session's `window.__debug.cfg` (and any other property read
  off `window.__debug`) can report STALE values for several real
  seconds after a genuine, already-rendered state change, via this
  sandbox's own JS-exec query path -- a 4th concrete symptom of the
  same tool quirk already documented elsewhere in this file
  (`document.hidden`/`window.innerWidth===0`/`clientWidth===0`/
  computed `top`/`left`===0).** Confirmed live 2026-09-19: after a real
  orbit-drag that visibly moved the Loading Preview's camera (confirmed
  via `loadingPreviewCamera.position` reading a genuinely different
  value AND a fresh screenshot showing a different hand angle),
  `window.__debug.cfg.loadingPreviewRotationY` kept reading `0` for 6+
  seconds across repeated JS-exec queries -- while the SLIDER's own
  actual DOM value (`row.querySelector('input[type=range]').value`)
  already correctly showed `23` the whole time. Don't trust a
  `window.__debug.cfg.*` read (or bare rAF/lapIndex-style counters
  exposed there) as proof a live-sync mechanism is broken; cross-check
  against the real DOM (an input's own `.value`) or a screenshot before
  concluding the underlying code is at fault.
- **`requestAnimationFrame` genuinely does not tick (not just a
  misreported flag -- 0 real ticks measured) on a mobile-viewport-
  emulated tab in this sandbox, even when explicitly fronted right
  before the check.** Confirmed live 2026-09-19 while investigating "the
  Loading Preview doesn't work on Mobile": a direct `requestAnimationFrame`
  counter probe (5 chained calls, checked after a real 300ms wait) came
  back at 0 ticks, on the SAME tab, at the SAME moment `document.hidden`
  also read `true` despite `tabs_select` having just fronted it -- this
  is a 5th concrete symptom of the same general tool-quirk family
  already documented elsewhere in this file, but this one is worse than
  the others: since the app's own `animate()` render loop runs off rAF,
  a genuine rAF stall means NOTHING renders for real, not just a stale
  debug READ -- so a "the canvas buffer is 100% empty" finding gathered
  under these conditions (e.g. via `gl.readPixels()`) is NOT trustworthy
  evidence of a real device bug; it may just be this sandbox's own rAF
  suspension. This specifically undermined an attempt to verify whether
  the Loading Preview genuinely fails to render on mobile -- a real,
  independently-justified bug (missing `setPixelRatio()`, see
  CHANGELOG.txt's matching entry) was found and fixed, but whether that
  was the COMPLETE explanation could not be confirmed this way. When a
  mobile-viewport test needs proof that real frames are being drawn
  (not just that a canvas/renderer object exists), don't rely on a
  buffer read alone if `document.hidden` reads true or rAF ticks measure
  0 in the same session -- that result is inconclusive, not negative.
- **Any `camera.lookAt(target)` call on the Loading Preview's own camera
  MUST set `camera.up` to `new THREE.Vector3(0,1,0).applyQuaternion(alignQuat)`
  first -- three.js's own default world `(0,1,0)` is WRONG here and was
  the real root cause of "the camera doesn't match HANDO... i need to
  set it to -90 for x y z rotation to make it match."** Confirmed live
  2026-09-20: `alignQuat` applied to world-up lands ~90.8 deg away from
  plain world-up. `lookAt()` resolves the camera's final orientation
  (including roll) from whatever `camera.up` currently is at call time
  -- since EVERY position/target in this preview lives in the
  `alignQuat`-rotated frame, `camera.up` needs the same rotation to stay
  consistent, and nothing does this automatically. This bit 3 separate
  functions (`applyLoadingPreviewCameraPreset()`, `applyLoadingPreviewCameraAutoFrame()`,
  `applyLoadingPreviewRoll()`), not just the HANDO-conversion path --
  the auto-frame default only "looked okay" because its own camera
  offset happens to sit nearly along the hand's own pointing axis, where
  a wrong roll is least visually obvious; a saved preset viewed from a
  more oblique angle showed it clearly. If a FUTURE function ever
  repositions this camera via `lookAt()` (a new preset type, a new
  auto-frame variant, etc.), it needs this same `camera.up` line or it
  will reintroduce the exact same ~90 deg-ish twist. Lighting has NO
  equivalent gap -- a directional light has no "roll" degree of freedom
  to get wrong, confirmed by re-deriving `applyLoadingPreviewLighting()`/
  `captureLoadingPreviewLightingPreset()`'s own round-trip math (proper
  inverses of each other, `alignQuat` already correctly baked in at
  HANDO-conversion time via `convertHandoLightingPreset()`). See
  CHANGELOG.txt's matching 2026-09-20 entry for the full derivation and
  live verification (a screenshot confirming a properly upright,
  recognizable fist instead of a twisted shape).
- **Deleting a dev-panel group via the 🗑 Delete button only removes its
  UI -- it does NOT automatically disable whatever functionality that
  group controlled, unless a host `onGroupDeleted` cleanup explicitly
  handles that specific group.** `cleanupDeletedCustomClickFunction()`
  only recognizes a group created by `registerCustomClickFunction()`
  (marked via `dataset.customFunctionFamily`); it was always a
  documented no-op for "a plain user-created group... or one of the 10
  static [Click Function] triggers." Confirmed live as a real bug
  2026-09-20 (direct report: "i have deleted all previous click
  functions, but when i click or click and hold etc, the previously
  saved functions are sitll being triggered") -- deleting one of the 10
  hardcoded Click Function groups (Click Hold-Pose, Right-Click
  Hold-Pose, Click/Double/Triple/Quadruple-Click Pose, Right Click,
  Double/Triple/Quadruple-Click Hold) left `cfg`'s own `<p>Enabled` flag
  and any in-flight per-hand trigger state completely untouched, so the
  trigger kept firing the last-configured pose with no UI left to turn
  it off. Fixed via `disableDeletedStaticClickTrigger()` (main.js),
  which maps the deleted group's own `dataset.key` (= its literal
  `title`, per devPanel.js's `createGroupElement()`) to its key-prefix
  and sets `cfg[\`${p}Enabled\`] = false` directly -- the same gate the
  trigger's own start function checks. Also: `findDevDeleteProtectionReason()`
  (devPanel.js) only protects the mandatory "Dev Panel" group by name --
  nothing stops any OTHER group, static or custom, from being deleted.
  Before assuming a devPanel.js group's deletion is functionally
  complete, check whether `onGroupDeleted`/an equivalent host hook
  actually covers that specific group's own underlying state, not just
  its DOM. See CHANGELOG.txt's matching 2026-09-20 entry for the full
  investigation (including why Custom Click Functions themselves were
  ruled out first, via the real saved `customClickFunctionIds: []`).
  **Scope note, not yet closed:** these 10 groups are hardcoded
  DEV_GROUPS entries, unlike real Custom Click Functions -- the deleted
  group's UI reappears on the next page reload regardless, so this fix
  only stops the trigger from firing for the rest of the CURRENT
  session, not a permanent removal. **Live-verified 2026-09-20** via
  `window.__debug`: deleted the real "Click Pose" group through the dev
  panel's own Delete Group/Setting flow -- `cfg.clickEnabled` flipped
  true->false, the group's row genuinely vanished from the panel (a
  sibling group, `chpEnabled`, stayed `true`, confirming correct
  scoping), `hand._cp['click']` was cleared on every hand, and a real
  click on the canvas afterward left EVERY hand's `_cp['click']` state
  empty (0 of 255 hands) -- the pose no longer fires, matching the
  reported bug's exact repro.
- **A curve widget's bezier handles (`buildGenericCurveWidget()`'s own
  `startHandleDrag()`) are Alt+drag (Out Handle) / Shift+drag (In
  Handle) on a curve point -- and are 100% invisible in the UI until one
  is actually created, by deliberate design (every pre-existing saved
  curve with no handles must render identically to before).** Confirmed
  live 2026-09-20 this was NEVER broken (direct bug report: "i currently
  dont see bezier handles for the curve graphs i thought we implemented
  that") -- a synthetic Alt+drag `PointerEvent` dispatched on a real
  curve point correctly created a handle marker and persisted a real
  `h1` value. The actual gap was that the gesture was documented ONLY in
  a source comment, never in any on-screen caption across any of the 8
  call sites that share this widget -- indistinguishable from "not
  implemented" to an actual user. Fixed by adding a 2nd caption line
  once inside `buildGenericCurveWidget()` itself spelling out the
  gesture (not per call site -- so it can't drift out of sync the way
  duplicated logic has bitten this project before, e.g. the
  `FINGER_SIGN`/HANDO-drift gotcha above). **If a future report says a
  documented-in-code-only interaction "isn't there," check whether it's
  actually working but just never surfaced anywhere the user can see --
  the same class of gap, not necessarily a regression.** See
  CHANGELOG.txt's matching 2026-09-20 entry for the full investigation,
  including the exact synthetic-event technique used to test a
  pointerdown-gated modifier-key gesture (a plain `.click()` would NOT
  have exercised this path -- same testing rule as the Undo-button
  gotcha in the parent workspace `.claude/TEMPLATE_DEV_PANEL.html`
  history, generalized here). This project's project-specific Arm
  Length/Wrist Splay curve widgets (`buildArmLengthCurveWidget()`/
  `buildWristSplayCurveWidget()`) are deliberately SEPARATE code and do
  NOT have bezier handles at all (per their own comments) -- this fix
  does not apply to them; if a report is ever about THOSE specific
  widgets instead, that's a real "not implemented," not a
  discoverability gap.
- **Nesting a dynamically-created (`renderDynamicGroup()`) group INSIDE
  another group's own `.dp-group-body` puts it under devPanel.js's
  generic `captureGroup()`/`applyOrder()` order-persistence system --
  which runs BEFORE any host file's own `onRestore` hook (see
  `initDevPanel()`'s own call order). If the dynamic group doesn't exist
  in the DOM yet at that point (true of every custom click function's
  own group, which `restoreCustomClickFunctions()` only rebuilds INSIDE
  `onRestore`), `applyOrder()` has no way to know that and creates an
  empty GHOST placeholder for whatever key it doesn't find live --
  producing a genuine duplicate-keyed pair once the real group renders
  moments later (same class of bug as this file's own "renaming a
  devPanel.js group is purely cosmetic" gotcha, different cause).**
  Caught by reading the restore-order code before shipping a 2026-09-20
  fix that nested custom click function groups inside "Custom Click
  Functions" (direct report: "the created function settings group
  should be within the Custom Click Functions group, not outside"), not
  by a live bug report -- guarded by having `restoreCustomClickFunctions()`
  clear any pre-existing nested groups under that anchor before
  rebuilding fresh from `customClickFunctionIds` itself (the true source
  of truth for which functions actually exist). **Any FUTURE feature
  that nests a `renderDynamicGroup()`-created group inside a static
  DEV_GROUPS group needs this same pre-clear in its own restore path --
  the risk isn't specific to Custom Click Functions, it's inherent to
  nesting a dynamically-rebuilt-on-load group into the generically-
  captured tree at all.** See CHANGELOG.txt's matching 2026-09-20 entry
  for the full account, including the separate (already-working, just
  under-discovered) Type-dropdown fix shipped the same round.
- **All 10 hardcoded static click-trigger groups (Click Hold-Pose,
  Right-Click Hold-Pose, Click Pose, Double-Click Pose, Triple-Click
  Pose, Quadruple-Click Pose, Right Click, Double Click Hold, Triple-
  Click Hold, Quadruple-Click Hold) were DELETED 2026-09-20**, direct
  request ("delete those static declarations... I dont mind having no
  click triggers currently" -- intent: replace them with custom click
  functions instead). `CLICK_HOLD_KEYS`/`CLICK_POSE_KEYS` are now empty
  arrays -- custom functions still register into them fine at creation
  time via `registerCustomClickFunction()`, completely independent of
  this. **A real crash risk was found and fixed in the same round**:
  several mouse event handlers (`pointerdown`/`pointerup` on `window`)
  read `clickHoldPoseTriggers.chp.active`/`.rchp.active` DIRECTLY,
  bypassing the `cfg[\`${p}Enabled\`]` guard every OTHER access path in
  this file has before touching trigger state -- with the arrays
  emptied, these specific properties would have been `undefined`,
  throwing on the very next real mouse click. Fixed with
  `LEGACY_REMOVED_HOLD_KEYS`/`LEGACY_REMOVED_POSE_KEYS` (the same 10
  prefixes, kept deliberately SEPARATE from `CLICK_HOLD_KEYS`/
  `CLICK_POSE_KEYS`) seeding inert placeholder trigger-state objects in
  `clickHoldPoseTriggers`/`clickPoseTriggers` for these prefixes only --
  legacy hardcoded access now finds a real, permanently-inactive object
  instead of `undefined`, while the actual registration arrays staying
  empty means no panel UI/generic per-key wiring happens for any of
  them. **If a future session ever needs to ALSO remove a custom
  function's own key** (or otherwise shrinks `CLICK_HOLD_KEYS`/
  `CLICK_POSE_KEYS` further), grep for `clickHoldPoseTriggers\.` /
  `clickPoseTriggers\.` DOT-notation access (not bracket/variable
  access) first -- that's specifically the pattern that bypasses the
  `Enabled` guard and can throw; a handful of comments/dead
  `safeRefreshSelectOptions('chpMode')`-style one-time calls referencing
  the 10 removed prefixes were deliberately left in place (harmless,
  try/catch-safe per that function's own design) rather than hunted down
  individually. **Not yet live-verified** -- this sandbox's own
  main.js network-truncation issue blocked a clean page load across 5
  retries even after the file shrank from this deletion; confidence
  rests on `node --check` plus direct source-tracing of every hardcoded
  reference to the 10 prefixes, not live interaction. See CHANGELOG.txt's
  matching 2026-09-20 (14th round) entry for the full account.
- **A custom click function with `Enabled: true` and a correct Type/
  ClickCount still fires nothing if its own `TargetPose` (Single Pose
  mode) or `TweenSelector` (Sequence mode) is left blank** -- the whole
  trigger/dispatch chain (`triggerCustomPoseFunctions()` ->
  `triggerClickPose()` -> the deferred-claim consumer in
  `updateRenderOrder()`'s `CLICK_POSE_KEYS.forEach`) runs correctly end
  to end with nothing to actually resolve into a pose, which is
  indistinguishable from "clicking does nothing" to the user. Confirmed
  2026-09-21 directly against real saved data (`data/processed/
  dev-panel-settings.json`): all 3 of a real user's custom functions had
  this gap -- 2 Single-Pose-mode functions with `TargetPose: ""`, and
  1 Sequence-mode function with `TweenSelector: ""` (it DID have a
  `TargetPose` value set, but that field is Single-Pose-only and
  unused in Sequence mode -- almost certainly set before the Mode was
  switched, then never filled in on the Sequence dropdown afterward).
  Before assuming a "click function doesn't trigger" report is a code
  bug, check the actual saved `${id}TargetPose`/`${id}TweenSelector`
  values for that exact function first -- it's a much more common and
  much cheaper explanation than a dispatch-chain regression, and this
  round's trace confirmed the dispatch chain itself has no issue.
- **`composer.render()` (the real GPU draw call for every hand mesh)
  ran completely unthrottled every `requestAnimationFrame` tick
  regardless of Global Pause -- only `updateRenderOrder()` (the per-hand
  pose/tween state machine) was ever gated by `isPaused`.** With a large
  field this is the dominant per-frame cost (confirmed via this file's
  own existing `[frame-profile]` console log: avgComposerRender scales
  directly with hand count, ~12ms at 240 hands vs. ~4-5ms at 48), and
  since JS is single-threaded, that cost directly competes with dev-
  panel input handling for main-thread time -- explains a real
  2026-09-21 report ("even when i have the animation/3js poses paused,
  it is still very slow when i try to use the dev panel... its much
  faster when i zoom in (showing less hands)"). Fixed by throttling
  (not skipping) `composer.render()` while paused, to a new
  `cfg.pausedRenderFps` slider ("Paused Render Rate (Fps)", Pause
  Button group, default 15) -- `setPaused()` resets the throttle's own
  timestamp on every toggle so there's no lag on the pause/resume
  transition itself. Live-verified via the same frame-profile log:
  paused, `avgUpdateRenderOrder` dropped to 0.00ms and real renders
  landed at exactly `fps=15.0`/14.9/14.0; unpaused, ramped back to
  68.3fps with `avgUpdateRenderOrder` non-zero again. If a future
  feature adds another expensive per-frame call to `animate()`, check
  whether it's actually gated by `isPaused` (or by this same throttle)
  before assuming Global Pause covers it -- the render call itself is
  the one thing in that function that visibly must keep running
  regardless of pause (so the frozen scene stays visible at all), which
  is exactly why it was never gated in the first place and needed a
  throttle instead of a skip.
- **CORRECTED 2026-09-27 -- exactly the "future feature" scenario the
  entry above's own closing advice warned about, just found on a
  PRE-EXISTING function instead of a new one.** Direct report: "when i
  ause the hands, how come the ui is still slow. its no longer
  animting." `syncCameraPanelFromLive()` (5 `syncValue()` calls, every
  `animate()` tick, unconditional -- deliberately not gated by
  `isPaused`, since camera panel-sync is meant to stay live while
  paused) was never touched by the 2026-09-21 fix above, because
  `composer.render()` was the dominant cost at the time. Each
  `syncValue()` runs devPanel.js's `findCtrl()`, a LINEAR SCAN over
  every registered control across every group (confirmed by reading its
  source) -- with this project's real control count (every custom click
  function's own ~30-control battery, Multi Trigger adding more
  per trigger, every Rendering Style), 5 scans + 5 real DOM writes 60
  times a second, regardless of whether the camera moved, is a genuine
  per-frame cost competing with dev-panel input handling. Fixed with a
  cheap "did this value change" cache (`__lastSyncedCameraX/Y/Z/Fov/
  Zoom`), mirroring the exact guard pattern `armLengthWidgetResyncs`'
  own 6 registered callbacks already use elsewhere in this file (all 6
  confirmed to already have it before assuming it was the right
  pattern to copy). **If a future "UI still slow while paused" report
  recurs after this, the next place to check is any OTHER unconditional,
  per-frame `syncValue()`/`findCtrl()` call this fix didn't touch** --
  the underlying `findCtrl()` linear scan itself is still O(n) over the
  full control list; this fix only removed ONE specific caller's
  redundant per-frame invocations of it, it didn't make the scan itself
  faster. Not independently verified live -- this sandbox's own
  documented GLB-truncation flakiness (below) blocked a clean model
  load across 5 retries.
- **CORRECTED 2026-09-27, same day, after the entry directly above --
  the user's own follow-up correctly identified that fix as necessary
  but not sufficient: "its sitll slow. so when i zoom in s oonly few
  hands are showing, its much smoother. But if its paused, then why
  does it matter how many hands are there."** The remaining, dominant
  cost while paused was `composer.render()` itself: the 2026-09-21 fix
  (2 entries above) only ever THROTTLED it while paused, never skipped
  it -- a throttled render is still a REAL render, so its own per-call
  cost still scales with hand count regardless of how infrequently it
  runs. Fixed properly this time via **render-on-demand**, chosen over
  a simpler alternative through AskUserQuestion: a new `sceneNeedsRedraw`
  module-level flag (declared near `isPaused`/`pauseOffsetMs`) is set by
  (1) a new generic `onAnyValueChange` devPanel.js host hook -- mirrors
  the existing `hostOnDevVisibilityChanged` module-variable bridge
  pattern exactly, since `commit()`/`syncValue()` are top-level functions
  with no closure access to `initDevPanel()`'s own `opts` -- firing from
  BOTH real paths a value can change through (`commit()`, a genuine live
  user edit; `syncValue()`, a host-driven push such as the camera-
  position sync above or a Saved Preset's "Use" action); and (2)
  `setPaused()` itself, on both the pause and resume transitions.
  `animate()`'s own paused-render gate became a 3-way OR: always render
  when not paused; render when paused AND `sceneNeedsRedraw` AND the
  `pausedRenderFps` interval has elapsed (same rate-limit as before, so
  a rapid slider drag doesn't over-render); OR render regardless of the
  dirty flag once a ~2000ms safety-net backstop interval elapses (a
  deliberate, UNMEASURED, explicitly-labeled judgment call -- a
  defensive catch-all for a future change that mutates the scene
  without going through either real trigger, not a number derived from
  any measurement -- per this project's own §0c convention of never
  presenting an arbitrary threshold as if it were measured). Net effect:
  paused + nothing changed = composer.render() skipped ENTIRELY, not
  merely throttled -- near-zero cost regardless of hand count, directly
  addressing the user's own correct reasoning. **Partially live-verified,
  and honestly incomplete, not silently assumed complete**: the app
  loaded cleanly (`window.__debug` fully populated -- no runtime error)
  and a `composer.render` call-counting wrapper measured 0 calls over a
  1-second window while paused, consistent with the fix -- but a
  follow-up check found this sandbox's own `requestAnimationFrame` was
  not ticking AT ALL in that same session, confirmed via an independent
  raw rAF probe (a plain self-scheduling `requestAnimationFrame` counter,
  nothing to do with any app code) that also read 0 ticks over 1.5s, even
  immediately after explicitly fronting the tab via `tabs_select`. This
  is the same general class of tool quirk already documented multiple
  times elsewhere in this file (`document.hidden`/`window.innerWidth`/
  `clientWidth`/computed-style/`window.__debug` misreports), extended
  here to a 6th concrete symptom: rAF itself failing to tick at all,
  even on an explicitly-fronted tab -- which means "0 renders measured"
  is NOT distinguishable from "nothing was ticking regardless of the
  fix," so it cannot be trusted as proof of this fix specifically. **If a
  future session needs to actually prove this render-on-demand mechanism
  works (not just that the app runs without error), first confirm real
  rAF ticks are occurring via an independent raw probe like the one
  above BEFORE trusting any render-call-count measurement gathered in
  the same session** -- otherwise a true negative (rAF suspended) and a
  correct fix (renders correctly suppressed) are indistinguishable from
  the outside. Toggling a dev-panel slider while paused (to confirm the
  onAnyValueChange -> sceneNeedsRedraw -> prompt-render path end to end)
  and confirming resume restores full-rate rendering both remain
  genuinely unverified for this same reason, not because of any observed
  defect in the code.
- **`realDeviceClass()` (devPanel.js) used to classify Mobile/Landscape
  purely from viewport dimensions (`Math.min(w,h) >= 768` => Desktop) --
  a real, ordinary desktop browser window with height under 768px
  (non-maximized, a laptop screen with browser chrome eating vertical
  space, or simply a 1280x720-class window) was misclassified as
  Landscape.** Confirmed live on the real Vercel deployment at a plain
  1280x720 viewport, `?dev=1`: `document.documentElement.clientWidth/
  clientHeight` read a correct, real 1280x720 (not a misread), yet the
  Landscape tab showed active, purely because 720 < 768. Fixed
  2026-09-21 by gating Mobile/Landscape on actual touch capability
  (`matchMedia('(pointer: coarse)')` / `navigator.maxTouchPoints > 0`)
  first -- a mouse-driven desktop now always classifies Desktop
  regardless of window height; a real touch device under the breakpoint
  still gets Mobile vs. Landscape exactly as before. If a future device-
  classification bug report describes a real desktop showing Mobile/
  Landscape content, check the ACTUAL viewport height first (not just
  width) before assuming it's a touch-detection issue -- this exact
  class of bug is easy to reproduce at any ordinary non-maximized
  browser window.
- **`devpanel/devPanel.js`'s own `commit()` used to gate whether a
  `dynamicDevice` (§12f-1) control's live `cfg`/`onChange` fired behind
  a hardcoded `changedOn` guess ('desktop' unless the edit was on an
  already-independent control) compared against `realDeviceClass()` --
  which only ever matched on an actual desktop machine, so a REAL
  mobile/landscape device editing a shared/mirrored control on its OWN
  native tab never applied the change live, even though the value was
  correctly written into the store.** Confirmed live 2026-09-21 (direct
  report: a phone's own Custom Click Function Mode select, switched
  Single Pose -> Sequence on the Mobile tab, never toggled Target Pose
  vs. the Sequence-selector row -- `updateClickTriggerModeVisibility()`/
  `updateChainModeVisibility()`, Mode's own `onChange`, simply never
  ran). This wasn't specific to Custom Click Functions or Mode --
  `makeClickPoseGroup()`/`makeClickHoldPoseGroup()` wrap their WHOLE
  controls array in `withDynamicDevice()`, and `select` isn't one of the
  4 excluded types (`NO_DYNAMIC_DEVICE_TYPES`), so this silently broke
  live application of EVERY non-independent dynamicDevice control on a
  real (non-desktop) device, project-wide, for as long as the universal
  dynamicDevice system has existed. Fixed by replacing the guess with a
  direct post-write check: `if (store[realDeviceClass()][ctrl.key] ===
  v) { cfg[...] = v; onChange(v) }` -- correct for every one of
  `commit()`'s 3 write branches by construction, since it checks whether
  the real device's own slot actually ended up holding the new value,
  rather than guessing which branch "should" have been the live one.
  Verified via REAL-device-property simulation rather than the Browser
  tool's viewport emulation (`Object.defineProperty(navigator,
  'maxTouchPoints', {value:5})` + `window.innerWidth/innerHeight`
  overrides on an already-loaded page, driving `realDeviceClass()`'s own
  real logic directly) -- this project's mobile-viewport-emulation tool
  already has a documented history of unreliable rAF/dimension
  reporting here (see the earlier `requestAnimationFrame` gotcha), so
  faking the underlying signals `realDeviceClass()` actually reads
  proved far more reliable than fighting that emulation layer again. If
  a future report describes ANY dynamicDevice control (not just a Click
  Function) "not doing anything" specifically when edited from a real
  Mobile/Landscape device on its own matching tab, re-check this exact
  mechanism before assuming the control's own `onChange` logic is at
  fault -- the value was very likely saved correctly the whole time,
  just never applied live.
- **A fix applied to the hold-kind trigger family (`updateClickHoldPoseForHand()`)
  does NOT automatically apply to its fire-and-forget pose-kind sibling
  (`updateClickPoseForHand()`), even for logic that reads as obviously
  symmetric -- these are 2 separate functions with their own separately-
  maintained comments, and one CAN drift stale while the other gets
  fixed.** Confirmed live 2026-09-22: a 2026-09-19 fix made
  `RetransitionEnabled` govern Sequence mode's own release behavior for
  hold-kind triggers (chp/rchp/dcHold/custom Click+Hold functions) --
  its own comment says so explicitly ("RetransitionEnabled now ALSO
  governs Sequence mode's own 'Stop' path, not just Single Pose"). The
  pose-kind family's own matching check (`if (!isTween && cfg[...RetransitionEnabled]
  === false) return`) was never touched by that fix -- its comment still
  read "Sequence/Tween mode's own release always retransitions
  (disclosed scoping choice)," a description that stopped being true for
  the sibling family 3 days earlier but was never corrected here. Fixed
  by removing the `!isTween &&` so both families now agree. **When
  fixing a behavior described as applying to "this trigger family," grep
  for the SAME concept's other implementation (hold vs. pose have almost
  always duplicated logic in this file, never shared) before assuming a
  fix is complete** -- this is the same class of drift as the
  `FINGER_SIGN`/HANDO gotcha above, just within one file instead of
  across two projects.
- **Touch Point Count's meaning changed 2026-09-22 -- it's no longer
  exclusive to a now-removed "Multi-Point" Type. It's now a live
  behavioral switch on Click/Click+Hold themselves: left at 1 (the
  default), a function uses the ordinary single-finger pointer-based
  click/hold detection (this project's existing, mouse-and-touch-agnostic
  pointerdown/pointerup listeners); raised above 1, that SPECIFIC
  function's regular single-pointer dispatch is suppressed
  (`customFunctionWantsMultiTouch()`) and it switches onto the
  touchstart/touchend N-finger-threshold mechanism instead** (the exact
  mechanism "Multi-Point" used to be, just reached differently now). Any
  future code that reads `${id}TouchPointCount` needs to know this is a
  per-function OPT-IN, not a fixed property of the Type -- checking
  `cfg[...Type] === 'Click'` alone is no longer enough to know which
  detection path a given function actually uses. A real, connected bug
  was caught live the same round: the control's own `def` and
  `NEW_CUSTOM_FUNCTION_TEMPLATE` were BOTH still `2` (a leftover from
  when 2 was Multi-Point's own reasonable default) -- left uncorrected,
  every brand-new mobile function would have silently required 2
  simultaneous fingers just to fire a normal Click. Both now default to
  `1`. If a future custom function "doesn't respond to a normal tap,"
  check its own `TouchPointCount` value before assuming the click/hold
  detection itself is broken.
- **Mobile's own "Scroll" Type (a 2-finger pan gesture, added 2026-09-22)
  shares a Type NAME with Desktop's own "Scroll" (a real mouse-wheel
  tick) but is a completely different gesture with its own separate
  detection code (`twoFingerGestureState`, touchstart/touchmove/touchend)
  -- each family's own `customFunctionTypeOptions()` list only ever
  offers one of the two, so a given function is never ambiguous about
  which it means, but don't assume "Scroll" behavior transfers between
  the 2 families if this ever gets refactored.** Its sibling gesture,
  Zoom (2-finger spread), and Scroll are classified from ONE shared
  2-touch tracking state (`twoFingerGestureState`) so a single real
  gesture can only ever resolve to one or the other -- if a future
  gesture type needs adding to this same family (e.g. a 2-finger
  rotate), extend that shared classifier rather than adding a 3rd
  independent touchmove listener, or multiple listeners will race to
  interpret the same touch sequence differently. The 2 thresholds
  (`zoomGestureThresholdPx`/`scrollGestureThresholdPx`, Custom Click
  Functions group, 40px default each) are UNVERIFIED starting values
  with no real-device measurement behind them -- if Zoom/Scroll fire too
  eagerly or too reluctantly on a real report, tune these first before
  suspecting the classification logic itself.
- **`findSkinnedMesh(root)` used to just return whichever SkinnedMesh
  `root.traverse()` happened to visit LAST -- safe only by coincidence,
  as long as a model has exactly one real skinned mesh.** Confirmed as a
  real, would-have-shipped-silently bug while swapping in `HandyOL.glb`
  2026-09-24: that model's single mesh has TWO skinned primitives
  sharing one skin (material "Hand" = the real fill, material "OUTLINE"
  = a 2nd mesh for the Emission Material outline mechanic, see below) --
  "last one found" could just as easily have returned the OUTLINE mesh,
  which the model-load code's own `root.traverse((obj) => { if
  (obj.isMesh && obj !== skinned) obj.visible = false })` line would then
  have treated as the ONLY visible mesh, hiding the real Hand fill
  entirely. Caught by parsing the GLB's own JSON chunk directly (a tiny
  Node script reading the glTF header + JSON chunk, no three.js needed)
  BEFORE writing any loader code, per parent `CLAUDE.md` §0a's "read the
  real source, don't guess" -- not caught live. Fixed: `findSkinnedMesh()`
  now explicitly prefers a mesh whose `material.name === 'Hand'`,
  falling back to the old "last found" behavior for any model without
  one (keeps Hand2.glb, whose one skinned mesh is also named "Hand",
  working unchanged). A future model with yet another naming convention
  needs this function extended, not reverted.
- **`HandyOL.glb` is roughly 40x denser than `Hand2.glb` and crashes the
  WebGL context outright at this project's default 12x13 (156-hand)
  field.** Measured directly on a live hand instance: the "Hand" fill
  mesh has 474,498 vertices / 2,846,976 indices (~949,000 triangles) --
  and the new "OUTLINE" mesh (see above) has the IDENTICAL count, so
  every hand carries ~1.9M triangles even before the OUTLINE mesh is
  ever made visible. Confirmed via console: `[frame-profile]` fps
  collapsed from a normal 11.2 to 0.0 within seconds
  (`avgComposerRender` reaching 35,244ms for ONE frame), followed by
  `GL_INVALID_FRAMEBUFFER_OPERATION` warnings, a real
  `THREE.WebGLProgram: Shader Error 1286 - VALIDATE_STATUS false` on the
  new emission `MeshStandardMaterial`, and finally
  `CONTEXT_LOST_WEBGL`/`WebGLRenderer: Context Lost`. Reproduces on a
  completely fresh page load with Outline Enabled left at its own
  default (off) -- this is NOT specific to the Emission Material
  mechanic or anything code-side; it's the sheer vertex/triangle count
  of the model itself at the existing default field size. Not fixed in
  code (a real content/asset decision, not a bug -- see parent
  `CLAUDE.md` §0a/§0b on why this was surfaced rather than silently
  patched by, say, forcing a smaller default field size unasked). If a
  future report describes poor performance, a black screen, or a
  WebGL-context-lost error with this model in use, check the field's
  hand count against this model's own polycount first -- it doesn't take
  many hands at ~949K triangles each to exhaust a browser's GPU
  resources. Needs either decimation/retopology of the model in the
  user's own 3D tool, or a much smaller field size, to resolve.
- **`touch-action: none` alone does NOT stop iOS Safari's native long-
  press callout/text-selection gesture -- that gesture can cancel an
  in-flight pointer sequence right around the same threshold a "hold"
  gesture needs, indistinguishable from "Click+Hold does nothing at
  all" while a plain quick tap (Click) works fine.** Confirmed 2026-09-26
  via direct report ("click functions work on desktop... the same
  functions dont seem to work on mobile" -- narrowed over several
  corrections to specifically Click+Hold, "nothing happens at all" on
  press-and-hold). `#viewport` only had `touch-action: none`; fixed by
  adding `user-select: none` / `-webkit-user-select: none` /
  `-webkit-touch-callout: none` alongside it -- the same 3-property
  combination HANDYSET's own `.dev-header` CSS rule already uses, with
  that file's own comment stating it's "confirmed via real device
  testing" for an analogous sustained-touch-drag interaction in this
  same workspace. NOT live-verified here -- this sandbox's browser-
  automation tool cannot reproduce a real iOS long-press cancellation;
  confidence rests on that cross-project precedent, not a fresh
  real-device test of THIS fix. If a future report describes any other
  sustained-touch gesture (a drag, a different hold-type interaction)
  "doing nothing" specifically on mobile while a quick tap/click works,
  check for this exact gap (missing `-webkit-touch-callout`/
  `-webkit-user-select`) before assuming the gesture-detection logic
  itself is broken. Also confirmed, separately, as architectural and
  NOT a bug: "Right Click"/"Right Click+Hold" custom functions can
  never work via touch at all -- no touch gesture produces
  `e.button === 2`, which the trigger reads directly, and
  `customFunctionTypeOptions()` only offers those 2 types for
  desktop-family functions in the first place.
- **CORRECTED 2026-09-26, same day -- the theory directly above was
  wrong for the actual device in question. The real device is a Pixel
  9a on Chrome, not iOS Safari** (direct correction from the user); the
  `-webkit-touch-callout`/`-webkit-user-select` fix targets a
  Safari-only mechanism and does nothing on Chrome. Left in place as a
  harmless no-op there, but it was never the real fix for this report --
  left uncorrected above (per this file's own convention: add a
  correction, don't silently rewrite a prior entry) as a caution against
  assuming a fix that "should" work cross-platform actually does. **The
  real Chrome/Android mechanism: a sustained, non-moving touch on ANY
  element is treated as a long-press-equals-right-click gesture** --
  after Chrome's own internal delay (landing right around this file's
  own `holdConfirmMs` default of ~500ms), it dispatches a synthetic
  `contextmenu` event and, if not prevented, opens the native context
  menu and fires `pointercancel` on the in-flight touch, ending the
  pointer sequence before or right as `holdConfirmMs` elapses -- this is
  standard, documented Chrome/Android behavior (the touch equivalent of
  a right-click, deliberately exposed so pages can implement their own
  long-press context menus), not guessed. Confirmed via direct grep
  that nothing in the file previously prevented `contextmenu` at the
  viewport/window level (only 3 curve-widget dot handlers did, for an
  unrelated desktop right-click-to-delete feature). Fixed with
  `canvas.addEventListener('contextmenu', e => e.preventDefault())` on
  `#viewport`. **If a future mobile report says a sustained-touch
  gesture "does nothing" while a quick tap works, check which platform
  is actually being tested FIRST (Chrome/Android vs. Safari/iOS use
  completely different native mechanisms for this exact symptom class --
  `-webkit-touch-callout` for one, `contextmenu`+`pointercancel` for the
  other) before assuming either fix from this file's own history
  applies.** Not live-verified -- this sandbox hit its own documented
  `main.js` network-truncation quirk across 5 retries (the standing cap)
  this round; needs the user's real Pixel 9a to confirm.
- **A control dynamically registered via `renderDynamicGroup()` (Custom
  Click Functions, the only such case in this project) can silently
  discard its own REAL SAVED VALUE for any non-DEV_MODE visitor, falling
  back to its hardcoded `def` instead -- with no error, no console
  warning, nothing.** Confirmed 2026-09-26 (3rd round) via direct report ("Click
  funcitons still dont work in non dev mode"), a follow-up correction on
  the contextmenu fix directly above (that fix was real, just not the
  whole story -- this is a completely separate DATA problem, not a
  touch-gesture one). Root cause, in `devPanel.js`:
  `applyStoredValues()` only ever applies a saved value to a control
  that already exists in `devGroups` AT THE MOMENT it's called. At boot,
  `restoreValuesForEveryVisitor()` calls `applyStoredValues()` strictly
  BEFORE `main.js`'s own `onRestore` -> `restoreCustomClickFunctions()`
  has had a chance to register any Custom Click Function via
  `renderDynamicGroup()` -- so a function's real saved
  `Type`/`Enabled`/`TargetPose`/etc. is silently never applied, and
  `renderDynamicGroup()`'s own seeding step falls back to each control's
  hardcoded `def` (`Enabled: false`, `TargetPose: ''` -- exactly the
  "clicking does nothing" symptom this file's own gotcha below already
  documents for a blank `TargetPose`, just with a different root cause
  than that entry describes). **Why this was invisible in DEV_MODE**:
  `resetSettings()` -- called exactly once, at boot, but ONLY reachable
  from the DEV_MODE-only panel-construction path (strictly after the
  boot-time restore) -- does a 2ND full fetch+`applyStoredValues()`
  pass, and by THAT point the custom controls already exist in
  `devGroups` (pushed there unconditionally by the 1st pass's own
  `renderDynamicGroup()` calls, regardless of whether the panel DOM
  exists yet) -- so DEV_MODE gets a lucky 2nd chance a real visitor
  never gets. Fixed by caching whatever `values` blob each successful
  restore actually saw (`lastRestoredValues`, new module-level state in
  `devPanel.js`, set in both `restoreValuesForEveryVisitor()` and
  `resetSettings()`, remote and localStorage paths alike) so
  `renderDynamicGroup()`'s own seeding step can check it directly,
  per device, mirroring `applyStoredValues()`'s own per-control
  resolution -- falling back to `def` only when nothing was ever
  restored for that exact key. Verified via an isolated logic-level
  reproduction (no DOM/three.js needed, since this bug and its fix are
  pure object/control-flow logic) using `custom7`'s own real saved data
  from `dev-panel-settings.json`: the buggy sequence reproduced
  `Enabled: false, TargetPose: ""` against real saved
  `Enabled: true, TargetPose: "Big Open Palm (S)"`; the fixed sequence
  recovered all 3 real fields exactly. **NOT verified against this
  project's own live running app** -- the local static server has no
  working backend for the git-tracked settings fetch
  (`opts.remoteSave`), confirmed directly via
  `window.__debug.cfg.customClickFunctionIds` reading `"[]"` (the
  code-level default) rather than the real saved array on a local load,
  meaning this exact bug can't be demonstrated live in this sandbox
  regardless of whether the fix is correct. **If a FUTURE feature ever
  dynamically registers a new kind of control after boot (another
  `renderDynamicGroup()` call site, or an equivalent mechanism), it
  needs this same `lastRestoredValues` lookup or it will reproduce this
  exact bug for its own keys** -- the risk is inherent to registering
  controls after the one-shot boot-time restore has already run, not
  specific to Custom Click Functions.
- **`addCustomClickFunction()` (the "+ Add Click Function" button) never
  called `updateCustomFunctionTypeVisibility(id)` at creation time -- the
  real, previously-undiagnosed cause of a symptom this file already
  documented once (2026-09-24) as an unresolved timing race ("Touch Point
  Count visible on Desktop... only an actual manual tab click fixed it").**
  Confirmed 2026-09-27 via direct report. It was never actually a race
  for a FRESHLY-CREATED function -- a brand-new function's Touch Point
  Count row (built by `buildRow()`, which has no notion of "hide on
  Desktop regardless of Type") simply stayed at its default-visible state
  until something ELSE happened to call
  `refreshAllCustomFunctionTypeVisibility()` (a tab switch, or the NEXT
  page load's own `restoreCustomClickFunctions()` sweep) -- which is
  exactly why a manual tab click "fixed" it. Fixed by calling
  `updateCustomFunctionTypeVisibility(id)` directly inside
  `addCustomClickFunction()`. If a FUTURE row-visibility rule is added
  that depends on something other than a control's own value (tab,
  device, an unrelated sibling control), check every CREATION path (not
  just the restore-on-load path) explicitly applies it -- this bug
  existed because only the restore/tab-switch paths called the
  visibility function, never the live "+Add" path.
- **devPanel.js's `createGroupElement(title)` sets a built group's
  `dataset.key` to its own DISPLAY TITLE string, not to any separate
  identifier a caller might have in mind.** Confirmed 2026-09-27 while
  building Multi Trigger (see PROJECT_PROGRESS.md's own 2026-09-27
  entry): code written to match a dynamically-created group's DOM element
  back to its own underlying id/prefix by reading `g.dataset.key` will
  silently get the group's TITLE STRING instead (e.g. "Trigger 1"), not
  whatever real key the caller cares about -- caught before shipping by
  reading `createGroupElement()`'s own source directly, not caught live.
  `renderCustomClickFunctionGroup()` already works around this
  correctly, by stamping its own `dataset.customFunctionId`/
  `dataset.customFunctionFamily` onto the group AFTER `renderDynamicGroup()`
  returns it, rather than trying to read anything back out of
  `dataset.key`. **Any future code that needs to identify a dynamically-
  built group by something other than its own display title must stamp
  its own custom `dataset.*` attribute the same way -- `dataset.key`
  is never a safe source for that.**
- **NOT YET LIVE-VERIFIED (2026-09-27): the new Multi Trigger feature for
  Custom Click Functions** (cycling a pose-kind function through
  different tweens on subsequent clicks -- see PROJECT_PROGRESS.md's own
  2026-09-27 entry and CHANGELOG.txt's matching entry for the full
  design). Built and reasoned through carefully -- every dependency
  (`triggerClickPose`/`updateClickPoseForHand`/`applyOffsetRotationToHand`/
  `parseClickPoseConfig`/`wrapClickFunctionGatedSubgroups`/
  `updateClickFunctionEnabledVisibility`) was read in full before writing
  anything, and the dispatch resolver's own cycling logic was verified in
  an isolated, no-DOM reproduction -- but this sandbox could not get a
  clean live app load this round (5 retries, the standing cap, all hit
  the documented `main.js` network-truncation quirk, worse now that the
  file is larger). **If a future report describes Multi Trigger not
  cycling correctly, not skipping a disabled trigger, not persisting a
  drag-reorder across a reload, or not working at all outside `?dev=1`,
  start there -- this is genuinely unverified, not just cautiously
  worded.**
- **`lib/visibility-tick-loop.js` (added 2026-09-27) is a vendored copy
  from the sibling "3JS ENGINE" project (`J:\CLAUDE\PROJECTS\3JS
  ENGINE\lib\visibility-tick-loop.js`), where it was originally built and
  is the canonical source -- treat it the same as any other vendored
  file in this workspace (HTML UI ENGINE, TEMPLATE_DEV_PANEL.html): a
  genuine gap found while integrating it here belongs in the canonical
  copy first, then gets re-vendored, not patched in place here. It stops
  `animate()` (registered via `window.VisibilityTickLoop.registerTick()`)
  entirely while this tab is hidden OR the browser window loses OS focus,
  and exposes `window.VisibilityTickLoop.isPaused()` for anything else
  that should stop working under the same conditions -- the pointermove
  cursor-tracking listener (`cursorNDC`) already uses it. **This
  project's own `syncPauseWithVisibility()`/`isPausedForVisibility`
  (main.js, right after `animate()`'s own `registerTick` call) is
  DELIBERATELY project-specific, not part of the vendored file** -- it
  bridges the new hidden/unfocused signal into this project's own
  PRE-EXISTING manual Global Pause (`isPaused`/`setPaused()`/
  `pauseOffsetMs`), so an in-flight tween's own elapsed-time computation
  doesn't jump forward by the entire hidden duration the moment the tab
  becomes active again -- the shared file has no `onPause` hook (only
  `onResume`) specifically because "what paused means for this project's
  content" is meant to stay out of the generic file. If a future report
  describes a tween snapping/jumping forward after the tab was hidden or
  unfocused for a while, this is the first place to check -- confirm
  `syncPauseWithVisibility()` is still correctly wired to all 3 events
  (`visibilitychange`/`blur`/`focus`) before assuming a regression
  elsewhere. **Not independently verified end-to-end through this
  project's own real trigger/tween system** -- the hand-model GLB failed
  to load in this sandbox across 5 retries the round this was added (a
  pre-existing, already-documented gotcha, see this file's own GLB-
  truncation entry above), so `window.__debug` never populated and the
  `setPaused()` sync logic specifically could only be reviewed by direct
  reasoning, not observed live. The core tick-pause-resume mechanism
  itself WAS verified live (a registered probe callback, ticking ->
  frozen 2s while simulated hidden -> resumed on simulated focus).
- **`applyPoseOffsetToPosition()`'s own "never compound" design (an
  ABSOLUTE position recompute from `basePosition` every call) was
  DELIBERATE for the original Offset/Rotation spec, but is exactly what a
  later direct request (2026-09-27) asked to reverse -- always re-check
  whether an existing "this is intentional" comment still describes what
  the user currently wants before assuming it's still correct.** Confirmed
  2026-09-27: a request for Offset/Rotation to "stack" across different
  triggered functions and compound across repeated loop laps directly
  contradicts this earlier comment's own stated intent. Fixed by adding a
  genuinely new mechanism (a persistent `hand._customOffsetAccum`/
  `_customRotationAccum` accumulator, baked in at every real tween/lap
  completion, cleared only by a completed Retransition) layered ON TOP of
  the existing per-frame reset, rather than removing the reset itself --
  see `applyOffsetRotationToHand()`'s own extensive comment for the full
  model. If a future report describes Offset/Rotation "not sticking"
  again, check whether `bakeOffsetRotationIntoAccum()` is actually being
  called at every real completion point in BOTH `updateClickPoseForHand()`
  and `updateClickHoldPoseForHand()` -- the hold-kind family's own
  'forward' phase specifically needs its `offsetBaked` per-trigger flag
  (a non-looping single-pose hold can linger at progress=1 indefinitely
  with no phase transition, unlike every pose-kind case, so re-baking
  every single frame without this guard would grow the accumulator
  without bound even while perfectly still).
- **`wrapGatedSubgroup()` can be nested inside its own previous output --
  calling it a 2nd time on rows that a FIRST call already relocated into
  a new subgroup correctly re-nests them one level deeper, because it
  finds its own `enabledKey` row via a GLOBAL, uniquely-prefixed
  `document.querySelector()`, not a parent-scoped one.** Confirmed
  2026-09-27 while building 2 new subgroups ("Retransition Speed Curve,"
  "Retransition Start Time Curve") nested inside the existing
  "Retransition" group -- traced through `wrapGatedSubgroup()`'s own
  source step by step before relying on this, since it was the first
  case in this file of nesting one call's output inside another's, and
  the ORDER matters: the outer wrap (which first moves the target rows
  into ITS OWN body) must run before any inner wrap that expects to find
  those same rows already there. Useful precedent for any future request
  to further subdivide an existing gated subgroup.
- **A per-frame function (not a per-hand-loop one) must never `return`
  early from inside a conditional sub-block that skips a hand for a
  GENUINE reason (e.g. "this hand is outside an eligible range") -- doing
  so also skips every OTHER thing that function does for that hand THIS
  FRAME, not just the intended part.** Caught 2026-09-27 while building
  Start Distance Curve's own eligibility gate, before it ever shipped
  live: `updateClickHoldPoseForHand(hand, p, ...)` is called once per
  hand PER FRAME (unlike `triggerClickPose(p)`, which loops over every
  hand itself via `hands.forEach`) -- an early `return` inside its own
  arming block for an "ineligible, don't start this hold" hand would ALSO
  have skipped that same frame's commit-check and phase-dispatch blocks
  further down in the SAME function, for that SAME hand -- potentially
  stalling whatever ELSE that hand/prefix might already be mid-way
  through (a retransition from a PREVIOUS trigger, for instance). Fixed
  with a plain `eligible` boolean guarding only the specific
  side-effects that should be skipped (never setting `pendingClaimAt`),
  letting the rest of the function's own per-frame work continue
  normally. **Before adding an early `return` inside ANY per-hand-per-
  frame function in this file (`updateClickPoseForHand`,
  `updateClickHoldPoseForHand`), check whether it's actually a per-hand
  LOOP (safe to `return`/`continue` for one hand) or a per-frame
  function called once per hand externally (where `return` exits ALL of
  this frame's work for that hand, not just the one thing you meant to
  skip).**
- **`data/processed/dev-panel-settings.json` crossing ~1MB breaks the
  live Save/Sync restore ENTIRELY -- and the failure mode looks like
  "everything about the app is broken," not like a settings-file
  problem.** Confirmed live 2026-09-27 on
  `https://handy-dandies.vercel.app`, a real production outage matching
  a direct user report ("somethign looks really broken. the background
  color is wrong and my hand poses look compeltely off. and my click
  functions dont work"). Root cause: the settings file had grown to
  1,213,317 bytes; GitHub's Contents API only inlines a file's `content`
  field for files up to ~1MB, so `api/save-settings.js`'s GET handler
  received an empty `content` and `JSON.parse('')` threw "Unexpected end
  of JSON input" on every single restore attempt -- confirmed via a
  direct `fetch()` against the live `/api/save-settings` endpoint AND
  `curl`, both returning that exact 500. With restore permanently
  broken, the live page fell back to `tryStartField()`'s own 6-second
  hardcoded-defaults timeout on EVERY load (confirmed via
  `window.__debug`: `cfg.customClickFunctionIds: "[]"`, `scene.background`
  at the code-default white, camera at its hardcoded default position),
  which is what actually produced all 3 reported symptoms as ONE shared
  cause, not 3 separate bugs. Fixed in `api/save-settings.js`'s GET
  handler by falling back to `getData.download_url` (GitHub always
  provides this, valid up to 100MB, regardless of whether `content` was
  inlined) whenever `content` is missing/empty -- read-only fix, the
  POST/save path never depended on `content` and was never affected.
  **This ceiling will be hit again** as more custom click functions/
  curves/multi-triggers get saved -- the fix raises the effective limit
  to ~100MB, it doesn't remove the underlying unbounded growth (see
  CHANGELOG.txt's 2026-09-27 7th-round entry for the full account,
  including a disclosed-but-not-yet-acted-on note about eventually
  pruning or restructuring this file). If a future report describes the
  app looking broken in a way that spans MULTIPLE unrelated-seeming
  systems at once (rendering, poses, AND interaction, simultaneously),
  check `/api/save-settings`'s own response before assuming a code
  regression -- a silently-broken restore path produces exactly this
  shape of symptom, because literally everything ends up running on
  hardcoded defaults instead of real saved state.
- **The fix above was pushed (commit `bd18889`) but NOT confirmed live
  before this entry was written -- Vercel had not redeployed it after
  ~10 minutes of polling** (`curl` against `/api/save-settings` roughly
  every 15-20s, ~28 attempts, still returning the OLD error verbatim;
  `gh api repos/LeisHo/HandyDandies/deployments` still showed the PRIOR
  commit, `a84a400`, as the most recent deployment record, over an hour
  old by that point). Every earlier commit this same session deployed
  within ~1-2 minutes of its own push, so this gap is itself anomalous
  and unexplained from inside this sandbox (no Vercel dashboard/API
  access available here) -- if a future session finds `/api/save-settings`
  still 500ing with this same error after this fix, check whether
  Vercel's GitHub integration for this repo is actually still connected
  and auto-deploying before assuming the code fix itself was wrong.
- **Responsive Wrist Splay used to be FROZEN at each click-function
  trigger's own arm time and applied as a flat constant for the trigger's
  whole lifetime, while idle hands recompute it fresh every frame from
  live cursor distance -- the 2 never blended, so every handoff between
  "click-function-governed" and "cursor-tracking-governed" was an
  instant snap, not a transition.** Fixed 2026-09-27 per direct report
  ("when a click function interrupts another... the wrist splay, palm
  rotation, and wrist crop should never suddenly jump... release midway,
  wait a second or 2, then click elsewhere, the hands will jump"). New
  `hand.currentSplayDeg` (written by `applyPoseValuesToHand()`, the one
  funnel every trigger family's per-frame apply already goes through,
  and by idle-repose's own splay line) is the single continuously-
  current value every trigger boundary blends FROM: a NEW trigger's
  'forward' phase lerps `fromSplayDeg -> frozenSplayDeg` across the same
  `progress` driving the rest of the pose (captured at arm time as
  `pendingFromSplayDeg = hand.currentSplayDeg`, so an INTERRUPTED
  trigger/retransition's own in-progress value is what the new one picks
  up from, not a stale default); retransition's own phase lerps from a
  `retransitionFromSplayDeg` snapshot (captured in
  `snapshotOffsetRotationAccumForRetransition()` for all 3 real chp entry
  points, inline for cp's 'paused'->'retransition' transition) toward a
  LIVE recomputed target, so splay already matches idle-tracking by the
  time `phase` reaches 'idle'. 'looping'/'stopping'/'sequencePlaying'/
  'paused' phases were deliberately left applying the flat frozen
  constant unchanged -- they never cross a trigger boundary mid-phase, so
  there's nothing to blend there. Arm Length/Hide Wrist ("wrist crop")
  was investigated and found to already be fully decoupled and
  frame-continuous (`computeArmLengthT()`/`applyHandArmLength()` run
  unconditionally every frame regardless of `overridden`) -- no change
  needed. **NOT live-verified** -- this sandbox's browser automation
  couldn't get a clean load this round either (the standing documented
  network-truncation quirk). If a future report describes ANY other
  skeletal/pose property jumping specifically at a trigger start/end
  boundary (not mid-phase), this is the pattern to replicate: capture a
  `from` value at arm/retransition-start time from whatever the hand
  actually has right now, blend across that phase's own progress toward
  the target, never apply a frozen constant on frame 1 of a NEW phase.
- **CORRECTED 2026-09-27, same day -- the fix above was necessary but
  not sufficient. `chp`/`cp`'s own 'retransition' phase animated back
  toward `poseDefaultValues` (a snapshot only resynced at page load or
  an explicit "Default" click), while idle-repose always renders from
  LIVE `cfg` directly.** The moment ANY Pose slider is tuned without a
  following "Default" click, these 2 sources of truth silently diverge
  -- confirmed by direct MEASUREMENT this time (not just code tracing):
  used `window.__debug` to drive `startClickHoldPose()`/
  `endClickHoldPose()`/`updateRenderOrder()` against the real production
  deployment and logged the wrist bone's own quaternion frame by frame
  -- it held steady through the whole retransition, then SNAPPED the
  instant `chp.phase` reached 'idle', a real, reproducible discontinuity.
  Fixed by having both `updateClickHoldPoseForHand()`'s and
  `updateClickPoseForHand()`'s 'retransition' phase target `cfg` directly
  instead of `poseDefaultValues` -- retransition now always converges to
  exactly what idle already shows, by construction. **Disclosed
  trade-off:** the "Default" button's own documented effect on
  retransition's target is now moot whenever a pose slider has been
  tuned since the last "Default" click (retransition follows the live
  tuning instead) -- `poseDefaultValues` is untouched everywhere else it's
  used. **Live-verified end to end** (not just the bug, the fix too) via
  the identical reproduction against the real deployment after redeploy
  -- the same frame-by-frame quaternion trace that caught the bug showed
  zero discontinuity afterward. If a future report describes a pose
  jumping specifically when retransition completes (not at trigger
  start), check whether `poseDefaultValues` has gone stale relative to
  `cfg` for the field in question before assuming the splay-style
  frozen-vs-live mismatch above is the cause -- these are 2 genuinely
  different bugs that happen to produce the same symptom.
- **CORRECTED 2026-09-27, 3rd round of the same jump investigation --
  `applyOffsetRotationRetransition()` left the REAL Offset/Rotation
  accumulator (`hand._customOffsetAccum`/`_customRotationAccum`)
  completely untouched throughout retransition's own decay, only
  clearing it once `progress` reached 1.** A DIFFERENT function
  interrupting mid-retransition (before that clear ever ran) had its
  own `applyOffsetRotationToHand()` read the accumulator at its FULL,
  un-decayed pre-retransition value -- a real jump back up to the old
  total, specifically in the "one click function interrupts another
  mid-retransition" case. Found while chasing 2 direct "still not
  fixed" follow-ups on the splay/retransition-target fixes above;
  confirmed this project's real, saved `custom7` (a plain `Click`-type
  function) fires on every click including a "click elsewhere," so the
  user's own simplified repro ("single click hold and a click elsewhere
  after") was actually exercising an inter-function interruption the
  whole time, not a same-function re-trigger. Fixed by keeping the real
  accumulator continuously in sync with the currently-decayed amount
  every frame -- same pattern as `hand.currentSplayDeg`. **Live-verified
  directly**: enabled Offset on custom8, held, released, logged the
  accumulator decaying (`8,4 -> 7.917,3.958 -> ... -> 3.727,1.864`),
  interrupted with a real `triggerClickPose('custom7')` call right at
  that point, and confirmed the accumulator continued the SAME decay
  trend immediately after rather than snapping back to `8,4`. If a
  future report describes a position/rotation offset jumping
  specifically when one click function interrupts ANOTHER that's
  mid-retransition (not idle, not mid-forward), this accumulator-sync
  gap is the pattern to check first -- any other place in this file
  that decays a persistent per-hand accumulator toward zero over time
  needs the same "keep the real value continuously in sync, don't just
  clear it at the end" treatment, or it will reproduce this exact bug
  class for its own state.
- **CORRECTED 2026-09-27, 4th round of the same jump investigation --
  `bakeOffsetRotationIntoAccum()` always adds the FULL configured
  Offset/Rotation amount, correct only for a ramp/lap's own NATURAL
  completion. `endClickHoldPose()` (the release handler) transitions a
  hand straight into 'stopping'/'retransition' the instant the user
  releases, regardless of how far the ramp had gotten, and neither exit
  branch ever baked anything first.** Found from a precisely-targeted
  follow-up report ("Its deifnitely during the retransition of stopping
  time") -- releasing mid-ramp meant whatever fraction of Offset/Rotation
  had already been visually shown (`cfg[OffsetX] * progress`) simply
  vanished the moment 'stopping'/'retransition' took over (they only ever
  call `applyOffsetRotationToHand()` with progress pinned to 0, baseline
  only). The identical gap existed in `releaseHandFromOtherFunctions()` --
  a different function's own commit force-idling a still-active one is
  just as much a mid-flight interruption as a manual release. Fixed with
  `hand._lastOffsetRotationProgress[p]` (recorded every frame by
  `applyOffsetRotationToHand()`) and a new `bakeInFlightOffsetRotation(hand,
  p)` that bakes exactly that fraction, not the full target, called at
  both `endClickHoldPose()` exits and both `releaseHandFromOtherFunctions()`
  loops. **Live-verified precisely**: released custom8 33.27% through a
  4000ms ramp (`OffsetX:10,OffsetY:6`) -- accumulator went `{0,0} ->
  {3.327,1.996}` (exactly `10*0.3327`/`6*0.3327`) at the instant of
  release, and `hand.wrapper.position` was IDENTICAL before and after
  (the old additive term and the new baked term produced the same value).
  Also verified the `releaseHandFromOtherFunctions()` path with a real
  2nd function interrupting mid-ramp. **This is the general pattern for
  this whole bug family**: ANY per-hand persistent state that's normally
  "locked in" only at a ramp/lap's own 100% natural completion needs an
  equivalent partial-credit path for every OTHER way that same phase can
  end (a manual release, a different function's own interruption, a
  page-level reset) -- a future feature that adds its own "bake at
  completion" step should audit every early-exit path for the same gap
  from the start, not just its own happy path.
