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

**SHIPPED 2026-09-19: HANDO camera/lighting import pipeline for the
Loading Preview + its own local saved-camera/lighting lists.** Found
the REAL reason "Left" (a HANDO-imported camera) made the Loading
Preview hand disappear: HANDY DANDIES rotates every hand clone by
`alignQuat` (a per-model bind-pose alignment HANDO has no equivalent
of), so HANDO's own camera/lighting coordinates are in a different
frame. Validated the fix mathematically (a standalone, never-committed
Node script measuring this GLB's own bind pose independently) before
building any UI, then built `convertHandoCameraPreset()`/
`convertHandoLightingPreset()`, a new small `ctrl.importTransform`
hook in devPanel.js's existing clipboard-import flow, and 2 new local
list-pickers (`loadingPreviewSavedCameras`,
`loadingPreviewSavedLighting`) separate from the main field's own
(which stay untouched -- a different, field-radius-scale context
HANDO has no equivalent of). Live-verified end-to-end: applying the
converted "Left" camera produced a clearly recognizable, well-framed
hand; converted default HANDO lighting produced clean, correctly-
directed shading. See CHANGELOG.txt's matching 2026-09-19 entry for
the full derivation and verification trail.

**SHIPPED 2026-09-19: 3 rotation sliders (X/Y/Z, Deg) for the Loading
Preview + a "Hide Hands" checkbox in Field Layout.** Rotation folds
directly into `loadingPreviewBaseQuat` (same pattern Pose Preview's own
Whole Hand Rotation already uses) so it survives every frame's pose
reapplication and stays in sync with finger-pose math. Hide Hands
toggles each hand's whole wrapper Group, wired into both the checkbox's
own onChange and `rebuildField()`. Live-verified with the field hidden
first (to avoid a repeat of the earlier false-positive mistake below) --
the preview's own silhouette visibly changed shape for both X=90 and
Y=90. See CHANGELOG.txt's matching 2026-09-19 entry.

**SHIPPED 2026-09-17: fixed the loading hand preview not being visible
in either mode (real root cause, superseding the entry below).** The
previous entry's z-index/race fixes and "confirmed via screenshot"
claim were incomplete/likely mistaken -- direct user follow-up
("I dont see the loading hand" in both the real-startup screen and the
live-toggle checkbox) led to checking the real, git-tracked settings
log directly: `loadingPreviewSize` was persisted at `2000` (5x past
its own coded max of 400, default 160) across all 3 device scopes,
almost certainly typed in via the dev panel's own auto-expanding-range
feature (§12h) at some earlier point. Since both modes share the same
`resizeLoadingPreview()` call, one bad data value explains both
reports at once. Fixed by resetting `loadingPreviewSize` to `160` in
`data/processed/dev-panel-settings.json` -- a data correction, not a
code change; deliberately did not add a code-level clamp, since §12h's
type-any-value behavior is a deliberate design choice. See
CHANGELOG.txt's matching 2026-09-17 correction entry for the full
account, including an honest re-read of why the prior screenshot
verification was likely a false positive.

**SHIPPED 2026-09-17 (prior entry, fixes believed still valid on their
own merits): fixed "Show Loading Preview (Live)" checkbox reported as
not working.** 2 real fixes: (1) checking the box before the model
finished loading silently stranded it forever (nothing re-checked its
state once the model became ready except the much-later
`tryStartField()`) -- fixed by re-checking it the instant
`modelMeasurementsReady` flips true; (2) `#loadingPreviewCanvas` had
no explicit `z-index` -- added `z-index: 100000` per the direct
request ("it should just show ontop of everything in browser"). Also
found and fixed a real gap in this project's OWN cache-busting
discipline: `style.css` had never had its own `?v=` bumped despite 2
real content changes this session -- now at `?v=13`. See
CHANGELOG.txt's matching 2026-09-17 entry for the full account.

**SHIPPED 2026-09-17: on-demand live Loading Preview toggle + X/Y
position offset sliders, on top of the pre-existing `loadingPreviewEnabled`
(shown only during the real page-load screen).** Scoped via an
AskUserQuestion exchange -- user chose the bigger option: a toggle that
also works AFTER the real hand field has already started rendering, not
just during the original load screen. Required a 2nd, fully independent
`requestAnimationFrame` loop (`startLoadingPreviewLiveLoop()`) since the
main `animate()` loop permanently stops driving the preview once the
real field starts, by original design -- toggling safely repeatable
(disposes the prior `WebGLRenderer` before rebuilding). New
`loadingPreviewOffsetX`/`Y` sliders position it via `translate(-50%,
-50%) translate(Xpx, Ypx)`; `#loadingPreviewCanvas` moved out from
inside `#loading` in `index.html` so its visibility no longer inherits
`#loading`'s own hidden-on-field-start state. Fully live-verified
(toggle on/off/on cycles, offset transform math checked against 2
different values, no console errors, and a regression check confirming
the original load-screen preview still works after the markup move).
See CHANGELOG.txt's matching 2026-09-17 entry for the full account.

**SHIPPED 2026-09-17: fixed Saved Camera presets silently no-op'ing on
"Use" when authored/imported with a shorter x/y/z/tx/ty/tz/fov field
naming instead of this app's own internal cameraX/targetX/cameraFov
names.** A new `normalizeCameraPresetItem()` helper (main.js) accepts
either naming at all 3 real read sites (the main "Use" button, "Set as
Default," and the Loading Preview's own camera override) without
mutating the original saved item. Lighting needed no equivalent fix --
its own preset field names already matched. Verified via an isolated
`node -e` check against the user's own exact pasted JSON (not a full
live app load -- blocked again by the environment issue below). See
CHANGELOG.txt's matching entry for the full account.

**SHIPPED 2026-09-17: ported the dev-panel template's Add Group/fold-
select/header-icon-buttons/search, PLUS Delete Group/Setting + Undo,
into this project's own devPanel.js copy.** Header now has 6 icon
buttons total (Text Edit Mode, Add Group, Collapse All, Delete Group/
Setting, Undo, Collapse); Delete refuses only the "Dev Panel" built-in
group (walking the full ancestor chain); Undo is a real infinite,
session-scoped stack (value snapshots + a separate delete-restore entry
kind), cleared on Save/Sync, with the template's own documented self-
reference-bug guard ported verbatim. All verified live with real
`pointerdown`+`click` event sequences (not `.click()`, which would hide
that exact bug). See CHANGELOG.txt's matching 2026-09-17 entries for the
full account, including which 2 of the original 4 template changes
turned out architecturally inapplicable here.

**SHIPPED 2026-09-17: the "Independent from Desktop" per-control mobile/
landscape checkbox system (§12f-1), redesigned (not ported 1:1) for
this project's one-row-per-control architecture -- fully live-verified
(one real bug found and fixed along the way: `resetSettings()` never
painted the new checkbox chrome for a brand-new visitor with nothing
saved yet), then applied to all 11 existing "Click Function" trigger
groups (Click Hold-Pose, Right-Click Hold-Pose, Double Click Hold,
Triple-Click Hold, Quadruple-Click Hold, Click Pose, Double-Click Pose,
Triple-Click Pose, Quadruple-Click Pose, Right Click, Tween) with zero
change to any of their currently-saved values.** The engine itself grew
a real safety property in the process: `isDevRowIndependent()` now
defaults an unset control to its own `perDevice` flag rather than a
blanket "mirrors Desktop" -- so retrofitting this checkbox system onto
an ALREADY `perDevice: true` control (none of these 11 groups happen to
have one today, confirmed by direct reading, but a future one might)
can never silently start overwriting its already-independent Mobile/
Landscape values. Applied via one shared `withDynamicDevice()` helper
in `main.js`, not 60 individual edits. See CHANGELOG.txt's 2 matching
2026-09-17 entries for the full account, including a disclosed gap:
live verification against the real, now-larger `main.js` was blocked
this round by the same environment truncation issue documented in the
prior entry (confirmed via `curl` to be that issue again, not a
regression) -- static/unit-level verification (`node --check`, an
isolated `node -e` test of the exclusion logic, direct reading
confirming no `perDevice: true` in scope) is what backs this entry's
confidence instead.

**IN PROGRESS, large multi-slice undertaking: a full rebuild of the
Click Function settings system** (direct request, spec A-L, since grown
further mid-implementation). **Phase 1 (per-trigger settings schema,
all 10 triggers) is DONE**: Mode 'Tween'->'Sequence' rename + label
unification (with a live-data migration), Offset/Rotation (camera-
relative, ramping, composes additively via `applyOffsetRotationToHand()`),
Animation Speed Curve/Start Time Curve/Retransition on-off gates
(Single Pose mode), and Sequence Mode (Count/Loop/Oscillate) for the 5
fire-and-forget triggers (e.g. "run 3 times, then stop"). **Phase 2
(Sequence-mode release behavior, hold-based triggers only) is also
DONE**: On Release Mode (Stop/Complete Sequence -- a released hold can
now finish its current tween pass/lap instead of aborting immediately)
+ Trigger All Hands (forces every hand to release simultaneously,
bypassing the normal per-hand stagger). The spec's own "Tween Stop
Start Time Curve/Delay" was deliberately deferred, flagged to the user
as likely duplicating the already-existing Tween Retransition Start
Time Curve/Range rather than silently built or silently dropped.

**The separately-requested Loading Preview upgrade is also DONE**:
Camera/Lighting selectors (own separate scene, its own camera/lights --
not the live main-scene ones) + the same Sequence Mode (Count/Loop/
Oscillate) system, defaulting to 'Loop' (unbounded) rather than 'Count'
to preserve the existing always-loop-forever behavior for current users.

All of the above verified live via `window.__debug` (this session's
browser-automation tool has a documented rAF-not-firing issue for this
project -- see CLAUDE.md's own Gotchas -- so verification bypasses the
render loop and drives the update functions directly, either with a
manufactured `now` for the per-hand trigger functions or real elapsed
wall-clock time for the Loading Preview's own `performance.now()`-based
one).

**Phase 4 (dynamic "Add Click Function" architecture) has now shipped 2
slices.** Users can create an unbounded number of custom click functions
at runtime, both fire-and-forget ("+ Add Click Function") AND hold-based
("+ Add Click+Hold Function", added in slice 2 -- reuses
`makeClickHoldPoseGroup()`, the same factory chp/rchp/etc. use). Each
custom function is tagged with a `family` ('desktop'/'mobile', read from
whichever dev-panel tab is active when the button is clicked) that
hides its group outside that family and narrows its own Type options
(desktop: Click/Right Click/Click+Hold/Right Click+Hold; mobile: Click/
Click+Hold -- no right-click on touch). Custom hold functions piggyback
on chp/rchp's own existing pointerdown/pointerup machinery, getting
per-hand stagger/Sequence mode/Loop Mode/Offset/Rotation/On Release Mode
for free. New custom functions insert right under the "Custom Click
Functions" anchor group (newest closest to it), not at the panel's
bottom.

**NEW this round: Offset/Rotation/Animation Speed Curve/Start Time
Curve/Retransition are now "mandatory gated subgroups"** across ALL 10
static triggers and every custom function -- each cluster is a real
nested collapsible group with its own On/Off checkbox living in the
GROUP'S OWN HEADER/LABEL (not a separate settings row); when off, the
group shows as empty. Required one small devPanel.js addition (a
click-guard so the relocated checkbox doesn't also toggle group
collapse) plus exporting `createGroupElement()` -- otherwise pure reuse
of already-proven wiring (the checkbox keeps its own `data-key`, so
Save/Reset/restore needed zero changes). Also fixed panel-wide: the 2nd
dynamicDevice checkbox ("Independent from Desktop") is now right-
aligned to the row/header's own right edge everywhere, not just
wherever its row's own control happened to end.

Found and fixed 3 real bugs across these 2 slices: `getOrInitHandCP()`/
`getOrInitHandCHP()` didn't backfill missing per-trigger state for an
already-touched hand when their trigger-key arrays grow at runtime
(would have crashed the next frame a new custom function fired for that
hand); Animation Speed Curve's own fields never got their interactive
curve-graph widget (now fixed for all 10 existing triggers too).

**Deliberately scoped down**, each disclosed rather than silently
skipped: Scroll (desktop) and Multi-Point Touch (mobile) Types --
genuinely new trigger-detection subsystems, not built for ANY trigger
yet; click-count selector; duplicate-setting validation; automatic
hold-timing conflict resolution for an arbitrary number of custom
Click+Hold functions; a delete-function button (the dev panel's own
Delete Group/Setting icon removes the DOM group but won't clean up this
feature's own bookkeeping).

**Still ahead**: the 2 gaps above (Scroll, Multi-Point); reordering the
10 fixed groups' own settings to match the original spec's B ordering;
the deferred "Tween Stop" curve question (Phase 2, likely duplicates
the existing Tween Retransition Start Time Curve/Range); click-count
selection and function deletion for Custom Click Functions; a multi-
sequence-plus-hold chain builder; bezier curve handles; duplicate-
setting validation. See CHANGELOG.txt's matching entries for full
slice-by-slice detail; this is genuinely large and will keep spanning
multiple rounds.

**SHIPPED 2026-09-17: dev-panel groups can now be individually locked
against reordering** (`.dp-group-lock-icon`, 🔒/🔓, in each group's title
bar) -- ported from Clicko's own dev panel, direct request. A locked
group's own settings can't be dragged/reordered within it (or moved into
another group), but the group itself can still be freely dragged/
reordered among other groups. Persisted through the existing
`captureGroup()`/`applyOrder()` pipeline (same as `collapsed` state) --
automatically covered by Copy/Save/Reset/Saved-Dev-Settings, no separate
wiring needed. **Now ported to HANDO too** (the other half of the
original request), including a same-day follow-up inverting the lock
icon's own opacity behavior (locked = full opacity by default, dims on
hover -- the exact inverse of unlocked) in both projects. See
CHANGELOG.txt's matching entries for full verification detail.

**SHIPPED 2026-09-17: quad-click-hold root cause fixed (a live-settings
value, not a code bug), plus new saveable Lighting presets.**
`quadClickHoldHoldConfirmMs` was `310ms`, below the documented `500ms`
invariant (`MOUSE_LOG_HELD_DRAG_MS`) every `CLICK_HOLD_KEYS` member's
own confirm delay must meet -- corrected to `500` (matching
tripleClickHold's own already-correct value) across all 3 device
blocks. Separately, a new `savedLighting` list-picker (Lighting group)
mirrors Camera's own `savedCameras` exactly -- Save/Use/Rename/Delete
for the 8 light sliders/colors, applied directly to the live scene.
Verified via direct capture->mutate->reapply round trip against both
`cfg` and the real THREE.js light objects. See CHANGELOG.txt's matching
entry for the full account, including why live event-dispatch testing
of the click-hold gesture itself was abandoned as unreliable in this
environment.

**Housekeeping flag, not yet acted on:** this doc has drifted well past
its own "live picture, not a log" rule (CLAUDE.md §4c) -- most of what
follows below is fully-resolved 2026-09-15/16 history that CHANGELOG.txt
already preserves permanently. Worth a dedicated pruning pass; not done
as a side effect of this entry since evaluating each item's continued
relevance is its own real task, not a 2-minute cleanup.

**SHIPPED 2026-09-16: Loading Preview -- a single animated hand cycles
through a Tween Sequence on the loading screen while the full field
builds behind it.** New "Loading Preview" dev-panel group:
`loadingPreviewEnabled` (checkbox), `loadingMinTimeMs` (min loading
time, ms), `loadingPreviewTweenSelector`, `loadingPreviewSpeedMs`,
`loadingPreviewSize`. A 3rd independent hand-preview instance (alongside
the main field and Pose Preview), built the instant the base model
finishes loading rather than waiting on the full field. Verified via
direct in-page inspection across multiple successful loads (scene/
camera/hand construction, error-free render loop, a pixel-grid sample
confirming a correctly-positioned silhouette, and a timing test
confirming the min-loading-time gate) after a clean visual screenshot
proved unobtainable due to unrelated test-environment friction (the dev
panel covering the narrow test viewport) -- see CHANGELOG.txt's matching
entry for the full verification account. **Worth a quick visual check on
the user's own next real page load.**

**Triple/quad-click -- multi-round thread, 2026-09-16, now converged on a
tunable setting instead of repeated hardcoded re-tuning.** 1st report
("registers as double-click first") -> `tripleClickEnabled`/
`quadClickEnabled` were off + 350ms window too tight -> flipped both to
`true`, widened to 450ms. 2nd report ("dont work even when turned on")
-> enabled but `tripleClickTweenSelector`/`quadClickTargetPose` were
both empty, a live-settings config gap (not a bug) -- left for the user
to pick, per their own creative choice. 3rd report ("quad click triggers
triple click first") -> 450ms still too tight for a genuine 4-click
attempt (3 gaps, each a chance to run long) -- converted the whole thing
from a hardcoded constant into a dev-panel slider,
`cfg.multiClickWindowMs` (Debug group, def 600ms), so further tuning
doesn't need another code change. **Awaiting the user's own confirmation**
that a real quad-click now fires correctly, and that they've picked a
target pose/tween for triple/quad-click if they want to see them
actually pose the hands.

**SHIPPED 2026-09-16: Cursor Tracking settings are now independently
adjustable per Desktop/Mobile/Landscape** (`perDevice: true` on all 6
controls) -- direct request. Reverses this project's own prior standing
design note (below, under "Dev-panel behavior") that Cursor Tracking was
deliberately shared since the mechanic has no touch equivalent; that
note is corrected in place in `CLAUDE.md`, not deleted, per this
project's own established convention. Live settings already held
identical values across all 3 device blocks, so this is a safe,
non-disruptive transition.

**Verification gap (applies to all 3 shipped items above, and to the
Responsive Wrist Splay stagger fix further below):** repeated live
full-app load attempts this whole round hit the same recurring local
test-server issue (`net::ERR_CONNECTION_RESET` on `main.js` specifically
when loaded as part of the full page) -- `node --check` passes and each
change was reviewed directly, but none of these 3 items have been
re-verified live this session. Recommend the user confirm all 3 on their
own device once this deploys.

**Desktop lag investigation, 2026-09-16 -- COMPLETE, root cause fixed,
verification PARTIAL (environmentally limited, disclosed).** ("why is
the app so laggy on desktop but very smooth on mobile" -> traced through
3 wrong/refuted hypotheses -- a settings-restore race real but not the
cause; a shader-compile cost real (49.8ms/240 hands) but trivial; the
user's own triple/quad-click-feature hypothesis checked and ruled out
(disabled on both devices) -- to the real, confirmed cause via the
user's own real frame-profiler console output: "Responsive Wrist Splay"
forcing a full per-hand repose (wrist + all 5 fingers) EVERY frame for
EVERY hand whenever its master toggle is on, ~25-42ms/frame at 240
hands, matching an already-documented 2026-09-15 measurement (not a new
regression).** Fixed with a new tunable stagger (`wristSplayReposeStagger`
dev-panel slider, def 4) that spreads each hand's own reactive-splay
repose across N frames (round-robin by field index) instead of doing
every hand's repose every single frame -- the "something in between"
option the user asked for over disabling the feature outright or a
from-scratch math optimization. A real TDZ crash introduced while
building this (a `let` declared too late in the file, below where
`animate()` already calls into it on its first synchronous invocation)
was caught via live testing and fixed by moving the declaration to the
top of the file. **Verification gap, disclosed honestly:** repeated live
full-app reloads hit this project's own previously-documented local
test-server flakiness (`net::ERR_CONNECTION_RESET` specifically on
`main.js` when loaded as part of the full page, never when fetched
standalone) across 3 different server processes/ports; one clean load
DID confirm the new setting seeds correctly and the field still builds,
and `node --check` + a standalone fetch confirm the file itself is
syntactically sound post-fix -- but the stagger's actual runtime
frame-cost reduction has NOT been directly re-measured live this
session. Recommend the user confirm the fix (and check the new
"Reactive Splay Update Stagger" slider works as expected) on their own
device once this deploys. See CHANGELOG.txt's matching entry for the
full account.

**SHIPPED 2026-09-16: Triple-Click / Triple-Click Hold / Quadruple-Click
/ Quadruple-Click Hold -- 4 new trigger groups, direct request.** Extends
both trigger families (fire-and-forget Click Pose, hold-based Click-
Hold-Pose) from 2-deep to 4-deep, reusing their existing generic
per-key architecture almost entirely for free. Real work was in the 2
gesture-detection layers: the click-count debounce (hardcoded 1-vs-2+ ->
a lookup table) and dcHold's own binary "was the last release clean"
flag (generalized into a running chain count so a 3rd/4th press can also
become a hold). **A real bug was caught and fixed BEFORE shipping, via
live testing, not a user report:** the chain-count rewrite's first
version treated a chain-triggered hold's own brief "starts immediately
on press" pulse as proof the chain was over, resetting it on every
intermediate click of a longer chain -- a click-click-HOLD sequence
meant to become tripleClickHold never committed. Fixed by decoupling
"does the chain continue" from "did a hold happen to pulse on this
press." Verified live: 1/2/3/4-click dispatch, dcHold regression,
tripleClickHold/quadClickHold both committing correctly, and a plain
3-click sequence firing only `tripleClick` with no stuck hold state. See
CHANGELOG.txt's matching entry for full detail.

**MAJOR devPanel.js bug fixed 2026-09-16: real (non-`?dev=1`) visitors
of the production site never received anything saved via the dev
panel's own Save/Sync button.** Direct user report ("`?dev=1` looks
fine, the bare URL shows old settings, incognito rules out cache").
`initDevPanel()` had a hard `if (!DEV_MODE) return cfg` immediately
after seeding `cfg` with pure code defaults -- the actual settings
restore (`resetSettings()`, fetching real saved/remote values) only ever
ran later, inside the DEV_MODE-only panel-building path this early
return skipped past entirely. Since DEV_MODE requires `?dev=1`/
`localhost`/`127.0.0.1`/`file:`, a normal production visitor has NEVER
seen anything tuned/saved via the dev panel, on this or any other
project sharing this engine. Fixed with a new `restoreValuesForEveryVisitor()`
call, unconditional, before the DEV_MODE check. Verified the restore
mechanism itself works correctly from its new call site (mocked a
delayed remote-settings fetch, confirmed `cfg`/`poseDefaultValues` both
update correctly, panel/field still render fine afterward) -- the actual
"does a non-dev visitor now get real settings" behavior still needs
confirming on the live production URL once this deploys, since
`localhost` is unconditionally DEV_MODE and can't exercise that branch.

**Middle/ring finger "outstretched for a split second" during
retransition -- ACTUALLY ROOT-CAUSED AND FIXED 2026-09-16 (the earlier
"re-exporting the Fist pose fixed it" report turned out to be
coincidental, not the real fix -- corrected here in place rather than
left as a stale record).** Real cause: `poseDefaultValues` (what every
retransition-to-default targets) was captured from `cfg` exactly ONCE,
synchronously, right after `initDevPanel()` returns -- but that
function's own remote-settings restore is ASYNCHRONOUS, so `cfg` still
held pure code defaults at that exact moment; the real saved values only
land moments later. Confirmed directly on production:
`poseDefaultValues.curlMiddle`/`curlRing` exactly matched their own code
defaults (-89/-95) while the REAL restored `cfg` values (92/98,
matching the user's actual Fist pose) were ~180-190 points apart -- a
genuine 2-frame jump between "retransition finishes at the wrong
default" and "idle repose snaps to the real one," invisible to the
original investigation's own single-retransition bone-tracing (which
never looked at the frame AFTER a retransition completes). Fixed with a
new `opts.onRestore` hook in devPanel.js's own `initDevPanel()`, firing
once real values actually land in `cfg`; verified live via a mocked
delayed remote-settings response. See CHANGELOG.txt's matching entry for
the full account, including why the original "Fist pose" theory was a
plausible-but-wrong read of a symptom that was actually about the
DEFAULT pose object, not any one saved pose's own data.

**Also investigated same day: "double click still not acting right,
something triggered before the double click or click hold sequence."**
Found and fixed one real data issue (the live `chpHoldConfirmMs`/
`rchpHoldConfirmMs` had drifted back to a stale 150ms, the same bug
class already fixed once before) but could NOT independently reproduce
a separate code-level cause beyond the `poseDefaultValues` fix above --
live-testing showed the current architecture already gates a hold's
visible commit behind both HoldConfirmMs AND a much longer distance-
based delay, so 150ms alone couldn't explain a visible flash. The
`poseDefaultValues` fix is the strongest evidence-backed candidate for
what's actually being seen (every double-click/click-hold ends in a
retransition-to-default, the exact phase that bug corrupted) -- **not
yet independently confirmed by the user for this specific symptom.**
If it persists after this deploy, a fresh screen recording of the exact
sequence is the fastest next step.

**SHIPPED 2026-09-16, 6 more direct-request items (interruption
continuity, Tween Retransition settings, grouped dropdowns, combined
Import button, 2 Pose Preview corrections) -- all verified live, see
CHANGELOG.txt's matching entry for full verification detail:**
- A hand interrupted mid-transition by a NEW trigger (any of chp/rchp/
  dcHold/click/dblclick/rc) no longer snaps to a stale default/trigger-
  time snapshot -- it continues its EXISTING transition, uninterrupted,
  until its own distance-based delay for the new trigger elapses, THEN
  smoothly continues from wherever it actually is. Rebuilt via a genuine
  2-stage deferred claim (arm the delay, commit later, reading the FROM
  value fresh at commit time from a new `hand._lastPoseValues`).
- Click-Hold-Pose's Tween mode now has its own dedicated Retransition
  Speed/Curve/Range (previously silently shared -- and hidden from view
  -- with Single Pose mode's own).
- Every Target-Pose/Tween-Sequence dropdown (and the Tween Poses multi-
  select) now renders `<optgroup>` sections matching whatever groups the
  underlying saved poses/sequences were organized into.
- A combined "Import" button (Tween group) imports both pose data AND
  tween sequence data from one clipboard paste in a single action --
  corrected same day to accept the REAL export key names
  (`poses`/`tweenSequences`, a HANDO-family format) after the user
  pasted their own actual payload; extra HANDO-only pose fields (wrist/
  shoulder/elbow/forearm rig fields this project doesn't have) import
  harmlessly as unread extras.
- The Pose Preview's own "Run" tween is no longer affected by Global
  Pause (that's field-only), and the preview now opens already showing
  the configured default pose instead of the raw GLB bind pose.

**SHIPPED 2026-09-16, 5 direct-request features (Pose Preview
floating panel + camera default, Tween Run/Edit + speed slider, global
Pause) -- all verified live, see CHANGELOG.txt's matching entry for full
verification detail:**
- Pose Preview is now an opt-in floating, resizable, movable panel
  (`posePreviewEnabled` checkbox, Pose group, default OFF) instead of an
  always-embedded dev-group.
- "Set Default Camera" button in that panel's own title bar.
- "Run" button on Saved Tween Sequences (plays the sequence on the Pose
  Preview model), paced by a new Tween Speed (Preview Run) slider.
- "Edit" button on Saved Tween Sequences (loads that sequence's poses
  back into the live Tween Poses list for editing/overwriting).
- Global "PAUSE" button (Debug group) -- freezes every pose/tween
  animation exactly where it is; resuming continues from there instead
  of jumping forward, via a virtual-clock mechanism (`nowVirtual()`).

**SHIPPED 2026-09-15: "Clear" button added to the Mouse Tracking Log
widget** itself, next to Copy/Save.

**AWAITING A DECISION: why the dev panel shows Landscape instead of
Desktop.** Answered, not fixed -- `devPanel.js`'s `realDeviceClass()`
classifies as Desktop only when BOTH viewport dimensions are >=768px;
below that it's Landscape (wider than tall) or Mobile, with NO touch-
capability check. A real desktop window shorter than 768px (confirmed:
the user's own recent log showed 1536x730) gets misread as a landscape
touchscreen device. The real fix (checking touch capability) touches
`devPanel.js`, the shared cross-project engine this project's own
CLAUDE.md says not to fork -- surfaced for the user's decision rather
than changed unilaterally, since it affects every project sharing this
engine.

**New feature: Tween + Double Click Hold Tween -- built 2026-09-15,
verified live on a local dev server, awaiting the user's confirmation on
production.** Modeled on HANDO's own "Tween / Export" dev-panel group,
deliberately narrower ("We dont need that. we just need poses" -- no
camera/lighting/toon capture, no PNG export UI) and with a different
trigger mechanic (a gesture-driven playback, not a manual preview slider).

**Tween group**: `tweenPoses`, an ordered, drag-to-reorder-capable list of
saved-pose selections (devpanel/devPanel.js's 'multi-select' control type,
extended with a drag handle + the same generic `setupReorder()` list-
picker rows already use). `savedTweenSequences`, a list-picker capturing
ONLY that ordered pose-name array, nothing else.

**Double Click Hold group**: Master On/Off, a Tween Selector dropdown
(reads `savedTweenSequences`), and one Tween Speed (Ms) slider. Gesture is
a genuine double-click whose 2nd press is HELD (distinct from Click-Hold-
Pose's single press-and-hold and Click-Pose's fire-and-forget double-
click) -- while held, every hand tweens IDENTICALLY (no per-hand distance
stagger, unlike every other trigger group in this project) from the
DEFAULT pose through the selected sequence's poses in order; on release,
every hand retransitions back to default from wherever it currently is,
at the same speed as the forward tween (2 rounds of direct clarification
nailed down both of these specifics).

Verified via real dispatched PointerEvents on a local dev server: drag-
reorder, sequence save, dropdown wiring, and the actual gesture (uniform
pose across the whole field while held, confirmed via screenshot;
correct retransition on release) all worked with no console errors. See
CHANGELOG.txt's 3rd 2026-09-15 entry for the complete account.

**Follow-up: Double Click Hold now has a Loop checkbox.** Unchecked
(default) = pre-existing behavior (hold at the final pose). Checked =
once the initial default->pose1->...->poseN pass finishes, keep cycling
through just the named poses (never re-including default) for as long as
the hold continues, at the same per-segment pace as the initial pass.
Verified: 0 console errors through an extended hold well past the loop
threshold plus a release; a real segment-continuity bug (a visible
backward pop at the loop's own start) was caught and fixed via manual
math trace BEFORE ever running it. **Not independently confirmed via a
live frame capture** -- this session's browser-automation tool showed the
same known "render loop appears paused during JS-exec polling" behavior
this project's CLAUDE.md already documents; a real-device check is still
worth doing. See CHANGELOG.txt's 4th 2026-09-15 entry for the complete
account, including a caught-and-fixed continuity bug.

**"Right Click" trigger group + idle-repose performance fix -- built
2026-09-15, now verified live by this feature's own author (landed via a
concurrent session's commit alongside the Loop checkbox above; see that
entry's own note for how the 2 unrelated changes ended up in one
commit).** Direct request: gate the known ~38ms/frame idle-repose cost
(measured earlier the same day) behind whether it can actually change
anything, and add a 3rd Click-Pose-family trigger on the right button
with a new capability none of the others have -- a Mode dropdown
choosing a single Target Pose or a full Tween Sequence, with only the
relevant one of those 2 rows shown at a time.

**Performance fix, re-measured directly:** `needsIdleRepose =
cfg.wristSplayResponsiveEnabled || hand._wasOverriddenLastFrame` around
`updateRenderOrder()`'s per-hand wrist+finger repose. Confirmed via
isolated `performance.now()` timing at 255 hands: ~30-44ms/call with
Responsive Wrist Splay on (matches the ~38ms figure already on record),
~0.2-0.7ms/call with it off -- essentially the full cost eliminated when
the feature isn't in live use. The one-frame-after-a-transition forced
repose (`hand._wasOverriddenLastFrame`) keeps a hand's finger curl from
going stale the instant it returns to idle.

**Right Click, verified via `window.__debug`:** both modes' phase
machines (forward -> paused -> retransition -> idle) confirmed correct
by manually stepping `updateRenderOrder()` (this session's browser tool
has its own known rAF-timing unreliability, so real frames were driven
directly) and reading back `lastAppliedValues` at each phase -- Single
Pose reached the target pose's own curl value then returned to default;
Tween mode resolved a 2-pose test sequence to `[liveSnapshot, pose1,
pose2]` and played through it the same way. The Mode-dependent row
visibility was confirmed toggling live.

**One real bug found and fixed post-hoc:** `rcMode`/`rcTargetPose`/
`rcTweenSelector` all rendered with 0 options on page load (the same
pre-`cfg`-exists TDZ timing gap already worked around for
chp/rchp/click/dblclick's own Target Pose dropdowns, just never extended
to these 3 new ones) -- fixed by adding the same one-time
`safeRefreshSelectOptions()` calls, pushed separately (`5daac10`).

See CHANGELOG.txt's 5th 2026-09-15 entry for the complete account.

**"All my click functions stopped working" / "click functinos still not
working" -- TWO SEPARATE bugs, BOTH now fixed 2026-09-15, verified
directly (not yet reconfirmed live by the user).** A first investigation
pass fixed a real-but-secondary crash path (Double Click Hold Loop's
NaN-unsafe speed math) and added a general try/catch backstop around
`animate()`'s per-frame body -- both good fixes, but neither was the
actual bug. Two further rounds, each following a more specific user
report, found the 2 real causes:

**Bug 1 -- startup pose (fixed round 2).** Hard refresh shows hands with
"weird surface texture as if there is overlapping 3d models... rotation
etc looks off," ANY click instantly fixes it.

Reproduced directly via a real screenshot on a fresh production load:
every hand rendered as long, spike-like shapes -- the raw, un-posed GLB
bind pose. Root cause: `hand.currentBaseQuat` is seeded from
`cloneBaseQuat` at hand-creation time; if `cloneBaseQuat` is still its
own module-load-time identity default at that exact moment (cfg not yet
finished restoring), every hand's own snapshot freezes on that stale
identity forever. Before the earlier idle-repose performance gate
existed, an unconditional per-frame resync caught this invisibly within
1 frame -- the gate broke that guarantee specifically for users with
Responsive Wrist Splay off (confirmed: `wristSplayResponsiveEnabled:
false` in this real user's own saved settings), so nothing ever resynced
it until a click incidentally forced one catch-up frame as a lucky side
effect.

Fixed with `hand.everReposed` (false until a hand's first real repose),
folded into the gate as a 3rd OR-condition -- forces exactly one
guaranteed correct repose per hand, then never forces it again. Verified
directly: simulated the exact broken state on a real hand and called
`updateRenderOrder()` once with no click involved -- self-healed
correctly. Getting to this root cause took much longer than its own
opening ETA (54m36s against ~15-25min) mostly due to this session's
browser-automation tool repeatedly misreporting `document.hidden`/
`window.innerWidth` on tabs that were genuinely fronted (the same
already-documented gotcha) -- a plain screenshot call, not a JS-exec
query, is what finally surfaced the real bug.

**Not yet independently investigated:** a `GL_INVALID_FRAMEBUFFER_OPERATION`
WebGL warning also appeared on that same fresh load -- real, but not
followed up since the screenshot + `currentBaseQuat` evidence already
fully explained the reported symptom on its own. Worth a look if a
startup-sizing issue is ever reported separately. See CHANGELOG.txt's
7th 2026-09-15 entry for the complete account.

**Bug 2 -- click transitions get stomped every frame (fixed round 3, the
ACTUAL "click functions don't work" bug).** Bug 1's fix resolved the
startup appearance but a fresh, more detailed report ("click functinos
still not working," with a mouse log showing real clicks/holds producing
no visible effect) showed the underlying trigger problem was still
there. Root cause: the idle-repose performance gate's `needsIdleRepose`
condition never actually checked `!overridden` -- so on every frame
after the FIRST frame of any click/hold transition,
`hand._wasOverriddenLastFrame` (true) made the idle-repose branch ALSO
run, immediately overwriting that same frame's own in-progress
transition pose with `cfg`'s plain default values. Every trigger's pose
only ever stuck for a single frame before being stomped back to default
-- at normal framerate, indistinguishable from "the click did nothing at
all." Fixed with one added condition (`!overridden &&`), restoring the
original mutual exclusion between "actively driven by a trigger this
frame" and "eligible for idle repose."

Also fixed in passing: a concurrent session's own function rename
(`updateRightClickModeVisibility` -> `updateClickTriggerModeVisibility`)
missed 1 call site, throwing a caught-but-real `ReferenceError` whenever
Right Click's Mode dropdown changed.

Verified directly: stepped a real Click Pose transition toward
"ThumbsUp" with real elapsed time between frames -- thumbCurl progressed
smoothly and monotonically end to end, no snap-back at any intermediate
frame. See CHANGELOG.txt's 8th 2026-09-15 entry for the complete
account.

**Mode dropdown (Single Pose / Tween) now ported to all 5 Click-family
groups -- built 2026-09-15, verified live.** Direct follow-up: "implement
it to all click functions in the dev panel," referencing Right Click's
own Mode selector as the model. Click Pose/Double-Click Pose reused the
already-generalized phase machine for free; Click Hold-Pose/Right-Click
Hold-Pose (a separate 2-phase hold-based machine) got their own Tween-
mode generalization (`startClickHoldPose()` resolves the sequence once
per hold-start, `updateClickHoldPoseForHand()` plays it via
`lerpTweenSequence()` for as long as the button stays held). Double
Click Hold Tween is NOT part of this -- already Tween-only by design.

**Mid-task correction, applied to all 5 groups:** "the pose transition,
hold, retransition UI should only show when Single Pose is selected" --
widened from Right Click's original "just Target Pose vs. Tween
Sequence" to the WHOLE transition/pause/retransition block via a
generalized `updateClickTriggerModeVisibility(p, extraSinglePoseKeys)`.
A hidden control's own cfg value isn't reset -- Tween mode just runs at
whatever it was last set to.

Verified via `window.__debug`: all 8 new selects populate with real
options; Mode-toggling hides/reveals the correct rows for both a Hold-
Pose-family group (chp) and a Click-Pose-family group (click); Click
Hold-Pose's new Tween mechanism confirmed end to end (forward plays
through a 2-pose test sequence to the final pose and holds; release
retransitions to idle); Click Pose's own Single Pose mode re-confirmed
unaffected. 0 new console errors. See CHANGELOG.txt's 9th 2026-09-15
entry for the complete account.

**Follow-up, same day: dedicated Tween Speed/Curve/Range trio + a Loop
Mode dropdown (Off/Loop/Oscillate, chp/rchp only).** Direct correction:
Tween mode had no visible speed control at all (it silently reused the
hidden Pose Transition fields) -- "tween speed is different from pose
transition speed," confirmed via a clarifying question. Added
`${p}TweenSpeedMs`/`TweenStartTimeCurve`/`TweenStartTimeRange` to all 5
groups as genuinely separate cfg keys (50-5000ms range, matching Double
Click Hold Tween's own Tween Speed slider).

Loop went through several more rounds the same day. First, a plain Loop
checkbox (Click Hold-Pose/Right-Click Hold-Pose only -- the other 3
groups are fire-and-forget, no "held" state for a loop to run during),
caught a real bug before it ever ran live (the existing "still holding,
re-enter forward" guard would have restarted a looping hand from scratch
every frame; fixed by excluding 'looping' from it too). A clarification
that was briefly (and incorrectly) read as "make the loop include the
default pose" turned out, on direct correction, to mean the opposite --
"no you're not meant to include the default pose... i guess we had it
correct previously." **Current, settled behavior: Loop/Oscillate cycle
through the tween's own NAMED poses only, same as always** -- a
1-named-pose sequence still can't meaningfully loop (needs >=2).

**Settled feature set:** `${p}LoopMode` (Off/Loop/Oscillate, replacing
the original plain checkbox per a direct follow-up: "provide a checkbox
under loop that is 'oscillate'... make it a drop down") plus `${p}LoopHoldMs`
(a Hold Duration slider, visible only when Tween mode + Loop Mode !=
Off, via a new nested `updateLoopHoldVisibility()`) -- direct follow-up
request: "provide a slider to set a hold duration at the end of a single
sequence... sequence, hold, repeat, hold etc, OR sequence, hold, reverse
sequence, hold, etc." Loop repeats the same wrap direction each lap;
Oscillate flips direction each lap (the literal "reverse sequence").
Caught and fixed a real bug before calling this done: an overshoot frame
could freeze a hold at a slightly-past-boundary interpolated value
instead of the clean boundary pose -- fixed by clamping the value
computation (not the completion check) to exactly one lap.

Verified live: Tween Speed genuinely decouples from Transition Speed
(set Transition Speed to an absurd 999999ms, tween still progressed at
the real Tween Speed pace); Loop/Oscillate confirmed excluding the
default pose again; Loop's hold freezes at the exact boundary pose for
the configured duration; Oscillate's hold produces the exact "hold,
reverse, hold" pattern requested. "Off" mode re-confirmed unaffected.
See CHANGELOG.txt's 10th-12th 2026-09-15 entries for the complete
account, including the exact misreading that triggered the brief
default-pose detour.

**The "thumb/finger pose looks wrong" saga -- 2 SEPARATE bugs found and
fixed 2026-09-15, both verified live; awaiting the user's final
confirmation before declaring this closed.** This turned out to be two
unrelated bugs compounding each other, found in 2 rounds the same day.

**Bug 1 -- curl-axis conjugation collapsing to identity at delta=0.** The
prior round's conjugation fix (`worldDelta = W1 * delta * W1^-1`) passed
every relative-to-wrist invariance test run against it, including live-
production tests with real saved poses -- but the user kept reporting
"still have wrist splay issues" anyway. Root cause, found only once a
real saved pose ("Fist") finally exercised the untested case: at
delta = identity (wristBend = wristSplay = 0 exactly), that formula
collapses to IDENTITY for any W1 at all, silently discarding `baseQuat`
(alignQuat) from every finger's curl axis. Fixed by conjugating `delta`
by `wristRestForAxis` (R) alone instead of by the full world quat --
`baseQuat * R * delta * R^-1` -- which correctly reduces to `baseQuat` at
delta=I.

**Bug 2 -- `FINGER_SIGN.middle`/`.ring` never synced with HANDO's own
2026-09-14 sign flip.** After Bug 1 shipped, the user reported poses
STILL looked wrong -- and, critically, that "Point and MiddleFinger also
look wrong" (both have wristSplay=0, ruling out anything wrist-splay-
related) and that "Fist (0 splay) and Fist-Bent Back (-50) look messed
up" -- both, not just the nonzero one. A direct A/B test (a scratch git
worktree checked out at the commit BEFORE Bug 1's fix) reproduced the
identical broken "Point" geometry on the OLD formula too, proving Bug 1
was not the cause of this. Diffing HANDY DANDIES's finger-curl constants
against HANDO's own found it: HANDO flipped `FINGER_SIGN.middle`/`.ring`
from `-1` to `1` on 2026-09-14, migrating its own saved poses to match --
this project's `FINGER_SIGN` was never updated, but every pose in this
project's own saved-pose list was imported from HANDO AFTER that
migration (already assumes the new convention), so middle/ring curled
BACKWARD on nearly every real pose. "Neutral"/"Neutral - Bent Back" (all
curl values 0) were the only poses unaffected -- coincidentally the same
2 poses the whole wrist-splay investigation had been testing against,
which is why this went unnoticed for so long. Fixed with a pure sign
flip, no data migration needed here.

Verified: "Point" and "Fist - Bent Back" both render as correctly-formed
hands on live production after both fixes; the relative-to-wrist
invariance check still holds at 0.0000 degrees (Bug 2's fix doesn't touch
the wrist-axis math at all). See CHANGELOG.txt's 2 2026-09-15 entries for
the complete account of each.

**HANDO's own team was given a handoff** explaining Bug 1's math and
recommending the same fix for HANDO's structurally similar (but
currently latent, not visibly broken there) version of it -- not yet
confirmed whether they've acted on it. Bug 2 is HANDY-DANDIES-specific
(a sync gap, not a shared math bug) and doesn't need a HANDO-side fix.

**Click-Pose start-of-transition stutter + mouse log click/drag
mislabeling -- both fixed 2026-09-15, verified live; awaiting the user's
confirmation.** User report with a screen recording and mouse log
attached: right after a plain click (target "Fist"), the closest hand
briefly flashed toward a DIFFERENT pose before the real transition took
over smoothly. Root cause: `startClickHoldPose()` fires on every
pointerdown unconditionally (needed for the camera-pan-lock side effect),
so a genuine hold and the start of a plain click were indistinguishable,
and the closest hand's own 0ms start delay let it begin visibly moving
toward Click Hold-Pose's own target before the click released. Fixed
with a new "Hold Confirm Delay (Ms)" control (default 150ms) gating when
a hold is allowed to actually start moving a hand. Separately, the mouse
log was mislabeling every plain click as "Camera Pan (OrbitControls,
X-drag)" regardless of whether anything was dragged -- fixed by only
using drag wording when a drag genuinely happened. See CHANGELOG.txt's
2nd 2026-09-15 entry for the complete account.

**Camera presets (Save/Use/Overwrite/Delete/Default) + Lock Pan/Zoom +
Set Default Camera As Max Extents.** Mirrors Saved Poses' own UI pattern
but applies directly to the live camera. Verified live; not yet
explicitly confirmed by the user as working the way they want on a real
device. See CHANGELOG.txt for the complete account and verification.

**Known, expected side effect:** any saved pose will look visually
different now than under either of the 2 earlier (wrong) formulas this
session tried -- not a new bug. **Not yet confirmed by the user on a
real device** -- don't declare this saga closed until they do.

**Field Layout + Camera are now per-device (Desktop/Mobile/Landscape) --
built and verified live 2026-09-15.** Direct request: "Allow for
separate field layout settings and camera settings for Desktop and
Mobile." Every Field Layout control and every live Camera control
(position/FOV/zoom/lock-pan/lock-zoom/max-extents) is now `perDevice:
true` -- confirmed via source inspection that devPanel.js's own
`commit()`/`syncValue()` already gate live effects behind `editingDevice
=== realDeviceClass()` generically, so no engine changes were needed.
All 3 devices start identical (no invented `defMobile`/`defLandscape`
numbers -- there's no design brief for what Mobile should look like);
`savedCameras` (the preset list) stays shared on purpose. **Noticed but
NOT fixed (out of scope for this request):** devPanel.js's generic
per-group seeding only ever reads plain `def`, never `defMobile`/
`defLandscape`, for any PROJECT-supplied group -- those overrides
currently only work for the built-in Dev Panel chrome group's own
separate seeding code. Worth knowing if a future project-supplied
control ever needs a genuinely different Mobile default via
`defMobile`. Verified live: editing Mobile's own Rows slider left the
live (desktop) scene completely untouched, and the edited value
persisted independently across tab switches in both directions.

**The real "double click acting weird" bug -- root-caused and fixed
2026-09-15, verified live twice; not yet reconfirmed by the user.**
Direct follow-up report: "I think its registering a single click first,
then when it realizes its double, it causes an issue." Root cause: Click
Hold-Pose's own Hold Confirm Delay (150ms -- how long before its target
pose becomes visible) and `MOUSE_LOG_HELD_DRAG_MS` (500ms -- the
separate threshold deciding whether a release counts as a genuine hold,
suppressing Click Pose/Double-Click Pose's own trigger) were 2 different
numbers serving what should've been the same purpose -- any press
landing in the 150-500ms gap (an entirely ordinary speed for a double-
click's own first tap) made chp's own target pose visibly flash on and
reverse, independent of whatever Click Pose/Double-Click Pose did once
the debounce resolved. Confirmed live via simulated realistic double-
clicks (real dispatched PointerEvents): clean with chp disabled, clean
at normal click speed, reproduced cleanly at a 200ms press (chp's own
phase measured entering 'forward' mid-press). Fixed by raising Hold
Confirm Delay's default to 500ms (matching `MOUSE_LOG_HELD_DRAG_MS`
exactly) and its slider max to 1000 for headroom -- also corrected the
same value directly in the live git-tracked settings (the user's own
real saved value was `0`ms, even more exposed than the old code
default). Verified live on a fresh page load (cleared localStorage,
picking up the new code default with no manual override) that the exact
same 200ms-press double-click no longer produces the flash.

**Shift-click multi-select + auto-group "+Group" in every devPanel.js
list-picker -- built and verified live 2026-09-15.** Direct request:
shift-click to select a range in Saved Poses/Saved Tween Sequences,
then have "+Group" auto-place the selection into the new group instead
of creating an empty one. Implemented as a genuine `devPanel.js` engine
capability (shared by every list-picker, not a main.js patch) --
`entry.selectedItem` keeps its existing single-item meaning for Use/
Rename/Overwrite/Delete; a new, separate `entry.multiSelected` Set
(read only by `+Group`) tracks the shift-click range, computed from
rendered DOM order so it correctly spans group boundaries. Verified
live: a 4-item shift-click range moved exactly those items into a new
group on `+Group`, leaving the rest untouched; the original empty-group
behavior (nothing selected) still works; plain-click single-selection
regression-checked clean. See CHANGELOG.txt's own matching 2026-09-15
entry for the complete account.

**Double Click Hold rebuilt as a literal 3rd Click Hold-Pose instance --
built and verified live 2026-09-15.** Direct request to match its
settings to Click Hold-Pose's own (it was "lacking a lot of the
options") plus Single Pose/Tween mode support -- this directly touched a
standing architectural decision (CLAUDE.md's own note that Double Click
Hold applied identically to every hand, no per-hand stagger, as a
deliberate exception), so 2 clarifying questions were asked before
implementing: confirmed (1) genuinely add per-hand stagger, reversing
that original design, and (2) Single Pose mode mirrors Click Hold-Pose
exactly. `dcHold` is now a 3rd entry in `CLICK_HOLD_KEYS`, sharing
chp/rchp's own machinery wholesale (a net REDUCTION in code despite
gaining every one of their settings) -- retired the old bespoke
`dcHoldTween` mechanism entirely. One exception preserved from dcHold's
own original requirement: Tween mode still always starts from the
default pose specifically, not the live snapshot chp/rchp's own Tween
mode uses. Caught and fixed a real regression along the way: retiring
the old functions also deleted the project's only NaN-safety guard for
`TweenSpeedMs` (a real, previously-fixed bug class) -- restored as a
shared helper now protecting all 3 Tween-capable triggers instead of
just the one that hit it first. `CLAUDE.md`'s own now-outdated note was
corrected in place rather than left to mislead a future session.

**Same day, separate request: new list-picker groups now sort to the
top.** "When I add a new group in any of the selector uis, place the
new group at the top of the list instead of the bottom." A first version
(prepend to whichever array the new group touches) worked for repeated
empty groups but a live test exposed a real gap when mixing an empty
group with a later auto-assigned one (the auto-assigned one still sorted
to the bottom, since array position within one queue says nothing about
recency relative to the OTHER queue) -- fixed with an explicit
`entry.groupOrder` priority list, consulted as a final re-sort pass and
cleared entirely the instant the user manually drags a group (past that
point their own arrangement is the real source of truth). See
CHANGELOG.txt's own latest 2026-09-15 entry for the complete account of
both.

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
- **WAS BELIEVED RESOLVED, later found NOT to be — see "Currently working
  on" above for the real, still-open state.** "thumb pose of all poses
  except startup still looks wrong": at the time this fix shipped, it
  was correctly diagnosed and verified for its OWN specific cause (below)
  — but the user reported the thumb STILL wrong afterward, and 2 more
  real causes (Base-Only Curl missing entirely; 2 rounds of a Click-Hold/
  Click-Pose interference bug) were found and fixed after this entry,
  and the thumb issue is STILL reported wrong even after those. Left in
  place as an accurate record of what this specific fix actually did and
  verified — it was a genuine, real bug, just not the ONLY one, and
  possibly not the one still causing what the user sees now.
  The wrist-before-fingers fix from earlier was always
  correct; the real remaining gap was that Click-Hold-Pose/Click-Pose
  silently ignored Whole-Hand Rotation during a transition (a disclosed
  scope decision from when Click-Hold-Pose was first built) — invisible
  with the user's own native poses (all had modelRotX/Y/Z at 0) but
  very visible with poses imported from HANDO, which commonly bake
  nonzero Whole-Hand Rotation into the gesture itself. Asked the user
  directly how to fix it; they chose full per-hand interpolation over 2
  smaller alternatives (snap-instantly, or leave-as-is-and-retune-poses).
  Each hand now gets its own `currentBaseQuat`, mirroring the shared
  value when idle, computed fresh from the transition's own interpolated
  Whole-Hand Rotation while transitioning. Live-verified across the full
  lifecycle: a 60-degree target rotates the hand's actual rendered
  orientation by exactly 60.0 degrees during transition, the shared
  field-wide value stays untouched, a hand reverts correctly after
  retransition, and ordinary non-transition Whole-Hand Rotation usage
  measures exactly 0.0 degrees of error (no regression). See
  CODE_SUMMARY.txt and CHANGELOG.txt for the full account.
- **Ported HANDO's own Base-Only Curl (5 sliders, one per finger) --
  this project's own Pose group had omitted it entirely.** Direct user
  suggestion broke this open: "maybe check hando for pose settings.
  maybe there is an extra setting you dont have." A pose imported from
  HANDO using Base-Only Curl on the thumb had that data silently
  dropped -- no control/key existed here to store or apply it. Added
  `baseOnlyCurl{Finger}` sliders matching HANDO's own placement/defaults,
  the additive base-joint-only rotation mechanism, and the 5 new keys to
  `POSE_PRESET_KEYS` + their per-finger Pose subgroups. Also found and
  fixed (2 rounds -- the first fix introduced a real regression, caught
  immediately by the user and corrected the same round) a genuine
  Click-Hold-Pose/Click-Pose interference bug: releasing a hold was also
  firing Click Pose's own sequence, then that fix briefly broke instant
  clicks from triggering Click Pose at all. Both now verified correct
  together (quick click triggers, genuine hold still suppresses the
  extra trigger). See CHANGELOG.txt for the full account.
- **The "thumb pose looks wrong" saga is genuinely, finally resolved.**
  4 earlier rounds of fixes (wrist-order; per-hand Whole-Hand Rotation;
  Base-Only Curl; Click-Hold/Click-Pose interference) were all real and
  stayed correct -- none of them were wrong, they just weren't the whole
  story. 2 more rounds this same day:
  (1) Responsive Wrist Splay recomputing live DURING a transition (fixed
  by freezing `extraSplayDeg` once at trigger time,
  `chp.frozenSplayDeg`/`cp.frozenSplayDeg`) -- real, but the user then
  reported the thumb was still wrong even with a completely static
  cursor, which this fix can't explain (a static cursor makes live vs.
  frozen recompute produce the identical value either way).
  (2) **The actual final root cause**, found by reading
  `updateRenderOrder()`'s own idle branch: it re-applies the wrist's live
  Responsive Wrist Splay rotation every frame, but never re-applies
  finger curl (only recomputed on a slider change or "Default" click).
  Since the thumb is the only finger parented to the wrist bone, and its
  curl axis is computed relative to the wrist's world orientation *at the
  instant curl is applied*, its rotation silently goes stale the moment
  the wrist keeps moving afterward -- independent of cursor movement,
  matching "every other finger is correct, it's just the thumb" exactly.
  Fixed by re-applying just the thumb's curl every idle frame, right
  after the wrist update (the other 4 fingers are provably unaffected).
  Verified with a genuinely independent double-check, static cursor
  throughout: two separately-computed references for the thumb's world
  orientation agreed to 0.0 degrees; reproducing the pre-fix behavior the
  same way against the same reference measured a real 12.5-degree error,
  confirming the test actually discriminates. See CHANGELOG.txt for the
  full account of both rounds.
- **Decoupled cursor target X/Y from Cursor Target Depth**, after
  quantifying a real parallax gap (up to ~45 world units at the field
  edge) between the true screen cursor position and where hands actually
  aimed. X/Y now always come from a raycast to a plane fixed at the
  hands' own z=0 depth; Z is set directly from the configured depth as a
  plain scalar. Known, accepted side effect: the Target Marker (a purely
  visual dot) no longer stays pixel-aligned with the true mouse position
  when Target Depth isn't 0 -- fix deferred, see "What's next".
- **Click Pose's own 350ms debounce delay removed when Double-Click Pose
  is disabled** -- every click used to wait the full disambiguation
  window even with nothing to disambiguate against. Also added a
  temporary "Diagnose" button (Saved Poses list-picker) for comparing a
  saved pose's Default-path vs. transition-path bone quaternions --
  turned out not to be needed for the thumb saga's resolution, left in
  place as a still-possibly-useful debugging aid.
- **Set the user's own real Copy Settings dump as the project's code
  defaults.** All 11 saved poses, Field Layout, Responsive Wrist Splay's
  real range/curve, Camera/Lighting, and all 4 click/hold trigger
  configs (chp->Point, rchp->Neutral - Bent Back, click->Open Palm,
  dblclick->ThumbsUp) now ship as the code default -- a fresh page load
  with no localStorage starts in exactly the configuration the user has
  actually been using. Required a real code change, not just data:
  `makeClickHoldPoseGroup()`/`makeClickPoseGroup()` previously shared ONE
  hardcoded default per field across both their instances (chp/rchp;
  click/dblclick) -- added an optional, backward-compatible `defaults`
  param so each of the 4 real instances can specify its own target
  pose/speed. `dp_*` Dev Panel chrome cosmetics deliberately left alone
  (live in the shared, do-not-fork `devpanel.js` engine). Verified live:
  cleared `localStorage`, hard-reloaded (caught and fixed a real stale-
  cache miss mid-verification -- a bare `/` navigation without a fresh
  top-level cache-bust served an old `index.html`), read every changed
  value back via `window.__debug` -- exact match, including the field
  correctly rebuilding to 255 hands (15x17).
- **Extended the idle-loop finger-curl refresh (above) from thumb-only to
  all 5 fingers**, after the user's phone retest showed the same problem
  plus "the other fingers are all also slightly uncurled." Direct
  skeleton inspection found every finger is a descendant of the wrist
  bone through its own "carpal" bone (rCarpal1-4) -- the earlier belief
  that only the thumb was parented to the wrist bone was wrong. See
  CHANGELOG.txt for the full account and verification.
- **Found and fixed the actual, final root cause: curl direction never
  rotated with the wrist.** The user confirmed the identical problem
  reproduces in HANDO (a separate codebase) -- ruling out every fix
  attempted so far and pointing at their shared curl-axis convention.
  `applyCurlToSkeleton()` computed curl/splay direction relative to the
  whole-hand's PRE-wrist orientation, never the wrist's own current
  bend/splay -- anatomically backwards, since every finger is a wrist-
  bone descendant. Fixed by reading the wrist bone's own current world
  rotation as the axis reference. Verified with a genuinely independent
  test: a curled finger's angle to the wrist stayed constant (78.006
  degrees) across a real 70-degree wrist rotation. Full regression suite
  still 0.0 degrees. See CHANGELOG.txt for the complete account.
- **CORRECTION, same day: switched the fix above to HANDO's own exact
  formula, after checking HANDO's concurrent fix for pose-export
  compatibility (direct request, since poses will be exported from
  HANDO).** The world-quaternion approach above and HANDO's own
  (independently-applied, same day) delta-from-rest approach measured an
  88.5-degree divergence for the same wrist state -- not equivalent, since
  `rHand`'s rest quaternion is far from identity. Switched to HANDO's
  exact technique; verified 0.0 degrees against 2 independent
  reconstructions of HANDO's own math, and the existing regression suite
  still 0.0 degrees.
- **Ported HANDO's "Tip-Only Curl"** (4 sliders, Index/Middle/Ring/Pinky,
  mirror of Base-Only Curl targeting the last joint) -- found missing
  entirely while checking HANDO compatibility, same failure mode as the
  earlier Base-Only Curl gap (would silently drop pose data on import).
  Verified in isolation: exactly 42.0 degrees on the tip joint only, 0.0
  on the other joints. See CHANGELOG.txt for the complete account of both.
- **Added git-tracked Save Settings** (`api/save-settings.js`, a Vercel
  serverless function ported from HANDO's own, writing through to
  `data/processed/dev-panel-settings.json` via GitHub's Contents API).
  `devPanel.js` already had the generic client engine shared workspace-
  wide, so only the serverless function + `main.js` wiring + a seeded
  settings file were needed. **Confirmed genuinely working in
  production**: a later push was rejected (non-fast-forward) because 3
  real auto-commits from actual live Save-button use had already landed
  on the remote -- merged cleanly. See CHANGELOG.txt for the full
  verification account.
- **Fixed the curl-axis math for real** (superseding the 2 same-day
  attempts above) via a direct handoff from a concurrent HANDO session --
  a conjugation, not a plain multiply, adapted for this project's own
  extra `wrapperQuat` layer; also caught and fixed a 2nd, self-introduced
  double-`baseQuat` bug along the way. Verified 0.0000 degrees using the
  handoff's own exact test methodology (finger-relative-to-wrist,
  wristSplay=0 vs. -50, every other value held constant). Also ported 2
  more real HANDO gaps found while re-checking for new sliders:
  `tipOnlyCurlThumb` and a full `midOnlyCurl{Thumb,Index,Middle,Ring,
  Pinky}` set (the 3rd and final joint-isolation slider). See
  CHANGELOG.txt for the complete account.
- **Added Camera presets + Lock Pan/Zoom + Max Extents** -- see
  "Currently working on" above and CHANGELOG.txt for the full account.

## What's next

**Awaiting the user's real-device confirmation of the corrected curl-axis
math (see "Currently working on") -- the strongest evidence yet that this
saga is actually closed, but still not user-confirmed.** Every prior
"fix" in this saga was independently real and independently verified,
yet the reported symptom kept persisting -- so don't treat this entry as
settled just because the math now checks out against a trusted external
methodology (the HANDO handoff's own exact test). If the SAME problem
somehow persists even after this, the quaternion-comparison verification
approach itself needs reconsidering (a skinning/mesh issue independent
of bone rotation correctness, or something not yet considered) rather
than attempting a 4th formula.

**Camera presets/Lock Pan-Zoom/Max Extents not yet seen by the user** --
verified live by this session, but the Max Extents interaction model
was refined through several rounds of correction from worked examples,
not a spec the user reviewed directly; worth confirming it feels right
in actual use.

**Target Marker fix -- explicitly deferred by the user, do NOT implement
in isolation.** Direct instruction: "yeah i want that. but dont do that
right now. group it with the next changes i ask for." Give the Target
Marker its own position, driven by the TRUE raycast-to-actual-depth hit
(always pixel-perfect under the cursor), independent from `cursorTarget`
(which keeps driving the hands with the decoupled X/Y-depth behavior
noted in "Recently completed"). Only implement this once bundled with a
future batch of user-requested changes.

**Cursor-tracking sticking near the browser edge** -- user-reported,
not yet resolved. Direct measurement (`cursorTarget` sampled at
increasing NDC.x toward the true screen edge) found the underlying
raycast math moves smoothly and continuously all the way to NDC 0.9984
(the true last pixel) -- no code-level threshold or clamp found. Likely
either a physical mouse/monitor-edge limit (the OS cursor simply can't
move further once it reaches the edge of the user's own monitor) or an
interaction specific to the dev panel's screen position, not yet
isolated. Worth asking the user: which screen edge, is the dev panel
positioned near that edge, and does the issue persist with the panel
hidden ('D' key)?

**Per-hand Whole-Hand Rotation's own real visual feel with an actual
HANDO-imported pose** — verified quantitatively (exact-degree quaternion
checks against independently-computed references), not yet eyeballed
against one of the user's own real imported poses in a live browser.
Worth a direct visual confirmation now that the user has a way to test
it (any HANDO-imported pose with nonzero Whole-Hand Rotation, used as a
Click-Hold-Pose or Click-Pose target).

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
