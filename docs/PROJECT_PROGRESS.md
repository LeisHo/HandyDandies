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

Nothing in progress — see What's next.

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

## What's next

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

## Open questions / blockers

None currently open.
