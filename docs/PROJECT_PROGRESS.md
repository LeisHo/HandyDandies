# HANDY DANDIES — Project Progress

**This is a live document, not a log.** It holds only the current picture —
what's being worked on right now, what's recently done, and what's next. It
does **not** accumulate a running history of every past session; that
history already lives in `CHANGELOG.txt` (the append-only, authoritative
record — see CLAUDE.md §4a/§4). When something here is finished and no
longer relevant to understand what's current, remove it from this file
rather than leaving it to pile up. Rewrite the sections below in place at
each real update — don't append a new dated block underneath the old one.

This doc functionally doubles as a handoff document (CLAUDE.md §4c): a
brand-new AI chat with no prior context should be able to read this file
alone and know exactly where the project currently stands, and pick up the
work seamlessly from there.

--------------------------------------------------------------------------------

## Currently working on

Nothing actively in progress. Shipped "Click Pose"/"Double-Click Pose"
(a fire-and-forget variant of Click Hold-Pose: click once, the whole
transition-pause-retransition sequence runs per-hand on its own) and
disabled camera pan during an active Click-Hold-Pose trigger. **Still
open: the user reports the Click-Hold-Pose retransitioned thumb pose is
wrong even after a hard refresh, but this has NOT been reproduced** —
every test this session (including the most realistic one yet: the real
Default-button flow, persisted through an actual page reload, varying
all 5 thumb keys + wrist bend/splay) measures exactly 0.0deg error. See
"What's next" for what a future session should try.

## Recently completed

(Consolidated 2026-09-12 -- the full blow-by-blow of every round below
remains permanently in `CHANGELOG.txt`; this summary keeps only what's
still relevant to understanding current state, per this doc's own
"live document, not a log" convention.)

- Initial build: a three.js field of rigged hands that each independently
  rotate to point at the live cursor, reusing HANDO's `Hand2.glb` rigged
  asset and its generic dev-panel engine. Camera pan/zoom (OrbitControls,
  rotation disabled, mobile touch via its own `touches` config), Field
  Layout (independent row/column spacing, Alternate/Progressive row
  offset, hand scale decoupled from spacing), and full Lighting/Toon
  Shading/Outline groups ported from HANDO followed as same-day
  follow-ons. Pushed to a new GitHub repo (`6d6ea29`).
- Cross-hand render ordering: farthest-from-cursor hands draw on top of
  nearer ones (direct request), via `renderOrder` set every frame from
  live cursor distance (`updateRenderOrder()`).
