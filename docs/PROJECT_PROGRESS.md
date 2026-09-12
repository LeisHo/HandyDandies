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

## What's next

No specific next action is currently queued. Open items worth the user's
own confirmation:
- **Alternate Row Offset's axis** was implemented as the standard brick/
  hex-pattern reading (shift along the column axis) since "perpendicular
  direction" was ambiguous phrasing — flag if a Z-depth stagger was
  actually meant instead (a 1-line change).
- Real on-device mobile touch-drag/pinch feel, since this environment
  can't produce genuine touch events to verify against.
- Default grid/spacing/toon/outline visual tuning, once seen at real size.

## Open questions / blockers

None currently open.
