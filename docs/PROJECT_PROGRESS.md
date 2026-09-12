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

- Initial build: a three.js field of rigged hands that each independently
  rotate to point at the live cursor, reusing HANDO's `Hand2.glb` rigged
  asset and its generic dev-panel engine.
- Same-day follow-on round, 10 requested items: camera click-drag-to-pan +
  scroll/pinch-to-zoom (OrbitControls with rotation disabled, mobile touch
  gestures included via its own `touches` config, no custom touch code
  needed); decoupled Field Layout entirely from camera/lighting framing
  (confirmed directly — changing row count leaves `camera.position`
  numerically unchanged); independent Row Spacing / Column Spacing sliders
  (previously one shared "Cell Spacing"); Alternate Row Offset (brick-style,
  every other row shifted) and Progressive Row Offset (each row shifted
  further than the last) as 2 mutually-exclusive modes via a checkbox;
  Camera X/Y/Z position sliders (2-way synced with live mouse pan/zoom, per
  HANDO's own pattern); full Lighting/Toon Shading/Outline groups ported
  from HANDO (rim-lit cel shading + a choice of inverted-hull or
  screen-space `OutlinePass` outline, both dev-panel toggleable).
- Fixed a real bug hit mid-build: `window.innerWidth`/`innerHeight` reading
  0 at script-parse time in this dev environment left the renderer/
  EffectComposer/OutlinePass permanently zero-sized (confirmed via
  `GL_INVALID_FRAMEBUFFER_OPERATION` console spam and `renderer.getSize()`
  reporting `[0,0]`) — fixed with a per-frame self-healing size check
  (same fix shape as a previously-documented DOTFLICKO gotcha for this
  exact class of quirk). Separately identified (NOT the same bug, NOT
  fixed by the above): this session's own browser-automation tool reports
  `document.hidden`/`innerWidth === 0` when queried via its JS-execution
  path even on a freshly-foregrounded tab, while a screenshot on the same
  tab at the same moment renders correctly — a tool characteristic, not a
  page defect. See CODE_SUMMARY.txt's GOTCHAS for both, in detail.
- Verified live in the browser: click-drag pans the camera, scroll wheel
  zooms, both confirmed via screenshots showing the view genuinely shift/
  scale; `fieldRows` changed from 6→10 live while `camera.position`
  stayed byte-identical (confirmed via direct `cfg`/scene inspection, not
  just visually); Progressive Row Offset visually produces the expected
  cascading/staircase pattern; both outline techniques (hull-mesh and
  OutlinePass) render correctly when toggled; all new dev-panel groups
  (Field Layout's new controls, Camera, Toon Shading, Outline) are present
  and reachable in the live panel. Mobile touch-drag was exercised under
  viewport emulation and behaved correctly, but this session's own browser
  tool documents that its drags "still arrive as mouse clicks" even under
  mobile emulation — genuine on-device touch/pinch confirmation is still
  the user's own to do.
- 2nd same-day follow-on round: a Camera "Zoom (Distance To Pan Target)"
  slider, 2-way synced with scroll/pinch zoom (confirmed both directions
  live: scrolling moved the slider from 259→172, and setting the slider to
  400 moved the live camera distance to exactly 400); every dev-panel
  default baked directly from the user's own pasted live-tuned settings
  dump (17x30 grid = 510 hands, tuned lighting/toon/camera values, outline
  off by default); render stacking between hands now driven by live
  distance from the cursor target (farthest drawn on top), which required
  `depthTest: false` on both hand materials to actually take visual effect
  — confirmed directly via `renderOrder` values varying correctly with
  each hand's own measured distance.
- Pushed to a new GitHub repo (see CHANGELOG.txt for the exact URL/commit).
- 3rd same-day follow-on: "Prevent Reordering Flash" Debug-group checkbox
  -- freezes a hand's cursor-distance render order the instant it starts
  visually overlapping another hand (approximated via projected on-screen
  circles), resuming live updates only once it clears every overlap it was
  in. Verified directly via a `window.__debug`-driven test (not visually --
  see below): forced 2 hands to identical positions, confirmed their order
  froze even after moving the cursor target far enough to hugely change
  their live distance, then cleared the overlap and confirmed the order
  immediately resumed live-updating.
  During verification, hit and correctly diagnosed a NEW variant of the
  browser-automation tool's rendering-suspension quirk: the tool's own
  Browser PANE (not just a tab) was not currently displayed, which
  suspends `requestAnimationFrame` entirely (confirmed with a vanilla,
  page-code-independent rAF-counting script) -- and since this project's
  own camera-resize self-heal lives inside the rAF loop, the camera was
  stuck with a NaN projection matrix the whole time, corrupting the
  overlap check's screen-projection math in a way that looked like a real
  bug until traced back to the camera state itself. See CODE_SUMMARY.txt's
  own GOTCHAS for the full account -- useful precedent if this shows up
  again.
- Pushed the above (Zoom slider, baked defaults, render order, Reordering
  Flash) to GitHub as commit `6d6ea29`.
- 4th same-day follow-on: fixed a real, user-reported bug in "Prevent
  Reordering Flash" ("certain hands are always rendering on top regardless
  of clearance"). Root cause: the per-HAND freeze design froze a hand's
  ENTIRE order the instant it overlapped ANYTHING -- fine in a sparse view,
  but in a dense/zoomed-in view where nearly every hand is always touching
  some neighbor, no hand ever got a single overlap-free frame to unfreeze
  on, so the whole field froze solid permanently the moment the checkbox
  was turned on. Replaced with a per-PAIR lock design (`pairLocks` Map) --
  every hand's order is now ALWAYS its own live cursor distance, with only
  a small corrective nudge applied to a pair whose live order would
  violate an active lock; a hand can no longer fully disconnect from
  reality. Re-verified the exact repro (240-frame sweep at closer zoom):
  0 hands stuck (previously all 510 were). Also fixed a real TDZ crash
  introduced while relocating the fix (`pairLocks` referenced from
  `animate()`'s own first synchronous call before its declaration further
  down the file had run).
- 5th same-day follow-on: the per-pair lock design above turned out to
  have its OWN real bug, caught by the user immediately ("better but not
  fully resolved... certain hands incorrectly rendering above a hand
  further than the cursor" + "flashing... previous build had no flashes,
  but it now does"). Root-caused via direct measurement (not guessing):
  sampling ~87,000 random pairs whose true distances differed by more
  than 15 world units, 21% still rendered in the WRONG order -- the
  unconditional "pin to partner+epsilon" correction compounds through
  chains of simultaneous locks in a dense field, collapsing many
  unrelated hands' values toward whichever hand anchors that chain.
  Replaced the entire lock/pin system with per-hand exponential smoothing:
  a hand not currently overlapping anything snaps straight to its own
  live distance; one that IS overlapping something blends toward its own
  live distance (never derived from another hand's value at all) instead
  of snapping. Measured against the same 87,000-pair test: under 0.1%
  wrong-order rate (vs. the lock design's 21%), 0 stuck hands across 150
  simulated frames, and roughly half the flip rate of no-fix-at-all for
  hands actually overlapping on screen. Trade-off, disclosed to the user:
  this is no longer a literal "won't change until they clear" freeze --
  it's a fast blend that avoids instant pops without the 2 failure modes
  a literal freeze/pin kept producing at this field's actual density.
- 6th same-day follow-on: fixed the actual root cause behind lingering
  flashing the user pinpointed precisely ("the thumb... doesnt seem to be
  accounted for... only happens when I move the cursor left and right").
  The overlap check's circle was centered at `wrapper.position` with
  radius = half the wrist-to-fingertip BONE distance -- measured the real
  mesh's bounding sphere directly and found it undersized by ~5x and
  mis-centered by ~13 world units, because the visible mesh includes a
  full forearm the bone measurement never accounted for. Fixed by
  measuring the mesh's own bounding sphere once at load and transforming
  its center through each hand's real live transform every frame. Verified
  concretely: the same grid-neighbor overlap count that found 326,012
  overlaps across a 150-frame sweep with the old circle found 975,875 with
  the corrected one (3x more genuine overlaps now actually protected) --
  this directly explains why the thumb was popping through before (those
  overlaps had ZERO flash protection, since the old circle never even
  detected them). **Not yet committed/pushed** -- ask before doing so.
- Investigation-only follow-up (no code change): user still reported
  flashing after the sphere fix, specifically "flashing above and below
  it on that vertical axis" when moving left/right, thumb popping onto
  the neighboring hand. Traced a specific vertically-adjacent pair
  frame-by-frame through a horizontal-only sweep and found the REAL
  explanation: this is a structural limitation, not a further bug.
  `renderOrder` is a discrete sort key with no partial/blended state --
  the underlying smoothed values cross ZERO discontinuity, perfectly
  cleanly, frame over frame, but the instant they cross zero, the actual
  draw order (visible stacking) flips completely in one frame, same as it
  would with no smoothing at all. The prior 2 fixes are both still doing
  real, measured work (correct overall ordering; damping noise-driven
  spurious crossings) but neither, nor further tuning of the same
  mechanism, can eliminate the pop at a GENUINE crossing (the cursor
  actually causing 2 hands' true order to swap) -- that would need a
  fundamentally different technique (e.g. a real alpha cross-fade during
  the crossing window), a materially bigger change flagged to the user as
  a scope decision rather than attempted unilaterally.

- 7th same-day follow-on: fixed the toon-shading-noise bug, after 2 wrong
  diagnoses in this same investigation were each directly disproven by the
  user. First theory (real mesh geometry + grazing light) was disproven by
  "but that noise doesnt occur in HANDO" (identical asset). Second theory
  (this project's zero-ambient/full-contrast toon recipe vs. HANDO's
  softer one) was disproven by "In Hando, even with 0 ambient light and 2
  step toon shader it still doesnt have that noise." The user then gave
  the decisive clue directly: "The noise is only present in areas where
  the hand is overlapping itself. So I can somewhat see through the hand
  itself and the noise represents the obscured surfaces behind the
  frontmost surface" -- plus "ive used many hand poses in HANDO" (and it
  never shows this, regardless of pose). That's the exact signature of
  `depthTest:false` self-occlusion bleed-through -- confirmed directly via
  a targeted pixel-diff (not the earlier coarse whole-canvas histogram,
  which is why an early pass in this same investigation wrongly measured
  only an 8% effect): isolated a single hand in its bind pose where a
  finger overlaps the palm, and found 8.2% of pixels in that exact overlap
  region differ between `depthTest:true`/`false`, with `false` showing a
  wrongly-lit back surface bleeding through the correctly-shadowed front
  one. Fixed by restoring `depthTest:true` on both hand materials (fill +
  outline) and giving each hand's own fill + outline mesh an
  `onBeforeRender = (r) => r.clearDepth()` hook instead -- clears the
  depth buffer immediately before each hand's own draw call, so a hand's
  own triangles depth-test correctly against each other (self-occlusion
  fixed) while cross-hand stacking is still decided purely by draw order
  (`renderOrder`, unchanged, from cursor distance) rather than real camera
  depth. Verified live: the same overlap region that showed the 8.2%
  bleed-through now reads one clean luminance value; a controlled 2-hand
  test (same screen position, 60 world units apart in real depth, farther
  hand given the higher renderOrder and a `MeshBasicMaterial` red tint to
  remove shader-uniform ambiguity from the test itself) confirmed the
  farther-but-later-drawn hand still wins 100% of the overlap, proving
  cross-hand ordering survived the change; 0 console errors; `renderOrder`
  still correlates perfectly with cursor distance across all 510 hands (0
  inversions). Corrected `CODE_SUMMARY.txt`'s GOTCHAS entries (3 separate
  places referenced the old `depthTest:false` architecture or the 2 wrong
  theories) to describe the actual final root cause and fix. Not yet
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

## Open questions / blockers

None currently open.
