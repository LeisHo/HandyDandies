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
- 8th same-day follow-on: **ported HANDO's own Pose dev-panel group**
  (direct request: "Add the pose settings from Hando. For now, the pose
  settings apply to every hand" + "Be sure to provide the Hide Wrist (%)
  setting"). 25 finger sliders (Curl/Splay/2nd-Segment-Splay/Curl-Bias/
  Tip-Twist x5), Wrist Bend/Splay, Whole-Hand Rotation X/Y/Z, and Hide
  Wrist -- applied identically to every hand (a shared pose, not yet
  per-hand). Ported near-verbatim from HANDO's own `applyCurlToSkeleton`/
  `applyWristPose` (same rig, same live-measured axis/sign/magnitude
  tables), but looping over every hand's own distinct skeleton clone
  rather than 1-2 posable models.

  Hide Wrist's own explicit requirement -- "a wrist that is cut will be
  shifted such that the cut wrist base should still correspond to the
  Field Layout points" -- required NEW math HANDO itself never needed
  (a single static hand has no grid to stay aligned with): each hand's
  `clone.position` is solved so the CURRENT visible cut point always
  lands exactly on that hand's own Field Layout grid point, for any
  Whole-Hand Rotation. Verified directly, repeatedly, via live bone-
  position measurement (not just code reading): isolated Hide Wrist,
  Hide Wrist + single/all rotation axes, multiple hands, multiple grid
  positions -- every case landed within floating-point precision of
  exactly 0 distance from the grid point.

  3 real bugs were found and fixed via direct empirical testing during
  this round, all documented in detail in `CODE_SUMMARY.txt`'s GOTCHAS:
  (1) a first position-compensation attempt preserved HANDO's own palm-
  center rotation pivot, which measurably drifted 0.27 world units off
  the grid point once combined with Whole-Hand Rotation -- resolved in
  grid-alignment's favor, a disclosed behavior difference from HANDO;
  (2) that same attempt also stored a direction+distance pair where an
  absolute position was needed, silently correct in isolation but wrong
  once rotation was combined in; (3) HANDO's own finger-curl axis math
  assumes no rotation layer beyond its own, but this project's hands
  have an EXTRA one (`wrapper`'s per-frame cursor-tracking) -- confirmed
  live that 2 differently-facing hands produced different local bone
  quaternions for identical slider values, fixed by excluding `wrapper`'s
  rotation from the axis conversion. Re-verified after each fix. Not yet
  committed/pushed.

## What's next

Awaiting the user's decision on the reordering-flash residual pop: accept
it as an inherent limitation of render-order-based stacking, tune the
smoothing rate further as a partial mitigation, or invest in a real alpha
cross-fade.

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
- Whole-Hand Rotation's own rotation pivot now differs from HANDO's own
  palm-center pivot once Hide Wrist is combined with it (see
  CODE_SUMMARY.txt's GOTCHAS) — flag if a closer-to-HANDO pivot feel
  matters enough to revisit.

## Open questions / blockers

None currently open.