- "Prevent Reordering Flash" (Debug group checkbox): went through 3 real
  design iterations after 2 rounds of user-reported bugs (a permanent-
  freeze failure mode, then a lock/pin design that measured a 21% wrong-
  order rate) before landing on the current per-hand exponential-
  smoothing design (measured under 0.1% wrong-order rate). Its overlap
  check was also fixed to use the mesh's own measured bounding sphere
  instead of an undersized, mis-centered wrist-bone approximation (a
  real, user-reported "thumb popping through" bug). A residual, disclosed
  limitation remains: `renderOrder` is a discrete sort key, so smoothing
  cannot eliminate the visual "pop" at a GENUINE crossing (only a real
  alpha cross-fade could, not yet attempted -- see What's next).
- Toon-shading-noise bug: fixed after 2 wrong diagnoses in the same
  investigation were each directly disproven by the user. Real root
  cause was `depthTest:false` self-occlusion bleed-through (confirmed via
  a targeted pixel-diff: 8.2% of pixels in a real finger-over-palm overlap
  region were wrongly lit). Fixed by restoring `depthTest:true` on both
  hand materials and giving each hand's own fill + outline mesh an
  `onBeforeRender = (r) => r.clearDepth()` hook instead -- self-occlusion
  is now correct while cross-hand stacking still follows draw order.
  **User-confirmed live: "ok noise is gone now."** Pushed as `0eb1f9b`.
- **Ported HANDO's own Pose dev-panel group** (25 finger sliders, Wrist
  Bend/Splay, Whole-Hand Rotation X/Y/Z, Hide Wrist), applied identically
  to every hand for now. Hide Wrist's own grid-alignment requirement (the
  cut wrist base always lands exactly on that hand's own Field Layout
  point, for any Whole-Hand Rotation) needed genuinely new math HANDO
  itself never had to solve. 3 real bugs found and fixed via direct
  empirical testing this round (a palm-pivot-vs-grid-alignment conflict;
  a direction+distance-vs-absolute-position mixup; HANDO's own finger-curl
  axis math leaking each hand's own cursor-tracking rotation) -- full
  detail in `CODE_SUMMARY.txt`'s GOTCHAS. Pushed as `25d47ce`.
- **Reframed "Hide Wrist" as "Arm Length," made reactive to live cursor
  distance.** A screen recording the user provided showed what looked
  like a real cropping bug; measurement proved it was pure perspective
  foreshortening on a physically-uniform 3D crop (not a bug), which led
  to the user's real ask: make the crop amount a deliberate function of
  cursor distance. Shipped Reactive Arm Length (checkbox), Min/Max Arm
  Length (a custom 2-handle range-bar widget), Length Scaling Curve (a
  custom draggable-point curve editor), and Default Arm Length (the
  original slider, used when Reactive is off). Arm-length compensation
  moved from a one-time shared calculation to per-hand, per-frame. Pushed
  as `6a468d0`.
- **4-item bug-fix round + 2 new features**, after further live testing
  (including 2 more user-provided screen recordings) surfaced real
  problems in the round above: (1) the dev panel's own Collapse button
  hid settings but left the panel's full-height box behind -- a genuine
  bug in the shared `devpanel.js` engine itself (both an inline `height`
  and a `min-height: 140px` needed overriding on collapse, not just one);
  (2) added a **Crop Wrist** master on/off checkbox; (3) a real unit-scale
  mismatch was the actual cause of "set default/max to .5, still see full
  arms" (0.5 on a 0-100 scale is 0.5%, not 50%) -- fixed by making the
  curve widget's own captions speak in percent too, removing the "(0-1)"
  language that likely primed the mistake; (4) Reactive's distance
  normalization used to divide by a FIXED field-radius constant, so once
  the cursor moved far enough from the whole field every hand collapsed
  to the same crop value ("hands furthest away disappearing... even
  though i have a min length more than 0") -- fixed by normalizing
  against the field's own CURRENT live min/max distance each frame
  instead, confirmed to preserve the full gradient even with the cursor
  placed ~20x the field radius away. Also added a **Mouse Tracking Log**
  (Debug group: a click log describing what each click actually triggers
  in this app, a regular interval-driven cursor-position log, an
  interval slider, and an on/off checkbox) and made the **Length Scaling
  Curve a real smooth spline** (Catmull-Rom, not piecewise-linear) per
  direct correction with a tone-curve-editor reference image. Caught and
  fixed 2 more small bugs live before shipping: a `NaN`/`null`-corrupting
  drag bug when a widget's own group is collapsed mid-drag, and a
  defensive gap in the new click handler. Two direct same-day follow-ons
  to the log itself: a **Copy** button (same clipboard pattern devPanel's
  own "Copy Settings" button already uses), and a delegated 'input'/
  'change' listener on the whole panel that logs every dev-panel setting
  change (control label + new value) without touching any individual
  control's own onChange -- works for every existing AND future control
  automatically.

  **A concurrent session (working from HANDO, handling the user's own
  separate "import poses from HANDO" ask) was actively adding a Saved-
  Poses-import list-picker and a standalone Pose Preview mini-viewer to
  this SAME project's `main.js`/`devpanel.js` while this round's own work
  was in progress.** Confirmed via direct diff inspection before touching
  anything further. `devpanel.js`'s own collapse-button fix was cleanly
  separable via a scoped `git apply --cached` patch (same technique used
  successfully earlier this project); `main.js`'s changes were judged NOT
  safely separable (their feature reuses this round's own
  `applyCurlToSkeleton()`/`applyWristPoseToSkeleton()` with a new,
  backward-compatible parameter) without real risk of breaking their
  work -- both sessions' `main.js` changes were committed together, with
  honest attribution in the commit message and `CODE_SUMMARY.txt` rather
  than silently claimed or held back. Not yet pushed at the time this was
  written -- see CHANGELOG.txt for the exact commit.
- **Fixed a real "arms disappearing" bug, after 2 earlier rounds
  misdiagnosed it as perspective foreshortening.** User pushed back
  directly on the foreshortening explanation, then pinpointed it further:
  disappearing happened even with Crop Wrist OFF, and specifically
  affected the FARTHEST-from-cursor hands when the cursor was far from
  the grid -- correctly reasoning those hands would be pointing AT the
  distant cursor, not edge-on to the camera. Root-caused live (reproduced
  exactly using the user's own pasted Copy Settings dump loaded into
  `localStorage`, not guessed settings): every field hand's fill/outline
  mesh shared ONE material instance with ONE shared, per-hand-mutated
  `wristClipPlane` -- three.js doesn't re-resolve a shared material's
  clipping-plane uniform per individual draw call, so with 289 hands only
  2 actually rendered anything at their own correct, independently-
  verified screen position. Confirmed by stripping `clippingPlanes` off
  the shared material as a falsification test: 288/289 immediately
  reappeared. Happened regardless of Crop Wrist/Reactive state, since the
  clip-plane update runs unconditionally for every hand. Fixed by giving
  every hand its own cloned material + own `THREE.Plane` instance (see
  `CODE_SUMMARY.txt`'s GOTCHAS for the full technical account). Verified
  live: 276/289 hands now render correctly at the exact cursor position
  that previously showed only 2/289; the Arm Length feature's own
  T-value math re-confirmed unchanged and correct (nearest T=0.9,
  farthest T=0.3) -- the bug was purely in the shared clip-plane
  mechanism, not the crop math itself.
- **Fixed a same-day follow-on regression from the fix above: Key Light
  Color (and rim lighting, toon-tint/texture blend) stopped working on
  the per-hand material clones.** User-reported: white key light still
  showed real texture colors, red visibly tinted -- `Material.clone()`
  turns out to NOT carry over a custom `onBeforeCompile` override (not
  part of three.js's own `.copy()` property list), so every cloned
  material silently reverted to the stock no-op, losing the toon
  material's rim-light/duotone customization entirely while normal
  lighting (unaffected by this) kept working. 2 wrong hypotheses ruled
  out live via direct compiled-shader inspection before finding this
  (a speculative `customProgramCacheKey` optimization added in the fix
  above, and program-cache sharing generally) -- see CODE_SUMMARY.txt's
  GOTCHAS for the full account. Fixed by explicitly re-assigning
  `onBeforeCompile` after `.clone()`; `customProgramCacheKey` removed for
  good (confirmed not the cause). Verified live: Key Light Color white/
  red now gives neutral gray / red-tinted output respectively, reversible;
  the wrist-clip-plane fix re-confirmed still intact (274/289 visible at
  the same test position).
- **Fixed the dev panel opening on the wrong tab (Landscape) on an
  actual desktop-sized window.** User-reported directly. Root cause in
  `devpanel.js` itself: the initially-active tab was set once,
  synchronously, from a `window.innerWidth`/`innerHeight` read that (per
  this project's own already-documented gotcha) can be wrong at that
  exact early moment, with nothing to correct it afterward. Fixed with a
  short self-heal window (up to 30 frames after the panel builds) that
  corrects the active tab once if the real device class differs, but
  stops the instant the user manually picks a tab and stops after the
  frame budget regardless -- see CODE_SUMMARY.txt's GOTCHAS for the full
  account. Verified live: correct tab on a genuine fresh load; a manual
  tab switch afterward sticks (checked well past the heal window).
- **"Palm Faces Cursor" (Cursor Tracking group, checkbox, default off) +
  "Palm Face Rotation (Deg)" slider.** Went through several rounds the
  same day before landing on its current, user-specified design (full
  history in CHANGELOG.txt) -- current behavior: with the checkbox on,
  each hand rotates, around the wrist-crop-plane's own normal axis, by
  the angle from that hand's own position to the live cursor in the
  field's world XY plane (`computeRadialRollDeg()` = `atan2(dx, -dy)`,
  a "compass needle" 2D roll) -- a hand directly below the cursor faces
  up (0 degrees, matching the default fingertip-tracking look), above
  faces down (180), right is 90, left is -90, and so on around the
  compass. With the checkbox off, this same mechanism still runs but at
  a fixed 0-degree base. The Palm Face Rotation slider always adds
  directly onto whatever base angle is in effect. Verified via
  quaternion dot-product checks against the externally-reconstructed
  render-loop math (a genuine live-render check is unreliable here --
  the Browser pane's own rAF suspends while hidden) -- see
  CODE_SUMMARY.txt's GOTCHAS for the full derivation and the earlier
  rounds' own dead-end (a full 3D palm-normal-vector-aim mechanism,
  calibrated across 3 rounds, ultimately replaced entirely once the
  user's real intent turned out to be this simpler 2D rotation).
- **"Default" pose button** (Pose group, next to Saved Poses) -- resets
  every pose slider to its code default and re-poses the whole field in
  one call, reusing existing `syncValue()`/`onWholeHandRotationChange()`
  infrastructure entirely. Answers a direct question about whether this
  had been asked before: yes, but the user had explicitly redirected
  that earlier request toward the preview-only Pose Preview viewer
  instead, so nothing applied a pose to the field until this button.
- **Ported HANDO's own Pose group subgroup structure** (names, nesting,
  groupings, order) — read directly from HANDO's own committed
  `data/processed/dev-panel-settings.json`, since HANDO's `main.js`
  control array has no nesting info at all (the real structure only
  ever existed in HANDO's own saved/drag-organized state). 6 subgroups
  in order: Whole-Hand Rotation & Thumb, Wrist, Index, Middle, Ring,
  Pinky — named descriptively since HANDO's own were still unrenamed
  drag-drop defaults ("New Group", "New Group (3)"–"(7)"). Omits
  HANDO's `baseOnlyCurl*` sliders (don't exist here) and `hideWrist`
  from Wrist (belongs to this project's own separate Arm Length system).
  Added a new generic `organizeGroupSubgroups()` export to `devpanel.js`
  (plus an `initDevPanel({ organizeSubgroups })` hook) so this port
  didn't require forking the shared engine or touching the existing
  Dev-Panel-specific version of this same mechanism.
  **Same-day follow-on fix ("you didnt move the settings into the
  groups"): a saved order predating the port was flattening it right
  back out on real page loads** (this project's own already-documented
  stale-localStorage gotcha, previously only ever worked around by
  clearing storage in a test tab, never actually fixed). Made both
  `organizeGroupSubgroups()` and `organizeDevPanelSubgroups()` idempotent
  and called again after `resetSettings()` restores a saved order.
  Verified by staging a deliberately stale flat Pose order and
  confirming all 6 subgroups still re-nest correctly on reload.
- **Ported the built-in "Dev Panel" chrome-styling group's expansion
  from `TEMPLATE_DEV_PANEL.html`, scoped to "just the chrome group"**
  (the user's own choice when asked how much of the template's growth to
  pull in -- a dynamic per-control Mobile/Landscape visibility system,
  whole-panel Named Setting States, and a Standard Text Settings battery
  were explicitly left for later). Added 24 controls (16 -> 40 total):
  per-category Bold/Letter Spacing/Line Spacing, Capitalize Title,
  Button Font Size/Height/Text Border, Setting Number Font Size, and 4
  new text colors -- each a no-op until touched. (Scroll Strength was
  initially skipped here on a mistaken read of the template's own
  wiring -- corrected and implemented in the next round below.)
  **Found and fixed a real, independently significant bug while
  verifying this live:**
  `index.html`'s stylesheet link had never had a cache-busting query
  string (unlike both JS files), so a browser that had already cached
  `style.css` would silently keep rendering an old version after ANY
  edit to it, not just this one -- fixed by adding `?v=2`, to be bumped
  on every future style.css change same as the JS files already are.
  See CODE_SUMMARY.txt's GOTCHAS for the full account.
- **Same-day follow-on: Scroll Strength (corrected), unlimited group
  nesting, full Dev Panel subgroup reorganization, template-matching
  actual values/colors, and a yellow-text fix — 4 direct requests
  together.** Scroll Strength (wrongly excluded above as unrelated — user
  corrected this directly) is now real: a wheel listener on the panel's
  own scrollable body reads `cfg.dp_scrollStrength` live. The group-level
  drag-reorder's 1-level nesting cap (`setupReorder`'s own `getTargets`)
  is removed — `captureGroup()`/`applyOrder()` were already genuinely
  recursive, only the live-reorder query itself was capped. The built-in
  "Dev Panel" group now matches the template's exact nested structure
  (`MECHANICS`/`PANEL UI`/`TEXT`, with `TEXT` nesting 5 further subgroups)
  via a new `organizeDevPanelSubgroups()`, and every control's default now
  matches the template's real current values/colors (a deliberate visual
  change — accent `#7d8cff` → `#005f8f`, font → Verdana, several
  caps/bold toggles false → true). Also fixed 4 letter-spacing controls
  wrongly marked `perDevice` (the actual cause of a reported "yellow text"
  bug). Verified live after clearing a stale `localStorage` blob that was
  masking the new structure/defaults (confirmed old saved state, not a
  bug, via `cfg` readback first).
- **Mouse Tracking Log port**, matching the template's newer click-
  classification layer onto this project's existing log. `pointerdown`/
  `pointerup` now classify Click/Double-click/Triple-click/Right-click/
  Drag-release (previously just a single undifferentiated click log);
  added viewport-context log entries (`Viewport (start)`/`(resize)`) and a
  "Save" button (Blob + `<a download>`) beside the existing "Copy" button.
  Deliberately did not port touch-gesture classification — this project's
  cursor-tracking mechanic has no touch equivalent. Verified live via
  synthetic pointer/resize events; zero new console errors.
- **Named Setting States ("Saved Dev Settings")** — CLAUDE.md §12d's
  Save/Use/Delete/Set-as-Default-for-whole-panel-snapshots feature, ported
  from the template's `[JS-13b]`. Sits above "Dev Panel" as a real member
  of the reorderable group system (its own drag handle, movable like any
  other group — corrected same day from an earlier standalone-group
  version, per direct follow-up). Reuses the exact same full-panel
  snapshot shape Copy Settings already produced
  (`captureFullPanelState()`/`applyFullPanelState()`, shared by both).
- **Dev Panel group corrected to match Clicko (the gold standard) exactly**
  — direct bug reports (yellow-text mismatch, floating Panel UI settings,
  possible redundant fields, values not matching Clicko). Audited all 41
  fields against Clicko's real source (not CLAUDE.md's own prose, which
  disagreed with Clicko's code on one point). Found and fixed 1 real
  perDevice bug (Scroll Strength) and 5 default-value mismatches; added
  `defMobile`/`defLandscape` control overrides so 6 fields Clicko tunes
  differently per device now seed their own real per-device defaults
  instead of cloning Desktop's. No redundant fields or floating settings
  found in the current code — likely a stale-cache artifact from before
  this session's earlier fixes; cache-busters bumped again regardless.
  Verified live (fresh tab, cleared storage): correct yellow/shared split,
  correct PANEL UI membership, correct per-tab values across all 3 tabs,
  510/510 hands still rendering, zero new console errors.
- **"Enable Label Rename Mode" moved to standalone panel chrome** (above
  "+ Add Group", outside every group) + **right-click delete on Arm
  Length curve dots** + **new "Responsive Wrist Splay" group**, mirroring
  the Wrist Crop/Arm Length group's exact structure (master on/off,
  Default/Reactive/Min-Max-range/Scaling-curve) but adding a per-hand
  extra wrist-splay rotation instead of a crop/position transform.
  Default range (min:0, max:-90) intentionally not numerically ordered —
  min/max name curve endpoints (farthest/nearest hand), not an ordering
  constraint. Verified end-to-end by calling `updateRenderOrder()`
  directly (bypasses the Browser pane's rAF-while-hidden limitation):
  nearest hand measures exactly -90.0 degrees, farthest exactly 0.
- **"Click Hold-Pose" / "Right-Click Hold-Pose"** — 2 independent
  top-level dev-panel groups. On mousedown/right-mousedown, every hand
  transitions to a chosen saved pose (own speed + a distance-from-cursor
  start-time curve/range for per-hand staggering, same widget family as
  Arm Length/Wrist Splay); on release, back to default the same way,
  with its own independent retransition speed/curve/range. Setting a
  trigger's Min/Max Start Time equal collapses the stagger to "every hand
  moves together." Excludes Whole-Hand Rotation (modelRotX/Y/Z) from
  per-hand interpolation by design — those drive a single shared
  `cloneBaseQuat` used by every hand's Arm Length compensation math (see
  CODE_SUMMARY.txt's GOTCHAS for the full reasoning). 2 new generic
  (parameterized) widget builders added for this round's 8 widget
  instances, alongside (not replacing) the existing dedicated Arm Length/
  Wrist Splay ones. 2 real TDZ bugs caught and fixed via live browser
  testing (a top-level setup call referenced a `const` declared later in
  the file); a real dropdown-staleness bug also caught and partially
  fixed (the Target Pose dropdowns didn't refresh when a pose was saved/
  deleted — wired to `refreshSelectOptions()`, though this only covered
  FUTURE saves/deletes, not poses that already existed at page load —
  see the next entry for the real fix). Live-verified via
  `window.__debug.updateRenderOrder()` plus real `PointerEvent` dispatch:
  correct phase transitions, a genuine 81-degree quaternion delta between
  2 distinct target poses, and 6 distinct per-hand start delays from the
  stagger. See CODE_SUMMARY.txt's GOTCHAS and CHANGELOG.txt for full
  detail.
- **Click Hold-Pose follow-ups**: fixed the Target Pose dropdowns not
  showing existing saved poses on page load (the earlier fix above only
  covered future saves/deletes), and added a master on/off checkbox to
  both groups (default off), gating `startClickHoldPose()`. Also found,
  during this round's own live debugging, that
  `refreshSelectOptions('rchpTargetPose')` throws inside devPanel.js's
  own `commit()`/`fillSelectOptions()` for a cause isolated but not
  fully root-caused — mitigated with a `safeRefreshSelectOptions()`
  try/catch wrapper rather than exhaustively debugged further, per
  direct user instruction mid-round to stop verifying and just push.
  See "What's next" below for the follow-up this leaves open.
- **Pose's "Default" button relocated + redefined; transition speed
  cap lowered.** The button moved out of its own Pose-group row into the
  Saved Poses list-picker's own button row (plain DOM injection, no
  devPanel.js UI change), and now applies the currently-SELECTED saved
  pose as the app's default rather than resetting to code defaults —
  both what a fresh page load restores (via a new `saveCurrentSettings()`
  devPanel.js export, triggering a real persisted save immediately) and
  what Click-Hold-Pose's own retransition animates toward (a new mutable
  `poseDefaultValues`, replacing the frozen `POSE_KEY_DEFAULTS` constant
  at both retransition call sites — `POSE_KEY_DEFAULTS` itself is
  unchanged, still used for its original, narrower per-key-fallback job).
  Also lowered the 4 Transition/Retransition Speed sliders' own max
  bound from 5000ms to 700ms (default value unchanged at 400ms). Not
  independently live-verified this round, per direct instruction to stop
  verifying and just push — see "What's next" for the resulting
  follow-up.
- **Fixed a real thumb-posing bug: wrist must be applied before fingers,
  not after.** Direct user report ("the thumb pose doesnt seem
  correct... has to do with the rotation that we had used. Double check
  in reference to hando"). Root cause, found by direct comparison
  against HANDO (same rig asset, already-fixed there): `rThumb1`'s own
  parent bone is `rHand`, the exact bone the wrist rotates; every
  finger's `rotateOnTrueWorldAxis()` reads the bone's CURRENT world
  quaternion, so posing the thumb before the wrist reaches its new
  target reads a stale rotation. The other 4 fingers aren't parented to
  `rHand`, so only the thumb was ever visibly affected. Fixed at all 3
  combined-call sites (`applyAllFingerPoses()`, `previewPosePreset()`,
  `applyPoseValuesToHand()`) by swapping the order. Verified with a real
  quantitative measurement (not just a look): 33.0-degree quaternion
  error with the old order vs. an independent reference, 0.0-degree
  error with the fix — confirmed the test itself was discriminating by
  temporarily reverting and re-measuring the 33.0deg number before
  restoring the fix. See CODE_SUMMARY.txt's GOTCHAS and CHANGELOG.txt
  for the full account.
- **"Click Pose" / "Double-Click Pose"** — fire-and-forget variant of
  Click Hold-Pose (direct follow-up request). A single click or double-
  click (left button, disambiguated by click count via the Mouse
  Tracking Log's own 350ms debounce window) starts every hand's own full
  sequence at once: transition to target → pause at the target for a
  configurable duration (new Pause Duration slider) → retransition back
  to default — runs to completion per-hand with no further mouse
  involvement needed. Each hand's own pause-end/retransition timing is
  computed from THAT hand's own live cursor distance at the moment it
  specifically finishes its pause, never gated on any other hand's
  progress, per direct requirement. Reuses Click Hold-Pose's own
  machinery directly (only new code: the 3-phase per-hand state machine
  and click-count trigger detection). Also disabled OrbitControls' own
  Pan while a Click-Hold-Pose trigger is active (direct request) —
  confirmed cursor-tracking rotation was already unaffected by any
  pose-transition state (a fully separate per-frame step), so nothing
  needed to change there. Live-verified: full phase sequence with real
  target values applied at each stage, correct click/double-click
  disambiguation, pan correctly toggling. See CODE_SUMMARY.txt and
  CHANGELOG.txt for the full account.

## What's next

**HIGH PRIORITY, UNRESOLVED — needs the user's own saved-pose data to
make further progress:** the user reports the Click-Hold-Pose
retransitioned thumb pose is still wrong, confirmed persisting after a
hard refresh (ruling out stale cache). This session could NOT reproduce
it despite the most realistic test constructed (the real
`setSelectedPoseAsDefault()` button flow, persisted through a genuine
page reload, then a real Click-Hold-Pose trigger/release cycle, varying
all 5 thumb-specific keys plus wrist bend/splay together — every trial
measured exactly 0.0 degrees of error). `window.__debug` now exposes
`poseDefaultValues`/`setSelectedPoseAsDefault`/`getSelectedSavedPoseItem`
to support this. Next step: get the user's own actual saved-pose JSON
(via Copy Settings) and their exact repro steps (which saved pose, which
trigger — chp/rchp/click/dblclick, whether Responsive Wrist Splay is
also active) rather than guessing at more synthetic test scenarios —
the discrepancy is real to them and not yet explained by anything this
session could construct.

**Click Pose / Double-Click Pose's own real mouse feel** — verified via
synthetic `pointerup` event dispatch (correct phase sequence, correct
click-count disambiguation, correct target values applied), not an
actual mouse click in the browser. Worth a real click/double-click check
on live hardware, same caveat as Click Hold-Pose's own equivalent item
elsewhere in this file.

**Unresolved (needs a real debugging pass, not flagged for the user's
input — this one's on Claude):** `refreshSelectOptions('rchpTargetPose')`
throws inside devPanel.js's own `commit()`/`fillSelectOptions()`, isolated
via repeated single-key testing (calling it alone for `'chpTargetPose'`
always succeeds; alone for `'rchpTargetPose'` always throws; both controls
are structurally identical, same registration code path) but not actually
root-caused to a specific statement — every static read of `commit()`/
`fillSelectOptions()`/`findCtrl()`/`displayValue()` turned up nothing that
should behave differently between the 2 keys. Currently caught and logged
via a `safeRefreshSelectOptions()` wrapper rather than fixed at the root,
per direct mid-round instruction to stop verifying and push. Worth a
proper `debugger`-based investigation (not just `console.log` markers,
which got lost once in this same round behind a WebGL error flood in a
degraded tab) next time this file is touched — the underlying devPanel.js
issue could affect some other `select` control the same way, not just
this one.

Two open architecture/tuning decisions awaiting the user:
- **Reordering-flash residual pop**: accept it as an inherent limitation
  of render-order-based stacking, tune the smoothing rate further as a
  partial mitigation, or invest in a real alpha cross-fade.
- **Whole-Hand Rotation's own pivot** now differs from HANDO's own palm-
  center pivot once Hide Wrist/Arm Length is combined with it (see
  CODE_SUMMARY.txt's GOTCHAS) — flag if a closer-to-HANDO pivot feel
  matters enough to revisit.

Other open items worth the user's own confirmation:
- **Alternate Row Offset's axis** was implemented as the standard brick/
  hex-pattern reading (shift along the column axis) since "perpendicular
  direction" was ambiguous phrasing — flag if a Z-depth stagger was
  actually meant instead (a 1-line change).
- Real on-device mobile touch-drag/pinch feel, since this environment
  can't produce genuine touch events to verify against.
- **Click Hold-Pose's real mouse feel** — this session verified the
  underlying mechanism via `window.__debug` calls and synthetic
  `PointerEvent` dispatch (a real state-machine/interpolation check, not
  a UI-feel one); the actual click-and-hold experience (does the stagger
  feel right, does the default Transition/Retransition Speed of 400ms
  feel right, does a saved pose need to exist to even see it fire) hasn't
  been eyeballed on a live page. A "Target Pose" left as its default
  empty string does nothing when triggered (no matching saved pose) —
  worth trying it with a real saved pose once one exists.
- Default grid/spacing/toon/outline visual tuning, once seen at real size.
- **Pose is currently shared across every hand** ("for now," per the
  user's own phrasing) — per-hand pose variation/randomization would be a
  new, separately-scoped feature if wanted later, not something this
  round attempted.
- ~~The Saved-Poses-import/Pose-Preview feature added by the concurrent
  HANDO-side session hasn't been independently reviewed or tested~~ —
  update from that session itself (2026-09-13 20:07 EDT): now verified
  live (bone-quaternion comparison proving Use touches only the preview
  hand, never the field/cfg; 2 real bugs found and fixed, preview camera
  framing and preview lighting — see CHANGELOG.txt). OrbitControls on the
  preview canvas couldn't be end-to-end verified via this environment's
  synthetic pointer events (confirmed a sandbox limitation, not a bug —
  the thrown error came from inside OrbitControls' own pointerdown
  handler) — worth a real on-device drag check, same caveat as this
  project's other OrbitControls/touch items above.
- The 2 arm-length widgets' resync-from-Reset path (picking up a value
  devPanel.js's own Reset/Copy-restore writes directly into the hidden
  input without firing an event) is code-reviewed and pattern-matches the
  already-verified drag-commit path, but could NOT be directly observed
  firing in this session's own test environment (a pre-existing,
  documented tool quirk suspends `requestAnimationFrame` entirely when the
  Browser pane isn't displayed) — worth a real on-device Reset-button
  check.
- **The wrong-tab-on-load bug just fixed here (see Recently completed)
  lives in `devpanel.js`, which this project's own file map describes as
  "reused verbatim from HANDO."** The same bug almost certainly exists in
  HANDO's own copy of this file (and any other project sharing it) —
  hasn't been checked or ported back there; flag to the user or the
  relevant HANDO-side session if a fix there is wanted too.

## Open questions / blockers

None currently open.
