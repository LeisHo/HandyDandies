import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeletal } from 'three/addons/utils/SkeletonUtils.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { initDevPanel, syncValue, organizeGroupSubgroups, refreshSelectOptions, refreshMultiSelectOptions, saveCurrentSettings, renderDynamicGroup, createGroupElement } from './devpanel/devPanel.js?v=32'

// A defensive wrapper around devPanel.js's own refreshSelectOptions() --
// found via live testing (direct user report: "I dont see any of the
// saved poses in the dropdown for Click Hold Pose Target pose selection")
// that calling it for the 'rchpTargetPose' key specifically throws inside
// devPanel.js's own commit()/fillSelectOptions(), for a cause isolated
// but not fully root-caused ('chpTargetPose' succeeds every time,
// 'rchpTargetPose' throws every time, even called alone, with no
// difference between the 2 controls' own definitions). A crash here must
// never take down the whole page load -- caught and logged instead.
function safeRefreshSelectOptions(key) {
  try { refreshSelectOptions(key) } catch (err) { console.error(`safeRefreshSelectOptions('${key}') failed`, err) }
}
function safeRefreshMultiSelectOptions(key) {
  try { refreshMultiSelectOptions(key) } catch (err) { console.error(`safeRefreshMultiSelectOptions('${key}') failed`, err) }
}

const MODEL_URL = '../data/processed/HAND3D/Hand2.glb'
// Measured once after the first load -- the rig's own bind-pose "pointing"
// axis (wrist -> middle fingertip), not assumed to be +Y/-Z.
let alignQuat = new THREE.Quaternion()
// "Palm Faces Cursor" (Cursor Tracking group) -- composed onto the
// per-frame lookAt quaternion (see the tracking code below) only while
// that mode is enabled. Whole-object rotation only -- never touches the
// skeleton/pose, per direct correction ("you shouldnt be doing any
// posing work" / "when i say rotate the hand... I just meant rotate the
// entire model").
//
// REDEFINED 2026-09-14, direct correction after live testing against the
// user's own real settings ("palm faces cursor isnt working as i expect
// ... every hand more or less faces Upwards [when cursor is centered].
// what i want is - imagine 8 hands surrounding my cursor [at 45-degree
// increments]... The hand directly below would be facing up (as it is
// currently)... above the cursor... 180... directly to the right...90
// ...the one to the left is -90. the one above and to the right would
// have rotation 135... My Palm Face rotation slider wil then just add
// onto that rotation number."). This REPLACES the prior 3-round "aim a
// calibrated palm-normal vector at the cursor in full 3D" mechanism
// entirely -- the new spec is a much simpler 2D "compass needle" roll:
// each hand rotates, around the SAME wrist-crop-plane axis
// (`wristCropNormalAligned`, unchanged from that prior work) already
// used for the Palm Face Rotation slider, by an angle computed from
// THAT hand's own position relative to the live cursor target in the
// world XY plane -- not a fixed value, and not a full 3D vector-aim.
// `computeRadialRollDeg()`'s exact formula (`atan2(dx, -dy)`) was
// derived directly from the user's own 5 stated reference points and
// verified to reproduce every one of them precisely (0/180/90/-90/135
// degrees) before being written into the render loop -- see its own
// comment. The old `palmNormalAligned`/`computePalmFaceCorrectionQuat()`
// measurement (index/pinky bone cross product) is removed as dead code,
// not just unused -- it answered a different question (which face of
// the mesh is "the palm") that this simpler 2D-rotation spec doesn't
// need at all.
let wristCropNormalAligned = null
// dx/dy measured directly in world space (X right, Y up, matching this
// project's own Field Layout grid and THREE.js's Y-up convention) --
// deliberately NOT projected through the camera to screen/NDC space:
// the camera sits close to axis-aligned looking down -Z at the field's
// own XY plane (confirmed live, cameraX/Y near 0), and the user's own
// mental model ("directly above/below/left/right") is itself a
// world/field-space description, not a screen-pixel one, so world-space
// dx/dy is the correct, simpler measurement -- no camera math needed.
// Formula verified against all 5 of the user's own stated points:
// dx=0,dy<0 (hand below cursor) -> atan2(0,+)=0; dx=0,dy>0 (above) ->
// atan2(0,-)=180; dx>0,dy=0 (right) -> atan2(+,0)=90; dx<0,dy=0 (left)
// -> atan2(-,0)=-90; dx>0,dy>0 equal magnitude (upper-right, 45-degree
// diagonal) -> atan2(1,-1)=135 -- exact match on every one.
function computeRadialRollDeg(handPos, cursorPos) {
  const dx = handPos.x - cursorPos.x
  const dy = handPos.y - cursorPos.y
  return THREE.MathUtils.radToDeg(Math.atan2(dx, -dy))
}
// Rotation around the wrist-crop-plane axis by `baseDeg` (the dynamic
// radial angle when Palm Faces Cursor is on, 0 when it's off) plus the
// live Palm Face Rotation slider, which "just adds onto that rotation
// number" in both cases, per direct instruction.
function computeRollQuat(baseDeg) {
  const axis = wristCropNormalAligned || new THREE.Vector3(0, 0, -1)
  const offsetRad = THREE.MathUtils.degToRad((baseDeg || 0) + (cfg.palmFaceRotationOffset || 0))
  return new THREE.Quaternion().setFromAxisAngle(axis, offsetRad)
}
let handLengthRaw = 1
// The actual rendered MESH's bounding sphere (center + radius), measured
// once at load in the same local/bind-pose frame as alignQuat/
// handLengthRaw -- used ONLY for the reordering-flash overlap check (#10
// in updateRenderOrder()'s own comment), kept deliberately separate from
// handLengthRaw (which drives grid scale-fitting and outline thickness,
// unaffected by this). Needed because the wrist-to-fingertip bone
// distance badly undersells the model's real screen footprint: this
// asset's visible mesh includes a full forearm below the wrist, spanning
// ~2.7x the wrist-to-fingertip length -- confirmed directly (bounding-
// sphere radius ~23 world units vs. handLengthRaw's own ~16-unit total
// length, i.e. an ~8-unit "half length" radius that was less than half
// of what the mesh actually needs).
const handBoundsCenterLocal = new THREE.Vector3()
let handBoundsRadiusLocal = 1

// Pose raw-frame measurements (ported from HANDO's own Pose group; same
// identity-transform frame as alignQuat/handLengthRaw/handBoundsCenterLocal
// above). boneRestQuat is captured once, right after load, from the
// ORIGINAL un-cloned skeleton's bind pose -- shared across every hand's
// own cloned skeleton (all clones share identical bone names/rest pose,
// since they're all cloned from the same source GLB; unlike HANDO, which
// needs a separate restQuatMap per model because it supports 2 DIFFERENT
// model files with slightly different rest poses).
const boneRestQuat = {}
// Hide Wrist's own position-compensation -- the ABSOLUTE raw-frame
// positions of the wrist and forearm-base bones (same frame as
// alignQuat/handLengthRaw's own wristPos/tipPos measurements). Storing
// the actual positions, not just the direction/distance between them, is
// what lets applyHandArmLength() reconstruct exactly where the
// current "cut" point sits relative to the model's own raw content-space
// origin -- a direction+distance pair alone can't do that (it was tried
// first and produced a real, measured bug: correct with Hide Wrist alone,
// wrong once combined with Whole-Hand Rotation -- see CHANGELOG.txt for
// the measured before/after).
const wristPosRaw = new THREE.Vector3()
const forearmPosRaw = new THREE.Vector3()
// Arm Length's cached/parsed state -- declared up here, not next to the
// functions that use them further down (parseArmLengthConfig(),
// computeArmLengthT(), buildArmLengthWidgets()), because those functions
// are CALLED right after initDevPanel() (this file's own established
// pattern: shared mutable state lives at the top, regardless of where the
// logic that reads it happens to live) -- calling them before reaching
// this point in the module's own top-to-bottom evaluation would hit these
// bindings' temporal dead zone, the same class of crash this project's
// own initDevPanel()-detach-onChange mitigation exists to avoid (see that
// code's own comment). Confirmed live: this exact TDZ crash is what
// happened when these were first declared next to their own functions
// instead.
let armLengthRangeParsed = { min: 30, max: 90 }
let armLengthCurveParsed = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
const armLengthWidgetResyncs = []
// Responsive Wrist Splay's own cached/parsed state -- same TDZ reasoning
// as armLengthRangeParsed/armLengthCurveParsed directly above (declared
// here, read by parseWristSplayConfig()/computeResponsiveWristSplayDeg()
// further down). Reuses `armLengthWidgetResyncs` (the SAME per-frame
// resync-poll array, not a second one) since both widget pairs need the
// identical "external change" detection.
let wristSplayRangeParsed = { min: 0, max: -90 }
let wristSplayCurveParsed = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
// Mouse Tracking Log's own state (see its own section further down) --
// declared here for the same TDZ-avoidance reason as the arm-length vars
// directly above: the `pointermove`/`pointerdown` listeners that write to
// these are registered at module top level, early in the file.
let lastPointerClientX = 0
let lastPointerClientY = 0
const MOUSE_LOG_MAX_ENTRIES = 200
const mouseTrackingLogEntries = []
let mouseTrackingLogEl = null
let cursorLogTimer = null
// Ported from TEMPLATE_DEV_PANEL.html's own [JS-13c] Mouse Log (2026-09-14
// port round, direct request: "I updated the Dev Panel Template to have a
// mouse log system similar to ours. Update ours to match the template if
// there are features missing.") -- multi-click detection, drag-release
// classification, and viewport/device context entries. Deliberately did
// NOT port the template's own touch-gesture classification (tap/double-
// tap/long-press/swipe/pinch): this project's own CLAUDE.md already
// documents that its core cursor-tracking mechanic has no touch-input
// equivalent (only OrbitControls' camera pan/zoom is touch-enabled, a
// pre-existing, separate interaction), so there's no genuine touch
// gesture stream here worth classifying the way the template's own
// touch-first reference project needed.
// WIDENED 2026-09-16, direct user report ("when i do triple or quad
// click. it registers and trigges double click first. I dont see a
// double click confirm delay") -- a real-world triple/quad-click attempt
// has more gaps that can exceed this window than a 2-click double-click
// does, so a slightly-too-slow gap between click 2 and click 3 gets read
// as "sequence over" early, visibly firing dblclick's own pose (enabled)
// before the 3rd click ever arrives as its own separate, later sequence.
// 350ms -> 450ms was a first, judgment-call increase -- NOT a measured
// value (CLAUDE.md §0c). Same-day follow-up report ("when i try quad
// click. it triggers triple click first") shows 450ms still isn't
// forgiving enough for a real 4-click attempt, whose 3 individual gaps
// are each a chance to exceed the window -- a 4th click is also simply a
// less-practiced human gesture than a 2nd, so its own gap is more likely
// to run long. Since this same constant has now needed re-tuning twice in
// one day, it's converted from a hardcoded value into an actual dev-panel
// slider (`cfg.multiClickWindowMs`, Debug group) instead of bumping the
// literal again -- per CLAUDE.md §12n ("feel/response curves are sliders,
// not constants"), so any further tuning doesn't need another code
// round-trip. Default raised to 600ms as this round's own judgment call,
// same "no real telemetry, modest reversible increase" reasoning as
// before. Shared by 3 systems (this comment's own siblings below): the
// fire-and-forget click-pose debounce, the click-hold chain continuation
// window, and the Mouse Tracking Log's own multi-click classification --
// deliberately still ONE setting, not 3 separately-tuned ones, per this
// value's own original "for consistency" intent.
// INVARIANT (see makeClickHoldPoseGroup()'s own `${p}HoldConfirmMs` control
// comment, 2026-09-15, for the full original account): every CLICK_HOLD_KEYS
// member's own HoldConfirmMs should be >= this value. If it's lower, a press
// held just long enough to make its pose VISIBLE isn't necessarily held long
// enough to be CLASSIFIED as a genuine hold on release (vs. "just another
// clean click continuing a multi-click chain") -- the pose flashes on then
// immediately reverses, and/or the click-hold chain misreads a real hold as
// a clean click. Confirmed live 2026-09-16 as the actual cause of "triple-
// click-hold works, quad-click-hold doesn't": `quadClickHoldHoldConfirmMs`
// had drifted to 310ms (below this 500ms threshold) while
// `tripleClickHoldHoldConfirmMs` correctly sat at 500 -- corrected in the
// live settings, not by raising this constant. This is a real recurring
// footgun (the SAME bug class already hit chp/rchp once before) -- when
// tuning any `${p}HoldConfirmMs` slider, check it against this value.
const MOUSE_LOG_HELD_DRAG_MS = 500
let mouseLogClickCount = 0
let mouseLogClickTimer = null
let mouseLogPendingClick = null
let mouseLogDownInfo = null
let mouseLogLastViewport = null

let modelRoot = null
let modelLoaded = false
// Frame counter for updateRenderOrder()'s idle-repose stagger
// (wristSplayReposeStagger) -- incremented once per updateRenderOrder()
// call, never per-hand, so every hand's turn this frame is computed
// against the same frame number. Declared here (near the top of the
// module) rather than next to updateRenderOrder() itself: animate() is
// called synchronously immediately after its own definition (see its
// `animate()` call right below the function), well before this file
// reaches updateRenderOrder()'s own definition further down -- a `let`
// declared down there would still be in its temporal dead zone on that
// first synchronous call, throwing "Cannot access before initialization"
// (confirmed live, 2026-09-16, before moving it here).
let idleReposeFrameCounter = 0
// ROOT CAUSE of a real, severe startup-lag regression, 2026-09-16 (direct
// user report: "way way way worse than ever before... its mainly laggy
// on startup... the hands are getting into position and setting their
// crops... then once it reaches some equilibrium state then the app is
// fine" -- and interacting DURING that settle makes it worse still).
// Caused by this SAME session's own earlier fix: `restoreValuesForEveryVisitor()`
// (devPanel.js, see its own comment) now correctly fetches real saved
// settings for EVERY visitor, not just `?dev=1` ones -- but that fetch
// is a real network round-trip, and the GLTFLoader callback below
// (`rebuildField()`, building every hand from whatever `cfg` currently
// holds) almost always finishes FIRST, since it only needs to load a
// local static asset. Net effect: the field built and revealed once
// with CODE DEFAULTS, then a moment later the real settings landed and
// every affected control's own onChange fired (`rebuildField()` again
// for fieldRows/fieldCols, plus every other Pose/Camera/Lighting
// control's own reflow) -- visibly rebuilding/repositioning/recropping
// the ENTIRE field in front of the user, and genuinely doing the
// (expensive) field-build work TWICE. This gate makes the field build
// exactly ONCE, using the REAL settings, by holding the loading screen
// up until BOTH the model has loaded AND settings restore has actually
// landed (`tryStartField()`, called from both the GLTFLoader callback
// below and `onRestore`, above). A bounded fallback timeout still starts
// the field on whatever `cfg` currently holds if settings restore is
// taking unreasonably long, so a visitor on a genuinely broken/
// unreachable connection is never left staring at "Loading hands..."
// forever -- same risk profile as before this whole feature existed.
// 6000ms itself is a judgment call, not derived from a strict formula,
// but sized against a real measurement: a live production fetch to
// `/api/save-settings` (warm, ~297KB response) measured 332.6ms total
// (291.4ms fetch + 41.2ms JSON parse) -- 6000ms leaves roughly 18x
// headroom over that measured figure for a slower/cold-start request.
let modelMeasurementsReady = false
let startupSettingsReady = false
let fieldStarted = false
// Loading Preview's own "Min Loading Time" (direct request) -- captured
// here, at the earliest point this module runs, so the min-time window
// starts from the true page-load moment, not from whenever tryStartField()
// first happens to be called.
const pageLoadStartMs = performance.now()
let minLoadingTimeTimerSet = false
function tryStartField() {
  if (fieldStarted || !modelMeasurementsReady || !startupSettingsReady) return
  // Only actually holds the reveal back when the loading preview itself
  // is on -- see the control's own DEV_GROUPS comment for why an
  // artificial delay with nothing to show isn't what was asked for.
  if (cfg.loadingPreviewEnabled) {
    const minMs = Math.max(0, cfg.loadingMinTimeMs || 0)
    const elapsed = performance.now() - pageLoadStartMs
    if (elapsed < minMs) {
      if (!minLoadingTimeTimerSet) {
        minLoadingTimeTimerSet = true
        setTimeout(tryStartField, minMs - elapsed)
      }
      return
    }
  }
  fieldStarted = true
  rebuildField()
  buildPosePreview()
  // ROOT CAUSE of the REAL startup jank, found 2026-09-16 after the
  // settings-restore-race fix above turned out NOT to be it (direct user
  // report: same issue persisted after that fix; further direct report --
  // "on mobile it doesnt lag, but the startup animation thing is still
  // happening... its smooth though" -- proved the visible "hands settling
  // into position" is the EXPECTED cursor-tracking damping animation
  // (hand.wrapper.quaternion.slerp toward the cursor, cfg.trackingDamping),
  // not a bug, since it happens on BOTH platforms; the bug is specifically
  // that DESKTOP drops frames WHILE that normal animation plays, and
  // mobile doesn't). Every field hand gets its OWN CLONED material (see
  // createToonMaterial()'s own comment -- required for per-hand wrist-
  // clip planes, `customProgramCacheKey` sharing was tried and reverted
  // for a real, different correctness bug), and WebGL shader compilation
  // is LAZY -- deferred to the first frame each material is actually
  // DRAWN, not when it's created. That means up to ~240+ separate GPU
  // shader-program compiles were silently happening spread across the
  // FIRST FEW RENDERED FRAMES (exactly the visible "settling" window,
  // since that's also when cursor-tracking is still converging) rather
  // than in one controlled spot -- and raw shader-compile speed is a
  // genuinely GPU-driver-dependent cost that varies far more between a
  // desktop's own GPU/driver and a modern phone's than between the 2
  // platforms' actual JS/CPU work, plausibly explaining the platform
  // split on its own. `renderer.compile()` (three.js's own standard fix
  // for exactly this class of stutter) forces every material in the
  // scene to compile its program HERE, synchronously, behind the loading
  // screen, moving the compile cost to one controlled spot instead of
  // smearing it across the first several visible, actively-animating
  // frames.
  //
  // CORRECTED 2026-09-16, same day, via the user's own real measurement:
  // this hypothesis is WRONG, or at best a minor contributor -- the
  // temporary diagnostic this call briefly shipped with measured
  // `renderer.compile()` itself at only 49.8ms for 240 hands on the
  // user's OWN reported-laggy desktop, nowhere near enough to explain
  // "very very laggy." Left in place anyway (cheap, harmless, a
  // legitimate best practice regardless), but the REAL cause is still
  // open -- see the next investigation entry in CHANGELOG.txt for
  // whatever comes next; don't treat this comment's own reasoning above
  // as the settled explanation.
  renderer.compile(scene, camera)
  window.__debug = { THREE, scene, camera, controls, renderer, composer, outlinePass, hands, cfg, sceneState, handLengthRaw, alignQuat, computeBaseScale, updateRenderOrder, cursorTarget, previewHand, previewScene, previewCamera, get previewControls() { return previewControls }, poseDefaultValues, setSelectedPoseAsDefault, getSelectedSavedPoseItem, updateCursorTarget, targetPlane, cursorNDC, applyAllFingerPoses, applyPoseValuesToHand, get cloneBaseQuat() { return cloneBaseQuat }, triggerClickPose, startClickHoldPose, endClickHoldPose, updateClickPoseForHand, updateClickHoldPoseForHand, getOrInitHandCP, getOrInitHandCHP, computeResponsiveWristSplayDeg, applyWristPoseToSkeleton, applyCurlToSkeleton, FINGER_NAMES, FINGER_JOINTS, boneRestQuat, FINGER_CURL_AXIS, cameraDefaultValues, applyCameraPreset, captureCameraPreset, setSelectedCameraAsDefault, updateCameraMaxExtentsBound, enforceCameraPanExtent, applyCameraLockState, applyLightingPreset, captureLightingPreset, updateLoadingPreviewAnimation, get loadingPreviewLapIndex() { return loadingPreviewLapIndex }, get loadingPreviewSequenceDone() { return loadingPreviewSequenceDone }, get loadingPreviewDirection() { return loadingPreviewDirection }, get loadingPreviewCamera() { return loadingPreviewCamera }, get loadingPreviewOrbitControls() { return loadingPreviewOrbitControls }, get loadingPreviewCameraTarget() { return loadingPreviewCameraTarget } }
  loadingEl.classList.add('hidden')
  // The loading-preview canvas is a top-level sibling of #loading now
  // (2026-09-17, decoupled specifically so this moment doesn't force it
  // to disappear too) -- hide it UNLESS the live-preview toggle wants it
  // kept visible (a session that had it on going into this transition
  // keeps seeing it seamlessly, rather than blinking off and needing a
  // 2nd click to bring it back). Reuses setLoadingPreviewLiveVisible()'s
  // own full rebuild-then-animate path rather than just starting the
  // loop directly -- covers the real edge case where the checkbox was
  // checked before the model even finished loading while
  // loadingPreviewEnabled was off, in which case NOTHING was ever built
  // yet for the loop to animate.
  if (cfg.loadingPreviewShowLive) {
    setLoadingPreviewLiveVisible(true)
  } else if (loadingPreviewCanvas) {
    loadingPreviewCanvas.style.display = 'none'
  }
}
setTimeout(() => { startupSettingsReady = true; tryStartField() }, 6000)
let framedOnce = false // camera/lighting/target-plane are framed ONCE, on first build -- Field Layout changes must never re-trigger this (direct request)
const hands = [] // { wrapper: Group, clone: Object3D, skinnedMesh: SkinnedMesh|null, outlineMesh: Mesh|null }
const sceneState = { fieldRadius: 10 }

const UP = new THREE.Vector3(0, 1, 0)
// Permanently fixed at z=0 (the hands' own field-layout plane) -- used
// ONLY to derive cursorTarget's X/Y ("the true cursor xy," direct user
// request), never mutated again after construction. See
// updateCursorTarget()'s own comment for why X/Y and Z (the latter
// driven by targetDepthFactor) are computed independently now, and why
// this no longer needs an updateTargetPlane()-style refresh function.
const targetPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const cursorTarget = new THREE.Vector3(0, 0, 0)
const rendererSizeCheck = new THREE.Vector2()
const cursorNDC = new THREE.Vector2(0, 0)
const raycaster = new THREE.Raycaster()
const projectScratch = new THREE.Vector3()
const boundsCenterScratch = new THREE.Vector3()

// -----------------------------------------------------------------------
// Dev panel groups (CLAUDE.md Section 12)
// -----------------------------------------------------------------------
const DEV_GROUPS = [
  {
    title: 'Field Layout',
    // Every control below is perDevice (added 2026-09-15, direct request:
    // "Allow for separate field layout settings and camera settings for
    // Desktop and Mobile") -- Desktop and Mobile (and Landscape, via the
    // same standard §12f 3-tab mechanism) can each hold their own,
    // genuinely independent grid/spacing/scale tuning from now on. No
    // `defMobile`/`defLandscape` overrides are set here -- all 3 devices
    // start out identical (cloned from `def`, the existing established
    // fallback per §12f), since this project has no design brief for what
    // Mobile's own layout SHOULD look like; that's a live tuning decision
    // for whoever opens the panel's own Mobile tab, not something to
    // invent numbers for here. `commit()`/`syncValue()` in devPanel.js
    // already gate live onChange firing behind `editingDevice ===
    // realDeviceClass()` generically -- no devPanel.js changes were
    // needed to support this, just the `perDevice: true` flag per control.
    controls: [
      { key: 'fieldRows', label: 'Rows (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 15, perDevice: true, onChange: () => rebuildField() },
      { key: 'fieldCols', label: 'Columns (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 17, perDevice: true, onChange: () => rebuildField() },
      { key: 'rowSpacing', label: 'Row Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 9.5, perDevice: true, onChange: () => relayoutField() },
      { key: 'columnSpacing', label: 'Column Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 14, perDevice: true, onChange: () => relayoutField() },
      { key: 'handScale', label: 'Hand Scale (x)', type: 'slider', min: 0.1, max: 3, step: 0.05, def: 1.55, perDevice: true, onChange: () => relayoutField() },
      // Classic brick/hex stagger: shifts every OTHER row sideways (along
      // the column axis, i.e. perpendicular to how rows themselves stack
      // in the row direction) by a fixed amount -- the standard reading of
      // "alternate row offset." If a Z-depth stagger was actually meant
      // instead, this is a 1-line change (see relayoutField()).
      { key: 'alternateRowOffset', label: 'Alternate Row Offset (World Units)', type: 'slider', min: -20, max: 20, step: 0.5, def: -5.5, perDevice: true, onChange: () => relayoutField() },
      { key: 'progressiveRowOffset', label: 'Progressive Row Offset (World Units / Row)', type: 'slider', min: -20, max: 20, step: 0.5, def: 0, perDevice: true, onChange: () => relayoutField() },
      { key: 'useProgressiveOffset', label: 'Use Progressive Offset (Off = Alternate)', type: 'checkbox', def: false, perDevice: true, onChange: () => relayoutField() },
      // Direct request ("Provide a Hide Hands checkbox in the Field
      // Layout settings group"). perDevice, matching every other control
      // in this group. Toggles each hand's own wrapper Group directly
      // (cheap, no rebuild) rather than removing/re-adding hands from the
      // scene -- see updateHandsVisibility()'s own comment.
      { key: 'hideHands', label: 'Hide Hands', type: 'checkbox', def: false, perDevice: true, onChange: () => updateHandsVisibility() }
    ]
  },
  {
    title: 'Cursor Tracking',
    // CORRECTED 2026-09-16, direct request ("for cursor tracking
    // settings, let mobile and desktop have different settings") --
    // every control below is now `perDevice: true`, reversing this
    // group's own prior standing note (see CLAUDE.md's "Dev-panel
    // behavior" section, corrected in place there too, not deleted) that
    // Cursor Tracking was deliberately SHARED across Desktop/Mobile/
    // Landscape since the mechanic has no touch-input equivalent. That
    // reasoning was about the INTERACTION having no touch counterpart,
    // not about whether its own tuning should differ per device -- the
    // user is asking for the latter regardless of the former, same
    // distinction already drawn for the CAMERA's own pan/zoom in that
    // same note.
    controls: [
      { key: 'trackingEnabled', label: 'Tracking Enabled', type: 'checkbox', def: true, perDevice: true },
      { key: 'trackingDamping', label: 'Look-At Damping (x)', type: 'slider', min: 0.02, max: 1, step: 0.01, def: 1, perDevice: true },
      // No onChange needed -- updateCursorTarget() (called every frame)
      // reads cfg.targetDepthFactor live when it sets cursorTarget.z, so
      // there's no cached per-depth state to refresh on a slider change
      // anymore (see that function's own 2026-09-14 correction comment).
      { key: 'targetDepthFactor', label: 'Cursor Target Depth (x Field Radius)', type: 'slider', min: -2, max: 2, step: 0.05, def: 0.6, perDevice: true },
      { key: 'showTargetMarker', label: 'Show Target Marker', type: 'checkbox', def: false, perDevice: true, onChange: (v) => { if (targetMarker) targetMarker.visible = v } },
      // REDEFINED 2026-09-14 (see computeRadialRollDeg()'s own comment
      // for the full account and the user's own exact reference points):
      // rotates each hand, around the wrist-crop-plane axis, by the
      // angle from that hand's OWN position to the live cursor -- a 2D
      // "compass needle" roll in the field's own XY plane, computed
      // fresh per hand per frame, not a fixed 3D palm-normal-aim (the
      // prior mechanism this replaced). Default off so nothing changes
      // until opted in.
      { key: 'palmFacesCursor', label: 'Palm Faces Cursor', type: 'checkbox', def: true, perDevice: true },
      // Adds directly onto whatever angle is already in effect --
      // computeRadialRollDeg()'s own dynamic angle when Palm Faces
      // Cursor is on, or 0 (just this slider alone) when it's off --
      // per direct instruction ("My Palm Face rotation slider wil then
      // just add onto that rotation number"). Rotates around the wrist
      // crop plane's own normal (see computeRollQuat()'s own comment for
      // why that axis) -- CLAUDE.md 12n, "feel/response curves are
      // sliders, not constants."
      { key: 'palmFaceRotationOffset', label: 'Palm Face Rotation (Deg)', type: 'slider', min: -180, max: 180, step: 1, def: 0, perDevice: true }
    ]
  },
  {
    // Direct request 2026-09-16: "is it possible to have 1 hand running
    // through a loading sequence, like a loading animation?" then "build
    // it... provide me a checkbox to turn it on and off... appropriate
    // settings in the dev panel... allow me to set a min loading time."
    // A 3rd, independent hand-preview instance (alongside the main field
    // and the Pose Preview panel) -- see `buildLoadingPreview()`'s own
    // comment for why it can't just reuse Pose Preview's.
    title: 'Loading Preview',
    controls: [
      { key: 'loadingPreviewEnabled', label: 'Show Hand Loading Animation', type: 'checkbox', def: true },
      // Direct request, following up on the Offset X/Y sliders below
      // ("so i can position the loading hand preview" implies actually
      // being able to SEE it while tuning, not just during the real
      // startup screen's own narrow window) -- confirmed via
      // AskUserQuestion this means a genuine on-demand live preview,
      // not just the checkbox directly above. Independent on/off switch
      // from loadingPreviewEnabled -- can preview it live even with
      // that one off. See setLoadingPreviewLiveVisible()'s own comment
      // for the render-loop mechanics this needs (the real startup
      // sequence's own animation loop permanently stops once the real
      // hand field starts, by design -- this reopens it on demand
      // through a separate loop, rather than reversing that).
      { key: 'loadingPreviewShowLive', label: 'Show Loading Preview (Live, No Reload Needed)', type: 'checkbox', def: false, onChange: (v) => setLoadingPreviewLiveVisible(v) },
      // Only actually delays the reveal while the preview above is ALSO
      // on (see tryStartField()'s own gate) -- an artificial delay with
      // nothing to show for it isn't what was asked for.
      { key: 'loadingMinTimeMs', label: 'Min Loading Time (Ms)', type: 'slider', min: 0, max: 5000, step: 100, def: 1200 },
      { key: 'loadingPreviewTweenSelector', label: 'Loading Tween Sequence', type: 'select', def: '', options: () => (cfg.savedTweenSequences || []).map((s) => ({ value: s.name, group: s.group || null })) },
      // Camera/Lighting selection for the loading preview's own SEPARATE
      // scene -- direct follow-up request ("allow selecting a Camera
      // setting and a Lighting setting for the chosen loading-preview
      // tween sequence"). Empty selection (default) preserves the
      // EXISTING auto-framed camera / cloned-live-lighting behavior
      // exactly -- see buildLoadingPreview()'s own comment for where
      // these are actually applied.
      //
      // Direct request 2026-09-19 ("so the camera settings for the
      // loading preview should be local to that only"): this list-picker
      // is this preview's own LOCAL saved-cameras list, separate from the
      // main field's own `savedCameras` (which `loadingPreviewCameraSelector`
      // used to read from -- see applyLoadingPreviewCameraPreset()'s own
      // comment for why that was wrong: the main field's saved views are
      // tuned for a far-away whole-field shot, not a single close-up
      // hand). `importable: true` lets a HANDO-authored camera JSON be
      // pasted in directly (normalizeCameraPresetItem() accepts its
      // shorter x/y/z/tx/ty/tz/fov naming too), and Save/Use/Delete work
      // the same as the main Saved Cameras list -- `captureCurrent`
      // grabs wherever this preview's own camera currently is,
      // `onUse` re-applies a saved item to it live for an immediate
      // preview.
      // `importTransform` (direct follow-up, 2026-09-19: "so being able to
      // port and read Hando's exported data is very important") --
      // converts a pasted HANDO camera export through
      // convertHandoCameraPreset() (see its own comment for the full
      // derivation) BEFORE it's merged into this list, so pasting HANDO's
      // own "Left"/"Right"/etc. export just works instead of landing
      // pointed at empty space. Only wired on THIS local list, not the
      // main field's own `savedCameras` -- that one frames the WHOLE
      // FIELD at field-radius scale, a fundamentally different context
      // HANDO (a single-hand-only app) has no equivalent of, so the same
      // conversion wouldn't be meaningful there.
      // CORRECTED 2026-09-19, direct follow-up request -- restored (was
      // briefly hidden via `hideUseButton` on the theory that the paired
      // select dropdown's own live-apply made it redundant; asked back).
      {
        key: 'loadingPreviewSavedCameras',
        label: 'Loading Preview Saved Cameras',
        type: 'list-picker',
        def: [],
        itemLabel: 'Loading Preview Camera',
        importable: true,
        importTransform: (item) => convertHandoCameraPreset(item),
        captureCurrent: () => captureLoadingPreviewCameraPreset(),
        onUse: (item) => applyLoadingPreviewCameraPreset(item),
        // Direct report 2026-09-19 ("those options arent immediatly
        // available in the drop downs") -- same fix savedPoses' own
        // onChange already applies to ITS dependent selects (see that
        // control's own comment): a `select` control's <option> list is
        // only rebuilt on an explicit refreshSelectOptions() call, never
        // automatically.
        onChange: () => safeRefreshSelectOptions('loadingPreviewCameraSelector')
      },
      // CORRECTED 2026-09-19, direct report ("I change them and nothing
      // atually changes in the preview") -- this select had NO onChange
      // at all. buildLoadingPreview() only reads this selector ONCE, at
      // build time -- changing the dropdown updated `cfg` but nothing
      // ever re-applied it to the already-built preview. Reuses the
      // exact same apply functions buildLoadingPreview() itself calls,
      // gated on `loadingPreviewRenderer` existing (only takes effect
      // live if the preview is currently built/visible; never force-
      // shows it).
      { key: 'loadingPreviewCameraSelector', label: 'Loading Preview Camera', type: 'select', def: '', options: () => (cfg.loadingPreviewSavedCameras || []).map((c) => ({ value: c.name, group: c.group || null })), onChange: () => { if (!loadingPreviewRenderer) return; const item = (cfg.loadingPreviewSavedCameras || []).find((c) => c.name === cfg.loadingPreviewCameraSelector); if (item) applyLoadingPreviewCameraPreset(item); else applyLoadingPreviewCameraAutoFrame() } },
      // Direct request 2026-09-19 ("so lighitng settings for the loading
      // preview will also be local to that, and the hand field itself
      // wil have its own") -- same local-list split as Camera above,
      // same reasoning: the main field's own `savedLighting` lights the
      // WHOLE FIELD at field-radius scale (also not something HANDO has
      // an equivalent of), so it stays separate and untouched.
      {
        key: 'loadingPreviewSavedLighting',
        label: 'Loading Preview Saved Lighting',
        type: 'list-picker',
        def: [],
        itemLabel: 'Loading Preview Lighting',
        importable: true,
        importTransform: (item) => convertHandoLightingPreset(item),
        captureCurrent: () => captureLoadingPreviewLightingPreset(),
        onUse: (item) => { if (loadingPreviewKeyLightRef && loadingPreviewHemiLightRef) applyLoadingPreviewLighting(loadingPreviewKeyLightRef, loadingPreviewHemiLightRef, item) },
        onChange: () => safeRefreshSelectOptions('loadingPreviewLightingSelector')
      },
      // Same fix as loadingPreviewCameraSelector above -- was missing an
      // onChange entirely. `applyLoadingPreviewLightingDefault()` (see
      // its own comment) re-clones the main scene's CURRENT key/hemi
      // lights when the selection is cleared, matching what
      // buildLoadingPreview() itself does at build time for "no preset
      // selected."
      { key: 'loadingPreviewLightingSelector', label: 'Loading Preview Lighting', type: 'select', def: '', options: () => (cfg.loadingPreviewSavedLighting || []).map((l) => ({ value: l.name, group: l.group || null })), onChange: () => { if (!loadingPreviewKeyLightRef || !loadingPreviewHemiLightRef) return; const item = (cfg.loadingPreviewSavedLighting || []).find((l) => l.name === cfg.loadingPreviewLightingSelector); if (item) applyLoadingPreviewLighting(loadingPreviewKeyLightRef, loadingPreviewHemiLightRef, item); else applyLoadingPreviewLightingDefault() } },
      { key: 'loadingPreviewSpeedMs', label: 'Loading Preview Speed (Ms / Cycle)', type: 'slider', min: 200, max: 5000, step: 50, def: 900 },
      // Sequence Mode - Count/Loop/Oscillate -- direct spec item, the
      // SAME control shape just added to every click function (see
      // makeClickPoseGroup()'s own matching comment for the full
      // reasoning), reused here almost verbatim. ONE real difference:
      // default 'Loop' (unbounded), not 'Count' -- this preserves the
      // loading preview's own EXISTING always-loop-forever behavior as
      // the default, rather than silently changing it to stop after 3
      // laps for every current user. A click trigger's natural default
      // is a bounded action; a loading animation's natural default is
      // "keep playing for as long as the page is still loading."
      { key: 'loadingPreviewSequenceMode', label: 'Sequence Mode - Count, Loop, Oscillate', type: 'select', def: 'Loop', options: () => ['Count', 'Loop', 'Oscillate'], onChange: () => updateLoadingPreviewSequenceVisibility() },
      { key: 'loadingPreviewSequenceCount', label: 'Sequence Count', type: 'slider', min: 1, max: 50, step: 1, def: 3 },
      { key: 'loadingPreviewSequenceCountMode', label: 'Sequence Count Mode - Loop, Oscillate', type: 'select', def: 'Loop', options: () => ['Loop', 'Oscillate'], onChange: () => updateLoadingPreviewSequenceVisibility() },
      { key: 'loadingPreviewSequenceLoopTransition', label: 'Loop Transition On/Off', type: 'checkbox', def: true },
      { key: 'loadingPreviewSequenceHoldMs', label: 'Sequence Hold Duration (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 0 },
      { key: 'loadingPreviewSize', label: 'Loading Preview Size (Px)', type: 'slider', min: 80, max: 400, step: 10, def: 160, onChange: () => resizeLoadingPreview() },
      // CORRECTED 2026-09-19, direct request+follow-up ("Loading Preview
      // Rotation X Y Z and XY offset should reflect the camera settings"
      // -> confirmed via AskUserQuestion: repurpose, don't keep the old
      // hand-rotation/canvas-CSS-position meaning) -- these 5 controls
      // used to rotate the loading-preview HAND itself (folded into
      // loadingPreviewBaseQuat) and nudge the CANVAS's own on-screen CSS
      // position, respectively. Now they're a live readout/driver of the
      // Loading Preview's own ORBIT CAMERA (see loadingPreviewCameraEditMode
      // just below): X/Y are the camera's elevation/azimuth around the
      // hand's own center (loadingPreviewOrbitOrigin()), Z is camera roll
      // (no live mouse gesture drives this -- there's no natural
      // "roll" orbit-control binding -- but it's still settable by hand,
      // matching every other slider in this panel's own click-to-type
      // convention), Offset X/Y is the orbit TARGET's own world-space X/Y
      // displacement from the hand's center (i.e. pan). Continuously
      // synced FROM the live camera every frame while Edit Mode is on
      // (syncLoadingPreviewOrbitSlidersFromLive(), called from both
      // render loops) and drive the camera FORWARD via their own onChange
      // (applyLoadingPreviewOrbitFromSliders()) so they stay usable even
      // with Edit Mode off, consistent with every other slider here. Per
      // direct clarification ("the ultimate Loading Preview camera should
      // just be whatever is selected in the dropdown... If i orbit and
      // zoom and i like what i set, i will hit Save"), these 5 are a
      // live/session-only view -- NOT what persists. buildLoadingPreview()
      // still resolves the real camera purely from
      // loadingPreviewCameraSelector/loadingPreviewSavedCameras, then
      // derives these 5 values FROM that result (deriveLoadingPreviewOrbitSliders())
      // so a rebuild always snaps back to the dropdown's own camera,
      // exactly as before -- orbiting never overrides it unless the user
      // explicitly re-Saves via the list-picker's own Save button.
      { key: 'loadingPreviewRotationX', label: 'Loading Preview Rotation X (Deg)', type: 'slider', min: -89, max: 89, step: 1, def: 0, onChange: (v) => applyLoadingPreviewOrbitFromSliders() },
      { key: 'loadingPreviewRotationY', label: 'Loading Preview Rotation Y (Deg)', type: 'slider', min: -180, max: 180, step: 1, def: 0, onChange: (v) => applyLoadingPreviewOrbitFromSliders() },
      { key: 'loadingPreviewRotationZ', label: 'Loading Preview Rotation Z (Deg)', type: 'slider', min: -180, max: 180, step: 1, def: 0, onChange: (v) => applyLoadingPreviewOrbitFromSliders() },
      { key: 'loadingPreviewOffsetX', label: 'Loading Preview Offset X (World Units)', type: 'slider', min: -30, max: 30, step: 0.5, def: 0, onChange: (v) => applyLoadingPreviewOrbitFromSliders() },
      { key: 'loadingPreviewOffsetY', label: 'Loading Preview Offset Y (World Units)', type: 'slider', min: -30, max: 30, step: 0.5, def: 0, onChange: (v) => applyLoadingPreviewOrbitFromSliders() },
      // Direct request ("Provide a Loading Preview Camera Edit Mode
      // checkbox. When Turned on, I can use my mouse's click and drag to
      // orbit the camera, and right click to pan the camera, as well as
      // scroll to zoom the camera... it orbits around the center of the
      // hand as an orbit origin point, [like HANDO]"). Reuses three.js's
      // own OrbitControls (already imported, same as the main scene's
      // and Pose Preview's own cameras) -- its stock default MOUSE
      // mapping is ALREADY exactly this (LEFT: ROTATE, RIGHT: PAN, wheel:
      // DOLLY/zoom), so no custom button remapping is needed, unlike the
      // main scene's own controls (which deliberately disables rotate).
      // `#loadingPreviewCanvas` is `pointer-events: none` in style.css by
      // design (so the preview never steals clicks meant for the real
      // page underneath it) -- OrbitControls needs real mouse events to
      // orbit/pan/zoom, so Edit Mode also flips this on/off live, not
      // just `.enabled` on the controls object itself (which alone would
      // silently do nothing -- the canvas would never even receive the
      // events for OrbitControls to ignore-or-not).
      { key: 'loadingPreviewCameraEditMode', label: 'Loading Preview Camera Edit Mode', type: 'checkbox', def: false, onChange: (v) => { if (loadingPreviewOrbitControls) loadingPreviewOrbitControls.enabled = v; if (loadingPreviewCanvas) loadingPreviewCanvas.style.pointerEvents = v ? 'auto' : 'none' } }
    ]
  },
  {
    // Phase 4, first slice, of the Click Function overhaul (direct
    // request, "the other session is done. fix everything" -- confirmed
    // via AskUserQuestion to proceed with a scoped-down first slice
    // rather than the full spec at once). A genuinely NEW capability:
    // custom click-triggered pose functions, created at runtime rather
    // than hardcoded like the existing 10 (chp/rchp/dcHold/
    // tripleClickHold/quadClickHold/click/dblclick/rc/tripleClick/
    // quadClick). Required extending devPanel.js itself with a new
    // exported `renderDynamicGroup()` (the engine had no way to inject a
    // brand-new, LIVE, interactive control group at runtime before this
    // -- only an EMPTY group the user drags existing settings into, see
    // devPanel.js's own addCustomGroup()/its matching comment) --
    // confirmed safe to do now (the concurrent session actively editing
    // that file finished and pushed its own work first, direct
    // confirmation).
    //
    // CORRECTED 2026-09-19 (direct follow-up requests, 2 rounds): now 2
    // entry points, not 1 -- "+ Add Click Function" (fire-and-forget,
    // reuses makeClickPoseGroup()) and "+ Add Click+Hold Function"
    // (hold-based, reuses makeClickHoldPoseGroup()) -- exactly the split
    // this section's own original comment already anticipated ("a hold-
    // based custom function would need its own '+Add Click+Hold
    // Function' entry point, since the hold and fire-and-forget families
    // are 2 architecturally distinct state machines that can't share one
    // control's worth of Type switching"). Each new function is also now
    // tagged with a `family` ('desktop' or 'mobile') read from whichever
    // dev-panel TAB is active at the moment the button is clicked (direct
    // request: "If I add a click function in the mobile tab, that click
    // function will only be available to mobile and landscape tab, not
    // desktop") -- see addCustomClickFunction()'s own comment for exactly
    // how the tab is read and how the resulting group is hidden outside
    // its own family.
    //
    // Type's own option list is now real (Click/Right Click via the pose
    // button, Click+Hold/Right Click+Hold via the hold button -- 4 of
    // the 5 desktop options from the original spec's own list), narrowed
    // further by family (mobile drops Right Click/Right Click+Hold
    // entirely, matching "Dont show scroll or right click functions" on
    // Mobile from the original spec's own item H).
    //
    // CORRECTED 2026-09-19 (direct follow-up, "do 1,2,3,4 and 8" against
    // the gap report this section used to list below): Scroll (desktop,
    // 'pose' kind only -- no hold analog for a wheel gesture) and Multi-
    // Point Touch (mobile, both kinds) are now real Type options, each
    // with their own new detection subsystem (see triggerCustomPoseFunctions()'s
    // own `wheel` listener and the `touchstart`/`touchend`/`touchcancel`
    // trio right after it). A Click Count selector ("Triggers On (Nth
    // Click)"/"...(Nth Press-And-Hold)", spliced in next to Type, hidden
    // for Types with no real chain of their own) now lets a custom Click/
    // Click+Hold function pick which press in this app's own EXISTING
    // left-button multi-click/hold chains fires it (1st through 4th) --
    // Right Click/Right Click+Hold/Scroll/Multi-Point still always fire
    // on their own single press/tap/scroll-tick (disclosed simplification:
    // no multi-click chain exists for the right button or for a wheel/
    // touch gesture in this app today, so there's no position to select
    // within for those).
    //
    // CORRECTED 2026-09-19: deleting a custom function via the dev
    // panel's own existing Delete Group/Setting (🗑) icon now genuinely
    // cleans up -- devPanel.js's own new `opts.onGroupDeleted` host hook
    // (initDevPanel()'s own call site) calls
    // cleanupDeletedCustomClickFunction(), which removes this function
    // from `customClickFunctionIds`, its `CLICK_POSE_KEYS`/
    // `CLICK_HOLD_KEYS` slot, its own trigger-state object, and every
    // hand's own per-function state. Reuses the existing icon rather than
    // a separate dedicated delete button, per this comment's own earlier
    // reasoning (a redundant 2nd delete mechanism was never actually
    // needed -- the gap was the missing cleanup hook, not the UI).
    //
    // Duplicate-setting validation and automatic hold-timing conflict
    // resolution across custom Click+Hold functions also shipped this
    // round -- see CHANGELOG.txt's own 2026-09-19 entries for the full
    // account of both.
    //
    // `customClickFunctionIds` is the ONLY control in this static group
    // -- a plain internal-bookkeeping text field (JSON array of
    // `{id, title, kind, family}`), never meant for direct editing,
    // restored through the normal cfg pipeline like any other control
    // (see restoreCustomClickFunctions()'s own comment for how it drives
    // re-creating every custom function's LIVE group fresh on each page
    // load, since `renderDynamicGroup()`'s own DOM rows don't persist
    // across a reload on their own).
    title: 'Custom Click Functions',
    controls: [
      { key: 'customClickFunctionIds', label: 'Custom Function IDs (Internal, Auto-Managed)', type: 'text', def: '[]' },
      { key: 'addCustomClickFunctionBtn', label: '+ Add Click Function', type: 'button', onClick: () => addCustomClickFunction('pose') },
      { key: 'addCustomClickHoldFunctionBtn', label: '+ Add Click+Hold Function', type: 'button', onClick: () => addCustomClickFunction('hold') }
    ]
  },
  {
    title: 'Pose',
    controls: [
      // Direct request 2026-09-16: "I now want a checkbox in the Pose
      // group. It allows me to turn on the Pose Preview, which will no
      // longer show by default in the dev panel. When turned on, the
      // pose preview will be its own separate panel that can be resized
      // and moved around." Replaces the old always-embedded "Pose
      // Preview" dev-group entirely -- see `buildPosePreview()`'s own
      // comment for the floating-panel chrome this now drives.
      { key: 'posePreviewEnabled', label: 'Show Pose Preview (Floating Panel)', type: 'checkbox', def: false, onChange: (v) => setPosePreviewVisible(v) },
      // Ported from HANDO's own Pose group (identical rig/bone names, same
      // Hand2.glb asset) -- applies identically to every hand for now, per
      // direct request ("For now, the pose settings apply to every hand").
      { key: 'thumbCurl', label: 'Thumb Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 79, lockRange: true, onChange: () => applyCurl('thumb') },
      { key: 'thumbSplay', label: 'Thumb Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 54, onChange: () => applyCurl('thumb') },
      { key: 'thumbSplay2', label: 'Thumb Tip Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 32, onChange: () => applyCurl('thumb') },
      { key: 'curlBiasThumb', label: 'Thumb Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 18, onChange: () => applyCurl('thumb') },
      // Ported from HANDO (direct request: "maybe check hando for pose
      // settings. maybe there is an extra setting you dont have" --
      // this WAS it, see FINGER_BASE_ONLY_CURL_KEY's own comment).
      { key: 'baseOnlyCurlThumb', label: 'Thumb Base-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'midOnlyCurlThumb', label: 'Thumb 2nd Segment Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'tipOnlyCurlThumb', label: 'Thumb Tip-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'tipTwistThumb', label: 'Thumb Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 4, onChange: () => applyCurl('thumb') },
      { key: 'curlIndex', label: 'Index Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 96, lockRange: true, onChange: () => applyCurl('index') },
      { key: 'splayIndex', label: 'Index Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 15, onChange: () => applyCurl('index') },
      { key: 'splayIndex2', label: 'Index 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 72, onChange: () => applyCurl('index') },
      { key: 'curlBiasIndex', label: 'Index Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: -7, onChange: () => applyCurl('index') },
      { key: 'baseOnlyCurlIndex', label: 'Index Base-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'midOnlyCurlIndex', label: 'Index Mid-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'tipOnlyCurlIndex', label: 'Index Tip-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'tipTwistIndex', label: 'Index Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 1, onChange: () => applyCurl('index') },
      { key: 'curlMiddle', label: 'Middle Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: -89, lockRange: true, onChange: () => applyCurl('middle') },
      { key: 'splayMiddle', label: 'Middle Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: -14, onChange: () => applyCurl('middle') },
      { key: 'splayMiddle2', label: 'Middle 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: -13, onChange: () => applyCurl('middle') },
      { key: 'curlBiasMiddle', label: 'Middle Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 10, onChange: () => applyCurl('middle') },
      { key: 'baseOnlyCurlMiddle', label: 'Middle Base-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'midOnlyCurlMiddle', label: 'Middle Mid-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'tipOnlyCurlMiddle', label: 'Middle Tip-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'tipTwistMiddle', label: 'Middle Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: -5, onChange: () => applyCurl('middle') },
      { key: 'curlRing', label: 'Ring Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: -95, lockRange: true, onChange: () => applyCurl('ring') },
      { key: 'splayRing', label: 'Ring Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 37, onChange: () => applyCurl('ring') },
      { key: 'splayRing2', label: 'Ring 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: -32, onChange: () => applyCurl('ring') },
      { key: 'curlBiasRing', label: 'Ring Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: -3, onChange: () => applyCurl('ring') },
      { key: 'baseOnlyCurlRing', label: 'Ring Base-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'midOnlyCurlRing', label: 'Ring Mid-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'tipOnlyCurlRing', label: 'Ring Tip-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'tipTwistRing', label: 'Ring Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: -5, onChange: () => applyCurl('ring') },
      { key: 'curlPinky', label: 'Pinky Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 89, lockRange: true, onChange: () => applyCurl('pinky') },
      { key: 'splayPinky', label: 'Pinky Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: -82, onChange: () => applyCurl('pinky') },
      { key: 'splayPinky2', label: 'Pinky 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 33, onChange: () => applyCurl('pinky') },
      { key: 'curlBiasPinky', label: 'Pinky Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 6, onChange: () => applyCurl('pinky') },
      { key: 'baseOnlyCurlPinky', label: 'Pinky Base-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'midOnlyCurlPinky', label: 'Pinky Mid-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'tipOnlyCurlPinky', label: 'Pinky Tip-Only Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'tipTwistPinky', label: 'Pinky Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: -3, onChange: () => applyCurl('pinky') },
      { key: 'wristBend', label: 'Wrist Bend (Deg)', type: 'slider', min: -90, max: 90, step: 1, def: 0, onChange: () => applyWristPose() },
      { key: 'wristSplay', label: 'Wrist Splay (Deg)', type: 'slider', min: -30, max: 30, step: 1, def: -1, onChange: () => applyWristPose() },
      { key: 'modelRotX', label: 'Whole-Hand Rotation X (Deg)', type: 'slider', min: -200, max: 200, step: 1, def: 0, lockRange: true, onChange: () => onWholeHandRotationChange() },
      { key: 'modelRotY', label: 'Whole-Hand Rotation Y (Deg)', type: 'slider', min: -200, max: 200, step: 1, def: 0, lockRange: true, onChange: () => onWholeHandRotationChange() },
      { key: 'modelRotZ', label: 'Whole-Hand Rotation Z (Deg)', type: 'slider', min: -200, max: 200, step: 1, def: 0, lockRange: true, onChange: () => onWholeHandRotationChange() },
      // Direct user request: import poses exported from HANDO (identical
      // rig/bone names, same Pose-slider set) and preview them without
      // reposing every hand in the field -- "Use" is wired to
      // previewPosePreset() (below), which poses only the standalone
      // preview hand in the "Pose Preview" group underneath this one.
      // Deliberately does NOT include the Crop Wrist / Arm Length family
      // (cropWristEnabled/hideWrist/reactiveArmLengthEnabled/
      // armLengthRange/armLengthCurve) in what a saved pose captures --
      // that system is reactive/cursor-driven staging, not finger/wrist
      // articulation, and doesn't fit "a pose" the way it does in HANDO
      // (where Hide Wrist is a plain static crop with no reactive mode).
      {
        key: 'savedPoses',
        label: 'Saved Poses',
        type: 'list-picker',
        def: [
          { name: 'Point', thumbCurl: 79, thumbSplay: 54, thumbSplay2: 32, curlBiasThumb: 18, tipTwistThumb: 4, curlIndex: 0, splayIndex: 0, splayIndex2: 0, curlBiasIndex: 0, tipTwistIndex: 0, curlMiddle: -89, splayMiddle: -14, splayMiddle2: -13, curlBiasMiddle: 10, tipTwistMiddle: -5, curlRing: -95, splayRing: 37, splayRing2: -32, curlBiasRing: -3, tipTwistRing: -5, curlPinky: 89, splayPinky: -82, splayPinky2: 33, curlBiasPinky: 6, tipTwistPinky: -3, wristBend: 0, wristSplay: -1, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'ThumbsUp', thumbCurl: -37, thumbSplay: -60, thumbSplay2: 32, curlBiasThumb: -24, tipTwistThumb: -90, curlIndex: 89, splayIndex: 15, splayIndex2: 72, curlBiasIndex: -1, tipTwistIndex: -4, curlMiddle: -89, splayMiddle: -14, splayMiddle2: -13, curlBiasMiddle: 10, tipTwistMiddle: -5, curlRing: -95, splayRing: 37, splayRing2: -32, curlBiasRing: -3, tipTwistRing: -5, curlPinky: 89, splayPinky: -82, splayPinky2: 33, curlBiasPinky: 6, tipTwistPinky: -3, wristBend: 0, wristSplay: -1, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'MiddleFinger', thumbCurl: 79, thumbSplay: 54, thumbSplay2: 32, curlBiasThumb: -15, tipTwistThumb: 4, curlIndex: 96, splayIndex: 34, splayIndex2: -107, curlBiasIndex: -7, tipTwistIndex: -1, curlMiddle: -1, splayMiddle: 0, splayMiddle2: 0, curlBiasMiddle: -32, tipTwistMiddle: -5, curlRing: -92, splayRing: 58, splayRing2: -32, curlBiasRing: -3, tipTwistRing: -5, curlPinky: 89, splayPinky: -101, splayPinky2: 33, curlBiasPinky: 6, tipTwistPinky: -3, wristBend: 0, wristSplay: -1, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Fist', thumbCurl: 79, thumbSplay: 54, thumbSplay2: 32, curlBiasThumb: 18, tipTwistThumb: 4, curlIndex: 96, splayIndex: 15, splayIndex2: 72, curlBiasIndex: -7, tipTwistIndex: 1, curlMiddle: -89, splayMiddle: -14, splayMiddle2: -13, curlBiasMiddle: 10, tipTwistMiddle: -5, curlRing: -95, splayRing: 37, splayRing2: -32, curlBiasRing: -3, tipTwistRing: -5, curlPinky: 89, splayPinky: -82, splayPinky2: 33, curlBiasPinky: 6, tipTwistPinky: -3, wristBend: 0, wristSplay: -1, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Neutral', thumbCurl: 0, thumbSplay: 0, thumbSplay2: 0, curlBiasThumb: 0, tipTwistThumb: 0, curlIndex: 0, splayIndex: 0, splayIndex2: 0, curlBiasIndex: 0, tipTwistIndex: 0, curlMiddle: 0, splayMiddle: 0, splayMiddle2: 0, curlBiasMiddle: 0, tipTwistMiddle: 0, curlRing: 0, splayRing: 0, splayRing2: 0, curlBiasRing: 0, tipTwistRing: 0, curlPinky: 0, splayPinky: 0, splayPinky2: 0, curlBiasPinky: 0, tipTwistPinky: 0, wristBend: 0, wristSplay: 0, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Neutral - Bent Back', thumbCurl: 0, thumbSplay: 0, thumbSplay2: 0, curlBiasThumb: 0, tipTwistThumb: 0, curlIndex: 0, splayIndex: 0, splayIndex2: 0, curlBiasIndex: 0, tipTwistIndex: 0, curlMiddle: 0, splayMiddle: 0, splayMiddle2: 0, curlBiasMiddle: 0, tipTwistMiddle: 0, curlRing: 0, splayRing: 0, splayRing2: 0, curlBiasRing: 0, tipTwistRing: 0, curlPinky: 0, splayPinky: 0, splayPinky2: 0, curlBiasPinky: 0, tipTwistPinky: 0, wristBend: 7, wristSplay: -50, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Open Palm', thumbCurl: 0, thumbSplay: 0, thumbSplay2: 0, curlBiasThumb: 0, tipTwistThumb: 0, curlIndex: 0, splayIndex: -56, splayIndex2: 0, curlBiasIndex: 0, tipTwistIndex: 0, curlMiddle: 0, splayMiddle: -20, splayMiddle2: 0, curlBiasMiddle: 0, tipTwistMiddle: 0, curlRing: 0, splayRing: 0, splayRing2: 0, curlBiasRing: 0, tipTwistRing: 0, curlPinky: 0, splayPinky: 7, splayPinky2: 0, curlBiasPinky: 0, tipTwistPinky: 0, wristBend: 0, wristSplay: 0, modelRotX: 0, modelRotY: 0, modelRotZ: 0 },
          { name: 'Preflick3', thumbCurl: 104, thumbSplay: 46, thumbSplay2: 29, curlBiasThumb: -82, tipTwistThumb: 58, curlIndex: 20, splayIndex: 7, splayIndex2: 0, curlBiasIndex: -79, tipTwistIndex: 5, curlMiddle: -88, splayMiddle: -10, splayMiddle2: 0, curlBiasMiddle: -32, tipTwistMiddle: 0, curlRing: -22, splayRing: -2, splayRing2: 0, curlBiasRing: -26, tipTwistRing: 30, curlPinky: 20, splayPinky: -2, splayPinky2: 0, curlBiasPinky: -100, tipTwistPinky: 30, wristBend: 0, wristSplay: -14, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'SCISSOR 1', thumbCurl: 102, thumbSplay: 35, thumbSplay2: 38, curlBiasThumb: -23, tipTwistThumb: 34, curlIndex: 0, splayIndex: -39, splayIndex2: -3, curlBiasIndex: -79, tipTwistIndex: 5, curlMiddle: -3, splayMiddle: 43, splayMiddle2: -13, curlBiasMiddle: -32, tipTwistMiddle: -27, curlRing: -80, splayRing: 58, splayRing2: -13, curlBiasRing: 37, tipTwistRing: 2, curlPinky: 74, splayPinky: -106, splayPinky2: 43, curlBiasPinky: 57, tipTwistPinky: -6, wristBend: 0, wristSplay: -3, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Drag1', thumbCurl: 69, thumbSplay: -20, thumbSplay2: -10, curlBiasThumb: 0, tipTwistThumb: 0, curlIndex: 17, splayIndex: 0, splayIndex2: 0, curlBiasIndex: 100, tipTwistIndex: 0, curlMiddle: 6, splayMiddle: 0, splayMiddle2: 0, curlBiasMiddle: 0, tipTwistMiddle: 0, curlRing: 10, splayRing: 0, splayRing2: 0, curlBiasRing: 28, tipTwistRing: 0, curlPinky: -11, splayPinky: 0, splayPinky2: 0, curlBiasPinky: 100, tipTwistPinky: 0, wristBend: 0, wristSplay: 3, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78 },
          { name: 'Fist - Bent Back', thumbCurl: 29, thumbSplay: 154, thumbSplay2: 52, curlBiasThumb: 100, baseOnlyCurlThumb: -51, tipTwistThumb: -31, curlIndex: 96, splayIndex: 15, splayIndex2: 72, curlBiasIndex: -7, baseOnlyCurlIndex: 0, tipTwistIndex: 1, curlMiddle: -89, splayMiddle: -14, splayMiddle2: -13, curlBiasMiddle: 10, baseOnlyCurlMiddle: 0, tipTwistMiddle: -5, curlRing: -95, splayRing: 37, splayRing2: -32, curlBiasRing: -3, baseOnlyCurlRing: 0, tipTwistRing: -5, curlPinky: 89, splayPinky: -82, splayPinky2: 33, curlBiasPinky: 6, baseOnlyCurlPinky: 0, tipTwistPinky: -3, wristBend: 0, wristSplay: -50, modelRotX: 0, modelRotY: 0, modelRotZ: 0, hideWrist: 78, shoulderRaise: 0, shoulderSwing: 0, shoulderRotation: 0, elbowBend: 0, elbowSideBend: 0, forearmTwist: 0 }
        ],
        itemLabel: 'Pose',
        importable: true,
        captureCurrent: () => capturePosePreset(),
        onUse: (item) => previewPosePreset(item),
        // Click-Hold-Pose's own 2 Target Pose dropdowns (chpTargetPose/
        // rchpTargetPose) read this same list via options(), but a
        // 'select' control's <option> list is only rebuilt on an explicit
        // refreshSelectOptions() call, not automatically -- without this,
        // saving or deleting a pose here wouldn't show up there until the
        // page reloads.
        onChange: () => { safeRefreshSelectOptions('chpTargetPose'); safeRefreshSelectOptions('rchpTargetPose'); safeRefreshSelectOptions('clickTargetPose'); safeRefreshSelectOptions('dblclickTargetPose'); safeRefreshSelectOptions('rcTargetPose'); safeRefreshSelectOptions('dcHoldTargetPose'); safeRefreshMultiSelectOptions('tweenPoses') }
      },
      // The "Default" button used to live here as its own DEV_GROUPS row
      // (reset every pose slider to its own CODE default). Direct
      // follow-up request redefined it entirely: "the Default button
      // should be next to the Save overwrite etc etc. When i click it
      // sets the selected pose as the default pose. So its the pose on
      // startup, as well as the pose that retransitions default back
      // to." It's no longer a DEV_GROUPS control at all -- it's injected
      // directly into the Saved Poses list-picker's own button row
      // (buildPoseDefaultButton(), called from the main setup sequence)
      // since devPanel.js's generic list-picker builder has no config
      // hook for an extra button and this project's own convention is to
      // not fork that shared engine (CLAUDE.md's own file-map note).
      // Master on/off for the whole Arm Length / Hide Wrist system --
      // direct request ("Crop Wrist Checkbox. To turn the cropping on and
      // off"). Off means full arm, always, on every hand -- no clip plane,
      // no position compensation needed (computeArmLengthT() returns 0
      // directly, skipping Default/Reactive entirely). Placed above both,
      // since it gates everything below it.
      { key: 'cropWristEnabled', label: 'Crop Wrist (Master On/Off)', type: 'checkbox', def: true },
      // Cuts away the forearm from a percentage down from the wrist -- 0%
      // clips nothing, 100% cuts off exactly at the wrist joint (hiding
      // the entire forearm). The whole hand shifts to compensate (see
      // applyHandArmLength()) so the newly-visible cut base stays at this
      // hand's own Field Layout grid point, rather than drifting away from
      // it as more of the forearm gets clipped. Used directly whenever
      // Reactive Arm Length (below) is off; no onChange needed -- read
      // fresh every frame by computeArmLengthT(), same as the reactive
      // controls below.
      //
      // Uses the SAME 0-100 percent scale as every other percent-like
      // slider in this project (toonShadowFloor, hullThickness, etc.) --
      // confirmed live as a real, reported bug: typing "0.5" here (typing
      // a fractional 0-1 value out of habit from the Length Scaling
      // Curve's own 0-1-axis captions just below) silently sets a
      // barely-there 0.5% crop, not the intended 50% -- indistinguishable
      // from "no crop" by eye. Not a code bug (0.5 IS a valid point on a
      // 0-100 scale) -- fixed by relabeling the curve's own axis captions
      // to also read in percent (see buildArmLengthCurveWidget()), so
      // every arm-length control in this feature speaks the same units.
      { key: 'hideWrist', label: 'Default Arm Length (Crop %, Reactive Off)', type: 'slider', min: 0, max: 100, step: 1, def: 100 },
      // Direct follow-up request: "make the crop or arm length dependent
      // on distance from the cursor, so the closer it is the shorter the
      // arm length." When on, computeArmLengthT() drives the crop % from
      // this hand's own live cursor distance through Length Scaling
      // Curve, remapped into the Min/Max Arm Length bounds below, instead
      // of the fixed Default Arm Length above.
      { key: 'reactiveArmLengthEnabled', label: 'Reactive Arm Length (By Cursor Distance)', type: 'checkbox', def: true },
      // Custom widgets (dual-handle range bar; a 2D curve editor), NOT
      // devPanel.js control types -- that engine is reused verbatim from
      // HANDO per this project's own convention ("do not fork it, add
      // controls via main.js's own DEV_GROUPS instead"), and neither of
      // these UI shapes exists there. Registered as plain 'text' controls
      // (cfg[key] holds a JSON string, exactly like any other devPanel.js
      // control, so Copy/Save/Reset all keep working transparently) with
      // their OWN custom DOM/drag-handling laid on top of that hidden
      // input by buildArmLengthWidgets(), called once right after
      // initDevPanel() -- see that function's own comment for the full
      // mechanism.
      { key: 'armLengthRange', label: 'Min / Max Arm Length (Crop %)', type: 'text', def: '{"min":0,"max":85}', onChange: () => parseArmLengthConfig() },
      { key: 'armLengthCurve', label: 'Length Scaling Curve (Distance -> Crop)', type: 'text', def: '[{"x":0,"y":1},{"x":0.148333740234375,"y":0.6613540649414062},{"x":0.4100001017252604,"y":0.31468760172526045},{"x":0.5316670735677084,"y":0.2680206298828125},{"x":0.748333740234375,"y":0.19468739827473958},{"x":1,"y":0}]', onChange: () => parseArmLengthConfig() }
    ]
  },
  {
    // New feature, direct request: "Wrist will Splay in response to
    // distance from cursor. Provide similar settings as the Wrist Crop/
    // arm Length group." A SEPARATE, top-level group rather than nested
    // inside Pose -- unlike Arm Length (which IS inside Pose, since it
    // shares that group's own "reactive staging, not a saved-pose value"
    // framing), this sits on its own per the request's own naming.
    // Mirrors Arm Length's exact structure (master on/off, a Default
    // value used when Reactive is off, a Reactive toggle, a Min/Max
    // range widget, a Distance->Value scaling curve widget) -- same
    // shape, different unit (degrees, not crop percent) and a DIFFERENT
    // underlying application: this ADDS an extra per-hand rotateZ onto
    // whatever the Pose group's own shared `wristSplay` slider already
    // contributes (see applyWristPoseToSkeleton()'s own extraSplayDeg
    // param), rather than driving a position/crop transform the way Arm
    // Length does -- computeResponsiveWristSplayDeg()'s own comment has
    // the full math, reusing evaluateArmLengthCurve() (already fully
    // generic -- distance-in, curve-value-out, nothing Arm-Length-
    // specific about it despite the name) and the SAME per-frame live
    // cursor-distance values Arm Length already computes in
    // updateRenderOrder(), not a second distance calculation.
    //
    // Default range (min:0, max:-90) is intentionally NOT numerically
    // ordered (0 > -90) -- "min"/"max" here name which ENDPOINT applies
    // at which end of the distance curve (min = farthest hand, max =
    // nearest, matching Arm Length's own min/max roles exactly), not a
    // numeric ordering constraint on the 2 values themselves; the
    // underlying lerp (`min + (max-min)*curveY`) works correctly
    // regardless of which endpoint is numerically larger. The range
    // widget itself (buildWristSplayRangeWidget()) doesn't cross-clamp
    // its 2 handles against each other the way Arm Length's own range
    // widget does, for the same reason.
    title: 'Responsive Wrist Splay',
    controls: [
      { key: 'wristSplayResponsiveEnabled', label: 'Responsive Wrist Splay (Master On/Off)', type: 'checkbox', def: true },
      // PERFORMANCE (2026-09-16): the idle-repose block this gates is the
      // confirmed sustained frame-cost bottleneck (see updateRenderOrder()'s
      // own comment) -- measured 25-42ms/frame at 240 hands, dominating the
      // frame budget. Staggering spreads that SAME per-hand work across N
      // frames instead of doing all of it every frame: with this at 4, each
      // hand's reactive wrist splay still refreshes every 4th frame (not
      // every hand every frame), cutting the per-frame cost by roughly this
      // factor while every hand keeps reacting to the cursor, just at a
      // slightly lower refresh rate -- imperceptible for a gentle reactive
      // splay effect. 1 = old behavior (every hand, every frame, no stagger).
      // Deliberately does NOT affect hand._wasOverriddenLastFrame/!everReposed's
      // own guaranteed-resync frames (see updateRenderOrder()) -- those must
      // stay immediate to avoid reintroducing the 2026-09-15 "click does
      // nothing"/stale-bind-pose bugs this stagger must not interact with.
      { key: 'wristSplayReposeStagger', label: 'Reactive Splay Update Stagger (Frames, 1=Off)', type: 'slider', min: 1, max: 8, step: 1, def: 4 },
      { key: 'wristSplayDefault', label: 'Default Wrist Splay (Deg, Reactive Off)', type: 'slider', min: -180, max: 180, step: 1, def: 7 },
      { key: 'wristSplayReactiveEnabled', label: 'Reactive Wrist Splay (By Cursor Distance)', type: 'checkbox', def: true },
      { key: 'wristSplayRange', label: 'Min / Max Wrist Splay (Deg)', type: 'text', def: '{"min":5,"max":-71}', onChange: () => parseWristSplayConfig() },
      { key: 'wristSplayCurve', label: 'Splay Scaling Curve (Distance -> Splay)', type: 'text', def: '[{"x":0,"y":1},{"x":0.31833343505859374,"y":0.6961458841959636},{"x":1,"y":0.042812347412109375}]', onChange: () => parseWristSplayConfig() }
    ]
  },
  // Click-Hold Pose -- direct request, then "the 2nd new clickhold pose
  // sets should be their own setting groups": on mousedown+hold, every
  // hand transitions from its CURRENT pose to a chosen Target Pose (one
  // of `cfg.savedPoses`); on release, transitions back to the code-
  // default pose. Each hand's own transition START TIME is staggered by
  // its live distance from the cursor at the moment the button went
  // down (curve + Min/Max range, same widget family as Arm Length/
  // Responsive Wrist Splay) -- setting Min equal to Max collapses this
  // to "every hand transitions together," satisfying the request's own
  // "choose if they all transition together, or if... based on
  // distance" without a separate toggle. Retransition (release) has its
  // own fully independent speed/curve/range, using each hand's own
  // CURRENT interpolated pose (not the target) as ITS retransition start
  // -- correct even if release happens mid-transition, before every hand
  // finished reaching the target. Left-click and right-click are 2
  // separate, symmetric instances built by makeClickHoldPoseGroup()
  // below (same control shape, different key prefix/mouse button) --
  // see setupClickHoldPoseTrigger()'s own comment for the full state
  // machine and the disclosed Whole-Hand-Rotation scope decision.
  makeClickHoldPoseGroup('chp', 'Click Hold-Pose', {
    enabled: true, targetPose: 'Point', transitionSpeedMs: 230,
    startTimeCurve: '[{"x":0,"y":0},{"x":0.4483332316080729,"y":0.7186457951863607},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":3000}',
    retransitionSpeedMs: 180,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":0.475,"y":0.7653123219807942},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":431,"max":3000}'
  }),
  makeClickHoldPoseGroup('rchp', 'Right-Click Hold-Pose', {
    enabled: true, targetPose: 'Neutral - Bent Back', transitionSpeedMs: 410,
    startTimeCurve: '[{"x":0,"y":0.02093760172526038},{"x":0.4366663614908854,"y":0.8109375},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":3000}',
    retransitionSpeedMs: 320,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":0.4683329264322917,"y":0.6742708841959635},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":3000}'
  }),
  // Direct follow-up request: a fire-and-forget variant of Click Hold-
  // Pose -- no holding required. A single click (or double-click) starts
  // the SAME transition-with-per-hand-distance-stagger mechanism, but
  // once triggered, every hand runs its own full sequence to completion
  // regardless of what the mouse does afterward: transition to target,
  // PAUSE at the target for a configurable duration, then retransition
  // back to default -- each phase change happens independently per hand
  // (a hand that started later, or has a longer pause, does NOT wait for
  // any other hand). "Click" and "Double-Click" are 2 separate, symmetric
  // instances (both on the left button, distinguished by click count, not
  // left/right button the way Click Hold-Pose's own 2 groups are) built
  // by makeClickPoseGroup() below -- see updateClickPoseForHand()'s own
  // comment for the full 3-phase state machine.
  makeClickPoseGroup('click', 'Click Pose', {
    enabled: true, targetPose: 'Open Palm', transitionSpeedMs: 700,
    startTimeCurve: '[{"x":0,"y":0},{"x":0.21833292643229166,"y":0},{"x":0.6616663614908854,"y":0.7919792175292969},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":2078}',
    pauseDurationMs: 0,
    retransitionSpeedMs: 700,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  makeClickPoseGroup('dblclick', 'Double-Click Pose', {
    enabled: true, targetPose: 'ThumbsUp', transitionSpeedMs: 400,
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":3000}',
    pauseDurationMs: 500,
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  // Triple-Click / Quadruple-Click Pose -- direct request ("provide me
  // um, setting groups for triple click... and quadruple click"), same
  // fire-and-forget family as Click/Double-Click Pose, distinguished
  // purely by consecutive left-click COUNT (see the click-count
  // disambiguation listener's own comment, below, for how a 3rd/4th
  // click is told apart from a 1st/2nd). Defaults left OFF (unlike
  // click/dblclick, which ship enabled) -- a brand-new, not-yet-tuned
  // trigger shouldn't start firing on every visitor's 3rd/4th click the
  // instant this ships; the user turns it on once a target pose/tween is
  // actually configured, same convention chp/rchp/dcHold already use.
  makeClickPoseGroup('tripleClick', 'Triple-Click Pose', {
    enabled: false, targetPose: '', transitionSpeedMs: 400,
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":3000}',
    pauseDurationMs: 500,
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  makeClickPoseGroup('quadClick', 'Quadruple-Click Pose', {
    enabled: false, targetPose: '', transitionSpeedMs: 400,
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":3000}',
    pauseDurationMs: 500,
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  // Right Click -- direct follow-up request: "provide another CLick
  // function, the same as the others - 'Right Click'. But this time,
  // provide me a dropbox that allows me to select either a single target
  // pose or a tween. The relevant setting ui only show when i select
  // either." Same fire-and-forget, per-hand-distance-staggered 3-phase
  // sequence as Click Pose/Double-Click Pose above (forward -> paused ->
  // retransition -> idle), on the right button, one new capability: Mode
  // chooses whether the "forward" phase's target is a single named Saved
  // Pose (same as click/dblclick) or a Saved Tween Sequence played
  // through in full (same sequences the Tween/Double Click Hold groups
  // already build, via resolveTweenSequencePoses()/lerpTweenSequence()) --
  // see updateClickPoseForHand()'s own comment for how the 2 modes share
  // one phase machine. Only rcTargetPose/rcTweenSelector are mode-
  // specific and toggled by updateClickTriggerModeVisibility() (below,
  // generalized to every Click-family group with a Mode dropdown -- see
  // its own comment); the Enabled checkbox and every timing control apply
  // to both modes the same way, so switching modes mid-session doesn't
  // reset any tuning.
  {
    title: 'Right Click',
    controls: withDynamicDevice([
      // "If Off, hide all settings for this function" -- see
      // makeClickHoldPoseGroup()'s own matching comment.
      { key: 'rcEnabled', label: 'Right Click (Master On/Off)', type: 'checkbox', def: false, onChange: () => updateClickFunctionEnabledVisibility('rc') },
      {
        key: 'rcMode', label: 'Mode', type: 'select', def: 'Single Pose', options: () => ['Single Pose', 'Sequence'],
        // BUG FIX 2026-09-15: this still called the OLD, pre-rename
        // `updateRightClickModeVisibility()` (confirmed live: threw
        // "updateRightClickModeVisibility is not defined" the instant
        // Mode changed, caught only by safeRefreshSelectOptions()'s own
        // try/catch -- contained, but Right Click's own mode-specific
        // rows silently stopped toggling). The function itself was
        // generalized/renamed to `updateClickTriggerModeVisibility(p,
        // extraSinglePoseKeys)` when Mode was ported to every other
        // Click-family group; this ONE call site (the original, from
        // before that generalization) was missed.
        onChange: () => { updateClickTriggerModeVisibility('rc', ['PauseDurationMs']); updateSingleTimingGateVisibility('rc'); updateSequencePlayModeVisibility('rc') }
      },
      // Offset/Rotation -- see makeClickHoldPoseGroup()'s own matching
      // comment for the full reasoning. Right Click is a hand-written
      // group (predates the 2 shared factories), not built via either
      // one -- added here directly rather than forking a factory for it.
      { key: 'rcOffsetEnabled', label: 'Offset On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility('rc') },
      { key: 'rcOffsetX', label: 'Offset X (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: 'rcOffsetY', label: 'Offset Y (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: 'rcRotationEnabled', label: 'Rotation On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility('rc') },
      { key: 'rcRotationX', label: 'Rotation X (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: 'rcRotationY', label: 'Rotation Y (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: 'rcRotationZ', label: 'Rotation Z (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: 'rcTargetPose', label: 'Target Pose', type: 'select', def: '', options: () => (cfg.savedPoses || []).map((sp) => ({ value: sp.name, group: sp.group || null })) },
      { key: 'rcTweenSelector', label: 'Sequence', type: 'select', def: '', options: () => (cfg.savedTweenSequences || []).map((s) => ({ value: s.name, group: s.group || null })) },
      // Tween's own SEPARATE speed/curve/range trio, added 2026-09-15 --
      // see makeClickHoldPoseGroup()'s own matching comment for the full
      // reasoning. No Loop checkbox -- Right Click is fire-and-forget.
      { key: 'rcTweenSpeedMs', label: 'Animation Speed (Ms)', type: 'slider', min: 50, max: 5000, step: 10, def: 800 },
      { key: 'rcTweenStartTimeCurve', label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcTweenStartTimeRange', label: 'Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickPoseConfig('rc') },
      // Sequence Mode - Count/Loop/Oscillate -- see makeClickPoseGroup()'s
      // own matching comment for the full reasoning.
      { key: 'rcSequencePlayMode', label: 'Sequence Mode - Count, Loop, Oscillate', type: 'select', def: 'Count', options: () => ['Count', 'Loop', 'Oscillate'], onChange: () => updateSequencePlayModeVisibility('rc') },
      { key: 'rcSequenceCount', label: 'Sequence Count', type: 'slider', min: 1, max: 50, step: 1, def: 3 },
      { key: 'rcSequenceCountMode', label: 'Sequence Count Mode - Loop, Oscillate', type: 'select', def: 'Loop', options: () => ['Loop', 'Oscillate'], onChange: () => updateSequencePlayModeVisibility('rc') },
      { key: 'rcSequenceLoopTransition', label: 'Loop Transition On/Off', type: 'checkbox', def: true },
      { key: 'rcSequenceHoldMs', label: 'Sequence Hold Duration (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 0 },
      { key: 'rcTransitionSpeedMs', label: 'Animation Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: 400 },
      // Animation Speed Curve / Start Time Curve / Retransition on-off
      // gates -- see makeClickHoldPoseGroup()'s own matching comments.
      { key: 'rcSpeedCurveEnabled', label: 'Animation Speed Curve On/Off', type: 'checkbox', def: false, onChange: () => updateSingleTimingGateVisibility('rc') },
      { key: 'rcSpeedCurve', label: 'Animation Speed Curve (Distance -> Speed)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcSpeedCurveRange', label: 'Min / Max Speed (Ms)', type: 'text', def: '{"min":50,"max":2000}', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcStartTimeCurveEnabled', label: 'Start Time Curve On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility('rc') },
      { key: 'rcStartTimeCurve', label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcStartTimeRange', label: 'Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcPauseDurationMs', label: 'Pause Duration At Tween End (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 500 },
      { key: 'rcRetransitionEnabled', label: 'Retransition On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility('rc') },
      { key: 'rcRetransitionSpeedMs', label: 'Retransition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: 400 },
      { key: 'rcRetransitionStartTimeCurve', label: 'Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig('rc') },
      { key: 'rcRetransitionStartTimeRange', label: 'Retransition Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickPoseConfig('rc') }
    ])
  },
  // Tween -- direct user request, modeled on HANDO's own "Tween / Export"
  // group (an ordered chain of saved poses, lerped through end-to-end) but
  // deliberately narrower: no manual preview slider, no camera/lighting/
  // toon capture, no PNG export UI -- "We dont need that. we just need
  // poses." `tweenPoses` is the SAME generic 'multi-select' control type
  // HANDO's own tween group uses (a growable list of dropdowns backed by
  // one ordered array), extended here with drag-to-reorder (direct
  // request: "allow me to click and drag to reorder these") -- see
  // devpanel/devPanel.js's own renderMultiSelectRows()/buildMultiSelectRow()
  // comments for that addition. `savedTweenSequences` is a 'list-picker'
  // capturing ONLY `tweenPoses`, via captureTweenSequencePreset()/
  // useTweenSequencePreset() below -- no camera/lighting/toon fields at
  // all, unlike HANDO's own equivalent.
  {
    title: 'Tween',
    controls: withDynamicDevice([
      { key: 'tweenPoses', label: 'Tween Poses (In Order)', type: 'multi-select', def: [], options: () => (cfg.savedPoses || []).map((p) => ({ value: p.name, group: p.group || null })) },
      // Paces the Saved Tween Sequences list-picker's own "Run" button
      // (direct request) -- the FULL sequence's own total duration, spread
      // evenly across however many named poses it has, same convention
      // `${p}TweenSpeedMs` already uses for the field hands' own Tween
      // mode. Deliberately its own separate control, not reused from any
      // single trigger's own TweenSpeedMs -- Run plays on the Pose Preview
      // model, independent of any live field trigger.
      { key: 'tweenPreviewSpeedMs', label: 'Tween Speed (Preview Run) (Ms)', type: 'slider', def: 2000, min: 100, max: 10000 },
      {
        key: 'savedTweenSequences',
        label: 'Saved Tween Sequences',
        type: 'list-picker',
        def: [],
        itemLabel: 'Sequence',
        captureCurrent: () => captureTweenSequencePreset(),
        onUse: (item) => useTweenSequencePreset(item),
        // Mirrors 'savedPoses'' own onChange: the Double Click Hold
        // group's own Tween Selector dropdown reads this same list via
        // options(), which devPanel.js only rebuilds on an explicit
        // refreshSelectOptions() call.
        onChange: () => { safeRefreshSelectOptions('dcHoldTweenSelector'); safeRefreshSelectOptions('rcTweenSelector'); safeRefreshSelectOptions('chpTweenSelector'); safeRefreshSelectOptions('rchpTweenSelector'); safeRefreshSelectOptions('clickTweenSelector'); safeRefreshSelectOptions('dblclickTweenSelector') }
      }
    ])
  },
  // Double Click Hold -- ORIGINALLY a bespoke, shared-not-per-hand
  // mechanism (direct request: "The tween will apply to all hands
  // simultaneously and stop when i release"). CORRECTED/REBUILT
  // 2026-09-15, direct follow-up: "make the available settings of double
  // click and hold to match click hold. Double click hold currently is
  // lacking a lot of the options. I want to also be able to select
  // single pose/ tween for double click hold" -- confirmed via 2
  // clarifying questions that this means (1) genuinely adding per-hand
  // distance stagger (reversing the "all hands simultaneously" design,
  // not just adding stagger-shaped settings that would've done nothing),
  // and (2) Single Pose mode mirroring Click Hold-Pose exactly. Given
  // that, this is now built via makeClickHoldPoseGroup() -- a literal 3rd
  // instance of Click Hold-Pose's own machinery (`dcHold` joins
  // CLICK_HOLD_KEYS below), not a parallel reimplementation -- gaining
  // every one of chp/rchp's own settings for free: Mode (Single Pose/
  // Tween), Target Pose, Tween Selector + its own separate Tween Speed/
  // Curve/Range, Hold Confirm Delay, Pose Transition Speed/Curve/Range,
  // Loop Mode (Off/Loop/Oscillate) + Hold Duration, and a genuinely
  // separate Pose Retransition Speed/Curve/Range (previously dcHold
  // reused its own Tween Speed for retransition too, per an EARLIER
  // direct clarification -- superseded by this request's own explicit
  // ask for Click Hold-Pose's full settings, retransition speed
  // included). The double-click-then-hold gesture DETECTION itself
  // (generalized 2026-09-16 into a chain count -- see
  // CLICK_HOLD_CHAIN_KEYS's own comment, below) is UNCHANGED here -- only which
  // functions it calls (startClickHoldPose('dcHold')/endClickHoldPose('dcHold')
  // now, instead of this feature's own retired start/end functions).
  // ONE deliberate exception preserved from the ORIGINAL, twice-clarified
  // requirement, NOT superseded by this request: Tween mode's own
  // sequence still always starts from the DEFAULT pose specifically (not
  // this hold's own live snapshot, unlike chp/rchp's own Tween mode) --
  // see startClickHoldPose()'s own `tweenAnchor` comment. Single Pose
  // mode has no such exception -- it mirrors chp/rchp exactly, per this
  // request's own direct confirmation.
  makeClickHoldPoseGroup('dcHold', 'Double Click Hold', {
    enabled: false, targetPose: '',
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":300}',
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  // Triple-Click Hold / Quadruple-Click Hold -- direct request, same
  // family as Double Click Hold: the Nth press of a still-building
  // consecutive-click chain, HELD instead of released quickly (see the
  // gesture-detection listener's own comment, below, for how the chain
  // count is tracked). Shares chp/rchp/dcHold's own exact machinery via
  // CLICK_HOLD_KEYS, same as dcHold already does.
  makeClickHoldPoseGroup('tripleClickHold', 'Triple-Click Hold', {
    enabled: false, targetPose: '',
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":300}',
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  makeClickHoldPoseGroup('quadClickHold', 'Quadruple-Click Hold', {
    enabled: false, targetPose: '',
    startTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    startTimeRange: '{"min":0,"max":300}',
    retransitionSpeedMs: 400,
    retransitionStartTimeCurve: '[{"x":0,"y":0},{"x":1,"y":1}]',
    retransitionStartTimeRange: '{"min":0,"max":300}'
  }),
  // "Pose Preview" used to be its own always-embedded, 0-control dev-
  // group here (a <canvas> injected directly into its .dp-group-body).
  // REMOVED 2026-09-16, direct request: it's now an opt-in FLOATING
  // panel instead, toggled by the Pose group's own `posePreviewEnabled`
  // checkbox -- see `buildPosePreview()`'s own comment for the new
  // resizable/movable chrome this drives.
  {
    title: 'Camera',
    // Live position/behavior controls below are perDevice (added
    // 2026-09-15, same direct request as Field Layout's own matching
    // comment -- see there for the full "no invented defMobile/
    // defLandscape numbers, no devPanel.js changes needed" reasoning,
    // which applies identically here). `savedCameras` (the named-preset
    // list-picker, below) deliberately stays SHARED, not perDevice -- a
    // saved preset is a reusable recipe either device's own tab can
    // "Use," not itself a spatial setting; making the LIST per-device
    // would just fragment one preset library into 3 for no benefit.
    controls: [
      // Position sliders only (no Yaw/Pitch/Zoom-as-distance like HANDO's
      // own Camera group) -- this camera never rotates (see OrbitControls
      // setup below: enableRotate is false, only pan + zoom), so a look-
      // direction concept doesn't apply here the way it does for HANDO's
      // orbiting camera. Defaults are static (NOT derived from field size,
      // per the "field layout shouldn't affect view scale" request) --
      // frame the view by dragging (pan) / scrolling (zoom) instead.
      { key: 'cameraX', label: 'Camera X Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: 6.638529594915686, perDevice: true, onChange: (v) => applyCameraControl('cameraX', v) },
      { key: 'cameraY', label: 'Camera Y Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: 13.373156794075216, perDevice: true, onChange: (v) => applyCameraControl('cameraY', v) },
      { key: 'cameraZ', label: 'Camera Z Position (x)', type: 'slider', min: 1, max: 500, step: 0.5, def: 259.74194092345493, perDevice: true, onChange: (v) => applyCameraControl('cameraZ', v) },
      { key: 'cameraFov', label: 'Field Of View (Deg)', type: 'slider', min: 15, max: 90, step: 1, def: 35, perDevice: true, onChange: (v) => applyCameraControl('cameraFov', v) },
      // Direct 2-way binding with scroll/pinch zoom, same pattern as the
      // X/Y/Z sliders above: this slider both SETS the camera's distance
      // to its own pan target (setCameraDistance(), below) and is kept in
      // sync FROM the live distance every frame (syncCameraPanelFromLive())
      // -- scrolling moves the slider, moving the slider zooms, per direct
      // request ("responsive to my wheel scroll and vice versa"). Its own
      // 2-way `syncValue()` binding is already perDevice-aware generically
      // (guards against writing into a non-matching device's own stored
      // value) -- no changes needed there for this to work correctly.
      { key: 'cameraZoom', label: 'Zoom (Distance To Pan Target) (x)', type: 'slider', min: 1, max: 800, step: 0.5, def: 260.17068872666084, perDevice: true, onChange: (v) => applyCameraControl('cameraZoom', v) },
      // Direct request: "Similar to the pose selector, allow me to save,
      // use, overwrite, etc for camera settings" -- mirrors savedPoses'
      // own list-picker shape exactly (captureCurrent/onUse), except
      // "Use" applies directly to the LIVE camera (captureCameraPreset()/
      // applyCameraPreset(), below) rather than a preview-only model,
      // since there's no separate "camera preview" concept the way
      // Pose Preview exists for hand poses.
      {
        key: 'savedCameras',
        label: 'Saved Cameras',
        type: 'list-picker',
        def: [],
        itemLabel: 'Camera',
        importable: true,
        captureCurrent: () => captureCameraPreset(),
        onUse: (item) => applyCameraPreset(item)
      },
      // 3 more direct requests, same message: lock pan/zoom independently,
      // and an optional bounded-camera mode built on top of the "Default"
      // button above (mirroring setSelectedPoseAsDefault()'s own pattern,
      // see setSelectedCameraAsDefault() below) -- see
      // enforceCameraMaxExtents()'s own comment for the exact bound
      // semantics and the worked example the user gave ("if camera pan is
      // locked, but zoom is not... i am able to zoom into the image, but
      // when i zoom out beyond the extents, it will just default me to
      // the default camera").
      { key: 'lockCameraPan', label: 'Lock Camera Pan', type: 'checkbox', def: false, perDevice: true, onChange: () => applyCameraLockState() },
      { key: 'lockCameraZoom', label: 'Lock Camera Zoom', type: 'checkbox', def: false, perDevice: true, onChange: () => applyCameraLockState() },
      { key: 'cameraMaxExtentsEnabled', label: 'Set Default Camera As Max Extents', type: 'checkbox', def: false, perDevice: true, onChange: () => updateCameraMaxExtentsBound() }
    ]
  },
  {
    title: 'Lighting',
    controls: [
      { key: 'keyAzimuth', label: 'Key Light Azimuth (Deg)', type: 'slider', min: 0, max: 360, step: 1, def: 209, onChange: updateKeyLightPosition },
      { key: 'keyElevation', label: 'Key Light Elevation (Deg)', type: 'slider', min: -89, max: 89, step: 1, def: 56, onChange: updateKeyLightPosition },
      { key: 'keyTargetHeight', label: 'Key Light Aim Height (%)', type: 'slider', min: -100, max: 100, step: 1, def: 2, onChange: updateKeyLightPosition },
      { key: 'keyIntensity', label: 'Key Light Intensity (x)', type: 'slider', min: 0, max: 6, step: 0.1, def: 6, onChange: (v) => { keyLight.intensity = v } },
      { key: 'keyColor', label: 'Key Light Color', type: 'color', def: '#ffffff', onChange: (v) => { keyLight.color.set(v) } },
      { key: 'ambientIntensity', label: 'Ambient Intensity (x)', type: 'slider', min: 0, max: 3, step: 0.05, def: 0, onChange: (v) => { hemiLight.intensity = v } },
      { key: 'ambientSkyColor', label: 'Ambient Sky Color', type: 'color', def: '#cfe8ff', onChange: (v) => { hemiLight.color.set(v) } },
      { key: 'ambientGroundColor', label: 'Ambient Ground Color', type: 'color', def: '#000000', onChange: (v) => { hemiLight.groundColor.set(v) } },
      // Direct request ("also make it so i can save seaparet light
      // setttings" / "save, use, delete etc") -- mirrors Camera's own
      // `savedCameras` list-picker exactly (captureCurrent/onUse), applied
      // directly to the live keyLight/hemiLight the same way Camera's own
      // applies directly to the live camera (no preview concept here
      // either). See captureLightingPreset()/applyLightingPreset() below.
      {
        key: 'savedLighting',
        label: 'Saved Lighting',
        type: 'list-picker',
        def: [],
        itemLabel: 'Lighting',
        importable: true,
        captureCurrent: () => captureLightingPreset(),
        onUse: (item) => applyLightingPreset(item)
      }
    ]
  },
  {
    title: 'Toon Shading',
    controls: [
      { key: 'toonSteps', label: 'Toon Steps (Count)', type: 'slider', min: 2, max: 8, step: 1, def: 2, onChange: () => rebuildGradientMap() },
      { key: 'toonStepThreshold', label: 'Toon Step Threshold (Bias)', type: 'slider', min: 0.2, max: 5, step: 0.05, def: 2.7, onChange: () => rebuildGradientMap() },
      { key: 'toonShadowFloor', label: 'Toon Shadow Floor (%)', type: 'slider', min: 0, max: 90, step: 1, def: 7, onChange: () => rebuildGradientMap() },
      { key: 'toonLightCeiling', label: 'Toon Light Ceiling (%)', type: 'slider', min: 10, max: 100, step: 1, def: 100, onChange: () => rebuildGradientMap() },
      { key: 'toonBaseTint', label: 'Toon Base Tint', type: 'color', def: '#ffffff', onChange: (v) => forEachToonMaterial((m) => m.color.set(v)) },
      { key: 'textureInfluence', label: 'Texture Influence (%)', type: 'slider', min: 0, max: 100, step: 1, def: 0, onChange: (v) => setToonUniform('textureInfluence', v / 100) },
      { key: 'toonTint', label: 'Toon Texture Tint', type: 'color', def: '#ffffff', onChange: (v) => setToonUniform('toonTint', new THREE.Color(v)) },
      { key: 'rimIntensity', label: 'Rim Light Intensity (x)', type: 'slider', min: 0, max: 3, step: 0.05, def: 0, onChange: (v) => setToonUniform('rimIntensity', v) },
      { key: 'rimPower', label: 'Rim Light Power (x)', type: 'slider', min: 0.5, max: 8, step: 0.1, def: 0.5, onChange: (v) => setToonUniform('rimPower', v) },
      { key: 'rimColor', label: 'Rim Light Color', type: 'color', def: '#ffffff', onChange: (v) => setToonUniform('rimColor', new THREE.Color(v)) }
    ]
  },
  {
    title: 'Outline',
    controls: [
      { key: 'outlineEnabled', label: 'Outline Enabled', type: 'checkbox', def: false, onChange: () => updateOutlineVisibility() },
      { key: 'useOutlinePass', label: 'Use OutlinePass (Screen-Space)', type: 'checkbox', def: false, onChange: () => updateOutlineVisibility() },
      { key: 'outlineColor', label: 'Outline Color', type: 'color', def: '#000000', onChange: (v) => {
        forEachOutlineMaterial((m) => m.uniforms.outlineColor.value.set(v))
        if (outlinePass) { outlinePass.visibleEdgeColor.set(v); outlinePass.hiddenEdgeColor.set(v) }
      } },
      { key: 'hullThickness', label: 'Hull Outline Thickness (% Of Hand Length)', type: 'slider', min: 0, max: 6, step: 0.05, def: 6, onChange: (v) => forEachOutlineMaterial((m) => { m.uniforms.outlineThickness.value = (v / 100) * handLengthRaw }) },
      { key: 'passThickness', label: 'Pass Edge Thickness (Px)', type: 'slider', min: 0.5, max: 15, step: 0.1, def: 0.9, onChange: (v) => { if (outlinePass) outlinePass.edgeThickness = v } },
      { key: 'passStrength', label: 'Pass Edge Strength (x)', type: 'slider', min: 0, max: 15, step: 0.5, def: 15, onChange: (v) => { if (outlinePass) outlinePass.edgeStrength = v } },
      { key: 'passGlow', label: 'Pass Edge Glow (x)', type: 'slider', min: 0, max: 5, step: 0.1, def: 0, onChange: (v) => { if (outlinePass) outlinePass.edgeGlow = v } }
    ]
  },
  {
    title: 'Background',
    controls: [
      { key: 'bgColor', label: 'Background Color', type: 'color', def: '#ffffff', onChange: (v) => { scene.background = new THREE.Color(v) } }
    ]
  },
  {
    title: 'Debug',
    controls: [
      { key: 'showGridHelper', label: 'Show Grid Helper', type: 'checkbox', def: false, onChange: (v) => { if (gridHelper) gridHelper.visible = v } },
      { key: 'showWireframe', label: 'Show Wireframe', type: 'checkbox', def: false, onChange: (v) => forEachToonMaterial((m) => { m.wireframe = v }) },
      // Freezes a hand's own render-order value (see animate()'s own
      // overlap-detection block) the instant it starts visually
      // overlapping another hand, instead of letting cursor-distance
      // render ordering keep re-sorting it live -- direct request: 2
      // overlapping hands' stacking must not flash/flip while they're
      // still overlapping, only once they visibly clear each other.
      { key: 'preventReorderFlash', label: 'Prevent Reordering Flash (Freeze Order While Overlapping)', type: 'checkbox', def: false },
      // Direct request: "Provide a 'PAUSE' button in debug group. When I
      // hit pause, all animations will pause where they are. Animations
      // will not run until i hit the button again." Toggles the module-
      // level `isPaused` flag (see its own declaration, right before
      // animate(), for the full "virtual clock" mechanism that makes a
      // resume continue exactly where it left off instead of jumping
      // forward by the paused duration). Not persisted through Copy/Save
      // -- a session-only runtime toggle, same reasoning as Mouse Log's
      // own session-only state.
      { key: 'pauseAnimations', label: 'PAUSE', type: 'button', onClick: (btn) => { setPaused(!isPaused); btn.textContent = isPaused ? 'RESUME' : 'PAUSE' } },
      // Direct request: a click log (location + what it triggered) and a
      // regular cursor-position log, both feeding one shared scrollable
      // display built by buildMouseTrackingLogWidget() (a plain, session-
      // only log -- not persisted through devPanel.js's Copy/Save, since
      // there's nothing meaningful to restore later). The click log itself
      // always runs (a click is a discrete, rare-enough event that logging
      // it unconditionally costs nothing); this checkbox/slider pair
      // controls only the REGULAR, timer-driven position log, which
      // otherwise would spam the display every frame.
      { key: 'logCursorPositionEnabled', label: 'Log Regular Cursor Position', type: 'checkbox', def: false, onChange: () => restartCursorLogTimer() },
      { key: 'cursorLogIntervalMs', label: 'Cursor Position Log Interval (Ms)', type: 'slider', min: 100, max: 5000, step: 50, def: 1000, onChange: () => restartCursorLogTimer() },
      { key: 'clearMouseLogBtn', label: 'Clear Mouse Tracking Log', type: 'button', onClick: () => clearMouseTrackingLog() },
      // See MOUSE_LOG_MULTICLICK_MS's own declaration comment for why this
      // is now a slider instead of a hardcoded constant -- governs how
      // long a gap between consecutive clicks is still read as "the same
      // multi-click sequence continuing" for Click Pose's 2/3/4-click
      // chain, the Click-Hold chain (dcHold/tripleClickHold/
      // quadClickHold), and this Mouse Tracking Log's own click
      // classification, all 3 at once.
      { key: 'multiClickWindowMs', label: 'Multi-Click Window (Ms) -- Click/Hold Chains + Mouse Log', type: 'slider', min: 200, max: 1200, step: 25, def: 600 }
    ]
  }
]
// initDevPanel() can fire a restored control's onChange synchronously
// (restoring a saved setting) before the scene objects those callbacks
// reference (camera/keyLight/etc.) exist yet -- a TDZ crash. Detach every
// onChange for this one call, then reattach for real, later, live edits
// (same mitigation Hando's own main.js uses for this exact gotcha).
const onChangeByCtrl = new Map()
DEV_GROUPS.forEach((g) => g.controls.forEach((c) => {
  if (c.onChange) { onChangeByCtrl.set(c, c.onChange); c.onChange = null }
}))
// Ported from HANDO's own current, live-organized Pose group -- direct
// request ("check the project Hando's git save in regards to its Dev
// Panel, Pose settings. I want you to port the subgroup names, nesting,
// setting groupings, and order"). Read directly from HANDO's own
// committed `data/processed/dev-panel-settings.json` (its `order` array,
// "Pose" entry) rather than its main.js control array (which is flat,
// with no nesting info at all -- the real subgroup structure only ever
// existed in HANDO's own saved/live-reorganized state). HANDO's own
// subgroup names were still the unrenamed defaults ("New Group", "New
// Group (3)"..."(7)") -- never actually renamed there -- so named these
// descriptively here instead of porting meaningless placeholder text;
// the GROUPING/ORDER itself (this part of the request) is ported
// exactly. Omits HANDO's `baseOnlyCurl*` sliders (5, one per finger --
// don't exist as controls in this project yet) and `hideWrist` from the
// Wrist group (this project's own Hide Wrist is a separate, larger
// reactive Arm Length system, not the single static slider HANDO's own
// Wrist subgroup bundles in -- deliberately left where it already sits,
// per this Pose group's own top comment on why Arm Length is excluded
// from what a saved pose even captures). Collapsed by default (matches
// HANDO's own majority state across its 6 subgroups -- one of HANDO's
// six happened to be left expanded, evidently just incidental to
// whatever was last interacted with there, not a deliberate choice worth
// preserving).
const POSE_SUBGROUP_SPECS = [
  { title: 'Whole-Hand Rotation & Thumb', collapsed: true, keys: ['modelRotX', 'modelRotY', 'modelRotZ', 'thumbCurl', 'thumbSplay', 'thumbSplay2', 'tipTwistThumb', 'curlBiasThumb', 'baseOnlyCurlThumb', 'midOnlyCurlThumb', 'tipOnlyCurlThumb'] },
  { title: 'Wrist', collapsed: true, keys: ['wristBend', 'wristSplay'] },
  { title: 'Index', collapsed: true, keys: ['curlIndex', 'tipTwistIndex', 'splayIndex', 'curlBiasIndex', 'splayIndex2', 'baseOnlyCurlIndex', 'midOnlyCurlIndex', 'tipOnlyCurlIndex'] },
  { title: 'Middle', collapsed: true, keys: ['curlMiddle', 'tipTwistMiddle', 'splayMiddle', 'curlBiasMiddle', 'splayMiddle2', 'baseOnlyCurlMiddle', 'midOnlyCurlMiddle', 'tipOnlyCurlMiddle'] },
  { title: 'Ring', collapsed: true, keys: ['curlRing', 'tipTwistRing', 'splayRing', 'curlBiasRing', 'splayRing2', 'baseOnlyCurlRing', 'midOnlyCurlRing', 'tipOnlyCurlRing'] },
  { title: 'Pinky', collapsed: true, keys: ['curlPinky', 'tipTwistPinky', 'curlBiasPinky', 'splayPinky', 'splayPinky2', 'baseOnlyCurlPinky', 'midOnlyCurlPinky', 'tipOnlyCurlPinky'] },
]
// Shared anti-abuse token for /api/save-settings (CLAUDE.md §12l) -- NOT a
// real secret (it ships in this page's own source, same as every other
// client-side value here); it exists only to keep a random visitor from
// spamming commits to the repo. Must match the DEV_PANEL_SAVE_SECRET env
// var set on this project's own Vercel project. Ported directly from
// HANDO (same day, direct request: "look at hando and see how the save
// button saves dev panel settings to git. Implement.") -- reuses the exact
// same value HANDO/DICKOCLICKO/OKCILCOKCID already use, since this is one
// workspace-wide shared secret, not a per-project one.
const DEV_PANEL_SAVE_SECRET = 'PkrbMti03M6xm3FEThYXa8gGW_08BOGj'
const SAVE_SETTINGS_ENDPOINT = '/api/save-settings'
const cfg = initDevPanel(DEV_GROUPS, {
  storageKeyPrefix: 'handyDandies',
  organizeSubgroups: (groupsEl) => organizeGroupSubgroups(groupsEl, 'Pose', POSE_SUBGROUP_SPECS),
  remoteSave: { endpoint: SAVE_SETTINGS_ENDPOINT, secret: DEV_PANEL_SAVE_SECRET },
  // ROOT CAUSE of the middle/ring finger "outstretched" bug's REAL
  // return, 2026-09-16 (direct user report, correctly suspecting "the
  // default position") -- `poseDefaultValues` (declared below) used to
  // be seeded from `cfg` exactly ONCE, synchronously, immediately after
  // this very call returns. But `initDevPanel()`'s own remote-settings
  // restore (`resetSettings()`'s boot-time fetch, devPanel.js) is
  // ASYNCHRONOUS and NOT awaited here -- this call returns with `cfg`
  // still holding pure CODE DEFAULTS (every control's own `def:`), and
  // the REAL saved values only land in `cfg` moments later, once that
  // fetch resolves. `poseDefaultValues`'s one-time seed always ran
  // BEFORE that -- confirmed live on production: `poseDefaultValues.
  // curlMiddle`/`curlRing` exactly matched their own CODE `def:` (-89/
  // -95) while the REAL, restored `cfg.curlMiddle`/`curlRing` (92/98,
  // matching the user's actual "Fist" pose) were completely different --
  // a ~180-190-point gap, vs. a much smaller coincidental gap on
  // thumb/index/pinky, exactly matching which fingers were reported as
  // visibly "lagging." Every retransition correctly interpolated TOWARD
  // this silently-wrong `poseDefaultValues`, then the very next idle-cfg-
  // driven repose frame snapped to the REAL cfg values -- a real 2-frame
  // jump, not a rendering-pipeline artifact, which is exactly why the
  // original deep investigation (bone-rotation tracing, world-space
  // distance tracing, all confined to a single retransition's own t=0..1
  // range) never found it: the discontinuity lives at the HANDOFF to the
  // next phase, one frame past where that tracing stopped looking.
  // `onRestore` (new, generic devPanel.js hook -- see its own comment)
  // fires once real values actually land in `cfg`, letting
  // resyncPoseDefaultValues() re-seed for real. Also unblocks the
  // startup field-build gate (see `modelMeasurementsReady`'s own
  // declaration comment) -- the field now only ever builds once, using
  // these real values, instead of building once with code defaults and
  // visibly rebuilding again the moment this fires.
  onRestore: () => { migrateModeTweenToSequence(); resyncPoseDefaultValues(); restoreCustomClickFunctions(); startupSettingsReady = true; tryStartField() },
  // Delete-function button (direct spec item) -- devPanel.js's own
  // existing Delete Group/Setting (🗑) icon already lets a real user
  // remove a Custom Click Function's whole group from the panel; the
  // disclosed gap was never the UI, it was that doing so left this
  // feature's OWN bookkeeping (`customClickFunctionIds`/`CLICK_POSE_KEYS`/
  // `CLICK_HOLD_KEYS`/trigger-state) untouched, so a "deleted" function
  // kept silently firing. `onGroupDeleted` (new, generic devPanel.js hook,
  // same pattern as `onRestore` above) fires for ANY deleted group/row,
  // host-side -- cleanupDeletedCustomClickFunction() itself filters down
  // to "was this actually a Custom Click Function's own group" and is a
  // no-op for anything else (a plain user-created group, a single deleted
  // settings row, one of the 10 static triggers -- none of those carry
  // `dataset.customFunctionFamily`).
  onGroupDeleted: (target) => cleanupDeletedCustomClickFunction(target)
})
onChangeByCtrl.forEach((fn, c) => { c.onChange = fn })
setupCustomFunctionTabVisibilitySync()
// Arm Length's 2 custom widgets (see their own declaration comments,
// Pose section below) -- parse whatever initDevPanel() just restored
// (saved or default) into the cached vars computeArmLengthT() reads every
// frame, then build the actual draggable UI on top of each control's own
// (now-hidden) generic text input.
parseArmLengthConfig()
buildArmLengthWidgets()
parseWristSplayConfig()
buildWristSplayWidgets()
// Click-Hold-Pose's own setup call (parseClickHoldConfig/
// buildClickHoldPoseWidgets per trigger) is NOT made here like the other
// widgets above -- clickHoldPoseTriggers (which parseClickHoldConfig
// reads) is a `const` declared much later in the file, alongside the rest
// of the Click-Hold-Pose state machine, so calling it this early would be
// a TDZ ReferenceError. See the matching setup call placed right after
// that const's own declaration instead.
buildMouseTrackingLogWidget()
restartCursorLogTimer()
setupSettingsChangeLog()

// -----------------------------------------------------------------------
// Scene setup
// -----------------------------------------------------------------------
const canvas = document.getElementById('viewport')
const loadingEl = document.getElementById('loading')

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
// Required for per-material `clippingPlanes` (Hide Wrist, see the Pose
// section below) -- three.js ignores a material's own clippingPlanes
// array unless this is set, per its own docs.
renderer.localClippingEnabled = true

const scene = new THREE.Scene()
scene.background = new THREE.Color(cfg.bgColor)

const camera = new THREE.PerspectiveCamera(cfg.cameraFov, window.innerWidth / window.innerHeight, 0.1, 2000)
camera.position.set(cfg.cameraX, cfg.cameraY, cfg.cameraZ)

// Click-drag = pan, scroll/pinch = zoom -- no orbit/rotate (a fixed-facing
// field doesn't need it). `touches` gives the exact same 2 gestures on
// mobile automatically (one-finger drag = pan, two-finger pinch = zoom),
// per this workspace's own "desktop gesture implies its mobile
// equivalent" convention -- no separate touch-handling code needed.
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableRotate = false
// Direct, no `clickHoldPoseTriggers` reference here -- nothing is holding
// at page load, and that object is declared much later in the file (see
// applyCameraLockState(), below, for the version that also composes with
// an active Click-Hold-Pose hold, used everywhere else after init).
controls.enablePan = !cfg.lockCameraPan
controls.enableZoom = !cfg.lockCameraZoom
controls.screenSpacePanning = true
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
controls.target.set(0, 0, 0)
controls.update()

// Position/FOV sliders both DRIVE the camera (when touched) and are kept
// in sync FROM it every frame (see syncCameraPanelFromLive(), called in
// animate()) so mouse-driven pan/zoom show up in the panel too, matching
// HANDO's own 2-way Camera-group pattern. syncValue() itself skips
// whichever row currently has focus, so this never fights a live edit.
// Moves the camera along the existing camera-to-target line to a new
// distance, leaving `controls.target` (the pan target) untouched -- the
// same axis OrbitControls' own scroll/pinch dolly already moves the
// camera along, so a slider edit and a scroll tick are indistinguishable
// to anything reading camera.position afterward.
function setCameraDistance(distance) {
  const offset = camera.position.clone().sub(controls.target)
  const currentDistance = offset.length()
  if (currentDistance < 1e-6) { camera.position.z = controls.target.z + distance; return }
  offset.multiplyScalar(distance / currentDistance)
  camera.position.copy(controls.target).add(offset)
}
function applyCameraControl(key, value) {
  if (key === 'cameraX' || key === 'cameraY' || key === 'cameraZ') {
    const axis = key === 'cameraX' ? 'x' : key === 'cameraY' ? 'y' : 'z'
    const delta = value - camera.position[axis]
    camera.position[axis] = value
    controls.target[axis] += delta
  } else if (key === 'cameraFov') {
    camera.fov = value
  } else if (key === 'cameraZoom') {
    setCameraDistance(value)
  }
  camera.updateProjectionMatrix()
  controls.update()
}
function syncCameraPanelFromLive() {
  syncValue('cameraX', camera.position.x)
  syncValue('cameraY', camera.position.y)
  syncValue('cameraZ', camera.position.z)
  syncValue('cameraFov', camera.fov)
  syncValue('cameraZoom', camera.position.distanceTo(controls.target))
}

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const outlinePass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, camera)
outlinePass.edgeThickness = cfg.passThickness
outlinePass.edgeStrength = cfg.passStrength
outlinePass.edgeGlow = cfg.passGlow
outlinePass.visibleEdgeColor.set(cfg.outlineColor)
outlinePass.hiddenEdgeColor.set(cfg.outlineColor)
outlinePass.overlayMaterial.blending = THREE.NormalBlending
outlinePass.enabled = false // decided by updateOutlineVisibility() once hands exist
composer.addPass(outlinePass)
composer.addPass(new OutputPass())

const hemiLight = new THREE.HemisphereLight(cfg.ambientSkyColor, cfg.ambientGroundColor, cfg.ambientIntensity)
scene.add(hemiLight)
const keyLight = new THREE.DirectionalLight(cfg.keyColor, cfg.keyIntensity)
scene.add(keyLight)
scene.add(keyLight.target)
function updateKeyLightPosition() {
  const az = THREE.MathUtils.degToRad(cfg.keyAzimuth)
  const el = THREE.MathUtils.degToRad(cfg.keyElevation)
  const r = sceneState.fieldRadius * 3
  keyLight.position.set(r * Math.cos(el) * Math.cos(az), r * Math.sin(el), r * Math.cos(el) * Math.sin(az))
  keyLight.target.position.set(0, (cfg.keyTargetHeight / 100) * sceneState.fieldRadius, 0)
  keyLight.target.updateMatrixWorld()
}

const gridHelper = new THREE.GridHelper(40, 20, 0x444466, 0x2a2a36)
gridHelper.rotation.x = Math.PI / 2
gridHelper.visible = cfg.showGridHelper
scene.add(gridHelper)

const targetMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), new THREE.MeshBasicMaterial({ color: 0xff5566 }))
targetMarker.visible = cfg.showTargetMarker
scene.add(targetMarker)

// -----------------------------------------------------------------------
// Cursor -> world target
// -----------------------------------------------------------------------
window.addEventListener('pointermove', (e) => {
  cursorNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
  lastPointerClientX = e.clientX
  lastPointerClientY = e.clientY
})
// Mouse Tracking Log (Debug group) -- direct request: a click log (location
// + what it triggered) plus a regular, interval-driven cursor-position
// log. The click log runs unconditionally (a click is discrete/rare enough
// that logging it costs nothing); "what it triggers" describes this app's
// OWN actual click semantics honestly, not a placeholder -- a click lands
// either inside the dev panel itself, or on the canvas, where this
// project's OrbitControls config (LEFT/RIGHT = pan, MIDDLE = dolly/zoom,
// see its own setup comment) is what actually responds to it; there is no
// OTHER click-triggered interaction in this app yet (no clickable hands).
//
// Extended 2026-09-14 (template-parity port, see this file's own module-
// level Mouse Log state comment) to classify what the template's own
// version distinguishes: multi-click (double/triple, same button, within
// MOUSE_LOG_MULTICLICK_MS) and drag-release (held past
// MOUSE_LOG_HELD_DRAG_MS, or moved past a small threshold, before
// release) -- both computed at pointerUP now, since neither is knowable
// at pointerdown time. `describeTrigger()` factored out unchanged from
// the original single-listener version so pointerup can reuse the exact
// same trigger logic pointerdown used to run inline.
//
// CORRECTED 2026-09-15, direct user report ("how come clicks are logging
// as Pans even though its just a click, not even a click hold drag") --
// this always described button 0/1/2 as "Camera Pan"/"Camera Zoom/Dolly
// (OrbitControls, X-drag)" regardless of whether a drag actually
// happened, because it was called ONCE per pointerup, before click-vs-
// drag was even classified, and every call site (including the genuine
// "Click at"/"Double-click at" ones) reused that same drag-worded
// string. A plain click that never moved and wasn't held never actually
// panned/zoomed anything -- OrbitControls only acts on continued
// pointermove while a button is down. Now takes `wasDrag` (computed by
// the caller, which already knows heldMs/moved by the time it calls
// this) and only uses the Camera Pan/Zoom-Dolly wording when a drag
// genuinely occurred; a plain click is described by button alone.
function describeMouseLogTrigger(e, wasDrag) {
  const inPanel = !!e.target?.closest?.('.dp-panel')
  if (inPanel) return 'Dev Panel interaction'
  if (!wasDrag) {
    if (e.button === 0) return 'Canvas (Left Click)'
    if (e.button === 1) return 'Canvas (Middle Click)'
    if (e.button === 2) return 'Canvas (Right Click)'
    return `Unhandled button ${e.button}`
  }
  if (e.button === 1) return 'Camera Zoom/Dolly (OrbitControls, middle-drag)'
  if (e.button === 0 || e.button === 2) return `Camera Pan (OrbitControls, ${e.button === 0 ? 'left' : 'right'}-drag)`
  return `Unhandled button ${e.button}`
}
const MOUSE_LOG_MOVE_THRESHOLD_PX = 10
window.addEventListener('pointerdown', (e) => {
  mouseLogDownInfo = { time: performance.now(), x: e.clientX, y: e.clientY, button: e.button, target: e.target }
})
window.addEventListener('pointerup', (e) => {
  const down = mouseLogDownInfo
  mouseLogDownInfo = null
  const x = Math.round(e.clientX), y = Math.round(e.clientY)
  const heldMs = down ? Math.round(performance.now() - down.time) : 0
  const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOUSE_LOG_MOVE_THRESHOLD_PX : false
  const wasDrag = !!(down && (heldMs > MOUSE_LOG_HELD_DRAG_MS || moved))
  // `e.target` isn't guaranteed to be an Element (e.g. `document` itself,
  // which has no `.closest()`) -- confirmed live as a real crash while
  // testing with a synthetic event dispatched directly on `document`; a
  // genuine user click always targets a real element in practice, but the
  // optional-chaining guard costs nothing and removes the failure mode
  // entirely rather than relying on that always being true.
  const trigger = describeMouseLogTrigger(down ? { target: down.target, button: down.button } : e, wasDrag)
  // A quick right-click (not dragged) still gets its own distinct,
  // immediate "Right-click at" line, same as before -- only a GENUINE
  // right-drag now falls through to the shared Drag-release branch below
  // (previously every right button release said "-drag" even when
  // nothing was dragged, and a real right-drag was mislabeled the other
  // way, as a plain "Right-click").
  if (down && down.button === 2 && !wasDrag) {
    logMouseTrackingEvent(`Right-click at (${x}, ${y}) -> ${trigger}`)
    return
  }
  if (wasDrag) {
    logMouseTrackingEvent(`Drag-release at (${x}, ${y}) -> ${trigger} (heldMs:${heldMs})`)
    return
  }
  // Quick click, left or middle button -- debounced into single/double/
  // triple the same way the template's own version does, so a rapid
  // double-click doesn't log as 2 separate unrelated clicks.
  mouseLogClickCount++
  mouseLogPendingClick = { x, y, trigger }
  clearTimeout(mouseLogClickTimer)
  mouseLogClickTimer = setTimeout(() => {
    const kind = mouseLogClickCount >= 3 ? 'Triple-click' : mouseLogClickCount === 2 ? 'Double-click' : 'Click'
    const p = mouseLogPendingClick
    if (p) logMouseTrackingEvent(`${kind} at (${p.x}, ${p.y}) -> ${p.trigger}`)
    mouseLogClickCount = 0
    mouseLogPendingClick = null
  }, cfg.multiClickWindowMs)
})
// Viewport/device context entries -- ported from the template's own
// logMouseLogContext()/isNarrowViewport() pattern: one entry when the
// log widget is first built, and one more on any REAL resize (viewport
// size actually different from the last-logged one, not just any
// 'resize' event firing) -- gives the log a record of what device/
// viewport shape the surrounding clicks/positions happened under.
function logMouseLogViewportContext(reason) {
  const w = window.innerWidth, h = window.innerHeight
  if (reason === 'resize' && mouseLogLastViewport && mouseLogLastViewport.w === w && mouseLogLastViewport.h === h) return
  mouseLogLastViewport = { w, h }
  logMouseTrackingEvent(`Viewport (${reason}): ${w}x${h}`)
}
window.addEventListener('resize', () => logMouseLogViewportContext('resize'))
// Session-only (never persisted through devPanel.js's Copy/Save -- there's
// nothing meaningful to restore later), capped at MOUSE_LOG_MAX_ENTRIES so
// a long session doesn't grow this without bound. `mouseTrackingLogEl` is
// set once buildMouseTrackingLogWidget() runs (right after initDevPanel());
// logging before then (shouldn't normally happen, since no pointer event
// can fire before the page itself has rendered) just skips the DOM update.
function logMouseTrackingEvent(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`
  mouseTrackingLogEntries.push(line)
  if (mouseTrackingLogEntries.length > MOUSE_LOG_MAX_ENTRIES) mouseTrackingLogEntries.shift()
  if (mouseTrackingLogEl) {
    mouseTrackingLogEl.textContent = mouseTrackingLogEntries.join('\n')
    mouseTrackingLogEl.scrollTop = mouseTrackingLogEl.scrollHeight
  }
}
function clearMouseTrackingLog() {
  mouseTrackingLogEntries.length = 0
  if (mouseTrackingLogEl) mouseTrackingLogEl.textContent = ''
}
// Re-armed whenever `logCursorPositionEnabled`/`cursorLogIntervalMs`
// change (both call this directly as their onChange) -- a real
// `setInterval`, not piggybacked on the render loop, since the requested
// interval (as low as 100ms) is finer-grained than "once per rendered
// frame" would guarantee under any frame-rate hiccup.
function restartCursorLogTimer() {
  if (cursorLogTimer) { clearInterval(cursorLogTimer); cursorLogTimer = null }
  if (!cfg.logCursorPositionEnabled) return
  cursorLogTimer = setInterval(() => {
    logMouseTrackingEvent(`Cursor position: (${Math.round(lastPointerClientX)}, ${Math.round(lastPointerClientY)})`)
  }, cfg.cursorLogIntervalMs)
}
// Appends a plain scrollable log display directly to the Debug group's own
// body -- NOT tied to any devPanel.js control (a live log has nothing to
// persist), so this bypasses the "custom widget over a hidden text input"
// pattern the arm-length widgets use and just appends straight to the
// group's DOM, found via its own `data-key` (see devPanel.js's
// `createGroupElement()`).
function buildMouseTrackingLogWidget() {
  const body = document.querySelector('.dp-group[data-key="Debug"] .dp-group-body')
  if (!body) return
  const wrap = elLocal('div', { padding: '4px 6px' })
  const headerRow = elLocal('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' })
  const label = elLocal('div', { fontSize: '11px', opacity: '0.85' }, { text: 'Mouse Tracking Log' })
  // Same copy pattern devPanel.js's own "Copy Settings" button already
  // uses (navigator.clipboard.writeText + a text flash) -- no new
  // transport needed.
  const copyBtn = elLocal('button', {
    fontSize: '10px', padding: '2px 8px', background: '#3a3a4a', color: 'inherit',
    border: 'none', borderRadius: '4px', cursor: 'pointer'
  }, { text: 'Copy', type: 'button' })
  // Template-parity addition (2026-09-14 port round): a Save-to-file
  // export alongside the existing clipboard-only Copy -- the template's
  // own version writes a .md file via a throwaway <a download> link (a
  // real client-side file save, not related to the artifact-viewer
  // download restriction that applies only to Claude-authored sandboxed
  // Artifact pages; this is a normal dev-tool feature running in the
  // user's own browser). Kept the file format plain text here rather
  // than the template's own headered .md structure -- this project's
  // own log entries are already flat, timestamped lines with nothing
  // resembling the template's separate context-vs-event sectioning.
  const saveBtn = elLocal('button', {
    fontSize: '10px', padding: '2px 8px', background: '#3a3a4a', color: 'inherit',
    border: 'none', borderRadius: '4px', cursor: 'pointer'
  }, { text: 'Save', type: 'button' })
  // Direct follow-up request ("Add a 'Clear' button to the click log so i
  // can clear the log") -- reuses clearMouseTrackingLog() unchanged
  // (already existed as a standalone DEV_GROUPS button control elsewhere
  // in the panel, but not here, next to Copy/Save, where it's actually
  // convenient -- matches this workspace's own standard Debug-group
  // button set, parent CLAUDE.md §12i-1: "Copy / Save / Clear buttons").
  const clearBtn = elLocal('button', {
    fontSize: '10px', padding: '2px 8px', background: '#3a3a4a', color: 'inherit',
    border: 'none', borderRadius: '4px', cursor: 'pointer'
  }, { text: 'Clear', type: 'button' })
  headerRow.appendChild(label)
  const btnRow = elLocal('div', { display: 'flex', gap: '4px' })
  btnRow.appendChild(copyBtn)
  btnRow.appendChild(saveBtn)
  btnRow.appendChild(clearBtn)
  headerRow.appendChild(btnRow)
  mouseTrackingLogEl = elLocal('pre', {
    height: '110px', overflowY: 'auto', margin: '0', padding: '4px 6px',
    background: 'rgba(255,255,255,0.06)', borderRadius: '4px', fontSize: '10px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word'
  })
  copyBtn.addEventListener('click', () => {
    const flash = (msg) => { const orig = copyBtn.textContent; copyBtn.textContent = msg; setTimeout(() => { copyBtn.textContent = orig }, 900) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mouseTrackingLogEntries.join('\n')).then(() => flash('Copied!')).catch(() => flash('Copy failed'))
    } else {
      flash('Copy failed')
    }
  })
  saveBtn.addEventListener('click', () => {
    const flash = (msg) => { const orig = saveBtn.textContent; saveBtn.textContent = msg; setTimeout(() => { saveBtn.textContent = orig }, 900) }
    const blob = new Blob([mouseTrackingLogEntries.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.href = url
    a.download = `mouse-tracking-log-${stamp}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    flash('Saved!')
  })
  clearBtn.addEventListener('click', () => clearMouseTrackingLog())
  wrap.appendChild(headerRow)
  wrap.appendChild(mouseTrackingLogEl)
  body.appendChild(wrap)
  logMouseLogViewportContext('start')
}
// Logs every dev-panel setting change (which control, and the value it was
// set to) -- direct follow-up request: "if i click a settings in the dev
// panel, it logs what i clicked and what setingg i had set." Delegated
// (ONE listener on the whole panel, not one per control) so it works for
// every existing AND future control without touching any of their own
// onChange handlers -- generic 'input'/'change' events bubble from
// whichever native input the user actually interacted with (range slider,
// checkbox, color picker, the Arm Length widgets' own hidden text inputs,
// etc.) up to the panel; the listener just reads that row's own `data-key`
// and looks up `cfg[key]`, which devPanel.js's own commit() has ALREADY
// set by the time this fires (the target's own listener always runs
// before an ancestor's during bubbling). `lastLoggedByKey` skips a
// duplicate log when 'input' and 'change' both fire for the identical
// value (e.g. a color picker firing both on the same close) -- a genuine
// value change during a slow slider drag still logs every distinct tick,
// which is deliberate: a debug log like this should show the real
// sequence, not just the final committed value.
const lastLoggedByKey = {}
function setupSettingsChangeLog() {
  const panel = document.querySelector('.dp-panel')
  if (!panel) return
  const handler = (e) => {
    const row = e.target.closest ? e.target.closest('.dp-row[data-key]') : null
    if (!row) return
    const key = row.dataset.key
    const value = cfg[key]
    const serialized = JSON.stringify(value)
    if (lastLoggedByKey[key] === serialized) return
    lastLoggedByKey[key] = serialized
    const label = row.querySelector('label')?.textContent || key
    logMouseTrackingEvent(`Setting changed: ${label} = ${serialized}`)
  }
  panel.addEventListener('input', handler)
  panel.addEventListener('change', handler)
}

// CORRECTED 2026-09-14 (direct user request, after a live explanation of
// the previous behavior with real numbers): "i want the xy position to
// be set directly perpendicular to the camera plane, not some parallax
// thing. The cursor target depth should still be what i set it as, but
// the xy should match the true cursor xy." The OLD behavior raycast
// straight to a plane already sitting AT the configured depth
// (targetDepthFactor * fieldRadius) -- since that plane sits CLOSER to
// the camera than the hands' own z=0 plane, the ray's own perspective
// spread meant the hit point's X/Y came out SMALLER in magnitude than
// "where the cursor really is" at the hands' own depth (confirmed live:
// a corner hand at world x=-166.8 ended up needing to face RIGHTWARD
// because the depth-shifted target's own x=-50.4 was numerically to its
// right, even though the cursor was clearly further left on screen).
// Fixed by decoupling the 2 axes entirely: X/Y now always come from
// `targetPlane` fixed at z=0 (the hands' own plane, "perpendicular to
// the camera" in the sense of matching the camera's own straight-on
// projection with no depth-driven scaling) -- genuinely the "true
// cursor xy," invariant to targetDepthFactor. Z is set directly from
// the configured depth as a plain scalar, with no raycast/plane
// intersection needed for it at all (a depth offset isn't a
// geometrically "hit" point, just a chosen distance along the shared Z
// axis) -- `targetDepthFactor` still fully controls the visual/pointing
// depth exactly as before, just no longer entangled with X/Y.
function updateCursorTarget() {
  raycaster.setFromCamera(cursorNDC, camera)
  const hit = new THREE.Vector3()
  if (raycaster.ray.intersectPlane(targetPlane, hit)) {
    cursorTarget.x = hit.x
    cursorTarget.y = hit.y
  }
  cursorTarget.z = sceneState.fieldRadius * cfg.targetDepthFactor
  targetMarker.position.copy(cursorTarget)
}

// -----------------------------------------------------------------------
// Toon material (shared across every hand instance -- same texture/style
// for all of them, so one material is correct here, unlike HANDO which
// needed 2 distinct materials for its 2 different model variants)
// -----------------------------------------------------------------------
let toonMaterial = null
const toonShaderUniformsList = []
function setToonUniform(name, value) {
  toonShaderUniformsList.forEach((u) => { if (u[name]) u[name].value = value })
}
// Every field hand now gets its OWN cloned toon/outline material (see
// rebuildField()'s own comment on wristClipPlane for why) -- these two
// helpers keep every existing "change a shared material property" control
// working across all of them, plus the original template material itself
// (still used directly by the single Pose Preview hand, which has no
// per-hand clipping conflict since nothing else shares its material).
function forEachToonMaterial(fn) {
  if (toonMaterial) fn(toonMaterial)
  hands.forEach((h) => { if (h.skinnedMesh && h.skinnedMesh.material !== toonMaterial) fn(h.skinnedMesh.material) })
}
function forEachOutlineMaterial(fn) {
  if (outlineMaterial) fn(outlineMaterial)
  hands.forEach((h) => { if (h.outlineMesh && h.outlineMesh.material !== outlineMaterial) fn(h.outlineMesh.material) })
}
function makeGradientTexture(steps, shadowFloor, lightCeiling, threshold) {
  const size = Math.max(2, Math.round(steps))
  const data = new Uint8Array(size * 4)
  for (let i = 0; i < size; i++) {
    const t = size <= 1 ? 1 : i / (size - 1)
    const biased = Math.pow(t, threshold)
    const v = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.lerp(shadowFloor, lightCeiling, biased), 0, 100) / 100 * 255)
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return tex
}
function rebuildGradientMap() {
  if (!toonMaterial) return
  if (toonMaterial.gradientMap) toonMaterial.gradientMap.dispose()
  const gradientTex = makeGradientTexture(cfg.toonSteps, cfg.toonShadowFloor, cfg.toonLightCeiling, cfg.toonStepThreshold)
  forEachToonMaterial((m) => { m.gradientMap = gradientTex; m.needsUpdate = true })
}
// Ported from HANDO's own createToonMaterial() -- a MeshToonMaterial with
// an onBeforeCompile injecting rim lighting + a duotone texture-tint blend
// (see HANDO's own code for why duotone rather than a flat color swap).
// This is a TEMPLATE material: the single Pose Preview hand uses it
// directly (no wrist-clip support there currently, so no clipping
// conflict), but every FIELD hand instead gets its own `.clone()` of this
// template with its own `clippingPlanes` (see rebuildField() and
// updateWristClipPlaneForHand()'s own corrected comment for why a shared
// material can't support per-hand clip planes).
//
// CORRECTED 2026-09-14 (user-reported: "Keylight color no longer seems to
// work... white still shows color, red does turn them red"): this used
// to also set `material.customProgramCacheKey = () => 'handToonMaterial'`
// on the theory that it would let all 289+ per-hand clones share ONE
// compiled WebGL program despite each being its own `.clone()`. Confirmed
// live this broke the ENTIRE onBeforeCompile customization below (rim
// light + toon-tint/texture duotone blend) for every hand except
// whichever one happened to compile the shared program first: direct
// pixel-readback showed the real texture map's own skin-tone colors
// rendering completely untouched (RGB ~93,78,63) even with
// `textureInfluence:0`/`toonTint:#ffffff` set (which should force a flat
// white blend, per the `<map_fragment>` replacement below) -- and every
// hand's own `renderer.properties.get(material).uniforms` was missing
// `toonTint`/`textureInfluence` entirely, confirming `onBeforeCompile`
// silently never ran (and so never registered those per-material
// uniforms) for materials that hit the forced cache key instead of
// compiling their own program. Removed `customProgramCacheKey` entirely
// -- correctness over the speculative compile-time saving; three.js now
// compiles up to 289 separate (but small, cheap) programs once at
// `rebuildField()` time, same as before this cache-key attempt existed.
function createToonMaterial(map) {
  const material = new THREE.MeshToonMaterial({
    map,
    color: new THREE.Color(cfg.toonBaseTint),
    gradientMap: makeGradientTexture(cfg.toonSteps, cfg.toonShadowFloor, cfg.toonLightCeiling, cfg.toonStepThreshold),
    wireframe: cfg.showWireframe,
    clippingPlanes: []
    // depthTest stays ON (the default) -- a single hand's own self-
    // occlusion (finger over palm, etc) needs a real depth test to render
    // correctly. Stacking between DIFFERENT hands (driven by renderOrder,
    // set every frame from each hand's own distance to the cursor target)
    // is instead achieved by clearing the depth buffer before each hand's
    // own draw call -- see the `onBeforeRender` hooks where this material
    // is assigned in rebuildField(), and that function's own comment for
    // the full account of why (a real user-reported "seeing through the
    // hand" bug, root-caused by direct pixel-diff measurement, from an
    // earlier `depthTest:false` approach here).
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new THREE.Color(cfg.rimColor) }
    shader.uniforms.rimIntensity = { value: cfg.rimIntensity }
    shader.uniforms.rimPower = { value: cfg.rimPower }
    shader.uniforms.textureInfluence = { value: cfg.textureInfluence / 100 }
    shader.uniforms.toonTint = { value: new THREE.Color(cfg.toonTint) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `varying vec3 vRimNormal;\nvarying vec3 vRimViewDir;\n#include <common>`)
      .replace('#include <project_vertex>', `#include <project_vertex>\nvRimNormal = normalize( normalMatrix * objectNormal );\nvRimViewDir = normalize( -mvPosition.xyz );`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `varying vec3 vRimNormal;\nvarying vec3 vRimViewDir;\nuniform vec3 rimColor;\nuniform float rimIntensity;\nuniform float rimPower;\nuniform float textureInfluence;\nuniform vec3 toonTint;\n#include <common>`)
      .replace('#include <map_fragment>', `#include <map_fragment>\nfloat toonLuma = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );\nvec3 toonDuotone = mix( vec3( 0.0 ), toonTint, toonLuma );\ndiffuseColor.rgb = mix( toonTint, toonDuotone, textureInfluence );`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\nfloat rimFactor = pow( 1.0 - max( dot( normalize( vRimNormal ), normalize( vRimViewDir ) ), 0.0 ), rimPower );\ngl_FragColor.rgb += rimColor * rimFactor * rimIntensity;`)
    toonShaderUniformsList.push(shader.uniforms)
  }
  return material
}

// -----------------------------------------------------------------------
// Outline (inverted-hull shader, ported from HANDO -- see its own GOTCHAS
// for why this technique breaks down at tight concave folds; not expected
// to matter here since this model's static bind pose has no such fold).
// One shared ShaderMaterial across every hand's own outline clone.
// -----------------------------------------------------------------------
const outlineVertexShader = `
#include <common>
#include <skinning_pars_vertex>
uniform float outlineThickness;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec3 outlinePosition = transformed + objectNormal * outlineThickness;
  vec4 mvPosition = modelViewMatrix * vec4( outlinePosition, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
}
`
const outlineFragmentShader = `
uniform vec3 outlineColor;
void main() {
  gl_FragColor = vec4( outlineColor, 1.0 );
}
`
let outlineMaterial = null
function ensureOutlineMaterial() {
  if (!outlineMaterial) {
    outlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        outlineThickness: { value: (cfg.hullThickness / 100) * handLengthRaw },
        outlineColor: { value: new THREE.Color(cfg.outlineColor) }
      },
      vertexShader: outlineVertexShader,
      fragmentShader: outlineFragmentShader,
      side: THREE.BackSide,
      clippingPlanes: []
      // depthTest stays ON -- see createToonMaterial()'s own note; matches
      // the fill material's depth-clear-per-hand approach.
    })
  }
  return outlineMaterial
}
// Every field hand gets its own `.clone()` of the outline material too
// (own `clippingPlanes`, see updateWristClipPlaneForHand()'s own
// corrected comment) -- a plain ShaderMaterial clone shares its compiled
// WebGL program automatically (same shader source, no onBeforeCompile
// involved), so this one was never at risk of the toon material's own
// `customProgramCacheKey` regression (see createToonMaterial()'s own
// corrected comment) -- nothing to change here.
function buildOutlineMesh(sourceMesh) {
  const mesh = sourceMesh.clone()
  mesh.material = ensureOutlineMaterial().clone()
  return mesh
}
function updateOutlineVisibility() {
  const hullVisible = cfg.outlineEnabled && !cfg.useOutlinePass
  const passOn = cfg.outlineEnabled && cfg.useOutlinePass
  hands.forEach((h) => { if (h.outlineMesh) h.outlineMesh.visible = hullVisible })
  outlinePass.enabled = passOn
  outlinePass.selectedObjects = passOn ? hands.map((h) => h.skinnedMesh).filter(Boolean) : []
}
// Field Layout's own "Hide Hands" checkbox -- toggles each hand's whole
// wrapper Group (fill mesh + outline mesh + everything else parented to
// it) in one shot, rather than removing/re-adding hands from the scene or
// hiding the fill/outline meshes separately (which would leave the
// outline visible on its own if `outlineEnabled` happens to be on).
function updateHandsVisibility() {
  hands.forEach((h) => { h.wrapper.visible = !cfg.hideHands })
}

// -----------------------------------------------------------------------
// Pose (ported from HANDO's own Pose dev-panel group) -- applies
// identically to every hand for now, per direct request. Every hand has
// its OWN skeleton (a separate SkeletonUtils.clone() per instance, see
// rebuildField()), so posing means walking every hand's own bones and
// applying the same rotation, not a single shared skeleton the way HANDO
// poses its 1-2 posable models.
// -----------------------------------------------------------------------
const WORLD_X_AXIS = new THREE.Vector3(1, 0, 0)
const WORLD_Y_AXIS = new THREE.Vector3(0, 1, 0)
const WORLD_Z_AXIS = new THREE.Vector3(0, 0, 1)
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky']
const FINGER_JOINTS = {
  thumb: ['rThumb1', 'rThumb2', 'rThumb3'],
  index: ['rIndex1', 'rIndex2', 'rIndex3'],
  middle: ['rMid1', 'rMid2', 'rMid3'],
  ring: ['rRing1', 'rRing2', 'rRing3'],
  pinky: ['rPinky1', 'rPinky2', 'rPinky3']
}
const FINGER_MAX_DEG = {
  thumb: [45, 55, 45],
  index: [90, 100, 70],
  middle: [90, 100, 70],
  ring: [90, 100, 70],
  pinky: [90, 100, 70]
}
// CORRECTED 2026-09-15 -- middle/ring flipped -1 -> 1, matching HANDO's own
// 2026-09-14 fix ("for middle finger and ring finger curl, inverse the
// number. right now, curling it is negative numbers"), never previously
// ported here. This was the ACTUAL cause of "Point"/"MiddleFinger"/"Fist"
// (and by extension any pose with nonzero curlMiddle/curlRing) rendering
// as fragmented, chaotic geometry rather than a coherent hand shape --
// confirmed both ways: (1) the SAME broken result reproduced identically
// on the pre-delta=identity-fix code, ruling out the wrist-axis
// conjugation as the cause; (2) patching just this one line in a scratch
// copy turned "Point"'s chaotic mess into a correctly-formed pointing
// hand (extended index, curled fist body, visible thumb). HANDO's own fix
// shipped together with a one-time migration of ITS OWN existing saved
// poses' curlMiddle/curlRing values (to preserve their visual meaning
// under the new sign) -- NOT needed here, since every pose in this
// project's own saved-pose list was captured/imported from HANDO AFTER
// that migration already happened (all use positive curlMiddle/curlRing
// for an actual curl, consistent with the new convention already) -- a
// pure sign flip, no data migration, is the complete fix for this project.
const FINGER_SIGN = { thumb: -1, index: 1, middle: 1, ring: 1, pinky: 1 }
// Per-finger curl axis -- all 4 non-thumb fingers curl around WORLD_X, the
// thumb around WORLD_Y (curls toward the palm center). Ported verbatim
// from HANDO's own live-measured tables (same asset/rig) -- see its own
// main.js for the measurement history behind these exact axes/signs.
const FINGER_CURL_AXIS = { thumb: WORLD_Y_AXIS, index: WORLD_X_AXIS, middle: WORLD_X_AXIS, ring: WORLD_X_AXIS, pinky: WORLD_X_AXIS }
const FINGER_SPLAY_AXIS = { thumb: WORLD_Z_AXIS, index: WORLD_Z_AXIS, middle: WORLD_Z_AXIS, ring: WORLD_Z_AXIS, pinky: WORLD_Z_AXIS }
const FINGER_SPLAY_SIGN = { thumb: 1, index: 1, middle: 1, ring: -1, pinky: 1 }
const FINGER_SPLAY_MAX_DEG = { thumb: 45, index: 30, middle: 30, ring: 30, pinky: 30 }
const FINGER_SPLAY_JOINT_INDEX = { thumb: 1, index: 0, middle: 0, ring: 0, pinky: 0 }
const FINGER_SPLAY2_JOINT_INDEX = { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 }
const FINGER_SPLAY2_AXIS = { thumb: WORLD_X_AXIS, index: WORLD_Z_AXIS, middle: WORLD_Z_AXIS, ring: WORLD_Z_AXIS, pinky: WORLD_Z_AXIS }
const FINGER_SPLAY2_MAX_DEG = { thumb: 90, index: 30, middle: 30, ring: 30, pinky: 30 }
const FINGER_SPLAY2_SIGN = { thumb: 1, index: 1, middle: 1, ring: -1, pinky: 1 }
const FINGER_SPLAY2_KEY = { thumb: 'thumbSplay2', index: 'splayIndex2', middle: 'splayMiddle2', ring: 'splayRing2', pinky: 'splayPinky2' }
const FINGER_CURL_KEY = { thumb: 'thumbCurl', index: 'curlIndex', middle: 'curlMiddle', ring: 'curlRing', pinky: 'curlPinky' }
const FINGER_SPLAY_KEY = { thumb: 'thumbSplay', index: 'splayIndex', middle: 'splayMiddle', ring: 'splayRing', pinky: 'splayPinky' }
const FINGER_CURL_BIAS_KEY = { thumb: 'curlBiasThumb', index: 'curlBiasIndex', middle: 'curlBiasMiddle', ring: 'curlBiasRing', pinky: 'curlBiasPinky' }
// Ported from HANDO (direct user request, "maybe check hando for pose
// settings. maybe there is an extra setting you dont have" -- this WAS
// exactly that: this project's own Pose group port deliberately omitted
// HANDO's `baseOnlyCurl*` sliders, disclosed at the time as "don't exist
// as controls in this project yet" but never circled back to. A pose
// imported from HANDO that uses Base-Only Curl on the thumb had that
// part of its data silently dropped -- no control/key existed here to
// store or apply it, explaining a thumb that looked wrong on EVERY
// imported pose using it, regardless of how correct the rest of the
// posing math was (already independently verified correct in 2 earlier
// rounds this session). See FINGER_BASE_ONLY_CURL_KEY's own use in
// applyCurlToSkeleton() below for the exact application (additive,
// base-joint-only, same mechanism HANDO itself uses).
const FINGER_TIP_TWIST_KEY = { thumb: 'tipTwistThumb', index: 'tipTwistIndex', middle: 'tipTwistMiddle', ring: 'tipTwistRing', pinky: 'tipTwistPinky' }
const FINGER_BASE_ONLY_CURL_KEY = { thumb: 'baseOnlyCurlThumb', index: 'baseOnlyCurlIndex', middle: 'baseOnlyCurlMiddle', ring: 'baseOnlyCurlRing', pinky: 'baseOnlyCurlPinky' }
// Ported from HANDO (found while checking HANDO's own recent changes for
// pose-export compatibility, direct request: "make sure you two are
// matching since i will be exporting poses from hando") -- the mirror of
// Base-Only Curl above, targeting the LAST joint instead of joint 0. No
// thumb entry, matching HANDO's own scope exactly (HANDO's own comment:
// "tipOnlyCurlT is 0 for the thumb (no key defined)").
// CORRECTED 2026-09-15 -- HANDO has since added `tipOnlyCurlThumb` too
// (this project's own port, earlier this session, excluded the thumb to
// match HANDO's THEN-current scope). Re-checked HANDO's live Pose group
// per direct request ("look into the Hando project to see the pose
// settings since we added more sliders. Port those") and found this plus
// an entirely new Mid-Only Curl slider set (below) -- porting both now.
const FINGER_TIP_ONLY_CURL_KEY = { thumb: 'tipOnlyCurlThumb', index: 'tipOnlyCurlIndex', middle: 'tipOnlyCurlMiddle', ring: 'tipOnlyCurlRing', pinky: 'tipOnlyCurlPinky' }
// Mid-Only Curl -- the 3rd and final joint-isolation slider (joint 1,
// the middle segment), completing the Base-Only/Mid-Only/Tip-Only set
// HANDO now has for all 5 fingers including the thumb (ported from
// HANDO's own FINGER_MID_ONLY_CURL_KEY -- same mechanism as Base-Only/
// Tip-Only, additive rotateOnTrueWorldAxis() call, joint 1 only).
const FINGER_MID_ONLY_CURL_KEY = { thumb: 'midOnlyCurlThumb', index: 'midOnlyCurlIndex', middle: 'midOnlyCurlMiddle', ring: 'midOnlyCurlRing', pinky: 'midOnlyCurlPinky' }
const FINGER_TIP_TWIST_MAX_DEG = 90

// Converts a rotation expressed around a WORLD axis into the correct LOCAL
// delta for `bone` -- exact for any existing local rotation (not just
// identity), via the bone's own FULL current world quaternion. Ported
// verbatim from HANDO's own `rotateOnTrueWorldAxis` (see its own main.js
// for why `Object3D.rotateOnWorldAxis` itself is NOT equivalent once a
// bone's parent chain carries real rotation -- the same rig, same issue).
// `excludeQuat`, when given, is factored OUT of the bone's world
// quaternion before the conversion (`excludeQuat^-1 * boneWorldQuat`) --
// needed ONLY for this project's own Curl/Splay/Splay2 axes (see
// applyCurlToSkeleton()'s own comment on why: unlike HANDO, every hand
// here sits under an EXTRA per-hand, per-frame rotation -- `wrapper`'s own
// cursor-tracking look-at -- that HANDO's single modelRoot never had, and
// a "world" curl axis must stay anatomically fixed relative to the hand's
// own canonical pose, not relative to whichever way it currently happens
// to be facing the cursor. Tip Twist's own axis (computed live from 2
// bones' actual current world positions, see segmentDirection()) is
// already correct as a true world-space direction and must NOT exclude
// anything -- omit `excludeQuat` for that call.
const _worldToLocalQuat = new THREE.Quaternion()
const _localAxis = new THREE.Vector3()
const _excludeQuatInv = new THREE.Quaternion()
function rotateOnTrueWorldAxis(bone, worldAxis, angle, excludeQuat) {
  bone.getWorldQuaternion(_worldToLocalQuat)
  if (excludeQuat) _worldToLocalQuat.premultiply(_excludeQuatInv.copy(excludeQuat).invert())
  _worldToLocalQuat.invert()
  _localAxis.copy(worldAxis).applyQuaternion(_worldToLocalQuat).normalize()
  bone.rotateOnAxis(_localAxis, angle)
}
const _segFromPos = new THREE.Vector3()
const _segToPos = new THREE.Vector3()
const _segDir = new THREE.Vector3()
function segmentDirection(fromBone, toBone) {
  fromBone.getWorldPosition(_segFromPos)
  toBone.getWorldPosition(_segToPos)
  return _segDir.subVectors(_segToPos, _segFromPos).normalize()
}
function curlBiasWeight(jointIndex, jointCount, bias) {
  const p = jointIndex / (jointCount - 1) // 0 (base) .. 1 (tip)
  return 1 - bias * (2 * p - 1)
}

// Applies Curl/Splay/Splay2/Curl Bias/Tip Twist for one finger to one
// hand's own skeleton -- ported from HANDO's own applyCurlToSkeleton(),
// with `modelRoot.quaternion` (HANDO's single posable object) replaced by
// `baseQuat` (this project's own per-hand-identical `cloneBaseQuat` --
// alignQuat composed with the live Whole-Hand Rotation sliders, see
// updateCloneBaseQuat()), passed in rather than read from a
// module-level object, since the SAME value applies to every hand's own
// distinct skeleton. Also takes `wrapperQuat` (THIS hand's own, per-hand,
// per-frame cursor-tracking rotation -- see animate()) and passes it as
// `rotateOnTrueWorldAxis()`'s own `excludeQuat`, which HANDO's identical
// code never needed to: HANDO has no extra per-instance rotation layer on
// top of its posed orientation, but every hand here does. Confirmed via a
// direct live test this round that omitting this made 2 different hands'
// SAME slider values produce 2 DIFFERENT local bone quaternions, purely
// because they happened to be facing different directions at that moment
// -- pre-rotating the axis by `baseQuat` (below) and excluding
// `wrapperQuat` during the conversion together cancel out to leave the
// axis fixed relative to the mesh's own raw/bind-pose frame regardless of
// either rotation, matching HANDO's own anatomical intent exactly.
const _curlAxisScratch = new THREE.Vector3()
const _splayAxisScratch = new THREE.Vector3()
const _splay2AxisScratch = new THREE.Vector3()
// CORRECTED 2026-09-14 (twice) -- the comment above this block (kept for
// its own historical account) documents that using `baseQuat` alone was
// a DELIBERATE port of HANDO's own convention -- and that convention
// turned out to be anatomically wrong, not just here: the user
// independently confirmed the identical symptom reproduces in HANDO
// itself. `baseQuat` is the whole-hand's PRE-wrist orientation (alignQuat
// + Whole-Hand Rotation only) -- it never includes the wrist bone's own
// current bend/splay rotation. Every finger (not just the thumb -- see
// this same day's earlier correction) is a descendant of the wrist bone
// (`rHand`, via its own "carpal" bone), so a real hand's curl direction
// should rotate WITH the wrist/palm.
//
// FIRST attempt at a fix (superseded, same day) read the wrist bone's
// full WORLD quaternion and excluded `wrapperQuat` -- structurally sound
// on its own, but the user's very next message asked to check HANDO's
// own concurrent fix to the identical bug, for pose-export compatibility.
// HANDO's fix at the time computed the wrist's LOCAL delta-from-ITS-OWN-
// rest (`wristRestQuat^-1 * wristBone.quaternion`) and composed that
// delta with `modelRoot.quaternion` directly -- switched to match.
//
// CORRECTED AGAIN 2026-09-15 -- HANDO's OWN team found that 2nd fix was
// itself still wrong, via a handoff doc from a concurrent session working
// on HANDO ("our fix wasnt complete in regards to the wrist splay"). The
// bug: `baseQuat * delta` treats `delta` (a rotation expressed in the
// wrist bone's own LOCAL/body frame) as if it were already a WORLD-frame
// rotation operator -- those 2 only agree when the wrist's REST pose is
// the identity quaternion, which it is not here (confirmed directly:
// `rHand`'s own rest quaternion is `[-0.078, 0.688, -0.086, 0.716]`, far
// from identity) -- explaining why this stayed invisible near
// wristBend=wristSplay=0 (nearly every pose) and only produced real
// errors (35-100+ degrees per joint, per HANDO's own measurement) at a
// genuinely bent/splayed wrist. The actual fix requires a CONJUGATION,
// not a plain multiply: a local rotation delta is converted to its
// equivalent WORLD-frame operator via `W1 * delta * W1^-1`, where W1 is
// the wrist bone's own CURRENT WORLD quaternion (read live, full
// ancestor chain) -- not by simply premultiplying `baseQuat` onto the
// raw local delta.
//
// FURTHER CORRECTED, same day (2026-09-15) -- the `W1 * delta * W1^-1`
// formula above (W1 = the wrist bone's own current world quat, wrapperQuat
// excluded) turned out to have the EXACT MIRROR-IMAGE flaw of the bug it
// replaced: that bug was invisible near wristBend=wristSplay=0 and wrong
// once genuinely bent/splayed; THIS formula is correct for any genuinely
// nonzero wristBend/wristSplay (confirmed repeatedly, 0.0000 degrees) but
// silently collapses to IDENTITY -- discarding `baseQuat` entirely -- the
// moment delta is EXACTLY identity (wristBend = wristSplay = 0, e.g. the
// "Fist" pose), since `W1 * I * W1^-1 = I` for any W1 at all. Confirmed
// live: axisRefQuat read back as [0,0,0,1] instead of baseQuat's actual
// value, and "Fist" rendered as flat wedge shapes instead of a closed
// fist. Caught only because a real saved pose finally exercised the
// exact-zero case -- every test this whole saga had run up to that point
// happened to use a nonzero wristSplay.
//
// Fixed by conjugating `delta` by `wristRestForAxis` (R) alone, instead of
// by the full world quat W1: `baseQuat * R * delta * R^-1`. This reduces
// to exactly `baseQuat` when delta = I (verified live, <1e-6 per
// component) -- matching the `else` branch below, which has always used
// `baseQuat` directly for the "no wrist rotation" case -- while still
// rotating the curl axis to track the wrist's actual bend/splay when
// delta != I. `wrapperQuat` and the wrist bone's world quaternion are no
// longer needed for this at all -- R and delta alone fully determine it,
// so this project no longer needs its own wrapperQuat-exclusion adaptation
// HANDO's version never required.
const _curlAxisRefQuat = new THREE.Quaternion()
const _curlWristDeltaScratch = new THREE.Quaternion()
const _curlWristRestInvScratch = new THREE.Quaternion()
// `values` (default `cfg`): lets a caller pose a DIFFERENT skeleton from a
// plain values object instead of the live cfg -- added for the Pose
// Preview mini-viewer (previewPosePreset(), below), which poses its own
// standalone preview hand from a SAVED item's own values without touching
// cfg or any hand in the main field. Every existing call site (the main
// `hands` field, via applyCurl()) omits this arg and behaves exactly as
// before.
function applyCurlToSkeleton(fingerName, skeleton, baseQuat, wrapperQuat, values = cfg) {
  const joints = FINGER_JOINTS[fingerName]
  const maxDegs = FINGER_MAX_DEG[fingerName]
  const sign = FINGER_SIGN[fingerName]
  const wristBoneForAxis = skeleton.getBoneByName('rHand')
  const wristRestForAxis = boneRestQuat.rHand
  let axisRefQuat
  if (wristBoneForAxis && wristRestForAxis) {
    // delta = wristRest^-1 * wristBone.currentLocalQuat (body-frame delta,
    // i.e. the wrist's rotation AWAY FROM REST, expressed in the wrist
    // bone's own local/parent frame -- identity whenever wristBend and
    // wristSplay are both exactly 0).
    const delta = _curlWristDeltaScratch.copy(wristRestForAxis).invert().multiply(wristBoneForAxis.quaternion)
    // CORRECTED 2026-09-15 -- the previous formula (`W1 * delta * W1^-1`,
    // W1 = the wrist bone's own current world quat with wrapperQuat
    // excluded) passed every relative-to-wrist consistency test run
    // against it (0.0000 degrees, repeatedly, including on live
    // production with real saved poses) because that test only checks
    // INVARIANCE -- that a finger's orientation relative to the wrist
    // stays constant as wristSplay changes -- which a systematically
    // biased but internally self-consistent formula can also satisfy.
    // It missed a real bug: at delta = identity (wristBend = wristSplay =
    // 0 exactly -- e.g. the "Fist" pose), `W1 * I * W1^-1` collapses to
    // IDENTITY for any W1 at all, silently discarding `baseQuat` (this
    // hand's own always-present alignQuat) from the curl axis entirely --
    // confirmed live: axisRefQuat read back as [0,0,0,1] instead of
    // baseQuat's actual [-0.712,0.021,0,0.702], and the pose rendered as
    // flat, wing-like wedges instead of a closed fist. The `else` branch
    // 2 lines below (no wrist bone at all) has always used `baseQuat`
    // directly for this exact "no extra wrist rotation" case, so that's
    // the ground truth the conjugation needs to reduce to at delta = I,
    // not identity.
    //
    // Fix: conjugate `delta` by `wristRestForAxis` alone (not by the full
    // world quat W1) before composing with `baseQuat` --
    // `baseQuat * R * delta * R^-1` -- which correctly reduces to
    // `baseQuat` when delta = I (verified live: exact match, both
    // directions, <1e-6 per component) while still rotating the curl
    // axis to follow the wrist's actual bend/splay for delta != I, same
    // as intended. No longer needs the wrist bone's world quat or
    // wrapperQuat at all -- R and delta alone fully determine it.
    axisRefQuat = _curlAxisRefQuat.copy(baseQuat).multiply(wristRestForAxis).multiply(delta).multiply(_curlWristRestInvScratch.copy(wristRestForAxis).invert())
  } else {
    axisRefQuat = baseQuat
  }
  const curlAxis = _curlAxisScratch.copy(FINGER_CURL_AXIS[fingerName]).applyQuaternion(axisRefQuat)
  const splayAxis = _splayAxisScratch.copy(FINGER_SPLAY_AXIS[fingerName]).applyQuaternion(axisRefQuat)
  const curlT = values[FINGER_CURL_KEY[fingerName]] / 100
  const splayT = values[FINGER_SPLAY_KEY[fingerName]] / 100
  const curlBias = values[FINGER_CURL_BIAS_KEY[fingerName]] / 100
  const tipTwistT = values[FINGER_TIP_TWIST_KEY[fingerName]] / 100
  // `|| 0` fallback: an older saved/imported pose predating this key
  // (or one that simply never set it) has no baseOnlyCurl* entry at all
  // -- treated as 0 (no additive base bend), not NaN.
  const baseOnlyCurlT = (values[FINGER_BASE_ONLY_CURL_KEY[fingerName]] || 0) / 100
  // `|| 0` fallback, same reasoning as baseOnlyCurlT above -- also covers
  // an older saved pose predating the thumb's own tipOnlyCurlThumb key
  // (added to HANDO, and ported here, after this project's own thumb
  // Tip-Only Curl gap was found and closed).
  const tipOnlyCurlKey = FINGER_TIP_ONLY_CURL_KEY[fingerName]
  const tipOnlyCurlT = ((tipOnlyCurlKey && values[tipOnlyCurlKey]) || 0) / 100
  // Mid-Only Curl -- same `|| 0` fallback reasoning, all 5 fingers now.
  const midOnlyCurlKey = FINGER_MID_ONLY_CURL_KEY[fingerName]
  const midOnlyCurlT = ((midOnlyCurlKey && values[midOnlyCurlKey]) || 0) / 100
  const splayAngle = FINGER_SPLAY_SIGN[fingerName] * THREE.MathUtils.degToRad(FINGER_SPLAY_MAX_DEG[fingerName] * splayT)
  const splayJointIndex = FINGER_SPLAY_JOINT_INDEX[fingerName]
  const splay2JointIndex = FINGER_SPLAY2_JOINT_INDEX[fingerName]
  const splay2Axis = _splay2AxisScratch.copy(FINGER_SPLAY2_AXIS[fingerName]).applyQuaternion(axisRefQuat)
  const splay2T = values[FINGER_SPLAY2_KEY[fingerName]] / 100
  const splay2Angle = FINGER_SPLAY2_SIGN[fingerName] * THREE.MathUtils.degToRad(FINGER_SPLAY2_MAX_DEG[fingerName] * splay2T)
  const bones = []
  joints.forEach((boneName, i) => {
    const bone = skeleton.getBoneByName(boneName)
    const rest = boneRestQuat[boneName]
    if (!bone || !rest) return
    bones[i] = bone
    bone.quaternion.copy(rest)
    bone.updateMatrixWorld(true)
    if (i === splayJointIndex) {
      rotateOnTrueWorldAxis(bone, splayAxis, splayAngle, wrapperQuat)
      bone.updateMatrixWorld(true)
    }
    if (i === splay2JointIndex) {
      rotateOnTrueWorldAxis(bone, splay2Axis, splay2Angle, wrapperQuat)
      bone.updateMatrixWorld(true)
    }
    const weight = curlBiasWeight(i, joints.length, curlBias)
    const angle = sign * THREE.MathUtils.degToRad(maxDegs[i] * curlT * weight)
    rotateOnTrueWorldAxis(bone, curlAxis, angle, wrapperQuat)
    bone.updateMatrixWorld(true)
    // Base-Only Curl (ported from HANDO -- see FINGER_BASE_ONLY_CURL_KEY's
    // own comment for why) -- a 2nd, purely ADDITIVE rotation on top of
    // whatever Curl (+ Bias) just did to the BASE joint only, same axis,
    // same mechanism Splay/Splay2 already use to compose onto Curl for
    // their own joints (rotateOnTrueWorldAxis always adds onto whatever
    // local rotation the bone already has). Lets a finger bend purely
    // from the knuckle while the rest of it stays relatively straight --
    // set the regular Curl slider to 0 and use only this one for that.
    if (i === 0) {
      const baseOnlyAngle = sign * THREE.MathUtils.degToRad(maxDegs[0] * baseOnlyCurlT)
      rotateOnTrueWorldAxis(bone, curlAxis, baseOnlyAngle, wrapperQuat)
      bone.updateMatrixWorld(true)
    }
    // Mid-Only Curl (ported from HANDO -- see FINGER_MID_ONLY_CURL_KEY's
    // own comment) -- the 3rd joint-isolation slider, joint 1 (the middle
    // segment) specifically, same mechanism as Base-Only/Tip-Only.
    if (i === 1) {
      const midOnlyAngle = sign * THREE.MathUtils.degToRad(maxDegs[1] * midOnlyCurlT)
      rotateOnTrueWorldAxis(bone, curlAxis, midOnlyAngle, wrapperQuat)
      bone.updateMatrixWorld(true)
    }
    // Tip-Only Curl (ported from HANDO, same day as Base-Only Curl's own
    // port -- see FINGER_TIP_ONLY_CURL_KEY's own comment) -- the mirror
    // of Base-Only Curl above, targeting the LAST joint instead of joint
    // 0, same axis/mechanism. Now covers all 5 fingers including the
    // thumb, matching HANDO's own current scope (this project's earlier
    // port excluded the thumb, matching HANDO's THEN-current scope).
    if (i === joints.length - 1) {
      const tipOnlyAngle = sign * THREE.MathUtils.degToRad(maxDegs[i] * tipOnlyCurlT)
      rotateOnTrueWorldAxis(bone, curlAxis, tipOnlyAngle, wrapperQuat)
      bone.updateMatrixWorld(true)
    }
    if (i === joints.length - 1 && i > 0) {
      // Tip Twist's own axis is already a true world-space direction,
      // measured live from this joint's own actual current position (see
      // segmentDirection()) -- no `wrapperQuat` exclusion here, unlike the
      // fixed WORLD_X/Y/Z-based axes above.
      const twistAxis = segmentDirection(bones[i - 1], bone)
      rotateOnTrueWorldAxis(bone, twistAxis, THREE.MathUtils.degToRad(FINGER_TIP_TWIST_MAX_DEG * tipTwistT))
      bone.updateMatrixWorld(true)
    }
  })
}
function applyCurl(fingerName) {
  if (!modelLoaded) return
  scene.updateMatrixWorld(true)
  hands.forEach((hand) => { if (hand.skinnedMesh) applyCurlToSkeleton(fingerName, hand.skinnedMesh.skeleton, cloneBaseQuat, hand.wrapper.quaternion) })
}
// `extraSplayDeg` (default 0, so every pre-existing call site is
// unaffected) is Responsive Wrist Splay's own PER-HAND contribution,
// added directly onto the shared `values.wristSplay` -- see
// computeResponsiveWristSplayDeg()'s own comment. Kept as one combined
// rotateZ() call, not 2 separate ones, so the 2 contributions compose as
// a single rotation rather than 2 stacked ones (equivalent here since
// both are Z-axis, but keeps the intent -- "one splay angle, from 2
// sources" -- explicit in the math itself).
function applyWristPoseToSkeleton(skeleton, values = cfg, extraSplayDeg = 0) {
  const bone = skeleton.getBoneByName('rHand')
  const rest = boneRestQuat.rHand
  if (!bone || !rest) return
  bone.quaternion.copy(rest)
  bone.rotateX(THREE.MathUtils.degToRad(values.wristBend))
  bone.rotateZ(THREE.MathUtils.degToRad(values.wristSplay + extraSplayDeg))
}
function applyWristPose() {
  if (!modelLoaded) return
  hands.forEach((hand) => { if (hand.skinnedMesh) applyWristPoseToSkeleton(hand.skinnedMesh.skeleton) })
}
// Re-applies every finger + the wrist -- needed after rebuildField()
// creates brand-new (bind-pose) skeletons, and after Whole-Hand Rotation
// changes (its own axes are re-expressed relative to cloneBaseQuat, so an
// already-curled finger's pose goes stale the moment that composition
// changes -- see onWholeHandRotationChange()).
// Wrist MUST be posed BEFORE fingers, not after -- this ordering bug was
// already found and fixed in HANDO (this project's own reference), never
// ported here when this code was adapted: `rThumb1`'s own PARENT bone is
// `rHand`, the exact bone applyWristPose() rotates.
// rotateOnTrueWorldAxis() (used by every finger's own Curl/Splay/Splay2)
// converts its world axis into the bone's CURRENT local space via the
// bone's FULL world quaternion, which depends on the ENTIRE parent
// chain's CURRENT matrixWorld -- so posing the thumb (and technically
// every finger, though only the thumb is directly parented to `rHand`
// and visibly affected) before the wrist reaches its own new target
// rotation used whatever wrist rotation was left over from BEFORE this
// call, not the one about to be set. Matches HANDO's own bug exactly
// (direct user report there: "From Scissor 1.5 to Scissor 1 - Wrong
// (thumb curled/splayed too much)") -- see its own CHANGELOG.txt entry
// for the full empirical confirmation (2 identical "Use" clicks in a row
// producing 2 different thumb quaternions).
function applyAllFingerPoses() {
  applyWristPose()
  FINGER_NAMES.forEach((name) => applyCurl(name))
}

// Saved-pose capture -- every key a saved pose stores, listed once here so
// capture and Pose Preview's own apply (previewPosePreset(), below) can
// never drift apart. Ported from HANDO's own POSE_PRESET_KEYS/
// capturePosePreset(), with the Crop Wrist / Arm Length family
// deliberately left out -- see the 'savedPoses' control's own comment for
// why.
const POSE_PRESET_KEYS = [
  'thumbCurl', 'thumbSplay', 'thumbSplay2', 'curlBiasThumb', 'baseOnlyCurlThumb', 'midOnlyCurlThumb', 'tipOnlyCurlThumb', 'tipTwistThumb',
  'curlIndex', 'splayIndex', 'splayIndex2', 'curlBiasIndex', 'baseOnlyCurlIndex', 'midOnlyCurlIndex', 'tipOnlyCurlIndex', 'tipTwistIndex',
  'curlMiddle', 'splayMiddle', 'splayMiddle2', 'curlBiasMiddle', 'baseOnlyCurlMiddle', 'midOnlyCurlMiddle', 'tipOnlyCurlMiddle', 'tipTwistMiddle',
  'curlRing', 'splayRing', 'splayRing2', 'curlBiasRing', 'baseOnlyCurlRing', 'midOnlyCurlRing', 'tipOnlyCurlRing', 'tipTwistRing',
  'curlPinky', 'splayPinky', 'splayPinky2', 'curlBiasPinky', 'baseOnlyCurlPinky', 'midOnlyCurlPinky', 'tipOnlyCurlPinky', 'tipTwistPinky',
  'wristBend', 'wristSplay', 'modelRotX', 'modelRotY', 'modelRotZ'
]
function capturePosePreset() {
  const item = {}
  POSE_PRESET_KEYS.forEach((key) => { item[key] = cfg[key] })
  return item
}
// Each POSE_PRESET_KEYS entry's own slider default -- the fallback for a
// key a pose imported from HANDO might lack (e.g. HANDO's newer
// Base-Only Curl sliders don't exist as controls here at all yet), same
// "never leave cfg/the preview at some OTHER pose's stale value" reasoning
// as HANDO's own POSE_KEY_DEFAULTS.
const POSE_KEY_DEFAULTS = {}
DEV_GROUPS.find((g) => g.title === 'Pose').controls.forEach((c) => {
  if (POSE_PRESET_KEYS.includes(c.key)) POSE_KEY_DEFAULTS[c.key] = c.def
})
// The pose Click-Hold-Pose's own retransition animates back TOWARD, and
// (by construction, see below) the pose already active on this very page
// load -- direct request ("the Default button... sets the selected pose
// as the default pose. So its the pose on startup, as well as the pose
// that retransitions default back to"). Seeded from `cfg`'s OWN restored
// values (whatever initDevPanel() just loaded from localStorage, or code
// `def` if nothing was ever saved) rather than POSE_KEY_DEFAULTS itself
// -- cfg already correctly reflects "the pose on startup" the moment
// this line runs, by the SAME persistence mechanism every other setting
// in this panel already uses, so no separate startup-specific logic is
// needed here. `let`, not `const`: setSelectedPoseAsDefault() (below)
// updates this live the moment "Default" is clicked, so a retransition
// mid-session immediately targets the new default without needing a
// page reload first.
let poseDefaultValues = {}
// Re-seeds poseDefaultValues from cfg's CURRENT values -- called once
// here (synchronously, the same instant `cfg` exists, matching this
// variable's original single-seed behavior for the plain-localStorage/
// no-remote-save case) AND again from `onRestore` (initDevPanel()'s own
// opts, above) once the async remote-settings fetch actually resolves --
// see that call site's own comment for the full root-cause account of
// why a single synchronous seed here was never enough on its own.
function resyncPoseDefaultValues() {
  POSE_PRESET_KEYS.forEach((key) => { poseDefaultValues[key] = cfg[key] !== undefined ? cfg[key] : POSE_KEY_DEFAULTS[key] })
}
resyncPoseDefaultValues()
// Builds ONE Click-Hold Pose group's control array -- called twice (see
// DEV_GROUPS' own use of this, above), once per mouse button, so the 2
// groups can never drift out of sync with each other. `p` is the short
// key prefix ('chp'/'rchp') every one of this group's own cfg keys uses.
// Default Start/Retransition curves ([{x:0,y:0},{x:1,y:1}]) make the
// NEAREST hand (x=0) start first (shortest delay, Min) and the FARTHEST
// (x=1) start last (Max) -- a "ripple outward from the cursor" feel,
// the opposite curve direction from Arm Length's own default (which
// makes the nearest hand crop MOST) since there's no equivalent real-
// world convention to match here; a disclosed default, not a spec'd one.
// Applied to every "Click Function" trigger group's own control array --
// the 9 Click Hold-Pose/Click Pose factory instances below plus Right
// Click and Tween -- direct request ("adapt all those existing click
// function sub groups to match our new system... dont change any of the
// actual settings, but make it show the way i requested"), i.e. give
// every one of them the Show-in-Mobile/Landscape + Independent-from-
// Desktop checkboxes (devPanel.js §12f-1) without altering any current
// value or behavior. Opts every ELIGIBLE control in -- skips the same
// types buildRow() never renders these checkboxes for anyway (text/
// list-picker/multi-select/button; a curve/range text field, a saved-
// sequence list, a fire button), since flagging those would silently
// engage devPanel.js's own dynamicDevice mirroring in commit() with no
// UI to ever control it, for zero benefit. Confirmed by reading every
// one of these 4 control arrays directly before writing this: NONE of
// them currently use `perDevice: true` anywhere, so devPanel.js's own
// category-aware independence default (added the same day --
// isDevRowIndependent()'s own `ctrl.perDevice` fallback) resolves to
// "mirrors Desktop" for every single control here -- an exact no-op,
// since all 3 devices already hold the identical shared value for all
// of them. That default exists specifically so this same helper stays
// safe to reuse later on a control that DOES already have `perDevice:
// true` (e.g. a future Camera-family control) without this comment
// needing revisiting.
function withDynamicDevice(controls) {
  const NO_CHECKBOX_TYPES = ['text', 'list-picker', 'multi-select', 'button']
  controls.forEach((c) => { if (!NO_CHECKBOX_TYPES.includes(c.type)) c.dynamicDevice = true })
  return controls
}
function makeClickHoldPoseGroup(p, title, defaults = {}) {
  return {
    title,
    controls: withDynamicDevice([
      // Direct user request ("provide a checkbox to turn that feature on
      // and off") -- gates startClickHoldPose(), same master on/off
      // pattern as Crop Wrist / Responsive Wrist Splay's own checkboxes.
      // "If Off, hide all settings for this function" (direct spec item,
      // corrected 2026-09-19 after re-reading the verbatim spec text --
      // this was previously unbuilt) -- see updateClickFunctionEnabledVisibility()'s
      // own comment.
      { key: `${p}Enabled`, label: `${title} (Master On/Off)`, type: 'checkbox', def: defaults.enabled ?? false, onChange: () => updateClickFunctionEnabledVisibility(p) },
      // Mode + the Tween Sequence select right below it, added 2026-09-15
      // (direct follow-up request, "implement it to all click functions
      // in the dev panel," porting Right Click's own Mode dropdown here)
      // -- see updateClickHoldPoseForHand()/startClickHoldPose()'s own
      // comments for how Tween mode shares this exact 2-phase forward/
      // retransition machine, just swapping what "forward" interpolates
      // toward. `updateClickTriggerModeVisibility()` hides the WHOLE
      // transition/retransition block below whenever Tween is selected
      // (direct correction: "the pose transition, hold, retransition UI
      // should only show when Single Pose is selected") -- Enabled, Mode,
      // and Hold Confirm Delay stay visible regardless of mode.
      {
        key: `${p}Mode`, label: 'Mode', type: 'select', def: 'Single Pose', options: () => ['Single Pose', 'Sequence'],
        onChange: () => { updateClickTriggerModeVisibility(p, [], ['LoopMode', 'OnReleaseMode', 'TriggerAllHands', 'TweenStopStartTimeCurveEnabled', 'TweenStopDelayEnabled']); updateLoopHoldVisibility(p); updateSingleTimingGateVisibility(p); updateTweenStopGateVisibility(p) }
      },
      // Offset/Rotation -- direct request 2026-09-17 ("Offset On and Off,
      // to set if the hand itself will be physically offset in the x and
      // y axes... This offset will occur with the tween" / "Rotation On
      // and Off... its rotation will be added ontop of the selected
      // tween's own rotation. they wont overwrite each other nor fight
      // against each other"). Both ramp from 0 at the tween/sequence's
      // own start to their full target value at its end (direct
      // confirmation: "Ramps like Rotation" for Offset too), reusing
      // whatever per-hand `progress` (0-1) the pose-application code
      // already computes each frame -- see applyOffsetRotationToHand()'s
      // own comment for the actual runtime math. World units for Offset
      // (this is a three.js world-space scene, not 2D CSS, per this
      // project's own CLAUDE.md -- matches Field Layout's own spacing
      // sliders' unit choice); degrees per axis for Rotation, composed
      // ON TOP of cursor-tracking's own wrapper rotation (added, never
      // replacing it) so it can never fight the tween's own posing.
      { key: `${p}OffsetEnabled`, label: 'Offset On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility(p) },
      { key: `${p}OffsetX`, label: 'Offset X (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: `${p}OffsetY`, label: 'Offset Y (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: `${p}RotationEnabled`, label: 'Rotation On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility(p) },
      { key: `${p}RotationX`, label: 'Rotation X (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}RotationY`, label: 'Rotation Y (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}RotationZ`, label: 'Rotation Z (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}TargetPose`, label: 'Target Pose', type: 'select', def: defaults.targetPose ?? '', options: () => (cfg.savedPoses || []).map((sp) => ({ value: sp.name, group: sp.group || null })) },
      { key: `${p}TweenSelector`, label: 'Sequence', type: 'select', def: '', options: () => (cfg.savedTweenSequences || []).map((s) => ({ value: s.name, group: s.group || null })) },
      // Tween's own SEPARATE speed/curve/range trio -- direct correction
      // ("tween speed is different from pose transition speed. For tween,
      // also provide a set of the curve graph, min max, pos transition
      // speed settings"): the Pose Transition trio below is Single-Pose-
      // only (hidden under Tween, see updateClickTriggerModeVisibility()),
      // so without this, Tween mode had no visible way to control its own
      // playback pace at all -- it was silently reusing whatever
      // TransitionSpeedMs/StartTimeCurve/StartTimeRange happened to be set
      // to, invisibly. These are genuinely separate cfg keys/values, not
      // an aliased view of the same 3 fields -- switching modes back and
      // forth no longer means the 2 paces fight over one shared setting.
      // Range/step/def match Double Click Hold Tween's own "Tween Speed
      // (Ms)" slider (min 50, max 5000), not the 0-700 Pose Transition
      // range -- a tween plays through MULTIPLE poses end to end, so it
      // routinely needs more time than a single-pose transition does.
      { key: `${p}TweenSpeedMs`, label: 'Animation Speed (Ms)', type: 'slider', min: 50, max: 5000, step: 10, def: 800 },
      { key: `${p}TweenStartTimeCurve`, label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}TweenStartTimeRange`, label: 'Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      // Loop Mode -- direct follow-up request ("Add a Loop checkbox to
      // chp/rchp only"), porting Double Click Hold Tween's own Loop
      // checkbox to the 2 OTHER hold-based groups (Click Pose/Double-
      // Click Pose/Right Click are fire-and-forget -- no "held" state for
      // a loop to run during, so they don't get this). CORRECTED, same
      // day, twice: (1) a plain boolean checkbox, then a direct follow-up
      // request for a 2nd cycling style ("provide a checkbox under loop
      // that is 'oscillate'... make it a dropdown") turned this into a
      // single 3-way select instead of 2 separate checkboxes; (2) briefly
      // made the cycle include the default pose, reverted the same day
      // ("no you're not meant to include the default pose... i guess we
      // had it correct previously") -- see startClickHoldPose()'s own
      // comment. 'Off' = the original non-looping behavior (hold at the
      // final pose once reached); 'Loop' = wrap forward through the named
      // poses only (poseN -> p1 -> p2 -> ... -> poseN, repeat -- see
      // lerpLoopSequence()'s own comment); 'Oscillate' = ping-pong back
      // and forth through the same named poses instead of wrapping,
      // reversing direction each lap. See updateClickHoldPoseForHand()'s
      // own 'looping' phase for how the 2 modes share one phase and how
      // the Hold Duration slider below splits each into discrete laps.
      { key: `${p}LoopMode`, label: 'Loop Mode', type: 'select', def: 'Off', options: () => ['Off', 'Loop', 'Oscillate'], onChange: () => updateLoopHoldVisibility(p) },
      // Hold Duration -- direct follow-up request ("provide a slider to
      // set a hold duration at the end of a single sequence. as in -
      // sequence, hold, repeat, hold etc, OR. sequence, hold, reverse
      // sequence, hold, etc"): pauses at the end of each lap (Loop:
      // after one full wrap; Oscillate: at each end, right before
      // reversing) before starting the next one. 0 (default) = no pause,
      // the original always-continuous cycling.
      { key: `${p}LoopHoldMs`, label: 'Loop Hold Duration (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 0 },
      // Direct user report, 2026-09-15: "right after te click, the closest
      // hand seems to start some sort of animation transition, but stops
      // after a split second, then the click-pose function runs smoothly."
      // Root cause: `startClickHoldPose()` fires on EVERY pointerdown,
      // unconditionally -- a plain quick click is indistinguishable from
      // the start of a genuine hold at press time, so the closest hand
      // (whose own distance-based Start Time delay can be as low as 0ms)
      // began visibly transitioning toward THIS group's own Target Pose
      // (a DIFFERENT pose than Click Pose's own target) on the very next
      // frame, then reversed the instant the real, brief click released --
      // all before Click Pose's own (correctly debounced) transition even
      // began. Fix: `updateClickHoldPoseForHand()` now refuses to leave
      // 'idle' until the hold has genuinely been sustained past this
      // delay, so a normal click's press-to-release window never gets far
      // enough to become visible at all. The camera-pan lock (the OTHER
      // thing `startClickHoldPose()` does) is untouched -- it still
      // engages immediately on pointerdown, per the direct request that
      // moving the cursor during a hold must never pan, even before the
      // hold is confirmed.
      //
      // CORRECTED 2026-09-15 -- default raised 150 -> 500 (max 500 -> 1000
      // for tuning headroom above that), direct follow-up report ("Double
      // click is still acting weird. I think its registering a single
      // click first, then when it realizes its double, it causes an
      // issue"). Root cause: this delay (was 150ms) and
      // `MOUSE_LOG_HELD_DRAG_MS` (500ms -- the SEPARATE threshold deciding
      // whether a release counts as a genuine hold, suppressing Click
      // Pose/Double-Click Pose's own trigger) were 2 different numbers
      // serving what should be the SAME purpose. Any press lasting between
      // 150-500ms -- a perfectly normal, not-especially-slow speed for a
      // double-click's own first tap -- crossed the 150ms "become visible"
      // threshold WITHOUT crossing the 500ms "count as a genuine hold"
      // threshold, so this group's own target pose visibly flashed on,
      // then reversed, entirely independent of whatever Click Pose/
      // Double-Click Pose went on to do afterward -- confirmed live via a
      // real simulated 200ms-press double-click (chp's own phase measured
      // entering 'forward' mid-press, well before either click resolved).
      // Matching this delay to `MOUSE_LOG_HELD_DRAG_MS` exactly closes the
      // gap: nothing can become visible without ALSO being long enough to
      // count as a genuine hold, eliminating the inconsistency rather than
      // just narrowing its window. Confirmed live: the same 200ms-press
      // double-click no longer moves chp's own phase out of 'idle' at all
      // with this delay raised to 500ms.
      { key: `${p}HoldConfirmMs`, label: 'Hold Confirm Delay (Ms)', type: 'slider', min: 0, max: 1000, step: 10, def: defaults.holdConfirmMs ?? 500 },
      { key: `${p}TransitionSpeedMs`, label: 'Animation Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.transitionSpeedMs ?? 400 },
      // Animation Speed Curve on/off -- direct spec item ("Animation
      // Speed Curve on/off [NEW]" under Single-Pose-mode settings), a
      // distance->speed curve exactly analogous to Start Time Curve
      // below but modulating the transition's own SPEED instead of its
      // START DELAY. Reuses the same generic computeStartDelayMs()
      // curve-eval function (it's already a generic curveParsed/
      // rangeParsed -> value-in-range mapper, nothing start-time-
      // specific about it) -- computed once per hand at commit time
      // (see updateClickHoldPoseForHand()'s own ARM/commit comment),
      // same "frozen at trigger time" philosophy as Responsive Wrist
      // Splay/the Start Time delay itself, not recomputed live mid-
      // transition. Range 50-2000ms is a disclosed judgment call (no
      // measured basis), matching the Tween trio's own min below.
      { key: `${p}SpeedCurveEnabled`, label: 'Animation Speed Curve On/Off', type: 'checkbox', def: false, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}SpeedCurve`, label: 'Animation Speed Curve (Distance -> Speed)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}SpeedCurveRange`, label: 'Min / Max Speed (Ms)', type: 'text', def: '{"min":50,"max":2000}', onChange: () => parseClickHoldConfig(p) },
      // Start Time Curve on/off -- direct spec item ("Start Time Curve
      // on/off [wraps existing]"). Off = no distance-based stagger at
      // all, every hand starts its forward transition immediately
      // (delay 0) -- same "wraps existing" gate pattern as Retransition
      // on/off below, not a new curve shape of its own.
      { key: `${p}StartTimeCurveEnabled`, label: 'Start Time Curve On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}StartTimeCurve`, label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.startTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}StartTimeRange`, label: 'Min / Max Start Time (Ms)', type: 'text', def: defaults.startTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      // Retransition on/off -- direct spec item ("Retransition on/off
      // [NEW behavioral gate]"). Off = the hand stays at its end pose
      // FOREVER, never retransitions back to default -- see
      // endClickHoldPose()'s own gate for the actual mechanism (skips
      // entering the 'retransition' phase entirely, leaving 'idle' so
      // nothing ever touches this hand/trigger pairing again). On =
      // the existing retransition machinery below, completely
      // unchanged. Scoped to Single Pose mode only, matching the
      // original spec's own grouping -- Sequence/Tween mode's own
      // release always retransitions, a disclosed scoping choice.
      { key: `${p}RetransitionEnabled`, label: 'Retransition On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}RetransitionSpeedMs`, label: 'Retransition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.retransitionSpeedMs ?? 400 },
      { key: `${p}RetransitionStartTimeCurve`, label: 'Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.retransitionStartTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}RetransitionStartTimeRange`, label: 'Retransition Min / Max Start Time (Ms)', type: 'text', def: defaults.retransitionStartTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      // Tween mode's own dedicated retransition trio -- direct request
      // ("for all click hold functions, when i select to tween a
      // sequence... on release of the click, i dont want the hands to
      // snap back to default position. Provide me 'Retransitioning'
      // settings just like the single poses"). Previously Tween mode's
      // release silently reused the Single-Pose trio immediately above,
      // even though that row is HIDDEN under Tween mode
      // (updateClickTriggerModeVisibility()) -- so Tween mode had no
      // visible/tunable release behavior of its own at all, the same gap
      // the Tween Start trio above was already added to close for the
      // FORWARD direction. Same range/step/default as the Tween Start
      // trio, not the 0-700 Pose Retransition range -- a tween's own
      // release can reasonably want more time than a single pose's.
      { key: `${p}TweenRetransitionSpeedMs`, label: 'Retransition Speed (Ms)', type: 'slider', min: 50, max: 5000, step: 10, def: 800 },
      { key: `${p}TweenRetransitionStartTimeCurve`, label: 'Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}TweenRetransitionStartTimeRange`, label: 'Retransition Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      // Sequence-mode release behavior -- direct spec item ("Sequence-
      // mode adds its own On Release Mode (Complete Sequence/Stop) with
      // Trigger All Hands"). Only meaningful for HOLD-based triggers
      // (chp/rchp/dcHold/tripleClickHold/quadClickHold) -- these are the
      // only ones with a genuine "release" event mid-tween; the fire-
      // and-forget family (click/dblclick/rc/tripleClick/quadClick) has
      // no hold to release, so this doesn't apply there.
      // 'Stop' (default) = CURRENT/existing behavior, unchanged: release
      // immediately begins retransition from wherever the hand is right
      // now, staggered per hand via the existing Retransition Start Time
      // Curve/Range above. 'Complete Sequence' = the hand keeps playing
      // (forward pass, or the CURRENT lap if already looping) instead of
      // stopping immediately on release -- see updateClickHoldPoseForHand()'s
      // own `chp.releasePending` handling in the forward/looping phases
      // for exactly where it checks in.
      { key: `${p}OnReleaseMode`, label: 'On Release Mode - Complete Sequence, Stop', type: 'select', def: 'Stop', options: () => ['Stop', 'Complete Sequence'] },
      // Trigger All Hands -- direct clarification (AskUserQuestion,
      // 2026-09-17): "force simultaneous release... ALL hands immediately
      // begin their stop/retransition together, overriding each hand's
      // own normal distance-based stagger delay." Off (default) = every
      // hand still staggers via the existing Retransition Start Time
      // Curve/Range, exactly as before this feature existed.
      { key: `${p}TriggerAllHands`, label: 'Trigger All Hands', type: 'checkbox', def: false },
      // Tween Stop (Sequence mode's own "Stop" release path) -- direct
      // spec item, corrected 2026-09-19 after re-reading the verbatim
      // spec text (an earlier pass wrongly deferred this as "likely
      // duplicates Retransition Start Time Curve" -- it's genuinely
      // different: on release, the sequence keeps PLAYING instead of
      // jumping to retransition, its own tween speed progressively
      // decaying to zero over Tween Stop Delay ("so the pose does not
      // abruptly stop but instead slows down to a stop... if the Tween
      // Stop Delay is 0, then the hands will just stop abruptly"). Off
      // by default (def: false) -- preserves this project's own
      // existing immediate-retransition 'Stop' behavior exactly, unless
      // explicitly turned on. See updateClickHoldPoseForHand()'s own
      // 'stopping' phase for the actual per-frame deceleration math, and
      // endClickHoldPose()'s own comment for how RetransitionEnabled now
      // ALSO governs Sequence mode's own post-decay behavior (a 2nd
      // verbatim-text correction -- "whether or not they retransition...
      // will depend on the settings i already described in Click mode,"
      // previously scoped to Single Pose only).
      { key: `${p}TweenStopStartTimeCurveEnabled`, label: 'Tween Stop Start Time Curve On/Off', type: 'checkbox', def: false, onChange: () => updateTweenStopGateVisibility(p) },
      { key: `${p}TweenStopStartTimeCurve`, label: 'Tween Stop Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}TweenStopStartTimeRange`, label: 'Tween Stop Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}TweenStopDelayEnabled`, label: 'Tween Stop Delay On/Off', type: 'checkbox', def: false, onChange: () => updateTweenStopGateVisibility(p) },
      { key: `${p}TweenStopDelayMs`, label: 'Tween Stop Delay (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 0 },
      { key: `${p}TweenStopDelayCurveEnabled`, label: 'Tween Stop Delay Curve On/Off', type: 'checkbox', def: false, onChange: () => updateTweenStopGateVisibility(p) },
      { key: `${p}TweenStopDelayCurve`, label: 'Tween Stop Delay Curve (Distance -> Delay)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}TweenStopDelayRange`, label: 'Tween Stop Min / Max Delay (Ms)', type: 'text', def: '{"min":0,"max":2000}', onChange: () => parseClickHoldConfig(p) }
    ])
  }
}
// Builds ONE Click Pose group's control array -- same shape as
// makeClickHoldPoseGroup() above (Enabled/TargetPose/TransitionSpeed/
// StartTimeCurve+Range/RetransitionSpeed/RetransitionStartTimeCurve+Range),
// plus ONE new control this fire-and-forget variant needs that
// hold-based Click-Hold-Pose never did: Pause Duration (Ms) -- how long
// a hand sits at the fully-reached target before its own retransition
// begins. A single flat value, not a curve+range pair like the transition
// timings -- the request's own "*D* pause duration*" was a single bare
// setting, and per-hand independence here already comes from the
// retransition's own existing distance-based stagger (below), not from
// staggering the pause length itself.
function makeClickPoseGroup(p, title, defaults = {}) {
  return {
    title,
    controls: withDynamicDevice([
      // "If Off, hide all settings for this function" -- see
      // makeClickHoldPoseGroup()'s own matching comment.
      { key: `${p}Enabled`, label: `${title} (Master On/Off)`, type: 'checkbox', def: defaults.enabled ?? false, onChange: () => updateClickFunctionEnabledVisibility(p) },
      // Mode + Tween Sequence -- added 2026-09-15, originally built only
      // for Right Click, then generalized here so Click Pose/Double-Click
      // Pose get it "the same as the others" (direct follow-up request).
      // See makeClickHoldPoseGroup()'s own matching comment for the full
      // reasoning (shared word-for-word, since both factories added this
      // the same way).
      {
        key: `${p}Mode`, label: 'Mode', type: 'select', def: 'Single Pose', options: () => ['Single Pose', 'Sequence'],
        onChange: () => { updateClickTriggerModeVisibility(p, ['PauseDurationMs']); updateSingleTimingGateVisibility(p); updateSequencePlayModeVisibility(p) }
      },
      // Offset/Rotation -- see makeClickHoldPoseGroup()'s own matching
      // comment for the full reasoning (shared word-for-word, both
      // factories added this the same way).
      { key: `${p}OffsetEnabled`, label: 'Offset On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility(p) },
      { key: `${p}OffsetX`, label: 'Offset X (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: `${p}OffsetY`, label: 'Offset Y (World Units)', type: 'slider', min: -50, max: 50, step: 0.5, def: 0 },
      { key: `${p}RotationEnabled`, label: 'Rotation On/Off', type: 'checkbox', def: false, onChange: () => updateOffsetRotationVisibility(p) },
      { key: `${p}RotationX`, label: 'Rotation X (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}RotationY`, label: 'Rotation Y (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}RotationZ`, label: 'Rotation Z (Deg)', type: 'slider', min: -360, max: 360, step: 1, def: 0 },
      { key: `${p}TargetPose`, label: 'Target Pose', type: 'select', def: defaults.targetPose ?? '', options: () => (cfg.savedPoses || []).map((sp) => ({ value: sp.name, group: sp.group || null })) },
      { key: `${p}TweenSelector`, label: 'Sequence', type: 'select', def: '', options: () => (cfg.savedTweenSequences || []).map((s) => ({ value: s.name, group: s.group || null })) },
      // Tween's own SEPARATE speed/curve/range trio -- see
      // makeClickHoldPoseGroup()'s own matching comment for the full
      // reasoning (shared word-for-word). No Loop checkbox here -- Click
      // Pose/Double-Click Pose/Right Click are fire-and-forget, not
      // hold-based, so there's no "held" state for a loop to run during
      // (direct clarification: Loop only ported to Click Hold-Pose/
      // Right-Click Hold-Pose).
      { key: `${p}TweenSpeedMs`, label: 'Animation Speed (Ms)', type: 'slider', min: 50, max: 5000, step: 10, def: 800 },
      { key: `${p}TweenStartTimeCurve`, label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}TweenStartTimeRange`, label: 'Min / Max Start Time (Ms)', type: 'text', def: '{"min":0,"max":300}', onChange: () => parseClickPoseConfig(p) },
      // Sequence Mode - Count/Loop/Oscillate -- direct follow-up request,
      // retrofitting the same "Sequence Mode - Count, Loop, Oscillate"
      // concept originally specced for the Loading Preview onto every
      // non-hold click function's own Sequence mode playback ("provide
      // me settings similar to above where a single click function will
      // provide the Sequence Mode - Count, Loop, Oscillate setting
      // availability. So a single click can trigger a sequence to run 3
      // times, then stop"). Click Hold-Pose/Right-Click Hold-Pose already
      // have their own LoopMode (Off/Loop/Oscillate, runs for as long as
      // the hold lasts) -- this is a SEPARATE, new mechanism for the
      // fire-and-forget family, bounded by a COUNT rather than a release
      // event (there is no "release" here to stop an infinite loop on).
      // 'Count' (default) is the fully-specified, primary validated case:
      // play `${p}SequenceCount` total one-way traversals, patterned by
      // `${p}SequenceCountMode` (Loop = every traversal repeats forward,
      // jumping back to the start between each per Loop Transition below;
      // Oscillate = ping-pong direction each traversal, no jump-back
      // needed), THEN fall through into the existing Pause/Retransition
      // flow unchanged -- exactly "run 3 times, then stop." 'Loop'/
      // 'Oscillate' at this TOP level (matching the spec's own literal 3
      // peer options) run the same pattern CONTINUOUSLY/unbounded instead
      // -- a disclosed simplification, since a fire-and-forget trigger
      // has no natural release event to stop an infinite loop on; it
      // keeps cycling until interrupted by a new trigger. Disclosed
      // simplification #2: the spec's own "a single run is 1 count, an
      // oscillate/loop pass is 2 counts" arithmetic isn't implemented
      // literally -- `${p}SequenceCount` here counts PHYSICAL one-way
      // traversals directly (the simplest reading that still satisfies
      // "run 3 times"), not a weighted count.
      { key: `${p}SequencePlayMode`, label: 'Sequence Mode - Count, Loop, Oscillate', type: 'select', def: 'Count', options: () => ['Count', 'Loop', 'Oscillate'], onChange: () => updateSequencePlayModeVisibility(p) },
      { key: `${p}SequenceCount`, label: 'Sequence Count', type: 'slider', min: 1, max: 50, step: 1, def: 3 },
      { key: `${p}SequenceCountMode`, label: 'Sequence Count Mode - Loop, Oscillate', type: 'select', def: 'Loop', options: () => ['Loop', 'Oscillate'], onChange: () => updateSequencePlayModeVisibility(p) },
      // Loop Transition On/Off -- direct spec wording ("Off = instant
      // jump back to frame 1, On = smooth tween back"). Only meaningful
      // for a Loop-style repeat (top-level Loop, or Count mode with
      // Sequence Count Mode = Loop) -- an Oscillate-style repeat reverses
      // in place and never needs to "jump back" anywhere.
      { key: `${p}SequenceLoopTransition`, label: 'Loop Transition On/Off', type: 'checkbox', def: true },
      // Hold Duration -- direct spec wording ("a Hold Duration slider for
      // the pause between loops/oscillations").
      { key: `${p}SequenceHoldMs`, label: 'Sequence Hold Duration (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: 0 },
      { key: `${p}TransitionSpeedMs`, label: 'Animation Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.transitionSpeedMs ?? 400 },
      // Animation Speed Curve / Start Time Curve / Retransition on-off
      // gates -- see makeClickHoldPoseGroup()'s own matching comments
      // for the full reasoning (shared word-for-word, both factories
      // added this the same way).
      { key: `${p}SpeedCurveEnabled`, label: 'Animation Speed Curve On/Off', type: 'checkbox', def: false, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}SpeedCurve`, label: 'Animation Speed Curve (Distance -> Speed)', type: 'text', def: '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}SpeedCurveRange`, label: 'Min / Max Speed (Ms)', type: 'text', def: '{"min":50,"max":2000}', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}StartTimeCurveEnabled`, label: 'Start Time Curve On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}StartTimeCurve`, label: 'Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.startTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}StartTimeRange`, label: 'Min / Max Start Time (Ms)', type: 'text', def: defaults.startTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}PauseDurationMs`, label: 'Pause Duration At Tween End (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: defaults.pauseDurationMs ?? 500 },
      { key: `${p}RetransitionEnabled`, label: 'Retransition On/Off', type: 'checkbox', def: true, onChange: () => updateSingleTimingGateVisibility(p) },
      { key: `${p}RetransitionSpeedMs`, label: 'Retransition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.retransitionSpeedMs ?? 400 },
      { key: `${p}RetransitionStartTimeCurve`, label: 'Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.retransitionStartTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}RetransitionStartTimeRange`, label: 'Retransition Min / Max Start Time (Ms)', type: 'text', def: defaults.retransitionStartTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickPoseConfig(p) }
    ])
  }
}
// Reads whichever Saved Poses row currently carries devPanel.js's own
// '.dp-list-picker-row-selected' class and returns its underlying item
// object -- devPanel.js stores this directly on the row element itself
// (`row.__item = item`, see renderListPickerItemRow()'s own selection-
// click handler) specifically so a host app doesn't need its own
// parallel "what's selected" tracking; reading it here rather than
// forking devPanel.js to add a getter.
function getSelectedSavedPoseItem() {
  const selectedRow = document.querySelector('.dp-row[data-key="savedPoses"] .dp-list-picker-row-selected')
  return selectedRow ? selectedRow.__item : null
}
// The "Default" button's own click handler (injected into the Saved
// Poses list-picker's own button row by buildPoseDefaultButton(), below)
// -- direct request: "sets the selected pose as the default pose. So
// its the pose on startup, as well as the pose that retransitions
// default back to." Applies the selected pose to every live slider +
// re-poses the field (syncValue()+onWholeHandRotationChange(), the same
// 2-step pattern the old code-default "Default" button used), updates
// `poseDefaultValues` live (so an in-progress or future Click-Hold-Pose
// retransition targets it immediately, no reload needed), and calls
// saveCurrentSettings() so the CURRENT live cfg -- which now includes
// this new default pose -- is what a fresh page load restores, making
// it genuinely "the pose on startup" per the request's own wording (no
// separate startup-specific persistence needed; this project's normal
// restore-from-localStorage mechanism already covers it once saved).
function setSelectedPoseAsDefault() {
  const item = getSelectedSavedPoseItem()
  if (!item) return
  POSE_PRESET_KEYS.forEach((key) => {
    const v = item[key] !== undefined ? item[key] : POSE_KEY_DEFAULTS[key]
    syncValue(key, v)
    poseDefaultValues[key] = v
  })
  onWholeHandRotationChange()
  saveCurrentSettings()
}
// Injects the "Default" button directly into the Saved Poses list-
// picker's own button row (next to Save/Overwrite/Use/Rename/Delete),
// per direct request ("the Default button should be next to the Save
// overwrite etc etc") -- devPanel.js's generic list-picker builder has
// no config hook for an extra button, and this project's own convention
// is not to fork that shared engine, so this is plain DOM injection
// (matching how Arm Length/Wrist Splay/Click-Hold-Pose's own custom
// widgets already find-and-augment an existing devPanel.js-built row)
// rather than a new devPanel.js capability. Placed right after "Use" --
// both act on the currently-selected item without renaming/removing it,
// unlike Rename/Delete further down the row.
function buildPoseDefaultButton() {
  const actionsRow = document.querySelector('.dp-row[data-key="savedPoses"] .dp-list-picker-actions')
  if (!actionsRow) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Default'
  btn.addEventListener('click', () => setSelectedPoseAsDefault())
  const useBtn = Array.from(actionsRow.querySelectorAll('button')).find((b) => b.textContent === 'Use')
  if (useBtn && useBtn.nextSibling) actionsRow.insertBefore(btn, useBtn.nextSibling)
  else actionsRow.appendChild(btn)
}
buildPoseDefaultButton()
// Camera's own Saved-Cameras/Default mechanism -- same shape as Pose's
// own above (capture/apply/getSelected/setAsDefault/inject-button), but
// applied directly to the live camera (no preview concept for Camera).
// `camera`/`controls` are declared later in the file (Camera group's own
// runtime setup) -- fine, since none of these functions actually RUN
// until a user interacts with the panel, well after full module init.
const CAMERA_PRESET_KEYS = ['cameraX', 'cameraY', 'cameraZ', 'cameraFov', 'cameraZoom']
const CAMERA_KEY_DEFAULTS = {}
DEV_GROUPS.find((g) => g.title === 'Camera').controls.forEach((c) => {
  if (CAMERA_PRESET_KEYS.includes(c.key)) CAMERA_KEY_DEFAULTS[c.key] = c.def
})
// The camera Max Extents (below) bounds against, and what a fresh page
// load's own Camera sliders already reflect -- seeded from cfg the same
// way poseDefaultValues is. `targetX/Y/Z` default to (0,0,0), matching
// `controls.target`'s own initial value (set once, below, before any
// panning has ever occurred) -- correct for a fresh load; overwritten by
// setSelectedCameraAsDefault() the moment the user actually sets one.
let cameraDefaultValues = {}
CAMERA_PRESET_KEYS.forEach((key) => { cameraDefaultValues[key] = cfg[key] !== undefined ? cfg[key] : CAMERA_KEY_DEFAULTS[key] })
cameraDefaultValues.targetX = 0
cameraDefaultValues.targetY = 0
cameraDefaultValues.targetZ = 0
// Captures the pan TARGET too (not just the 5 slider-driven fields) --
// needed to fully reproduce this exact view on "Use"/Default/Max-Extents-
// snap (a saved camera with only position+FOV+zoom, applied via the same
// delta-preserving math the position sliders use, would inherit whatever
// pan offset happens to already be live rather than the view actually
// captured).
function captureCameraPreset() {
  const item = {}
  CAMERA_PRESET_KEYS.forEach((key) => { item[key] = cfg[key] })
  item.targetX = controls.target.x
  item.targetY = controls.target.y
  item.targetZ = controls.target.z
  return item
}
// Direct bug report, 2026-09-17: a camera preset authored/imported using
// a shorter x/y/z/tx/ty/tz/fov naming (the user's own external format)
// silently fell back to EVERY default value on "Use" -- every read site
// below only ever looked for this app's own internal names (cameraX/
// cameraY/cameraZ/targetX/targetY/targetZ/cameraFov, exactly what
// captureCameraPreset() itself produces), so a short-name item matched
// nothing and looked completely broken (always snapping to the same
// default view regardless of which preset was selected). Accepts EITHER
// naming -- the internal one always wins when both happen to be present
// -- and returns a NEW object in the internal shape, never mutating the
// original saved/imported item (so a later re-export/re-save isn't
// silently reformatted underneath the user). `name`/`group` pass through
// unchanged via the spread. Lighting's own equivalent (LIGHTING_PRESET_KEYS)
// needed no such fix -- the user's own lighting JSON already used this
// app's exact internal field names.
function normalizeCameraPresetItem(item) {
  return {
    ...item,
    cameraX: item.cameraX !== undefined ? item.cameraX : item.x,
    cameraY: item.cameraY !== undefined ? item.cameraY : item.y,
    cameraZ: item.cameraZ !== undefined ? item.cameraZ : item.z,
    cameraFov: item.cameraFov !== undefined ? item.cameraFov : item.fov,
    targetX: item.targetX !== undefined ? item.targetX : item.tx,
    targetY: item.targetY !== undefined ? item.targetY : item.ty,
    targetZ: item.targetZ !== undefined ? item.targetZ : item.tz
  }
}
// Applies a camera preset (a Saved Camera item OR cameraDefaultValues
// itself, both the same shape) directly to the live camera + pan target,
// then syncs the panel's own sliders to match -- deliberately sets
// camera.position/controls.target directly rather than going through
// applyCameraControl()'s own delta-preserving math, so this is fully
// deterministic regardless of whatever view was live beforehand.
function applyCameraPreset(rawItem) {
  const item = normalizeCameraPresetItem(rawItem)
  const targetX = item.targetX !== undefined ? item.targetX : 0
  const targetY = item.targetY !== undefined ? item.targetY : 0
  const targetZ = item.targetZ !== undefined ? item.targetZ : 0
  controls.target.set(targetX, targetY, targetZ)
  camera.position.set(
    item.cameraX !== undefined ? item.cameraX : CAMERA_KEY_DEFAULTS.cameraX,
    item.cameraY !== undefined ? item.cameraY : CAMERA_KEY_DEFAULTS.cameraY,
    item.cameraZ !== undefined ? item.cameraZ : CAMERA_KEY_DEFAULTS.cameraZ
  )
  camera.fov = item.cameraFov !== undefined ? item.cameraFov : CAMERA_KEY_DEFAULTS.cameraFov
  camera.updateProjectionMatrix()
  controls.update()
  syncValue('cameraX', camera.position.x)
  syncValue('cameraY', camera.position.y)
  syncValue('cameraZ', camera.position.z)
  syncValue('cameraFov', camera.fov)
  syncValue('cameraZoom', camera.position.distanceTo(controls.target))
}
function getSelectedSavedCameraItem() {
  const selectedRow = document.querySelector('.dp-row[data-key="savedCameras"] .dp-list-picker-row-selected')
  return selectedRow ? selectedRow.__item : null
}
function setSelectedCameraAsDefault() {
  const rawItem = getSelectedSavedCameraItem()
  if (!rawItem) return
  applyCameraPreset(rawItem)
  // Normalized independently here too -- applyCameraPreset() above
  // normalizes its OWN internal copy, but never exposes it, and this
  // function's own direct item[key]/item.targetX reads below need the
  // same short-name fallback to correctly seed cameraDefaultValues.
  const item = normalizeCameraPresetItem(rawItem)
  CAMERA_PRESET_KEYS.forEach((key) => { cameraDefaultValues[key] = item[key] !== undefined ? item[key] : CAMERA_KEY_DEFAULTS[key] })
  cameraDefaultValues.targetX = item.targetX !== undefined ? item.targetX : 0
  cameraDefaultValues.targetY = item.targetY !== undefined ? item.targetY : 0
  cameraDefaultValues.targetZ = item.targetZ !== undefined ? item.targetZ : 0
  updateCameraMaxExtentsBound()
  saveCurrentSettings()
}
// Max Extents (direct request, refined over several corrections in the
// same message thread down to this exact model): a standard bounding
// clamp using Default Camera's own zoom distance as the ONE shared
// "extent radius" -- free movement INWARD (zoom in, pan back toward the
// default's own target) always stays completely free; only the OUTWARD
// direction (zoom out past the default's distance, pan away from the
// default's own target past that same radius) hits a hard wall. "hits a
// wall" specifically means a CLAMP, not a snap/reset -- confirmed
// directly ("I dont get snapped back. that only applies to zoom" was
// itself later corrected to "the max i can zoom out is the extents", a
// cap, not a teleport-to-default).
//
// Zoom's own cap is handled by OrbitControls' own native `maxDistance`
// property -- no custom code needed, it already enforces "can zoom in
// freely, capped zooming out" on every drag/scroll/pinch internally.
// Pan has no native OrbitControls equivalent (there's no built-in
// "bound controls.target to a sphere" option), so panning's own cap is
// enforced by hand, once per frame (see enforceCameraPanExtent(), called
// from animate()) -- reusing the exact same radius so both axes are
// bounded by the one single "Default Camera" concept the user asked for,
// not 2 separately-tuned numbers.
function updateCameraMaxExtentsBound() {
  controls.maxDistance = cfg.cameraMaxExtentsEnabled ? cameraDefaultValues.cameraZoom : Infinity
}
// Composes the new Lock Camera Pan/Zoom checkboxes with the EXISTING
// Click-Hold-Pose pan-disable (startClickHoldPose()/endClickHoldPose(),
// below) -- a hold must always disable pan regardless of the lock
// setting (unchanged), but RESTORING pan once a hold ends must now also
// respect a genuine permanent lock rather than unconditionally
// re-enabling it. `clickHoldPoseTriggers` is declared later in the file
// (Click-Hold-Pose section) -- safe, since this function only ever RUNS
// at runtime (checkbox onChange, or endClickHoldPose()'s own call),
// never during module init.
function applyCameraLockState() {
  const anyHoldActive = clickHoldPoseTriggers.chp.active || clickHoldPoseTriggers.rchp.active
  controls.enablePan = !cfg.lockCameraPan && !anyHoldActive
  controls.enableZoom = !cfg.lockCameraZoom
}
const _cameraExtentTargetScratch = new THREE.Vector3()
const _cameraExtentOffsetScratch = new THREE.Vector3()
function enforceCameraPanExtent() {
  if (!cfg.cameraMaxExtentsEnabled) return
  _cameraExtentTargetScratch.set(cameraDefaultValues.targetX, cameraDefaultValues.targetY, cameraDefaultValues.targetZ)
  _cameraExtentOffsetScratch.copy(controls.target).sub(_cameraExtentTargetScratch)
  const panDistance = _cameraExtentOffsetScratch.length()
  const maxPanDistance = cameraDefaultValues.cameraZoom
  if (panDistance <= maxPanDistance) return
  // Clamp controls.target back onto the boundary sphere's surface, and
  // shift camera.position by the SAME delta so the current zoom distance
  // is preserved -- panning "into the wall" stops advancing further
  // rather than the pan target alone snapping while the camera itself
  // stays disconnected from it.
  _cameraExtentOffsetScratch.multiplyScalar(maxPanDistance / panDistance)
  const clampedTarget = _cameraExtentTargetScratch.clone().add(_cameraExtentOffsetScratch)
  const delta = clampedTarget.clone().sub(controls.target)
  controls.target.copy(clampedTarget)
  camera.position.add(delta)
  controls.update()
}
function buildCameraDefaultButton() {
  const actionsRow = document.querySelector('.dp-row[data-key="savedCameras"] .dp-list-picker-actions')
  if (!actionsRow) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Default'
  btn.addEventListener('click', () => setSelectedCameraAsDefault())
  const useBtn = Array.from(actionsRow.querySelectorAll('button')).find((b) => b.textContent === 'Use')
  if (useBtn && useBtn.nextSibling) actionsRow.insertBefore(btn, useBtn.nextSibling)
  else actionsRow.appendChild(btn)
}
buildCameraDefaultButton()
// Lighting's own Saved-Lighting mechanism -- same shape as Camera's own
// above (capture/apply directly to the live scene, no preview concept),
// minus a "Default" button: unlike Pose's poseDefaultValues (what a
// retransition falls back to) or Camera's cameraDefaultValues (what Max
// Extents bounds against), no other system in this project reads a
// tracked "lighting default" -- a saved lighting preset only ever needs
// Save/Use/Rename/Delete, all already provided by the generic list-picker
// control itself, so there's nothing extra to inject here.
const LIGHTING_PRESET_KEYS = ['keyAzimuth', 'keyElevation', 'keyTargetHeight', 'keyIntensity', 'keyColor', 'ambientIntensity', 'ambientSkyColor', 'ambientGroundColor']
const LIGHTING_KEY_DEFAULTS = {}
DEV_GROUPS.find((g) => g.title === 'Lighting').controls.forEach((c) => {
  if (LIGHTING_PRESET_KEYS.includes(c.key)) LIGHTING_KEY_DEFAULTS[c.key] = c.def
})
function captureLightingPreset() {
  const item = {}
  LIGHTING_PRESET_KEYS.forEach((key) => { item[key] = cfg[key] })
  return item
}
// Applies a lighting preset (a Saved Lighting item OR any pose-shaped
// fallback) directly to the live keyLight/hemiLight, writing through to
// cfg first so updateKeyLightPosition() (which reads cfg live, not a
// passed value) picks up the new azimuth/elevation/aim-height -- then
// syncs the panel's own sliders/color-pickers to match, same reasoning
// as applyCameraPreset()'s own final syncValue() calls.
function applyLightingPreset(item) {
  LIGHTING_PRESET_KEYS.forEach((key) => {
    const value = item[key] !== undefined ? item[key] : LIGHTING_KEY_DEFAULTS[key]
    cfg[key] = value
    syncValue(key, value)
  })
  updateKeyLightPosition()
  keyLight.intensity = cfg.keyIntensity
  keyLight.color.set(cfg.keyColor)
  hemiLight.intensity = cfg.ambientIntensity
  hemiLight.color.set(cfg.ambientSkyColor)
  hemiLight.groundColor.set(cfg.ambientGroundColor)
}
// Sets the initial maxDistance bound on page load -- restored-from-
// localStorage `cameraMaxExtentsEnabled: true` doesn't fire its own
// onChange during initDevPanel() (see this project's own established
// TDZ/reattach-after-init pattern), so this needs one explicit call here.
updateCameraMaxExtentsBound()
// TEMPORARY diagnostic tool (direct request context: repeated user
// reports of a thumb mismatch this session could never reproduce with
// approximated test data -- every synthetic pose tested came back at
// exactly 0.0 degrees of error). Rather than asking the user to keep
// transcribing their own real slider values by hand, this runs the
// EXACT SAME "Default path" vs. "transition path" comparison directly
// on whichever Saved Pose is currently selected, using the user's own
// REAL data, and reports the result via alert() so no DevTools/console
// access is needed. "Default path": temporarily pushes the pose's own
// values into cfg and calls onWholeHandRotationChange() (the same
// re-pose call setSelectedPoseAsDefault() uses), then restores cfg
// exactly as it was. "Transition path": calls applyPoseValuesToHand()
// directly (the same function every Click-Hold-Pose/Click-Pose
// transition uses at progress=1) with the SAME merged values. If this
// reports 0 degrees for the user's own real pose, the posing math is
// confirmed correct even for their exact data, and whatever they're
// seeing is something else entireIy (a different hand, a rendering
// issue, etc.) -- not a code path this project's own posing pipeline
// controls. Checks all 5 finger base joints, not just the thumb, so a
// mismatch anywhere is caught, not just where this session happened to
// keep looking. Should be removed once the underlying mystery is
// actually resolved -- this is a debugging aid, not a real feature.
function diagnosePoseThumbMismatch() {
  const item = getSelectedSavedPoseItem()
  if (!item) { alert('Select a saved pose in the list first, then click Diagnose again.'); return }
  const hand = hands[0]
  if (!hand || !hand.skinnedMesh) { alert('No hand available to diagnose yet -- try again once the field has loaded.'); return }

  const mergedValues = {}
  POSE_PRESET_KEYS.forEach((key) => { mergedValues[key] = item[key] !== undefined ? item[key] : POSE_KEY_DEFAULTS[key] })

  const savedCfgSnapshot = {}
  POSE_PRESET_KEYS.forEach((key) => { savedCfgSnapshot[key] = cfg[key] })
  POSE_PRESET_KEYS.forEach((key) => { cfg[key] = mergedValues[key] })
  onWholeHandRotationChange()
  const boneQuatsViaDefault = {}
  FINGER_NAMES.forEach((name) => { boneQuatsViaDefault[name] = hand.skinnedMesh.skeleton.getBoneByName(FINGER_JOINTS[name][0]).quaternion.clone() })

  applyPoseValuesToHand(hand, mergedValues, 0)
  const boneQuatsViaTransition = {}
  FINGER_NAMES.forEach((name) => { boneQuatsViaTransition[name] = hand.skinnedMesh.skeleton.getBoneByName(FINGER_JOINTS[name][0]).quaternion.clone() })

  POSE_PRESET_KEYS.forEach((key) => { cfg[key] = savedCfgSnapshot[key] })
  onWholeHandRotationChange()

  const lines = [`Pose "${item.name}" -- Default path vs. Transition path (base joint of each finger):`]
  FINGER_NAMES.forEach((name) => {
    const a = boneQuatsViaDefault[name], b = boneQuatsViaTransition[name]
    const d = a.clone().invert().multiply(b)
    const deg = THREE.MathUtils.radToDeg(2 * Math.atan2(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z), Math.abs(d.w)))
    lines.push(`  ${name}: ${deg.toFixed(2)} degrees`)
  })
  alert(lines.join('\n'))
}
function buildDiagnosePoseButton() {
  const actionsRow = document.querySelector('.dp-row[data-key="savedPoses"] .dp-list-picker-actions')
  if (!actionsRow) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Diagnose'
  btn.addEventListener('click', () => diagnosePoseThumbMismatch())
  actionsRow.appendChild(btn)
}
buildDiagnosePoseButton()

// -----------------------------------------------------------------------
// Loading Preview -- a 3rd, independent hand instance (alongside the main
// field and Pose Preview's own) shown inside `#loading` while the field
// itself is still building. Can't just reuse Pose Preview's scene/camera/
// hand: Pose Preview is lazily built on its own opt-in checkbox and isn't
// guaranteed to exist this early, and this preview specifically needs to
// exist and start animating the INSTANT the base model finishes loading
// (buildLoadingPreview() is called from the GLTFLoader callback itself,
// before tryStartField()'s own settings-restore gate has necessarily
// resolved) -- see this project's own README... no, see `tryStartField()`'s
// own comment for the full startup-race context this sits inside.
// -----------------------------------------------------------------------
let loadingPreviewHand = null // { clone, skinnedMesh }
let loadingPreviewRenderer = null
let loadingPreviewScene = null
let loadingPreviewCamera = null
let loadingPreviewCanvas = null
let loadingPreviewAnimStartMs = 0
const loadingPreviewBaseQuat = new THREE.Quaternion()
// CORRECTED 2026-09-19 -- the Loading Preview's own camera DOES have
// interactive OrbitControls now (loadingPreviewCameraEditMode, below),
// but this tracker is still needed: it's the single source of truth
// this file's own code reads/writes directly (applyLoadingPreviewCameraPreset()/
// applyLoadingPreviewCameraAutoFrame()/applyLoadingPreviewOrbitFromSliders()),
// kept in sync WITH `loadingPreviewOrbitControls.target` (not replaced by
// it) so captureLoadingPreviewCameraPreset() and the orbit-derived
// sliders always have a real value even before OrbitControls has been
// built for the very first time.
const loadingPreviewCameraTarget = new THREE.Vector3()
// See loadingPreviewSavedLighting's own DEV_GROUPS comment -- module-level
// so its list-picker's "Use" button can live-apply a saved lighting item
// without needing a full buildLoadingPreview() rebuild.
let loadingPreviewKeyLightRef = null
let loadingPreviewHemiLightRef = null
// See loadingPreviewCameraEditMode's own DEV_GROUPS comment -- the
// Loading Preview's own interactive orbit/pan/zoom camera, built once
// per buildLoadingPreview() call (setupLoadingPreviewOrbitControls()),
// enabled/disabled live by the Edit Mode checkbox without needing a
// rebuild.
let loadingPreviewOrbitControls = null
const _loadingPreviewSpherical = new THREE.Spherical()
// Sequence Mode (Count/Loop/Oscillate) state -- module-level, not per-
// hand, since there's exactly ONE loading-preview instance. Reset in
// buildLoadingPreview() (see its own call site below).
let loadingPreviewLapIndex = 1
let loadingPreviewLapStartMs = 0
let loadingPreviewHoldEndMs = 0
let loadingPreviewDirection = 1
let loadingPreviewSequenceDone = false
// Called once, from the GLTFLoader callback, right after modelRoot/
// alignQuat/toonMaterial/handBoundsCenterLocal/handBoundsRadiusLocal are
// all measured -- same one-time-measurement dependencies buildPosePreview()
// has, just reached earlier in the startup sequence. Gated on
// `loadingPreviewEnabled` so a session with it off skips this entirely
// (cfg already holds at least its own def by now, seeded synchronously
// well before this async callback ever fires -- see initDevPanel()'s own
// documented seed-then-async-restore behavior).
// `bypassEnabledGate` (2026-09-17, direct request) -- lets the new
// "Show Loading Preview (Live)" checkbox build/show this on demand even
// when `loadingPreviewEnabled` (the SEPARATE "show it during the real
// startup screen" toggle) is off; the original call site below (the
// GLTFLoader callback) is unchanged, still gated normally.
function buildLoadingPreview(bypassEnabledGate) {
  if (!bypassEnabledGate && !cfg.loadingPreviewEnabled) return
  loadingPreviewCanvas = document.getElementById('loadingPreviewCanvas')
  if (!loadingPreviewCanvas) return
  // Disposes any previously-built renderer/GL context before creating a
  // new one -- required now that this function can genuinely run more
  // than once per session (the live-preview toggle can rebuild it
  // repeatedly); a 2nd WebGLRenderer bound to the SAME canvas without
  // disposing the first would otherwise leak a GL context on every
  // toggle.
  if (loadingPreviewRenderer) { loadingPreviewRenderer.dispose(); loadingPreviewRenderer = null }
  loadingPreviewCanvas.style.display = 'block'
  loadingPreviewScene = new THREE.Scene()
  loadingPreviewCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000)
  loadingPreviewRenderer = new THREE.WebGLRenderer({ canvas: loadingPreviewCanvas, antialias: true, alpha: true })
  loadingPreviewRenderer.outputColorSpace = THREE.SRGBColorSpace
  loadingPreviewRenderer.setClearColor(0x000000, 0)

  // Clones of the main scene's own already-tuned lights -- same reasoning
  // as buildPosePreview()'s own identical comment (a from-scratch light
  // produced a flat, washed-out silhouette with no visible toon-shading
  // steps). A selected Lighting preset (direct follow-up request) then
  // overrides these cloned starting values -- see
  // applyLoadingPreviewLighting()'s own comment.
  //
  // CORRECTED 2026-09-19 (own local `loadingPreviewSavedLighting` list,
  // same reasoning as the camera split above): stored at module level
  // (loadingPreviewKeyLightRef/loadingPreviewHemiLightRef) so the new
  // list-picker's own "Use" button (a live preview independent of a full
  // rebuild) can reach these lights without needing buildLoadingPreview()
  // to run again.
  const key = keyLight.clone()
  key.target = keyLight.target.clone()
  const hemi = hemiLight.clone()
  loadingPreviewScene.add(key, key.target, hemi)
  loadingPreviewKeyLightRef = key
  loadingPreviewHemiLightRef = hemi
  const lightingPreset = (cfg.loadingPreviewSavedLighting || []).find((l) => l.name === cfg.loadingPreviewLightingSelector)
  if (lightingPreset) applyLoadingPreviewLighting(key, hemi, lightingPreset)

  const clone = cloneSkeletal(modelRoot)
  clone.quaternion.copy(alignQuat)
  const skinnedMesh = findSkinnedMesh(clone)
  if (skinnedMesh && toonMaterial) skinnedMesh.material = toonMaterial
  loadingPreviewScene.add(clone)
  loadingPreviewHand = { clone, skinnedMesh }

  // A selected Camera preset (direct follow-up request) overrides the
  // existing auto-framed default, applied to this preview's own SEPARATE
  // camera object (not the main scene's), same reasoning as the lighting
  // override above. Empty selection keeps the existing auto-framed
  // behavior exactly as it was.
  //
  // CORRECTED 2026-09-19, direct report ("I dont see the loading preview
  // even if its turned on" -> "the camera settings for the loading
  // preview should be local to that only"): this used to read from
  // `cfg.savedCameras` -- the SAME shared list the MAIN multi-hand
  // field's own Camera group uses for ITS saved views, which are tuned
  // for viewing the whole field from far away (this project's own
  // default main camera sits at cameraZ ~260 world units out). Applying
  // one of those to this preview's single, close-up hand (auto-framed at
  // only `handBoundsRadiusLocal * 2.4` away, typically single digits)
  // shrank the hand down to an invisible speck -- the preview WAS
  // rendering, just nothing recognizable was in frame. Now reads its own
  // separate, local `cfg.loadingPreviewSavedCameras` list instead (see
  // that control's own comment) so importing/saving a close-up-scaled
  // camera (e.g. from HANDO) can never collide with the field's own
  // far-away views.
  const rawCameraPreset = (cfg.loadingPreviewSavedCameras || []).find((c) => c.name === cfg.loadingPreviewCameraSelector)
  if (rawCameraPreset) applyLoadingPreviewCameraPreset(rawCameraPreset)
  else applyLoadingPreviewCameraAutoFrame()

  applyLoadingPreviewPose(poseDefaultValues)
  loadingPreviewAnimStartMs = performance.now()
  // Sequence Mode state -- fresh for every build (a page-load-lifetime
  // instance, but reset defensively rather than assuming this only ever
  // runs once).
  loadingPreviewLapIndex = 1
  loadingPreviewLapStartMs = loadingPreviewAnimStartMs
  loadingPreviewHoldEndMs = 0
  loadingPreviewDirection = 1
  loadingPreviewSequenceDone = false
  resizeLoadingPreview()
  repositionLoadingPreview()
  setupLoadingPreviewOrbitControls()
}
// Applies one saved item from the Loading Preview's own local
// `loadingPreviewSavedCameras` list directly to `loadingPreviewCamera` --
// the preview's equivalent of the main scene's `applyCameraPreset()`.
// normalizeCameraPresetItem() (shared with the main camera's own preset
// handling) accepts either this app's internal cameraX/targetX/etc.
// naming or a shorter x/y/z/tx/ty/tz/fov naming, so a preset imported/
// pasted straight from HANDO's own export format works without hand-
// renaming every field first. Also re-syncs the orbit camera (target +
// the 5 read-back sliders) so this remains the actual source of truth
// after any live orbiting -- see loadingPreviewCameraEditMode's own
// DEV_GROUPS comment for the full "dropdown wins on every rebuild"
// contract.
function applyLoadingPreviewCameraPreset(rawItem) {
  if (!loadingPreviewCamera) return
  const item = normalizeCameraPresetItem(rawItem)
  loadingPreviewCamera.position.set(
    item.cameraX ?? CAMERA_KEY_DEFAULTS.cameraX,
    item.cameraY ?? CAMERA_KEY_DEFAULTS.cameraY,
    item.cameraZ ?? CAMERA_KEY_DEFAULTS.cameraZ
  )
  loadingPreviewCamera.fov = item.cameraFov ?? CAMERA_KEY_DEFAULTS.cameraFov
  loadingPreviewCamera.updateProjectionMatrix()
  const tx = item.targetX ?? 0
  const ty = item.targetY ?? 0
  const tz = item.targetZ ?? 0
  loadingPreviewCamera.lookAt(tx, ty, tz)
  loadingPreviewCameraTarget.set(tx, ty, tz)
  syncLoadingPreviewOrbitControlsTarget()
  deriveLoadingPreviewOrbitSliders()
}
// The pre-existing auto-framed default (unchanged math, just pulled out
// of buildLoadingPreview() into its own function so both the "no preset
// selected" build-time path and a future reset-to-default action can
// call it identically) -- frames the hand using its own LOCAL bounds
// (handBoundsCenterLocal/handBoundsRadiusLocal), correctly scaled for a
// single close-up hand regardless of the main field's own camera scale.
function applyLoadingPreviewCameraAutoFrame() {
  if (!loadingPreviewCamera) return
  const target = handBoundsCenterLocal.clone().applyQuaternion(alignQuat)
  // CORRECTED 2026-09-19, direct report ("why is the loading preview
  // cropped? it shouldnt be"). A real, measured math bug: for the hand's
  // own bounding sphere (radius R) to fully fit inside a camera's FOV at
  // distance D, D must be >= R / sin(FOV/2) -- at this camera's FOV (35
  // deg, so half-FOV 17.5 deg) that's D >= R * 3.326. The old `R * 2.4`
  // distance put the camera almost 40% too close: the sphere's own
  // subtended half-angle at that distance was ~24.6 deg, well past the
  // 17.5 deg half-FOV, guaranteed to clip the hand's outer edges
  // (fingertips/forearm) regardless of framing offset. 3.6 gives ~8%
  // margin over the exact 3.326 minimum. Pose Preview's own
  // defaultPosePreviewCamera() had this identical formula/bug -- fixed
  // together, same root cause.
  const pos = target.clone().add(new THREE.Vector3(0, handBoundsRadiusLocal * 0.15, handBoundsRadiusLocal * 3.6))
  loadingPreviewCamera.position.copy(pos)
  loadingPreviewCamera.lookAt(target)
  loadingPreviewCameraTarget.copy(target)
  syncLoadingPreviewOrbitControlsTarget()
  deriveLoadingPreviewOrbitSliders()
}
// -----------------------------------------------------------------------
// Loading Preview Camera Edit Mode -- interactive orbit/pan/zoom (direct
// request 2026-09-19). Orbit ORIGIN is always the hand's own center
// (`loadingPreviewOrbitOrigin()`, the SAME point the auto-frame already
// targets), matching HANDO's own orbit-around-hand-center convention
// (direct request: "In Hando, when i Click and Drag to orbit, it orbits
// around the center of the hand... Do the same for our loading preview").
// -----------------------------------------------------------------------
// Hand-center orbit origin, in world space -- identical to the point
// applyLoadingPreviewCameraAutoFrame() already targets. A plain function
// (not cached) since handBoundsCenterLocal/alignQuat are each only ever
// measured once at model load and never change afterward -- cheap to
// recompute on demand, no staleness risk either way.
function loadingPreviewOrbitOrigin() {
  return handBoundsCenterLocal.clone().applyQuaternion(alignQuat)
}
// Built once per buildLoadingPreview() call (mirrors buildPosePreview()'s
// own previewControls setup) -- OrbitControls' own STOCK default mouse
// mapping is already exactly what was asked for (LEFT: ROTATE, RIGHT:
// PAN, wheel: DOLLY/zoom), unlike the main scene's own `controls` (which
// deliberately disables rotate for its fixed-facing field), so no custom
// `mouseButtons` override is needed here. Starts disabled -- the Edit
// Mode checkbox's own onChange is what actually turns it on.
function setupLoadingPreviewOrbitControls() {
  if (!loadingPreviewCamera || !loadingPreviewCanvas) return
  if (loadingPreviewOrbitControls) { loadingPreviewOrbitControls.dispose(); loadingPreviewOrbitControls = null }
  loadingPreviewOrbitControls = new OrbitControls(loadingPreviewCamera, loadingPreviewCanvas)
  loadingPreviewOrbitControls.target.copy(loadingPreviewCameraTarget)
  loadingPreviewOrbitControls.update()
  loadingPreviewOrbitControls.enabled = !!cfg.loadingPreviewCameraEditMode
  // A fresh build's own getElementById() re-fetches the SAME persistent
  // DOM element, not a new one -- its inline pointer-events style
  // normally already matches, but set it explicitly here too so a
  // rebuild can never leave it stuck on the wrong value regardless of
  // whatever else touched it in between.
  loadingPreviewCanvas.style.pointerEvents = cfg.loadingPreviewCameraEditMode ? 'auto' : 'none'
}
// Keeps the orbit controls' own target in sync whenever the camera is
// repositioned some OTHER way (a saved preset, auto-frame) -- otherwise
// the NEXT orbit-drag would suddenly re-center on a stale target and the
// camera would visibly jump.
function syncLoadingPreviewOrbitControlsTarget() {
  if (!loadingPreviewOrbitControls) return
  loadingPreviewOrbitControls.target.copy(loadingPreviewCameraTarget)
  loadingPreviewOrbitControls.update()
}
// Reads the 5 sliders (elevation/azimuth/roll/pan-X/pan-Y) and positions
// the camera to match -- the FORWARD direction (sliders -> camera),
// wired as each slider's own onChange so they stay usable with Edit Mode
// off, same click-to-type convention every other slider in this panel
// has. Distance is deliberately NOT one of the 5 sliders (not asked
// for) -- preserved from whatever it currently is (live scroll-zoom, a
// loaded preset, or the auto-frame default) rather than reset every
// time one slider changes.
function applyLoadingPreviewOrbitFromSliders() {
  if (!loadingPreviewCamera) return
  const origin = loadingPreviewOrbitOrigin()
  const target = origin.clone().add(new THREE.Vector3(cfg.loadingPreviewOffsetX || 0, cfg.loadingPreviewOffsetY || 0, 0))
  const priorDistance = loadingPreviewCamera.position.distanceTo(loadingPreviewCameraTarget)
  const distance = priorDistance > 1e-6 ? priorDistance : handBoundsRadiusLocal * 3.6 // matches applyLoadingPreviewCameraAutoFrame()'s own corrected distance
  const phi = THREE.MathUtils.degToRad((cfg.loadingPreviewRotationX || 0) + 90) // elevation-from-horizon -> THREE.Spherical's own polar-from-+Y
  const theta = THREE.MathUtils.degToRad(cfg.loadingPreviewRotationY || 0)
  const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, phi, theta))
  loadingPreviewCamera.position.copy(target).add(offset)
  applyLoadingPreviewRoll(target)
  loadingPreviewCameraTarget.copy(target)
  syncLoadingPreviewOrbitControlsTarget()
}
// Camera roll (Rotation Z) -- no native OrbitControls mouse gesture
// drives this (there's no standard "roll" drag binding), but it's still
// a real, settable slider like every other one in this panel. Rotating
// `camera.up` around the current view direction, THEN re-calling
// lookAt() (which uses `camera.up` to resolve the final orientation),
// achieves a pure image roll without disturbing the elevation/azimuth
// math above, which never reads `camera.up` at all.
function applyLoadingPreviewRoll(target) {
  if (!loadingPreviewCamera) return
  const rollRad = THREE.MathUtils.degToRad(cfg.loadingPreviewRotationZ || 0)
  const viewDir = target.clone().sub(loadingPreviewCamera.position).normalize()
  loadingPreviewCamera.up.set(0, 1, 0).applyAxisAngle(viewDir, rollRad)
  loadingPreviewCamera.lookAt(target)
}
// The REVERSE direction (camera -> sliders) -- reads wherever the camera
// actually ended up (a just-applied preset, the auto-frame default, or
// live orbiting) and writes it back into the 5 sliders via syncValue()
// (which itself skips whichever row currently has focus, so this never
// fights a live edit -- same established pattern as the main scene's own
// syncCameraPanelFromLive()). THREE.Spherical's own convention: phi is
// the polar angle measured from +Y (0=straight up, PI=straight down);
// subtracting 90 deg converts that into "elevation from the horizon"
// (0=level), matching how Rotation X is labeled/ranged (-89..89).
function deriveLoadingPreviewOrbitSliders() {
  if (!loadingPreviewCamera) return
  const offset = loadingPreviewCamera.position.clone().sub(loadingPreviewCameraTarget)
  _loadingPreviewSpherical.setFromVector3(offset)
  const origin = loadingPreviewOrbitOrigin()
  syncValue('loadingPreviewRotationX', THREE.MathUtils.radToDeg(_loadingPreviewSpherical.phi) - 90)
  syncValue('loadingPreviewRotationY', THREE.MathUtils.radToDeg(_loadingPreviewSpherical.theta))
  syncValue('loadingPreviewOffsetX', loadingPreviewCameraTarget.x - origin.x)
  syncValue('loadingPreviewOffsetY', loadingPreviewCameraTarget.y - origin.y)
}
// Continuous per-frame sync while Edit Mode is actually on -- mirrors the
// main scene's own syncCameraPanelFromLive() (called every animate()
// frame, not event-based), the simplest reliable way to reflect live
// mouse-driven orbit/pan/zoom without wiring OrbitControls' own 'change'
// event by hand. Called from both Loading Preview render paths (the
// pre-fieldStarted branch in animate() and the separate live loop) --
// see each call site's own comment.
function syncLoadingPreviewCameraFromOrbit() {
  if (!cfg.loadingPreviewCameraEditMode || !loadingPreviewOrbitControls || !loadingPreviewCamera) return
  loadingPreviewCameraTarget.copy(loadingPreviewOrbitControls.target)
  deriveLoadingPreviewOrbitSliders()
}
// `captureCurrent` for the `loadingPreviewSavedCameras` list-picker --
// captures wherever `loadingPreviewCamera` actually is RIGHT NOW (either
// the auto-framed default or whatever preset was last applied), the same
// "Save" semantics as the main camera's own captureCameraPreset(), just
// reading this preview's own camera/target instead of the live
// interactive one.
function captureLoadingPreviewCameraPreset() {
  if (!loadingPreviewCamera) return {}
  return {
    cameraX: loadingPreviewCamera.position.x,
    cameraY: loadingPreviewCamera.position.y,
    cameraZ: loadingPreviewCamera.position.z,
    cameraFov: loadingPreviewCamera.fov,
    targetX: loadingPreviewCameraTarget.x,
    targetY: loadingPreviewCameraTarget.y,
    targetZ: loadingPreviewCameraTarget.z
  }
}
// `captureCurrent` for the `loadingPreviewSavedLighting` list-picker --
// captures the loading preview's OWN key/hemi lights (not the main
// scene's), same shape as the main Lighting group's own
// captureLightingPreset(), reused via LIGHTING_PRESET_KEYS.
function captureLoadingPreviewLightingPreset() {
  if (!loadingPreviewKeyLightRef || !loadingPreviewHemiLightRef) return {}
  // Re-derive azimuth/elevation from the live light position -- the
  // inverse of applyLoadingPreviewLighting()'s own forward formula
  // (r*cos(el)*cos(az), r*sin(el), r*cos(el)*sin(az)).
  const p = loadingPreviewKeyLightRef.position
  const r = p.length() || 1
  const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(p.y / r, -1, 1)))
  const azimuth = ((THREE.MathUtils.radToDeg(Math.atan2(p.z, p.x)) % 360) + 360) % 360
  return {
    keyAzimuth: azimuth,
    keyElevation: elevation,
    keyTargetHeight: LIGHTING_KEY_DEFAULTS.keyTargetHeight,
    keyIntensity: loadingPreviewKeyLightRef.intensity,
    keyColor: '#' + loadingPreviewKeyLightRef.color.getHexString(),
    ambientIntensity: loadingPreviewHemiLightRef.intensity,
    ambientSkyColor: '#' + loadingPreviewHemiLightRef.color.getHexString(),
    ambientGroundColor: '#' + loadingPreviewHemiLightRef.groundColor.getHexString()
  }
}
// -----------------------------------------------------------------------
// HANDO coordinate-frame converters (direct request, 2026-09-19: "so
// being able to port and read Hando's exported data is very important").
// HANDY DANDIES rotates every hand clone by `alignQuat` (measured once
// from this model's own bind pose -- see alignQuat's own declaration
// comment); HANDO has no equivalent correction (its own modelRoot uses
// the raw GLTF orientation plus its own separate, independently-tuned
// Whole-Hand Rotation sliders). A camera/light captured in HANDO is
// therefore in a DIFFERENT coordinate frame than this project's own
// alignQuat-rotated one -- pasting HANDO's raw numbers in directly
// points the camera at empty space (confirmed live, 2026-09-19: HANDO's
// own "Left" preset applied unconverted made the Loading Preview hand
// disappear entirely).
//
// VALIDATED via a standalone measurement script (this GLB's own bind-
// pose bones, outside the running app, not committed): rotating HANDO's
// "Left" preset's target by this exact `alignQuat` lands it ~3 world
// units from the wrist-to-fingertip midline (handLengthRaw ~16 units
// total) -- essentially on the hand's own central axis, confirming
// HANDO's saved cameras were captured at the model's raw/un-rotated
// bind pose (Whole-Hand Rotation at 0), not whatever HANDO's OWN
// Whole-Hand Rotation sliders currently happen to read.
//
// Deliberately only wired onto the Loading Preview's own local
// `loadingPreviewSavedCameras`/`loadingPreviewSavedLighting` lists (see
// each control's own DEV_GROUPS comment) -- the main field's own
// `savedCameras`/`savedLighting` frame the WHOLE FIELD at a completely
// different (field-radius) scale HANDO has no equivalent of, so this
// same conversion wouldn't be meaningful there.
function convertHandoCameraPreset(rawItem) {
  const item = normalizeCameraPresetItem(rawItem)
  const pos = new THREE.Vector3(
    item.cameraX ?? CAMERA_KEY_DEFAULTS.cameraX,
    item.cameraY ?? CAMERA_KEY_DEFAULTS.cameraY,
    item.cameraZ ?? CAMERA_KEY_DEFAULTS.cameraZ
  ).applyQuaternion(alignQuat)
  const target = new THREE.Vector3(
    item.targetX ?? 0,
    item.targetY ?? 0,
    item.targetZ ?? 0
  ).applyQuaternion(alignQuat)
  return {
    name: rawItem.name,
    ...(rawItem.group ? { group: rawItem.group } : {}),
    cameraX: pos.x, cameraY: pos.y, cameraZ: pos.z,
    cameraFov: item.cameraFov ?? CAMERA_KEY_DEFAULTS.cameraFov,
    targetX: target.x, targetY: target.y, targetZ: target.z
  }
}
// Converts a HANDO-authored keyAzimuth/keyElevation pair into this
// project's own convention. Not a simple rotation-of-the-angle-numbers --
// the 2 apps' own azimuth/elevation formulas assign X/Z differently
// (HANDO: x=cos(el)*sin(az), z=cos(el)*cos(az); HANDY DANDIES here:
// x=cos(el)*cos(az), z=cos(el)*sin(az) -- see updateKeyLightPosition()'s
// own comment), so this reconstructs HANDO's own direction VECTOR first
// (using HANDO's formula), rotates that vector by `alignQuat` (same
// reasoning as the camera converter above), then re-derives azimuth/
// elevation from the rotated vector using THIS project's own formula.
// keyTargetHeight/intensity/colors pass through unconverted -- height is
// a plain percentage of the hand's own radius (frame-independent), and
// intensity/color have no coordinate-frame component at all.
function convertHandoLightingPreset(rawItem) {
  const az = THREE.MathUtils.degToRad(rawItem.keyAzimuth ?? LIGHTING_KEY_DEFAULTS.keyAzimuth)
  const el = THREE.MathUtils.degToRad(rawItem.keyElevation ?? LIGHTING_KEY_DEFAULTS.keyElevation)
  // HANDO's own spherical convention (see its updateKeyLightPosition()).
  const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
  dir.applyQuaternion(alignQuat)
  // This project's own spherical convention, inverted.
  const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)))
  const azimuth = ((THREE.MathUtils.radToDeg(Math.atan2(dir.z, dir.x)) % 360) + 360) % 360
  return {
    name: rawItem.name,
    ...(rawItem.group ? { group: rawItem.group } : {}),
    keyAzimuth: azimuth,
    keyElevation: elevation,
    keyTargetHeight: rawItem.keyTargetHeight ?? LIGHTING_KEY_DEFAULTS.keyTargetHeight,
    keyIntensity: rawItem.keyIntensity ?? LIGHTING_KEY_DEFAULTS.keyIntensity,
    keyColor: rawItem.keyColor ?? LIGHTING_KEY_DEFAULTS.keyColor,
    ambientIntensity: rawItem.ambientIntensity ?? LIGHTING_KEY_DEFAULTS.ambientIntensity,
    ambientSkyColor: rawItem.ambientSkyColor ?? LIGHTING_KEY_DEFAULTS.ambientSkyColor,
    ambientGroundColor: rawItem.ambientGroundColor ?? LIGHTING_KEY_DEFAULTS.ambientGroundColor
  }
}
// Independent render loop for the on-demand "live" preview
// (loadingPreviewShowLive) -- the main animate() loop's own loading-
// preview branch (see its own comment, near `if (!fieldStarted &&
// loadingPreviewRenderer)`) permanently stops calling this once
// `fieldStarted` flips true, by design (a deliberate one-time-per-
// session optimization for the REAL startup sequence, not something
// this feature should reverse). This is a SEPARATE loop specifically so
// a post-load, on-demand preview can still animate -- self-terminates
// the moment `loadingPreviewShowLive` goes false again (checked at the
// top of every tick, no separate cancelAnimationFrame bookkeeping
// needed) or if the renderer it's driving disappears out from under it.
let loadingPreviewLiveRafId = null
function startLoadingPreviewLiveLoop() {
  if (loadingPreviewLiveRafId !== null) return // already running
  const tick = () => {
    if (!cfg.loadingPreviewShowLive || !loadingPreviewRenderer) { loadingPreviewLiveRafId = null; return }
    try {
      updateLoadingPreviewAnimation()
      syncLoadingPreviewCameraFromOrbit()
      loadingPreviewRenderer.render(loadingPreviewScene, loadingPreviewCamera)
    } catch (err) {
      console.error('Loading Preview (live) frame threw -- disabling for this session:', err)
      cfg.loadingPreviewShowLive = false
      syncValue('loadingPreviewShowLive', false)
      if (loadingPreviewCanvas) loadingPreviewCanvas.style.display = 'none'
      loadingPreviewLiveRafId = null
      return
    }
    loadingPreviewLiveRafId = requestAnimationFrame(tick)
  }
  loadingPreviewLiveRafId = requestAnimationFrame(tick)
}
// loadingPreviewShowLive's own onChange. Rebuilds from scratch on every
// "on" (buildLoadingPreview() itself now disposes any previous renderer
// first, see its own comment, so repeated toggling can't leak GL
// contexts) rather than trying to resume a possibly-stale previous
// instance. Guarded on `modelMeasurementsReady` -- the dev panel itself
// is visible from page load, well before the hand model has actually
// finished loading, so this checkbox IS reachable before there's
// anything real to preview yet; silently does nothing in that case
// rather than throwing on an undefined `modelRoot`.
function setLoadingPreviewLiveVisible(show) {
  if (!show) {
    if (loadingPreviewCanvas) loadingPreviewCanvas.style.display = 'none'
    return
  }
  if (!modelMeasurementsReady) return
  buildLoadingPreview(true)
  // Pre-fieldStarted, the main animate() loop's own existing branch is
  // already animating this renderer every frame -- only start the
  // separate loop once that branch has permanently stopped.
  if (fieldStarted) startLoadingPreviewLiveLoop()
}
// Applies a Lighting preset's own values to the loading preview's own
// cloned key/hemi lights -- a bespoke version of the main scene's
// updateKeyLightPosition() (which is hardcoded to the global `keyLight`/
// `sceneState.fieldRadius`, neither of which apply to this isolated
// single-hand preview), scaled off `handBoundsRadiusLocal` instead of
// the field's own radius -- the natural "scale of the visible thing" for
// this preview, mirroring updateKeyLightPosition()'s own x3 factor.
function applyLoadingPreviewLighting(key, hemi, preset) {
  const az = THREE.MathUtils.degToRad(preset.keyAzimuth ?? LIGHTING_KEY_DEFAULTS.keyAzimuth)
  const el = THREE.MathUtils.degToRad(preset.keyElevation ?? LIGHTING_KEY_DEFAULTS.keyElevation)
  const r = handBoundsRadiusLocal * 3
  key.position.set(r * Math.cos(el) * Math.cos(az), r * Math.sin(el), r * Math.cos(el) * Math.sin(az))
  key.target.position.set(0, ((preset.keyTargetHeight ?? LIGHTING_KEY_DEFAULTS.keyTargetHeight) / 100) * handBoundsRadiusLocal, 0)
  key.target.updateMatrixWorld()
  key.intensity = preset.keyIntensity ?? LIGHTING_KEY_DEFAULTS.keyIntensity
  key.color.set(preset.keyColor ?? LIGHTING_KEY_DEFAULTS.keyColor)
  hemi.intensity = preset.ambientIntensity ?? LIGHTING_KEY_DEFAULTS.ambientIntensity
  hemi.color.set(preset.ambientSkyColor ?? LIGHTING_KEY_DEFAULTS.ambientSkyColor)
  hemi.groundColor.set(preset.ambientGroundColor ?? LIGHTING_KEY_DEFAULTS.ambientGroundColor)
}
// `loadingPreviewLightingSelector`'s own onChange, for the "cleared back
// to no selection" case -- re-clones the MAIN scene's own CURRENT
// key/hemi lights (position/target/intensity/color), matching exactly
// what buildLoadingPreview() itself does at build time before any
// preset override is applied.
function applyLoadingPreviewLightingDefault() {
  if (!loadingPreviewKeyLightRef || !loadingPreviewHemiLightRef) return
  loadingPreviewKeyLightRef.position.copy(keyLight.position)
  loadingPreviewKeyLightRef.target.position.copy(keyLight.target.position)
  loadingPreviewKeyLightRef.target.updateMatrixWorld()
  loadingPreviewKeyLightRef.intensity = keyLight.intensity
  loadingPreviewKeyLightRef.color.copy(keyLight.color)
  loadingPreviewHemiLightRef.intensity = hemiLight.intensity
  loadingPreviewHemiLightRef.color.copy(hemiLight.color)
  loadingPreviewHemiLightRef.groundColor.copy(hemiLight.groundColor)
}
// Sized directly off the Loading Preview Size (Px) slider (an inline
// style, not CSS-var-driven like the main dev panel's own chrome, since
// this canvas only exists during a narrow startup window) -- called once
// at build time and again on that slider's own onChange (live-resizable
// isn't strictly needed since it can't be touched before the model loads,
// but this keeps it consistent with the size actually configured, since a
// value restored async, after the loading screen already opened, would
// otherwise never take effect until next reload).
function resizeLoadingPreview() {
  if (!loadingPreviewCanvas || !loadingPreviewRenderer) return
  const size = Math.max(20, cfg.loadingPreviewSize || 160)
  loadingPreviewCanvas.style.width = size + 'px'
  loadingPreviewCanvas.style.height = size + 'px'
  loadingPreviewCamera.aspect = 1
  loadingPreviewCamera.updateProjectionMatrix()
  loadingPreviewRenderer.setSize(size, size, false)
}
// Loading Preview Offset X/Y (Px) -- same "called once at build time and
// again on the slider's own onChange" pattern as resizeLoadingPreview()
// directly above (see its own comment for why live-resizable/
// repositionable isn't strictly needed but costs nothing to keep
// consistent with the configured value). The canvas is a top-level
// element positioned via `top:50%;left:50%` (style.css) -- exactly like
// #loading centers ITSELF -- so this transform has to do BOTH jobs in
// one value: `translate(-50%,-50%)` recenters the canvas on its own
// size (matching #loading's own base centering exactly), THEN an
// additional `translate(offsetXpx, offsetYpx)` nudges it per the 2
// sliders. Completely independent of #loadingText's own layout (a
// separate element, #loading's own child) since this only ever touches
// the canvas's own inline style.
// CORRECTED 2026-09-19 -- loadingPreviewOffsetX/Y no longer nudge the
// canvas's own on-screen CSS position (they're the orbit camera's own
// world-space pan target now, see that control's own DEV_GROUPS
// comment); this just keeps the canvas centered on the viewport, same
// base transform #loading itself uses. Kept as its own function (not
// inlined at the 2 call sites) since the canvas's own CSS position may
// grow independent options again later.
function repositionLoadingPreview() {
  if (!loadingPreviewCanvas) return
  loadingPreviewCanvas.style.transform = 'translate(-50%, -50%)'
}
// Applies one pose-shaped values object to ONLY the loading-preview hand's
// skeleton -- deliberately a 3rd near-duplicate of previewPosePreset()
// (Pose Preview's own version) rather than a shared helper, matching this
// codebase's own existing precedent of a bespoke apply-to-isolated-hand
// function per independent preview instance instead of a new abstraction
// both would route through.
function applyLoadingPreviewPose(item) {
  if (!loadingPreviewHand || !loadingPreviewHand.skinnedMesh) return
  const values = {}
  POSE_PRESET_KEYS.forEach((k) => { values[k] = item[k] !== undefined ? item[k] : POSE_KEY_DEFAULTS[k] })
  // CORRECTED 2026-09-19 -- loadingPreviewRotationX/Y/Z used to be folded
  // in here (rotating the hand itself); they're now the ORBIT CAMERA's
  // own elevation/azimuth/roll instead (see that control's own DEV_GROUPS
  // comment), so the hand goes back to plain `alignQuat`, matching every
  // camera computation in this file (auto-frame, saved presets, orbit
  // math), which all assume the hand sits at exactly alignQuat with no
  // extra rotation. A real production bug traced to the OLD behavior:
  // a leftover non-zero loadingPreviewRotationX (6 deg) rotated the hand
  // out from under whatever the camera was actually framed for, reported
  // as "the camera is off, now rotated at some angle."
  loadingPreviewBaseQuat.copy(alignQuat)
  loadingPreviewHand.clone.quaternion.copy(loadingPreviewBaseQuat)
  applyWristPoseToSkeleton(loadingPreviewHand.skinnedMesh.skeleton, values)
  FINGER_NAMES.forEach((name) => applyCurlToSkeleton(name, loadingPreviewHand.skinnedMesh.skeleton, loadingPreviewBaseQuat, null, values))
}
// Row visibility for the Loading Preview's own Sequence Mode controls --
// same 2-level gating as updateSequencePlayModeVisibility() (Count's own
// Sequence Count/Count Mode; Loop Transition only for a Loop-style
// repeat), minus the Mode check that function also does (there's no
// Single-Pose-vs-Sequence distinction here -- the Loading Preview group
// is ALWAYS about sequence playback).
function updateLoadingPreviewSequenceVisibility() {
  const setRow = (suffix, visible) => {
    const row = document.querySelector(`.dp-row[data-key="loadingPreviewSequence${suffix}"]`)
    if (row) row.style.display = visible ? '' : 'none'
  }
  const playMode = cfg.loadingPreviewSequenceMode
  const isCount = playMode === 'Count'
  setRow('Count', isCount)
  setRow('CountMode', isCount)
  setRow('LoopTransition', playMode === 'Loop' || (playMode === 'Count' && cfg.loadingPreviewSequenceCountMode === 'Loop'))
}
// Plays the selected Tween Sequence (default pose + every named pose in
// it) for as long as the loading screen stays up, per the Sequence Mode
// (Count/Loop/Oscillate) settings -- same lap-based mechanism as
// updateClickPoseForHand()'s own 'sequencePlaying' phase (see
// makeClickPoseGroup()'s own control comment for the full reasoning),
// generalized to module-level state (a single instance, not per-hand)
// instead of per-hand `cp` state, and with no "release" concept at all
// (this preview just plays until the page itself finishes loading).
// 'Count' mode freezes at the last pose reached once its laps are used
// up (`loadingPreviewSequenceDone`) rather than doing anything further --
// there's no pause/retransition concept for a loading animation. Falls
// back to just holding the default pose (no visible motion, but still a
// rendered hand) when no sequence is selected or it resolves to zero
// poses.
function updateLoadingPreviewAnimation() {
  const seq = (cfg.savedTweenSequences || []).find((s) => s.name === cfg.loadingPreviewTweenSelector)
  const namedPoses = seq ? resolveTweenSequencePoses(seq.tweenPoses) : []
  if (namedPoses.length < 1) { applyLoadingPreviewPose(poseDefaultValues); return }
  if (loadingPreviewSequenceDone) return // frozen at whatever was last applied
  const poses = [poseDefaultValues, ...namedPoses]
  const playMode = cfg.loadingPreviewSequenceMode
  const lapStyle = playMode === 'Count' ? cfg.loadingPreviewSequenceCountMode : playMode
  const totalLaps = playMode === 'Count' ? Math.max(cfg.loadingPreviewSequenceCount || 1, 1) : Infinity
  const holdMs = Math.max(cfg.loadingPreviewSequenceHoldMs || 0, 0)
  const now = performance.now()
  if (loadingPreviewHoldEndMs && now < loadingPreviewHoldEndMs) return // mid-hold -- last applied pose stays, nothing to reapply (no other config drives this preview's own idle state)
  if (loadingPreviewHoldEndMs && now >= loadingPreviewHoldEndMs) {
    loadingPreviewHoldEndMs = 0
    loadingPreviewLapStartMs = now
    if (lapStyle === 'Oscillate') loadingPreviewDirection *= -1
  }
  const speedMs = Math.max(safeTweenSpeedMs(cfg.loadingPreviewSpeedMs), 1)
  const lapT = THREE.MathUtils.clamp((now - loadingPreviewLapStartMs) / speedMs, 0, 1)
  let values
  if (lapStyle === 'Oscillate') {
    const t = loadingPreviewDirection === 1 ? lapT : 1 - lapT
    values = lerpTweenSequence(poses, t)
  } else if (cfg.loadingPreviewSequenceLoopTransition === false) {
    values = lerpTweenSequence(poses, lapT) // instant jump back to frame 1 between laps -- same forward pass every time, no wrap interpolation
  } else {
    const segments = poses.length
    const tCyclic = (loadingPreviewLapIndex - 1) * segments + lapT * segments
    values = lerpLoopSequence(poses, tCyclic) // smooth wrap-back -- same cyclic segment math Click Hold-Pose's own Loop Mode already uses
  }
  applyLoadingPreviewPose(values)
  if (lapT >= 1) {
    loadingPreviewLapIndex++
    if (loadingPreviewLapIndex > totalLaps) {
      loadingPreviewSequenceDone = true
    } else if (holdMs > 0) {
      loadingPreviewHoldEndMs = now + holdMs
    } else {
      loadingPreviewLapStartMs = now
      if (lapStyle === 'Oscillate') loadingPreviewDirection *= -1
    }
  }
}

// -----------------------------------------------------------------------
// Pose Preview -- a small, independent Three.js viewport embedded in the
// dev panel's own collapsible "Pose Preview" group (direct user request:
// "Use" should NOT repose every hand in the field). Its own scene/camera/
// renderer/OrbitControls/hand clone, entirely separate from the main
// field -- never touches `hands`, `cfg`, or `cloneBaseQuat`.
// -----------------------------------------------------------------------
let previewHand = null // { clone, skinnedMesh }
let previewRenderer = null
let previewScene = null
let previewCamera = null
let previewControls = null
let posePreviewPanel = null // the floating panel element itself, once built
const previewBaseQuat = new THREE.Quaternion()
const _previewWholeHandRotEuler = new THREE.Euler()
const POSE_PREVIEW_CAMERA_KEY = 'hd-pose-preview-camera-default'
const POSE_PREVIEW_MIN_W = 220
const POSE_PREVIEW_MIN_H = 200

// Restores this hand's default framing (the same one-time bounding-sphere
// auto-frame buildPosePreview() always falls back to) -- shared by both
// the initial build and a future "reset" if ever needed.
function defaultPosePreviewCamera() {
  const target = handBoundsCenterLocal.clone().applyQuaternion(alignQuat)
  // CORRECTED 2026-09-19 -- same distance-too-close bug as
  // applyLoadingPreviewCameraAutoFrame()'s own identical formula, fixed
  // together; see that function's own comment for the full math.
  const pos = target.clone().add(new THREE.Vector3(0, handBoundsRadiusLocal * 0.15, handBoundsRadiusLocal * 3.6))
  return { pos, target }
}
// "Set Default Camera" (direct request) -- captures the preview's OWN
// current camera position/orbit-target and persists it (localStorage,
// this panel has no devPanel.js-tracked control of its own) so a later
// panel rebuild (page reload, or toggling the checkbox off/on) restores
// THIS framing instead of the generic auto-frame.
function setPosePreviewDefaultCamera() {
  if (!previewCamera || !previewControls) return
  const data = { pos: previewCamera.position.toArray(), target: previewControls.target.toArray() }
  try { localStorage.setItem(POSE_PREVIEW_CAMERA_KEY, JSON.stringify(data)) } catch (err) { /* best-effort only */ }
}
function loadPosePreviewDefaultCamera() {
  try {
    const raw = localStorage.getItem(POSE_PREVIEW_CAMERA_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    return { pos: new THREE.Vector3().fromArray(data.pos), target: new THREE.Vector3().fromArray(data.target) }
  } catch (err) { return null }
}
// Pose Preview -- REBUILT 2026-09-16 as an opt-in FLOATING panel (direct
// request: "the pose preview will be its own separate panel that can be
// resized and moved around"), toggled by the Pose group's own
// `posePreviewEnabled` checkbox rather than always-embedded in the dev
// panel body. Appended directly to `document.body` (a sibling of the dev
// panel itself, NOT inside it) so it can be dragged/resized independently
// and stay visible even if the dev panel is hidden/collapsed. Chrome is a
// deliberately minimal version of the main dev panel's own §12c geometry
// (resizable from all 4 edges + 4 corners, movable by dragging the title
// bar, clamped to the viewport, a close button) -- hand-built here rather
// than reusing devPanel.js internals, since this project's own convention
// is not to fork that shared engine and its resize/drag helpers aren't
// exported for reuse anyway.
let posePreviewCanvas = null
function ensurePosePreviewPanel() {
  if (posePreviewPanel) return
  const panel = document.createElement('div')
  panel.id = 'posePreviewPanel'
  Object.assign(panel.style, {
    position: 'fixed', left: '20px', top: '80px', width: '280px', height: '260px',
    background: '#0f0f18', border: '1px solid #3a3a4a', borderRadius: '6px',
    display: 'none', flexDirection: 'column', overflow: 'hidden', zIndex: 9998,
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)', fontFamily: 'inherit'
  })
  const titlebar = document.createElement('div')
  titlebar.className = 'pp-titlebar'
  Object.assign(titlebar.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
    padding: '4px 6px', background: '#1a1a26', color: '#e8e8f0', fontSize: '11px',
    cursor: 'move', userSelect: 'none', touchAction: 'none', flex: '0 0 auto'
  })
  const title = document.createElement('div')
  title.textContent = 'POSE PREVIEW'
  title.style.fontWeight = 'bold'
  const btnRow = document.createElement('div')
  btnRow.style.display = 'flex'
  btnRow.style.gap = '4px'
  const camBtn = document.createElement('button')
  camBtn.type = 'button'
  camBtn.textContent = 'Set Default Camera'
  Object.assign(camBtn.style, { fontSize: '10px', padding: '2px 6px', background: '#3a3a4a', color: 'inherit', border: 'none', borderRadius: '4px', cursor: 'pointer' })
  camBtn.addEventListener('click', () => {
    setPosePreviewDefaultCamera()
    const orig = camBtn.textContent
    camBtn.textContent = 'Saved!'
    setTimeout(() => { camBtn.textContent = orig }, 900)
  })
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  Object.assign(closeBtn.style, { fontSize: '11px', padding: '2px 6px', background: '#3a3a4a', color: 'inherit', border: 'none', borderRadius: '4px', cursor: 'pointer' })
  closeBtn.addEventListener('click', () => { cfg.posePreviewEnabled = false; syncValue('posePreviewEnabled', false); setPosePreviewVisible(false) })
  btnRow.append(camBtn, closeBtn)
  titlebar.append(title, btnRow)

  const canvas = document.createElement('canvas')
  canvas.className = 'dp-pose-preview-canvas'
  Object.assign(canvas.style, { flex: '1 1 auto', minHeight: '0', display: 'block', width: '100%', height: '100%' })
  posePreviewCanvas = canvas

  panel.append(titlebar, canvas)
  document.body.appendChild(panel)
  posePreviewPanel = panel

  initPosePreviewDrag(panel, titlebar)
  initPosePreviewResize(panel)
}
// Movable by dragging the title bar, clamped to the viewport (§12c) --
// same "stop at the window edge, never let it go offscreen" rule the main
// dev panel itself follows, so all 4 resize corners stay reachable.
function initPosePreviewDrag(panel, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target !== handle && e.target.tagName === 'BUTTON') return
    e.preventDefault()
    const startX = e.clientX, startY = e.clientY
    const startLeft = panel.offsetLeft, startTop = panel.offsetTop
    try { handle.setPointerCapture(e.pointerId) } catch (err) { /* best-effort */ }
    function move(ev) {
      const w = panel.offsetWidth, h = panel.offsetHeight
      let left = startLeft + (ev.clientX - startX)
      let top = startTop + (ev.clientY - startY)
      left = Math.max(0, Math.min(left, window.innerWidth - w))
      top = Math.max(0, Math.min(top, window.innerHeight - h))
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
    }
    function up(ev) {
      try { handle.releasePointerCapture(ev.pointerId) } catch (err) { /* best-effort */ }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}
// Resizable from all 4 edges + all 4 corners (§12c), floored at a size
// that still keeps the title bar and its 2 buttons usable.
function initPosePreviewResize(panel) {
  const EDGE_PX = 7
  const edges = [
    { cursor: 'nwse-resize', x: -1, y: -1 }, { cursor: 'ns-resize', x: 0, y: -1 }, { cursor: 'nesw-resize', x: 1, y: -1 },
    { cursor: 'ew-resize', x: -1, y: 0 }, { cursor: 'ew-resize', x: 1, y: 0 },
    { cursor: 'nesw-resize', x: -1, y: 1 }, { cursor: 'ns-resize', x: 0, y: 1 }, { cursor: 'nwse-resize', x: 1, y: 1 }
  ]
  edges.forEach(({ cursor, x, y }) => {
    const h = document.createElement('div')
    Object.assign(h.style, {
      position: 'absolute', cursor, zIndex: 1, touchAction: 'none',
      left: x === -1 ? '0' : x === 1 ? 'auto' : EDGE_PX + 'px',
      right: x === 1 ? '0' : 'auto',
      top: y === -1 ? '0' : y === 1 ? 'auto' : EDGE_PX + 'px',
      bottom: y === 1 ? '0' : 'auto',
      width: x === 0 ? `calc(100% - ${EDGE_PX * 2}px)` : EDGE_PX * 2 + 'px',
      height: y === 0 ? `calc(100% - ${EDGE_PX * 2}px)` : EDGE_PX * 2 + 'px'
    })
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX, startY = e.clientY
      const startW = panel.offsetWidth, startH = panel.offsetHeight
      const startLeft = panel.offsetLeft, startTop = panel.offsetTop
      try { h.setPointerCapture(e.pointerId) } catch (err) { /* best-effort */ }
      function move(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY
        if (x !== 0) {
          let newW = x === 1 ? startW + dx : startW - dx
          newW = Math.max(POSE_PREVIEW_MIN_W, newW)
          if (x === -1) panel.style.left = (startLeft + startW - newW) + 'px'
          panel.style.width = newW + 'px'
        }
        if (y !== 0) {
          let newH = y === 1 ? startH + dy : startH - dy
          newH = Math.max(POSE_PREVIEW_MIN_H, newH)
          if (y === -1) panel.style.top = (startTop + startH - newH) + 'px'
          panel.style.height = newH + 'px'
        }
        resizePosePreview()
      }
      function up(ev) {
        try { h.releasePointerCapture(ev.pointerId) } catch (err) { /* best-effort */ }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
    panel.appendChild(h)
  })
}
// Show/hide -- called directly by `posePreviewEnabled`'s own onChange.
// Builds the panel (and its scene/camera/hand clone) lazily, the first
// time it's ever shown, rather than at page load -- most sessions never
// turn this on at all.
function setPosePreviewVisible(visible) {
  if (visible) {
    if (!posePreviewPanel) buildPosePreview()
    posePreviewPanel.style.display = 'flex'
    resizePosePreview()
  } else if (posePreviewPanel) {
    posePreviewPanel.style.display = 'none'
  }
}
// Called once, the first time the panel is ever shown (modelRoot/
// alignQuat/boneRestQuat/toonMaterial all ready well before then, since
// this only runs on a user's own explicit checkbox click) -- clones the
// SAME already-loaded GLB one more time (no extra network fetch), same as
// rebuildField() clones it per field hand.
function buildPosePreview() {
  ensurePosePreviewPanel()
  const canvas = posePreviewCanvas

  previewScene = new THREE.Scene()
  previewCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000)
  previewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace

  // Clones of the MAIN scene's own already-tuned key/ambient lights rather
  // than inventing fresh ones -- a from-scratch light produced a flat,
  // washed-out white silhouette (confirmed live: no visible toon-shading
  // steps at all), while the main field's own hands show clear shaded
  // detail under their own tuned lighting. A DirectionalLight's actual
  // effect only depends on the position-to-target DIRECTION, not
  // magnitude, so reusing keyLight's exact position/target vectors is
  // correct even though they're scaled for the much larger main scene
  // (sceneState.fieldRadius * 3) -- only a one-time snapshot at build
  // time, not live-synced to further Lighting-tab tweaks (a minor,
  // acceptable gap for what's meant to be a quick pose check).
  const previewKey = keyLight.clone()
  previewKey.target = keyLight.target.clone()
  previewScene.add(previewKey)
  previewScene.add(previewKey.target)
  previewScene.add(hemiLight.clone())

  const clone = cloneSkeletal(modelRoot)
  clone.quaternion.copy(alignQuat)
  const skinnedMesh = findSkinnedMesh(clone)
  if (skinnedMesh && toonMaterial) skinnedMesh.material = toonMaterial
  previewScene.add(clone)
  previewHand = { clone, skinnedMesh }
  // Direct request: "the pose preview hand should have the same default
  // pose as i have set" -- otherwise the preview opens showing the raw,
  // un-posed GLB bind pose (long straight fingers) until something else
  // (a saved-pose "Use", or a tween Run) happens to pose it.
  previewPosePreset(poseDefaultValues)

  // Framed from the SAME bounding-sphere measurement taken once at load
  // (handBoundsCenterLocal/handBoundsRadiusLocal) the main scene's own
  // one-time auto-frame already uses -- no separate measurement needed.
  // Aimed at the mesh's own measured center (rotated by alignQuat, the
  // same transform the clone itself carries), NOT the raw origin -- this
  // asset's visible mesh includes a full forearm hanging below the wrist
  // (documented in handBoundsCenterLocal's own declaration comment), so
  // the bounding sphere's center sits well away from the wrist/bone-
  // origin point; aiming at (0,0,0) framed mostly forearm instead of the
  // hand+fingers. A saved "Set Default Camera" (direct request) overrides
  // this auto-frame when present.
  const saved = loadPosePreviewDefaultCamera()
  const fallback = defaultPosePreviewCamera()
  const framing = saved || fallback
  previewCamera.position.copy(framing.pos)
  previewControls = new OrbitControls(previewCamera, canvas)
  previewControls.target.copy(framing.target)
  previewControls.enableDamping = true
  previewControls.update()

  resizePosePreview()
  window.addEventListener('resize', resizePosePreview)
}
// canvas.clientWidth/Height (CSS layout size) drives the resize, same
// self-heal reasoning as the main scene's own applyRendererSize() --
// re-read on demand (called after building, on window resize, after every
// manual panel resize-drag above, and cheap to guard in the per-frame
// render call below) rather than assumed fixed, since the panel is now
// user-resizable at any time.
function resizePosePreview() {
  if (!previewRenderer) return
  const canvas = previewRenderer.domElement
  const w = canvas.clientWidth || 200
  const h = canvas.clientHeight || 200
  if (previewCamera.aspect !== w / h) {
    previewCamera.aspect = w / h
    previewCamera.updateProjectionMatrix()
  }
  previewRenderer.setSize(w, h, false)
}
// Applies one saved pose's OWN values (not cfg) to ONLY the preview hand's
// skeleton, via applyCurlToSkeleton()/applyWristPoseToSkeleton()'s own
// `values` param -- reuses the exact same posing math the main field uses,
// just pointed at different data and a different (single, untracked)
// hand. No `wrapperQuat` (previewHand has no cursor-tracking wrapper
// layer at all, unlike a field hand) -- omitted (null), matching how Tip
// Twist's own axis conversion already omits it for the same "nothing to
// exclude" reason.
function previewPosePreset(item) {
  if (!previewHand || !previewHand.skinnedMesh) return
  const values = {}
  POSE_PRESET_KEYS.forEach((k) => { values[k] = item[k] !== undefined ? item[k] : POSE_KEY_DEFAULTS[k] })
  _previewWholeHandRotEuler.set(
    THREE.MathUtils.degToRad(values.modelRotX),
    THREE.MathUtils.degToRad(values.modelRotY),
    THREE.MathUtils.degToRad(values.modelRotZ)
  )
  previewBaseQuat.copy(alignQuat).multiply(new THREE.Quaternion().setFromEuler(_previewWholeHandRotEuler))
  previewHand.clone.quaternion.copy(previewBaseQuat)
  // Wrist BEFORE fingers -- see applyAllFingerPoses()'s own comment for
  // why (rThumb1's parent is rHand, the same bone the wrist rotates;
  // posing it first ensures the finger loop below reads the wrist's
  // NEW target rotation, not whatever was left over from before).
  applyWristPoseToSkeleton(previewHand.skinnedMesh.skeleton, values)
  FINGER_NAMES.forEach((name) => applyCurlToSkeleton(name, previewHand.skinnedMesh.skeleton, previewBaseQuat, null, values))
}

// Whole-Hand Rotation X/Y/Z -- changes `cloneBaseQuat` only (a single
// shared quaternion, applied to every hand's own `clone.quaternion` every
// frame alongside the arm-length position update below -- see
// applyHandArmLength()) -- never touches `wrapper`'s own transform, which
// the per-frame cursor look-at owns exclusively (see animate()). Only
// needs recomputing when a Whole-Hand Rotation slider actually changes,
// not per frame.
const wholeHandRotQuat = new THREE.Quaternion()
const cloneBaseQuat = new THREE.Quaternion()
const _wholeHandRotEuler = new THREE.Euler()
function updateCloneBaseQuat() {
  if (!modelLoaded) return
  wholeHandRotQuat.setFromEuler(_wholeHandRotEuler.set(
    THREE.MathUtils.degToRad(cfg.modelRotX),
    THREE.MathUtils.degToRad(cfg.modelRotY),
    THREE.MathUtils.degToRad(cfg.modelRotZ)
  ))
  cloneBaseQuat.copy(alignQuat).multiply(wholeHandRotQuat)
}
// Whole-Hand Rotation's own axes are re-expressed relative to
// cloneBaseQuat (see applyCurlToSkeleton()'s own `baseQuat` parameter) --
// changing modelRotX/Y/Z therefore requires BOTH updating the transform
// AND re-applying every finger's curl/splay with the new axis basis, or
// an already-posed finger would keep its OLD (now stale) rotation.
function onWholeHandRotationChange() {
  updateCloneBaseQuat()
  applyAllFingerPoses()
}

// Arm Length / Hide Wrist -- per-hand, per-frame now (see
// applyHandArmLength()'s own comment for why this moved out of a
// slider-triggered one-time calculation): direct follow-up request,
// "make the crop or arm length dependent on distance from the cursor, so
// the closer it is the shorter the arm length," with the crop reframed
// from "wrist cut %" to "arm length" -- both endpoints (cropped short vs.
// long) still spawn from the SAME Field Layout grid point, per the
// original "cut wrist base corresponds to grid points" request, now true
// for every possible length rather than one fixed slider value.
//
// Reactive mode maps each hand's LIVE distance to the cursor target
// through a user-editable curve (`cfg.armLengthCurve`, control points in
// normalized [0,1] x [0,1] space) into the [min,max] crop-percent bounds
// (`cfg.armLengthRange`) -- both new dev-panel widgets, built outside the
// generic devPanel.js engine (kept "reused verbatim, don't fork it" per
// this project's own convention) via buildArmLengthWidgets(), called once
// after initDevPanel(). Non-reactive mode just uses `cfg.hideWrist` (the
// original single slider, relabeled "Default Arm Length") -- unchanged
// behavior from before this round.
//
// Distance is normalized against the CURRENT field's own live min/max
// distance-to-cursor (computed fresh each frame in updateRenderOrder(),
// passed in here as `minDist`/`distRange`) rather than a fixed constant --
// see updateRenderOrder()'s own comment for the real bug this fixes (far-
// away hands all collapsing to the same curve value once the cursor left
// a FIXED reference range entirely).
//
// Smooth spline (Catmull-Rom, C1-continuous, passes exactly through every
// control point) -- direct correction: "the arm length curve input should
// not be angled lines, it should be a smooth curve where ever i drag it,"
// with a Photoshop/Lightroom-style tone-curve editor as the reference.
// Parameterized by X-position within each segment (not true arc-length --
// a common, visually-indistinguishable simplification for this kind of
// monotonic-ish editor) using the immediate neighbor on each side (the
// segment's own 2 endpoints double as their own missing neighbor at the
// curve's first/last segment, the standard Catmull-Rom boundary handling).
function catmullRomY(y0, y1, y2, y3, t) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
}
// Bezier curve handles (direct spec item) -- a per-point OPTIONAL manual
// tangent, additive to the smooth Catmull-Rom spline above rather than a
// replacement for it. A point's own `h1` ({x,y} offset, absolute -- added
// directly to the point) shapes the curve LEAVING it toward the next
// point; `h2` shapes the curve ARRIVING at it FROM the previous point.
// Only a segment where at least one endpoint actually defines the
// relevant handle switches to an explicit cubic bezier (see
// evaluateArmLengthCurve()'s own call site) -- every segment with no
// handles keeps the exact same Catmull-Rom shape it always had, so no
// existing saved curve changes at all just because this capability now
// exists.
function cubicBezier1D(p0, p1, p2, p3, t) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
// A cubic bezier isn't naturally parameterized by X, so this solves for
// the parameter `t` whose X(t) matches the requested `x` via binary
// search (24 iterations -- plenty for this widget's own display/eval
// precision), then reads Y(t) off that same `t`. Assumes X(t) is
// monotonic across the segment, true for any handle configuration that
// doesn't double back on itself horizontally -- a well-formed use of a
// tone-curve-style handle in practice, not enforced here (an S-shaped X
// would just evaluate to whichever of the (possibly multiple) matching
// t's this search happens to land on, a disclosed edge case rather than a
// hard block on dragging a handle past its neighbor).
function bezierSegmentY(P0, C1, C2, P3, x) {
  let lo = 0, hi = 1
  for (let iter = 0; iter < 24; iter++) {
    const mid = (lo + hi) / 2
    const xm = cubicBezier1D(P0.x, C1.x, C2.x, P3.x, mid)
    if (xm < x) lo = mid; else hi = mid
  }
  const t = (lo + hi) / 2
  return cubicBezier1D(P0.y, C1.y, C2.y, P3.y, t)
}
function evaluateArmLengthCurve(points, x) {
  if (!points || points.length === 0) return 1
  if (points.length === 1) return points[0].y
  const sorted = points // already kept sorted by the widget itself
  if (x <= sorted[0].x) return sorted[0].y
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i], p2 = sorted[i + 1]
    if (x >= p1.x && x <= p2.x) {
      // Bezier curve handles override -- see cubicBezier1D()'s own
      // comment. p1.h1/p2.h2 undefined (the overwhelmingly common case,
      // and every pre-existing saved curve) falls straight through to the
      // original Catmull-Rom line below, unchanged.
      if (p1.h1 || p2.h2) {
        const C1 = p1.h1 ? { x: p1.x + p1.h1.x, y: p1.y + p1.h1.y } : p1
        const C2 = p2.h2 ? { x: p2.x + p2.h2.x, y: p2.y + p2.h2.y } : p2
        return bezierSegmentY(p1, C1, C2, p2, x)
      }
      const p0 = sorted[i - 1] || p1
      const p3 = sorted[i + 2] || p2
      const segT = p2.x === p1.x ? 0 : (x - p1.x) / (p2.x - p1.x)
      return catmullRomY(p0.y, p1.y, p2.y, p3.y, segT)
    }
  }
  return sorted[sorted.length - 1].y
}
// `cfg.armLengthRange`/`cfg.armLengthCurve` are plain JSON strings (the
// generic devPanel.js 'text' control's own storage format -- see
// buildArmLengthWidgets()'s own comment for why these 2 controls are
// custom-built rather than new devPanel.js control types). Re-parsing a
// JSON string 510 times a frame would be real, needless per-frame cost --
// parsed once into `armLengthRangeParsed`/`armLengthCurveParsed` (declared
// near this file's other early shared state, see that declaration's own
// comment for why) instead, refreshed only when the underlying control's
// value actually changes (called from each control's own onChange and
// once right after initDevPanel() to pick up the restored/default value).
function parseArmLengthConfig() {
  try { armLengthRangeParsed = JSON.parse(cfg.armLengthRange) } catch (e) { /* keep last-good value */ }
  try { armLengthCurveParsed = JSON.parse(cfg.armLengthCurve).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
}
function computeArmLengthT(hand, distanceToCursor, minLiveDist, liveDistRange) {
  if (!cfg.cropWristEnabled) return 0 // master off -- full arm, always
  if (!cfg.reactiveArmLengthEnabled) return cfg.hideWrist / 100
  const normDist = THREE.MathUtils.clamp((distanceToCursor - minLiveDist) / liveDistRange, 0, 1)
  const curveY = THREE.MathUtils.clamp(evaluateArmLengthCurve(armLengthCurveParsed, normDist), 0, 1)
  const minT = armLengthRangeParsed.min / 100, maxT = armLengthRangeParsed.max / 100
  return minT + (maxT - minT) * curveY
}
function parseWristSplayConfig() {
  try { wristSplayRangeParsed = JSON.parse(cfg.wristSplayRange) } catch (e) { /* keep last-good value */ }
  try { wristSplayCurveParsed = JSON.parse(cfg.wristSplayCurve).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
}
// Returns the EXTRA wrist-splay rotation (degrees) this hand should get
// on top of the Pose group's own shared `cfg.wristSplay` -- 0 when the
// master switch is off, `wristSplayDefault` (a single shared value) when
// Reactive is off, otherwise a live per-hand value from the same
// distance-curve-range pipeline Arm Length uses (evaluateArmLengthCurve()
// is fully generic despite its name -- reused directly, not duplicated).
// `min`/`max` are lerp ENDPOINTS, not a numeric min<=max constraint (see
// this group's own top comment) -- the lerp itself doesn't care which is
// numerically larger.
function computeResponsiveWristSplayDeg(distanceToCursor, minLiveDist, liveDistRange) {
  if (!cfg.wristSplayResponsiveEnabled) return 0
  if (!cfg.wristSplayReactiveEnabled) return cfg.wristSplayDefault
  const normDist = THREE.MathUtils.clamp((distanceToCursor - minLiveDist) / liveDistRange, 0, 1)
  const curveY = THREE.MathUtils.clamp(evaluateArmLengthCurve(wristSplayCurveParsed, normDist), 0, 1)
  const { min, max } = wristSplayRangeParsed
  return min + (max - min) * curveY
}

// Small local DOM helper -- devPanel.js's own `el()` isn't exported, and
// pulling in a whole helper just for 2 one-off widgets isn't worth it.
function elLocal(tag, styles, attrs) {
  const node = document.createElement(tag)
  if (styles) Object.assign(node.style, styles)
  if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (k === 'text') node.textContent = v; else node.setAttribute(k, v) })
  return node
}
// Drives a devPanel.js control's own hidden text input programmatically --
// setting .value and dispatching a real 'input' event routes through that
// control's existing commit()/onChange/localStorage-save machinery
// exactly as if the user had typed into it, so Copy/Save/Reset all keep
// working without either widget knowing anything about devPanel.js
// internals beyond "it's a text input that reacts to 'input' events."
function commitTextControl(input, value) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
// devPanel.js's own Reset/Copy-restore path writes straight to the hidden
// text input's `.value` property without dispatching an 'input' event
// (see its own `displayValue()`) -- there's no event for either widget to
// listen for, so each one registers a cheap resync() into
// `armLengthWidgetResyncs` (declared near this file's other early shared
// state), polled once per frame from animate() (a single string compare
// against last-seen value; only re-parses/redraws on an actual external
// change, e.g. a Reset or a Named Setting State being applied -- not
// every frame).

// Min/Max Arm Length -- a 2-handle range bar on a 0-100 track, and Length
// Scaling Curve -- a small draggable-point curve editor (distance 0-1 on
// X, crop-fraction 0-1 on Y, piecewise-LINEAR between points, not a true
// spline/bezier -- a deliberate simplicity tradeoff; genuinely
// "manipulate the curve" per the request, just not smoothed). Both replace
// their own control's generic `.dp-text-input` (hidden, not removed --
// still the actual source of truth devPanel.js persists) with custom
// markup inside that SAME `.dp-row`, per this project's "add controls via
// main.js, don't fork devPanel.js" convention (parent CLAUDE.md §12 note
// on this project's own file map).
function buildArmLengthWidgets() {
  const rangeRow = document.querySelector('.dp-row[data-key="armLengthRange"]')
  const curveRow = document.querySelector('.dp-row[data-key="armLengthCurve"]')
  if (rangeRow) buildArmLengthRangeWidget(rangeRow)
  if (curveRow) buildArmLengthCurveWidget(curveRow)
}
function buildWristSplayWidgets() {
  const rangeRow = document.querySelector('.dp-row[data-key="wristSplayRange"]')
  const curveRow = document.querySelector('.dp-row[data-key="wristSplayCurve"]')
  if (rangeRow) buildWristSplayRangeWidget(rangeRow)
  if (curveRow) buildWristSplayCurveWidget(curveRow)
}

function buildArmLengthRangeWidget(row) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const wrap = elLocal('div', { flex: '1', padding: '6px 4px 2px' })
  const track = elLocal('div', {
    position: 'relative', height: '18px', margin: '0 9px',
    background: 'rgba(255,255,255,0.12)', borderRadius: '9px'
  })
  const fill = elLocal('div', { position: 'absolute', top: '0', bottom: '0', background: 'var(--dp-accent, #7d8cff)', opacity: '0.5', borderRadius: '9px' })
  const minHandle = elLocal('div', {
    position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px',
    background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none'
  })
  const maxHandle = elLocal('div', {
    position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px',
    background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none'
  })
  const readout = elLocal('div', { fontSize: '11px', textAlign: 'center', marginTop: '4px', opacity: '0.85' })
  track.appendChild(fill); track.appendChild(minHandle); track.appendChild(maxHandle)
  wrap.appendChild(track); wrap.appendChild(readout)
  row.appendChild(wrap)

  let current = { min: 30, max: 90 }
  try { current = JSON.parse(input.value) } catch (e) { /* keep default */ }
  let lastSeenValue = input.value

  function redraw() {
    fill.style.left = current.min + '%'
    fill.style.right = (100 - current.max) + '%'
    minHandle.style.left = current.min + '%'
    maxHandle.style.left = current.max + '%'
    readout.textContent = `Min: ${current.min}%  Max: ${current.max}%`
  }
  redraw()
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try { current = JSON.parse(input.value); redraw() } catch (e) { /* leave displayed state as-is */ }
  })

  function startDrag(handleKey, otherKey, isMin) {
    return (downEv) => {
      downEv.preventDefault()
      function onMove(moveEv) {
        const rect = track.getBoundingClientRect()
        // A zero-width rect (the row/group hidden or mid-collapse-
        // transition when the drag starts) would divide by 0 -> NaN ->
        // JSON.stringify silently turns it into `null`, corrupting the
        // saved value -- confirmed live as a real bug this round. Bail
        // out rather than commit a broken value.
        if (rect.width <= 0) return
        let pct = Math.round(THREE.MathUtils.clamp((moveEv.clientX - rect.left) / rect.width, 0, 1) * 100)
        pct = isMin ? Math.min(pct, current[otherKey]) : Math.max(pct, current[otherKey])
        current[handleKey] = pct
        redraw()
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        commitTextControl(input, JSON.stringify(current))
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
  }
  minHandle.addEventListener('pointerdown', startDrag('min', 'max', true))
  maxHandle.addEventListener('pointerdown', startDrag('max', 'min', false))
}

function buildArmLengthCurveWidget(row) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const W = 240, H = 120
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('width', W); svg.setAttribute('height', H)
  Object.assign(svg.style, { background: 'rgba(255,255,255,0.06)', borderRadius: '4px', marginTop: '6px', touchAction: 'none', cursor: 'crosshair' })
  const axisX = document.createElementNS(svgNS, 'line')
  axisX.setAttribute('x1', 0); axisX.setAttribute('y1', H - 1); axisX.setAttribute('x2', W); axisX.setAttribute('y2', H - 1)
  axisX.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  const axisY = document.createElementNS(svgNS, 'line')
  axisY.setAttribute('x1', 1); axisY.setAttribute('y1', 0); axisY.setAttribute('x2', 1); axisY.setAttribute('y2', H)
  axisY.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  // A <path>, not a <polyline> -- direct correction: "the arm length curve
  // input should not be angled lines, it should be a smooth curve where
  // ever i drag it," with a Photoshop/Lightroom tone-curve editor as the
  // reference. Fine-sampled from the SAME evaluateArmLengthCurve() the
  // real per-hand math uses (not a separately-drawn approximation), so
  // the visible curve is always exactly what's actually applied.
  const curvePath = document.createElementNS(svgNS, 'path')
  curvePath.setAttribute('fill', 'none'); curvePath.setAttribute('stroke', 'var(--dp-accent, #7d8cff)'); curvePath.setAttribute('stroke-width', '2')
  svg.appendChild(axisX); svg.appendChild(axisY); svg.appendChild(curvePath)
  // Percent (0-100), matching every other arm-length control in this
  // feature -- direct correction after a real, reported bug: the previous
  // "(0-1)" axis language here is what led to typing "0.5" into the
  // (0-100-scale) Default Arm Length slider expecting "half," silently
  // producing a barely-there 0.5% crop instead of the intended 50%.
  const caption = elLocal('div', { fontSize: '10px', opacity: '0.7', marginTop: '3px', textAlign: 'center' }, { text: 'X: Distance From Cursor (%, Nearest→Farthest Hand This Frame)  ·  Y: Crop (0%=None, 100%=Full)' })
  row.appendChild(svg)
  row.appendChild(caption)

  let points = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
  try {
    const parsed = JSON.parse(input.value)
    if (Array.isArray(parsed) && parsed.length >= 2) points = parsed.sort((a, b) => a.x - b.x)
  } catch (e) { /* keep default */ }

  const toPx = (p) => ({ x: p.x * W, y: (1 - p.y) * H })
  const fromPx = (px, py) => ({ x: THREE.MathUtils.clamp(px / W, 0, 1), y: THREE.MathUtils.clamp(1 - py / H, 0, 1) })
  let circles = []

  function commitPoints() {
    points.sort((a, b) => a.x - b.x)
    commitTextControl(input, JSON.stringify(points))
  }
  const CURVE_SAMPLES = 48
  function redraw() {
    let d = ''
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const x = i / CURVE_SAMPLES
      const y = THREE.MathUtils.clamp(evaluateArmLengthCurve(points, x), 0, 1)
      const px = toPx({ x, y })
      d += (i === 0 ? 'M' : 'L') + px.x.toFixed(2) + ',' + px.y.toFixed(2) + ' '
    }
    curvePath.setAttribute('d', d.trim())
    circles.forEach((c) => svg.removeChild(c))
    circles = points.map((p, i) => {
      const px = toPx(p)
      const c = document.createElementNS(svgNS, 'circle')
      c.setAttribute('cx', px.x); c.setAttribute('cy', px.y); c.setAttribute('r', 5)
      c.setAttribute('fill', 'var(--dp-accent, #7d8cff)')
      Object.assign(c.style, { cursor: 'grab' })
      let dragged = false
      c.addEventListener('pointerdown', (downEv) => {
        downEv.stopPropagation()
        dragged = false
        const isEndpoint = i === 0 || i === points.length - 1
        function onMove(moveEv) {
          const rect = svg.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return // hidden mid-drag -- see the range widget's own guard, same bug class
          dragged = true
          const np = fromPx(moveEv.clientX - rect.left, moveEv.clientY - rect.top)
          if (isEndpoint) { p.y = np.y } else { p.x = np.x; p.y = np.y }
          redraw()
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (dragged) commitPoints()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      function deletePointIfRemovable() {
        if (points.length > 2 && i !== 0 && i !== points.length - 1) {
          points.splice(points.indexOf(p), 1)
          redraw()
          commitPoints()
        }
      }
      c.addEventListener('dblclick', (dblEv) => {
        dblEv.stopPropagation()
        deletePointIfRemovable()
      })
      // Direct request: "allow right click to delete curve dots" -- same
      // delete logic as the existing double-click (endpoints stay, since
      // the curve always needs a value at both x=0 and x=1), added
      // alongside it rather than replacing it. preventDefault() suppresses
      // the browser's own native right-click context menu over the dot.
      c.addEventListener('contextmenu', (ctxEv) => {
        ctxEv.preventDefault()
        ctxEv.stopPropagation()
        deletePointIfRemovable()
      })
      svg.appendChild(c)
      return c
    })
  }
  svg.addEventListener('click', (clickEv) => {
    if (clickEv.target.tagName === 'circle') return
    const rect = svg.getBoundingClientRect()
    const np = fromPx(clickEv.clientX - rect.left, clickEv.clientY - rect.top)
    if (np.x <= 0 || np.x >= 1) return // keep the domain-spanning endpoints unique
    points.push(np)
    redraw()
    commitPoints()
  })
  redraw()
  let lastSeenValue = input.value
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try {
      const parsed = JSON.parse(input.value)
      if (Array.isArray(parsed) && parsed.length >= 2) { points = parsed.sort((a, b) => a.x - b.x); redraw() }
    } catch (e) { /* leave displayed state as-is */ }
  })
}

// Responsive Wrist Splay's own Min/Max range widget -- structurally the
// same dual-handle bar as buildArmLengthRangeWidget() above, with 2
// deliberate differences: (1) the track spans a DEGREE range (-180 to
// 180), not a fixed 0-100 percent, so values are mapped through
// toPct()/fromPct() instead of used directly as percents; (2) the 2
// handles do NOT cross-clamp each other -- Arm Length's own widget keeps
// minHandle <= maxHandle because its 2 bounds are always numerically
// ordered (0-100%), but this group's default (min:0, max:-90) is
// DELIBERATELY not numerically ordered (see this group's own top
// comment on why) -- clamping min<=max here would make that default
// impossible to represent. A vertical tick marks the 0-degree point on
// the track, since (unlike Arm Length's all-positive scale) this one
// spans negative and positive values and 0 isn't otherwise obvious.
function buildWristSplayRangeWidget(row) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const TRACK_MIN = -180, TRACK_MAX = 180
  const toPct = (deg) => THREE.MathUtils.clamp((deg - TRACK_MIN) / (TRACK_MAX - TRACK_MIN) * 100, 0, 100)
  const fromPct = (pct) => Math.round(TRACK_MIN + (pct / 100) * (TRACK_MAX - TRACK_MIN))

  const wrap = elLocal('div', { flex: '1', padding: '6px 4px 2px' })
  const track = elLocal('div', {
    position: 'relative', height: '18px', margin: '0 9px',
    background: 'rgba(255,255,255,0.12)', borderRadius: '9px'
  })
  const fill = elLocal('div', { position: 'absolute', top: '0', bottom: '0', background: 'var(--dp-accent, #7d8cff)', opacity: '0.5', borderRadius: '9px' })
  const zeroTick = elLocal('div', { position: 'absolute', top: '-2px', bottom: '-2px', width: '1px', background: 'rgba(255,255,255,0.35)' })
  const minHandle = elLocal('div', {
    position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px',
    background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none'
  })
  const maxHandle = elLocal('div', {
    position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px',
    background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none'
  })
  const readout = elLocal('div', { fontSize: '11px', textAlign: 'center', marginTop: '4px', opacity: '0.85' })
  track.appendChild(fill); track.appendChild(zeroTick); track.appendChild(minHandle); track.appendChild(maxHandle)
  wrap.appendChild(track); wrap.appendChild(readout)
  row.appendChild(wrap)

  let current = { min: 0, max: -90 }
  try { current = JSON.parse(input.value) } catch (e) { /* keep default */ }
  let lastSeenValue = input.value

  function redraw() {
    const minPct = toPct(current.min), maxPct = toPct(current.max)
    const leftPct = Math.min(minPct, maxPct), rightPct = Math.max(minPct, maxPct)
    fill.style.left = leftPct + '%'
    fill.style.right = (100 - rightPct) + '%'
    zeroTick.style.left = toPct(0) + '%'
    minHandle.style.left = minPct + '%'
    maxHandle.style.left = maxPct + '%'
    readout.textContent = `Min (Farthest Hand): ${current.min}°  Max (Nearest Hand): ${current.max}°`
  }
  redraw()
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try { current = JSON.parse(input.value); redraw() } catch (e) { /* leave displayed state as-is */ }
  })

  function startDrag(handleKey) {
    return (downEv) => {
      downEv.preventDefault()
      function onMove(moveEv) {
        const rect = track.getBoundingClientRect()
        if (rect.width <= 0) return // hidden/mid-collapse-transition -- see Arm Length's own range widget for the real bug this guard fixes
        const pct = THREE.MathUtils.clamp((moveEv.clientX - rect.left) / rect.width, 0, 1) * 100
        current[handleKey] = fromPct(pct)
        redraw()
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        commitTextControl(input, JSON.stringify(current))
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
  }
  minHandle.addEventListener('pointerdown', startDrag('min'))
  maxHandle.addEventListener('pointerdown', startDrag('max'))
}

// Responsive Wrist Splay's own curve widget -- identical shape to
// buildArmLengthCurveWidget() above (same 0-1 x 0-1 Catmull-Rom point
// editor, reusing evaluateArmLengthCurve() directly since it's already
// fully generic), only the caption text differs (splay, not crop) and
// right-click-delete is included from the start (see the Arm Length
// widget's own comment on why it was added there).
function buildWristSplayCurveWidget(row) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const W = 240, H = 120
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('width', W); svg.setAttribute('height', H)
  Object.assign(svg.style, { background: 'rgba(255,255,255,0.06)', borderRadius: '4px', marginTop: '6px', touchAction: 'none', cursor: 'crosshair' })
  const axisX = document.createElementNS(svgNS, 'line')
  axisX.setAttribute('x1', 0); axisX.setAttribute('y1', H - 1); axisX.setAttribute('x2', W); axisX.setAttribute('y2', H - 1)
  axisX.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  const axisY = document.createElementNS(svgNS, 'line')
  axisY.setAttribute('x1', 1); axisY.setAttribute('y1', 0); axisY.setAttribute('x2', 1); axisY.setAttribute('y2', H)
  axisY.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  const curvePath = document.createElementNS(svgNS, 'path')
  curvePath.setAttribute('fill', 'none'); curvePath.setAttribute('stroke', 'var(--dp-accent, #7d8cff)'); curvePath.setAttribute('stroke-width', '2')
  svg.appendChild(axisX); svg.appendChild(axisY); svg.appendChild(curvePath)
  const caption = elLocal('div', { fontSize: '10px', opacity: '0.7', marginTop: '3px', textAlign: 'center' }, { text: 'X: Distance From Cursor (%, Nearest→Farthest Hand This Frame)  ·  Y: Splay Fraction (0=Min End, 1=Max End)' })
  row.appendChild(svg)
  row.appendChild(caption)

  let points = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
  try {
    const parsed = JSON.parse(input.value)
    if (Array.isArray(parsed) && parsed.length >= 2) points = parsed.sort((a, b) => a.x - b.x)
  } catch (e) { /* keep default */ }

  const toPx = (p) => ({ x: p.x * W, y: (1 - p.y) * H })
  const fromPx = (px, py) => ({ x: THREE.MathUtils.clamp(px / W, 0, 1), y: THREE.MathUtils.clamp(1 - py / H, 0, 1) })
  let circles = []

  function commitPoints() {
    points.sort((a, b) => a.x - b.x)
    commitTextControl(input, JSON.stringify(points))
  }
  const CURVE_SAMPLES = 48
  function redraw() {
    let d = ''
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const x = i / CURVE_SAMPLES
      const y = THREE.MathUtils.clamp(evaluateArmLengthCurve(points, x), 0, 1)
      const px = toPx({ x, y })
      d += (i === 0 ? 'M' : 'L') + px.x.toFixed(2) + ',' + px.y.toFixed(2) + ' '
    }
    curvePath.setAttribute('d', d.trim())
    circles.forEach((c) => svg.removeChild(c))
    circles = points.map((p, i) => {
      const px = toPx(p)
      const c = document.createElementNS(svgNS, 'circle')
      c.setAttribute('cx', px.x); c.setAttribute('cy', px.y); c.setAttribute('r', 5)
      c.setAttribute('fill', 'var(--dp-accent, #7d8cff)')
      Object.assign(c.style, { cursor: 'grab' })
      let dragged = false
      c.addEventListener('pointerdown', (downEv) => {
        downEv.stopPropagation()
        dragged = false
        const isEndpoint = i === 0 || i === points.length - 1
        function onMove(moveEv) {
          const rect = svg.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          dragged = true
          const np = fromPx(moveEv.clientX - rect.left, moveEv.clientY - rect.top)
          if (isEndpoint) { p.y = np.y } else { p.x = np.x; p.y = np.y }
          redraw()
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (dragged) commitPoints()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      function deletePointIfRemovable() {
        if (points.length > 2 && i !== 0 && i !== points.length - 1) {
          points.splice(points.indexOf(p), 1)
          redraw()
          commitPoints()
        }
      }
      c.addEventListener('dblclick', (dblEv) => {
        dblEv.stopPropagation()
        deletePointIfRemovable()
      })
      c.addEventListener('contextmenu', (ctxEv) => {
        ctxEv.preventDefault()
        ctxEv.stopPropagation()
        deletePointIfRemovable()
      })
      svg.appendChild(c)
      return c
    })
  }
  svg.addEventListener('click', (clickEv) => {
    if (clickEv.target.tagName === 'circle') return
    const rect = svg.getBoundingClientRect()
    const np = fromPx(clickEv.clientX - rect.left, clickEv.clientY - rect.top)
    if (np.x <= 0 || np.x >= 1) return
    points.push(np)
    redraw()
    commitPoints()
  })
  redraw()
  let lastSeenValue = input.value
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try {
      const parsed = JSON.parse(input.value)
      if (Array.isArray(parsed) && parsed.length >= 2) { points = parsed.sort((a, b) => a.x - b.x); redraw() }
    } catch (e) { /* leave displayed state as-is */ }
  })
}

// -----------------------------------------------------------------------
// Click-Hold Pose -- on mousedown+hold, every hand transitions from its
// CURRENT pose to a chosen Target Pose; on release, transitions back to
// the code-default pose. Left-click ('chp') and right-click ('rchp') are
// 2 fully independent instances of the same mechanism, keyed by their
// own control prefix throughout this section.
//
// STATE MACHINE, per hand per trigger (`hand._chp[p]`, lazily created by
// getOrInitHandCHP() the first frame it's needed -- avoids touching
// rebuildField()'s own hand-construction code): 'idle' (no override,
// the hand's pose is driven entirely by the normal shared cfg/Pose-group
// pipeline, completely unaffected by this feature) -> 'forward' (while
// the button is held, or briefly after release if that hand's own
// forward transition hadn't caught up to real time yet -- see below) ->
// 'retransition' (after release, until this hand's OWN retransition
// finishes) -> back to 'idle'.
//
// Per-hand START-TIME STAGGERING reuses the exact same distance-curve-
// range pipeline Arm Length/Responsive Wrist Splay already use
// (evaluateArmLengthCurve(), already fully generic) -- computed ONCE,
// from a live distance snapshot taken at the exact moment the
// button goes down (forward) or up (retransition), not continuously
// re-evaluated during the hold/release, so a moving cursor mid-gesture
// doesn't reshuffle which hand goes first partway through. Setting a
// trigger's own Min Start Time equal to its Max collapses every hand to
// the SAME delay, satisfying "choose if they all transition together,
// or if... based on distance from cursor" directly through the existing
// range control -- no separate toggle needed.
//
// RETRANSITION uses each hand's own CURRENT interpolated pose (captured
// at the exact moment of release, not the target pose) as ITS OWN
// retransition start -- correct even when release happens mid-
// transition, before every hand reached the target: a hand only 40% of
// the way there retransitions back to default FROM that 40% point, not
// from the (never-reached) full target.
//
// DISCLOSED SCOPE DECISION: interpolation covers the 27 finger-curl +
// wrist-bend/-splay keys only, EXCLUDING modelRotX/Y/Z (Whole-Hand
// Rotation) from POSE_PRESET_KEYS. Those 3 drive `cloneBaseQuat`, a
// SINGLE shared value computed once from `cfg` and used identically by
// every hand's own Arm Length position-compensation math (see
// updateCloneBaseQuat()) -- making them genuinely per-hand-
// interpolatable would mean a per-hand cloneBaseQuat and touching that
// compensation math too, a materially larger change than this feature
// asked for. In practice this is a near-total non-issue: real saved
// poses/targets essentially always carry modelRotX/Y/Z = 0 (confirmed
// against the user's own pasted Copy Settings dump, every saved pose
// listed there has all 3 at exactly 0), so the exclusion is invisible
// for real-world use; only a saved pose that deliberately rotates the
// whole hand model would notice its own Whole-Hand Rotation staying at
// whatever the shared cfg sliders currently say throughout the hold.
// 'dcHold' added 2026-09-15 -- Double Click Hold rebuilt as a literal 3rd
// instance of this same machinery (see its own DEV_GROUPS comment for the
// full account). Placed LAST so it still wins the "whichever runs last
// this frame wins" tie-break over chp/rchp if somehow simultaneously
// active on the same hand, matching its own former priority as the
// explicitly-checked-last trigger in animate()'s per-hand loop (now
// folded into this same array/forEach instead of a separate check).
// `tripleClickHold`/`quadClickHold` added 2026-09-16 (direct request) --
// generalized from a 3-entry hand-written literal (chp/rchp/dcHold) into
// one generated from CLICK_HOLD_KEYS, since all 5 entries share the
// exact same shape; keeps a 6th/7th future trigger a one-line array add
// instead of a 4th near-duplicate literal to keep in sync by hand.
const CLICK_HOLD_KEYS = ['chp', 'rchp', 'dcHold', 'tripleClickHold', 'quadClickHold']
const clickHoldPoseTriggers = Object.fromEntries(CLICK_HOLD_KEYS.map((p) => [p, {
  active: false, holdStartTime: 0, forwardSnapshot: null, loopPoses: null, loopSegmentMs: 1,
  startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 },
  speedCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], speedRangeParsed: { min: 50, max: 2000 },
  tweenStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStartRangeParsed: { min: 0, max: 300 },
  retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 },
  tweenRetransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenRetransitionRangeParsed: { min: 0, max: 300 },
  tweenStopStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStopStartRangeParsed: { min: 0, max: 300 },
  tweenStopDelayCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStopDelayRangeParsed: { min: 0, max: 2000 }
}]))
function parseClickHoldConfig(p) {
  const t = clickHoldPoseTriggers[p]
  try { t.startCurveParsed = JSON.parse(cfg[`${p}StartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.startRangeParsed = JSON.parse(cfg[`${p}StartTimeRange`]) } catch (e) { /* keep last-good value */ }
  // Animation Speed Curve's own distance->speed curve/range -- see
  // makeClickHoldPoseGroup()'s own control comment for the full
  // reasoning (reuses computeStartDelayMs()'s generic curve-eval math).
  try { t.speedCurveParsed = JSON.parse(cfg[`${p}SpeedCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.speedRangeParsed = JSON.parse(cfg[`${p}SpeedCurveRange`]) } catch (e) { /* keep last-good value */ }
  // Tween's own separate start-time curve/range -- see
  // makeClickHoldPoseGroup()'s own comment for why this is a genuinely
  // distinct pair, not an alias of the 2 lines above.
  try { t.tweenStartCurveParsed = JSON.parse(cfg[`${p}TweenStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.tweenStartRangeParsed = JSON.parse(cfg[`${p}TweenStartTimeRange`]) } catch (e) { /* keep last-good value */ }
  try { t.retransitionCurveParsed = JSON.parse(cfg[`${p}RetransitionStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.retransitionRangeParsed = JSON.parse(cfg[`${p}RetransitionStartTimeRange`]) } catch (e) { /* keep last-good value */ }
  // Tween's own separate RETRANSITION curve/range (direct request: "for
  // all click hold functions, when i select to tween a sequence...
  // provide me 'Retransitioning' settings just like the single poses") --
  // previously Tween mode silently reused the Single-Pose-only trio
  // above even though that row was hidden from view under Tween mode
  // (updateClickTriggerModeVisibility()), so it had no visible/tunable
  // release behavior of its own at all.
  try { t.tweenRetransitionCurveParsed = JSON.parse(cfg[`${p}TweenRetransitionStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.tweenRetransitionRangeParsed = JSON.parse(cfg[`${p}TweenRetransitionStartTimeRange`]) } catch (e) { /* keep last-good value */ }
  // Tween Stop's own 2 curve/range pairs -- see the control's own
  // DEV_GROUPS comment for the full reasoning.
  try { t.tweenStopStartCurveParsed = JSON.parse(cfg[`${p}TweenStopStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.tweenStopStartRangeParsed = JSON.parse(cfg[`${p}TweenStopStartTimeRange`]) } catch (e) { /* keep last-good value */ }
  try { t.tweenStopDelayCurveParsed = JSON.parse(cfg[`${p}TweenStopDelayCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.tweenStopDelayRangeParsed = JSON.parse(cfg[`${p}TweenStopDelayRange`]) } catch (e) { /* keep last-good value */ }
}
function getOrInitHandCHP(hand) {
  if (!hand._chp) hand._chp = {}
  // `pendingClaimAt`/`armedForHoldStartTime`/`pendingFrozenSplayDeg`:
  // the deferred-claim mechanism (direct request -- see
  // updateClickHoldPoseForHand()'s own top comment for the full
  // account). `forwardStartTime`/`forwardSnapshot`/`tweenPosesResolved`
  // are now genuinely PER-HAND (captured at each hand's own claim
  // moment), replacing the old shared `trig.forwardSnapshot`/
  // `trig.tweenPoses` this hand used to read directly. Per-key backfill
  // (not just a first-touch init), same fix/reasoning as
  // getOrInitHandCP()'s own matching comment -- Custom Click+Hold
  // Functions (Phase 4) can grow CLICK_HOLD_KEYS at runtime too, well
  // after some hands' `_chp` was already built for the original static
  // keys.
  CLICK_HOLD_KEYS.forEach((p) => {
    if (hand._chp[p]) return
    hand._chp[p] = { phase: 'idle', forwardStartTime: 0, forwardSnapshot: null, tweenPosesResolved: null, loopStartTime: 0, loopHoldEndTime: 0, loopDirection: 1, retransitionDelay: 0, retransitionStart: null, retransitionStartTime: 0, retransitionIsTween: false, lastAppliedValues: null, frozenSplayDeg: 0, pendingClaimAt: 0, armedForHoldStartTime: -1, pendingFrozenSplayDeg: 0, frozenSpeedMs: 0, pendingFrozenSpeedMs: 0, releasePending: false, stoppingStartTime: 0, stoppingStartDelay: 0, stoppingDelayMs: 1, stoppingLastFrameTime: 0, stoppingBaseElapsedMs: 0, stoppingVirtualElapsedMs: 0, stoppingWasLooping: false, stoppingFreezeAtEnd: false }
  })
  return hand._chp
}
// Linearly interpolates every POSE_PRESET_KEYS value, INCLUDING
// modelRotX/Y/Z, between 2 pose-shaped objects (a saved pose,
// POSE_KEY_DEFAULTS, or a live cfg snapshot -- all 3 share the same key
// shape). Falls back to POSE_KEY_DEFAULTS for any key missing from
// either side (matches previewPosePreset()'s own established "a saved
// pose may predate a newer key" tolerance).
//
// CORRECTED 2026-09-14 (direct user report: "thumb pose of all poses
// except startup still looks wrong," root-caused to poses imported from
// HANDO relying on nonzero Whole-Hand Rotation as part of the gesture --
// see applyPoseValuesToHand()'s own comment for the full account):
// modelRotX/Y/Z used to be EXCLUDED here on the reasoning that they
// drive a single SHARED cloneBaseQuat, making them "genuinely per-hand-
// interpolatable" a materially larger change than this feature's own
// original scope. That tradeoff is now resolved differently -- see
// hand.currentBaseQuat (rebuildField()) and applyHandArmLength()'s own
// updated comment for how a per-hand basis was added without disturbing
// Whole-Hand Rotation's existing single-shared-value behavior for every
// hand that ISN'T mid a pose transition.
function lerpPoseValues(a, b, t) {
  const result = {}
  POSE_PRESET_KEYS.forEach((key) => {
    const av = a[key] !== undefined ? a[key] : POSE_KEY_DEFAULTS[key]
    const bv = b[key] !== undefined ? b[key] : POSE_KEY_DEFAULTS[key]
    result[key] = av + (bv - av) * t
  })
  return result
}
const _poseBaseQuatEuler = new THREE.Euler()
const _poseBaseQuat = new THREE.Quaternion()
// Same formula as updateCloneBaseQuat() (alignQuat * Euler(modelRotX/Y/Z
// in degrees, converted to radians)), just reading a passed-in `values`
// object instead of live `cfg` -- lets a per-hand, mid-transition
// interpolated modelRot produce a per-hand basis without touching
// updateCloneBaseQuat() itself (which still drives the single SHARED
// cloneBaseQuat used by every hand that's currently idle, unchanged).
function computeBaseQuatFromValues(values) {
  _poseBaseQuatEuler.set(
    THREE.MathUtils.degToRad(values.modelRotX),
    THREE.MathUtils.degToRad(values.modelRotY),
    THREE.MathUtils.degToRad(values.modelRotZ)
  )
  _poseBaseQuat.setFromEuler(_poseBaseQuatEuler)
  return _poseBaseQuat.premultiply(alignQuat)
}
// Applies an interpolated pose to ONE hand's own skeleton -- reuses
// applyCurlToSkeleton()/applyWristPoseToSkeleton()'s own existing
// `values` override param (already proven by Pose Preview's own use of
// it), so no new skeleton-posing code was needed for this feature at
// all. `extraSplayDeg` is Responsive Wrist Splay's own per-hand
// contribution, still composed on top during an active Click-Hold-Pose
// override -- the 2 systems stack, consistent with every other
// "independent, stackable" effect in this project.
//
// CORRECTED 2026-09-14: now also updates `hand.currentBaseQuat` from
// THIS call's own `poseValues.modelRotX/Y/Z` (which lerpPoseValues()
// now genuinely interpolates, see its own updated comment) and passes
// THAT per-hand quaternion to applyCurlToSkeleton() as `baseQuat`,
// instead of the single shared `cloneBaseQuat` every hand used to read
// regardless of its own pose-transition state. Root cause of the
// reported bug: a saved pose imported from HANDO can carry nonzero
// Whole-Hand Rotation as an integral part of its own gesture design: the
// fingers/wrist WERE already transitioning correctly, but the finger
// CURL AXES were being pre-rotated by the OLD, unchanged shared
// cloneBaseQuat throughout -- anatomically wrong the instant a pose
// implies a different whole-hand orientation than whatever the field's
// shared Whole-Hand Rotation sliders currently say. This is also why
// only "startup" (no transition in progress, cloneBaseQuat and
// currentBaseQuat trivially equal) looked correct while every actual
// transition didn't.
function applyPoseValuesToHand(hand, poseValues, extraSplayDeg) {
  if (!hand.skinnedMesh) return
  hand.currentBaseQuat.copy(computeBaseQuatFromValues(poseValues))
  // Wrist BEFORE fingers -- see applyAllFingerPoses()'s own comment.
  applyWristPoseToSkeleton(hand.skinnedMesh.skeleton, poseValues, extraSplayDeg)
  FINGER_NAMES.forEach((name) => applyCurlToSkeleton(name, hand.skinnedMesh.skeleton, hand.currentBaseQuat, hand.wrapper.quaternion, poseValues))
  // The ONE place every trigger family (chp/rchp/dcHold/click/dblclick/rc)
  // funnels its own per-frame pose application through, regardless of
  // which phase/mode is driving it -- stashing the values here gives every
  // OTHER trigger a universal, cross-family "wherever this hand actually
  // is right now" snapshot (direct request: a hand interrupted mid-
  // transition by a NEW trigger must smoothly continue from its own
  // current position, never snap to a stale default/trigger-time
  // snapshot). See updateClickHoldPoseForHand()/updateClickPoseForHand()'s
  // own pending-claim comments for how this gets consumed, gated by the
  // already-existing `hand._wasOverriddenLastFrame` so a genuinely IDLE
  // hand's stale old values are never mistaken for "currently active."
  hand._lastPoseValues = poseValues
}
const _offsetRightVec = new THREE.Vector3()
const _offsetUpVec = new THREE.Vector3()
const _offsetEuler = new THREE.Euler()
const _offsetQuat = new THREE.Quaternion()
// Click Function Offset/Rotation (Phase 1) -- composes ADDITIVELY on top
// of whatever cursor-tracking + arm-length already set on hand.wrapper
// this frame. animate()'s own per-frame loop runs tracking rotation
// (quaternion.slerp) and applyHandArmLength() BEFORE calling
// updateRenderOrder() -> updateClickHoldPoseForHand()/
// updateClickPoseForHand(), so hand.wrapper.position/.quaternion already
// hold this frame's base transform by the time this runs -- adding to
// position and right-multiplying the rotation means Offset/Rotation
// layer on top instead of fighting tracking, exactly as required.
// `progress` is the SAME per-hand-staggered forward-phase progress the
// pose-lerp itself uses, so Offset ramps 0->target across the tween
// exactly like Rotation does (direct user choice: "Ramps like Rotation").
function applyOffsetRotationToHand(hand, p, progress) {
  if (cfg[`${p}OffsetEnabled`]) {
    const ox = (cfg[`${p}OffsetX`] || 0) * progress
    const oy = (cfg[`${p}OffsetY`] || 0) * progress
    if (ox !== 0 || oy !== 0) {
      // Camera-relative right/up, not world/local axes -- this project's
      // camera only pans/zooms, never rotates, so these stay a stable
      // "up down left right in browser terms" regardless of framing.
      _offsetRightVec.setFromMatrixColumn(camera.matrixWorld, 0)
      _offsetUpVec.setFromMatrixColumn(camera.matrixWorld, 1)
      hand.wrapper.position.addScaledVector(_offsetRightVec, ox)
      hand.wrapper.position.addScaledVector(_offsetUpVec, oy)
    }
  }
  if (cfg[`${p}RotationEnabled`]) {
    const rx = (cfg[`${p}RotationX`] || 0) * progress
    const ry = (cfg[`${p}RotationY`] || 0) * progress
    const rz = (cfg[`${p}RotationZ`] || 0) * progress
    if (rx !== 0 || ry !== 0 || rz !== 0) {
      _offsetEuler.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'XYZ')
      _offsetQuat.setFromEuler(_offsetEuler)
      // Composes on top of the pose's OWN wrist rotation, never overwrites
      // it -- right-multiply, not assignment.
      hand.wrapper.quaternion.multiply(_offsetQuat)
    }
  }
}
// Tween group's own preset capture/apply -- ONLY `tweenPoses` (the ordered
// array of saved-pose NAMES, same shape 'multi-select' always stores),
// unlike HANDO's equivalent which also bundles camera/lighting ("We dont
// need that. we just need poses" -- direct user request).
function captureTweenSequencePreset() {
  return { tweenPoses: (cfg.tweenPoses || []).slice() }
}
function useTweenSequencePreset(item) {
  if (item.tweenPoses !== undefined) {
    cfg.tweenPoses = item.tweenPoses.slice()
    syncValue('tweenPoses', cfg.tweenPoses)
    safeRefreshMultiSelectOptions('tweenPoses')
  }
}
// Resolves an ordered array of saved-pose NAMES into the actual pose
// objects from `cfg.savedPoses`, dropping any name that's empty (an
// unfilled row) or no longer exists (deleted since) -- same logic and
// same "last match wins" duplicate-name tie-break as HANDO's own
// resolveTweenPoses(), ported here rather than re-derived.
function resolveTweenSequencePoses(names) {
  return (names || [])
    .map((name) => {
      const matches = (cfg.savedPoses || []).filter((p) => p.name === name)
      return matches[matches.length - 1]
    })
    .filter(Boolean)
}
// Interpolates across a WHOLE ordered sequence of pose-shaped objects at
// fraction `t` (0 = poses[0], 1 = poses[last]) -- same segment-finding
// math as HANDO's own applyPoseTween(), generalized to return a values
// object (for applyPoseValuesToHand()) instead of writing straight to
// cfg/sliders, since Double Click Hold Tween (below) never previews on
// the Pose group's own sliders, exactly like Click-Hold-Pose/Click-Pose
// don't either.
function lerpTweenSequence(poses, t) {
  if (!poses || poses.length === 0) return null
  if (poses.length === 1) return lerpPoseValues(poses[0], poses[0], 0)
  const segments = poses.length - 1
  const scaled = THREE.MathUtils.clamp(t, 0, 1) * segments
  const segIndex = Math.min(Math.floor(scaled), segments - 1)
  const localT = scaled - segIndex
  return lerpPoseValues(poses[segIndex], poses[segIndex + 1], localT)
}
// Double Click Hold Tween's own Loop mode, and now also Click Hold-Pose/
// Right-Click Hold-Pose's own Loop Mode dropdown (direct follow-up
// request): once the initial forward pass finishes, keep cycling
// through EVERY pose the forward pass played (poseN->...->pose1->
// default->pose1->...->poseN, wrapping) for as long as the hold
// continues. CORRECTED 2026-09-15: `poses` here used to be JUST the
// named poses (the default pose deliberately excluded, per an earlier
// request); direct follow-up clarification ("when i said the looping
// disregards the first pose, i meant the default pose. All poses saved
// in tweens should be looped") reversed that -- callers now pass the
// SAME full sequence (default + named poses) the forward pass already
// used, not a stripped-down version, so nothing about this function
// itself needed to change. `tCyclic` is an unbounded, ever-increasing
// position along the loop (not clamped to [0,1] like lerpTweenSequence's
// `t`) -- its integer part selects which segment, its fractional part is
// the local lerp within that segment; wrapping is just `% poses.length`,
// so the caller never needs to reset a counter or track lap count.
function lerpLoopSequence(poses, tCyclic) {
  if (!poses || poses.length === 0) return null
  const segments = poses.length
  const wrapped = ((tCyclic % segments) + segments) % segments // stays positive regardless of sign
  const segIndex = Math.floor(wrapped)
  const localT = wrapped - segIndex
  return lerpPoseValues(poses[segIndex], poses[(segIndex + 1) % segments], localT)
}
function computeStartDelayMs(distanceToCursor, minLiveDist, liveDistRange, curveParsed, rangeParsed) {
  const normDist = THREE.MathUtils.clamp((distanceToCursor - minLiveDist) / liveDistRange, 0, 1)
  const curveY = THREE.MathUtils.clamp(evaluateArmLengthCurve(curveParsed, normDist), 0, 1)
  return rangeParsed.min + (rangeParsed.max - rangeParsed.min) * curveY
}
// NaN/undefined-safe read for `${p}TweenSpeedMs` -- a real, previously-
// fixed bug class (a stale saved-settings value predating this control,
// e.g. from before Tween mode existed for a given trigger, dividing down
// into a NaN `t`/`tCyclic`, then `poses[NaN]` -> undefined ->
// lerpPoseValues() throwing on `undefined[key]` INSIDE animate() every
// single frame -- silently freezing the screen at whatever was last
// rendered, indistinguishable from "nothing responds to clicks anymore").
// Originally fixed only for Double Click Hold's own bespoke tween speed
// read; ported here so all 5 Click-family Tween-mode triggers (chp/rchp/
// click/dblclick/rc, now including dcHold once it shares this exact
// machinery -- see makeClickHoldPoseGroup()'s own DEV_GROUPS comment)
// share the same protection instead of just the one trigger that
// happened to hit it first.
function safeTweenSpeedMs(v) { return Number.isFinite(v) ? v : 800 }
// Called once per hand per trigger, per frame, from updateRenderOrder()'s
// own existing per-hand loop -- reuses that loop's own `live`/
// `minLiveDist`/`liveDistRange` (Arm Length/Wrist Splay's own live-
// distance values), not a 3rd distance pass. A no-op (returns without
// touching the hand's pose at all) whenever this hand's own phase is
// 'idle' for this trigger, leaving the normal cfg-driven pose pipeline
// completely in control, exactly as before this feature existed.
//
// CORRECTED 2026-09-14: 'forward'/'retransition' now apply
// `chp.frozenSplayDeg` (captured once, at the instant this hand's own
// 'forward' phase begins) instead of recomputing
// computeResponsiveWristSplayDeg() live every frame. Root cause of the
// user-reported "thumb shifts on click" symptom: Responsive Wrist
// Splay is a LIVE, cursor-distance-driven wrist rotation, and it used
// to keep recalculating throughout an entire transition -- so any
// cursor movement during the hold/transition made the thumb (the only
// finger parented to the wrist bone) visibly chase a moving target
// instead of following a clean pose interpolation. Freezing it at
// trigger time makes a triggered transition deterministic and matches
// whatever was already visible the instant before the trigger, while
// idle hands (this function's own no-op branch, left untouched) keep
// tracking Responsive Wrist Splay fully live exactly as before -- the
// 2 features now both work, on their own terms, instead of fighting.
// CORRECTED 2026-09-16 (direct request): "when a hand is mid transition
// (a tween), if i trigger another command/pose tween during that time, I
// dont want the hands to snap back to the new tween's starting position.
// I want them to continue their existing transition until it gets
// interrupted by the new one... not every hand has to change upon the
// 2nd trigger. Thus, the ones that arent triggered yet will continue
// their first tween. When they do get interrupted (after the delay
// time) by the 2nd trigger, they will smoothly begin transitioning from
// their current position instead of the default position." Previously,
// once `trig.active` flipped true and HoldConfirmMs elapsed, EVERY hand
// was claimed (chp.phase='forward') in the SAME frame, using a single
// SHARED `trig.forwardSnapshot`/`trig.tweenPoses` captured once at
// hold-start (effectively "the default pose") -- a hand's own distance-
// based delay only delayed when it started VISIBLY MOVING, not when it
// got claimed, so a hand mid-retransition (or mid a totally different
// trigger) got its old phase silently overwritten and its very next
// applied value was that stale shared snapshot -- a real snap.
//
// Fixed with a genuine 2-stage DEFERRED claim: the block below only
// ARMS a pending claim (computes and stores this hand's own delay, once,
// per hold-start -- `chp.armedForHoldStartTime` dedupes so this doesn't
// re-arm every frame while waiting) once HoldConfirmMs has passed; it
// does NOT touch `chp.phase` at all. A separate COMMIT step further down
// only takes over -- reading `chp.forwardSnapshot` fresh, from this
// hand's own live current pose -- once that hand's own delay has
// genuinely elapsed. Until commit, `chp.phase` is left exactly as it
// was, so whatever phase branch below (forward/looping/retransition) was
// already running for this hand keeps running completely unaffected --
// literally "continue their first tween" for as long as the 2nd
// trigger's own per-hand delay hasn't elapsed yet.
// Shared by updateClickHoldPoseForHand()'s own forward/looping phases
// (Complete-Sequence mode's own natural-completion stop) -- begins this
// hand's retransition using the SAME Tween Retransition Start Time
// Curve/Range every OTHER tween-retransition path already uses, except
// when Trigger All Hands is on, which bypasses that per-hand stagger
// entirely (delay 0, every hand starts together) per the direct
// clarification (AskUserQuestion, 2026-09-17).
function beginTweenReleaseStop(chp, trig, p, values, live, minLiveDist, liveDistRange, now) {
  chp.retransitionStart = values
  chp.retransitionStartTime = now
  const triggerAllHands = !!cfg[`${p}TriggerAllHands`]
  chp.retransitionDelay = triggerAllHands ? 0 : computeStartDelayMs(live, minLiveDist, liveDistRange, trig.tweenRetransitionCurveParsed, trig.tweenRetransitionRangeParsed)
  chp.retransitionIsTween = true
  chp.phase = 'retransition'
  chp.releasePending = false
}
function updateClickHoldPoseForHand(hand, p, live, minLiveDist, liveDistRange, now) {
  const trig = clickHoldPoseTriggers[p]
  const chp = getOrInitHandCHP(hand)[p]
  if (trig.active && chp.armedForHoldStartTime !== trig.holdStartTime && now - trig.holdStartTime >= (cfg[`${p}HoldConfirmMs`] ?? 0)) {
    chp.armedForHoldStartTime = trig.holdStartTime // dedupe -- arm exactly once per hold-start, not every frame spent waiting
    const isTweenStart = cfg[`${p}Mode`] === 'Sequence'
    // Start Time Curve on/off (Single Pose only, direct spec item) --
    // Off means no distance-based stagger at all, every hand starts
    // immediately. Sequence/Tween mode's own start stagger is unaffected
    // by this gate (a disclosed scoping choice -- see the control's own
    // comment in makeClickHoldPoseGroup()).
    const delay = isTweenStart
      ? computeStartDelayMs(live, minLiveDist, liveDistRange, trig.tweenStartCurveParsed, trig.tweenStartRangeParsed)
      : (cfg[`${p}StartTimeCurveEnabled`] === false ? 0 : computeStartDelayMs(live, minLiveDist, liveDistRange, trig.startCurveParsed, trig.startRangeParsed))
    chp.pendingClaimAt = now + delay
    chp.pendingFrozenSplayDeg = computeResponsiveWristSplayDeg(live, minLiveDist, liveDistRange)
    // Animation Speed Curve (Single Pose only) -- computed once here,
    // same "frozen at arm time" treatment as the splay/delay above, not
    // recomputed live mid-transition. See makeClickHoldPoseGroup()'s own
    // control comment for the full reasoning.
    chp.pendingFrozenSpeedMs = (!isTweenStart && cfg[`${p}SpeedCurveEnabled`]) ? computeStartDelayMs(live, minLiveDist, liveDistRange, trig.speedCurveParsed, trig.speedRangeParsed) : 0
  }
  if (chp.pendingClaimAt && now >= chp.pendingClaimAt) {
    // COMMIT -- this hand's own delay has elapsed; take over right now.
    // FROM value is this hand's own live current pose (`hand._lastPoseValues`,
    // stashed by applyPoseValuesToHand() every time ANY trigger family
    // applies a value) whenever `hand._wasOverriddenLastFrame` confirms
    // it was genuinely mid-SOMETHING as of last frame -- covers both
    // same-trigger re-interruption and a totally different trigger
    // family, per the direct request's own "another command/pose tween."
    // A genuinely idle hand (never touched, or already fully settled)
    // falls back to the shared hold-start snapshot exactly as before --
    // `poseDefaultValues` specifically for dcHold's own twice-confirmed
    // "always starts from default" exception (see startClickHoldPose()'s
    // own comment), which only still applies to the genuinely-idle case;
    // an interrupted dcHold now also continues smoothly like every other
    // trigger, since that's what this new request asks for. Extended
    // 2026-09-16 to tripleClickHold/quadClickHold too -- both are the
    // same multi-click-hold gesture family as dcHold, just a longer
    // chain, so they inherit dcHold's own exception rather than chp/
    // rchp's plain-single-press-hold behavior.
    const wasActive = hand._wasOverriddenLastFrame && hand._lastPoseValues
    const isMultiClickHoldFamily = p === 'dcHold' || p === 'tripleClickHold' || p === 'quadClickHold'
    chp.forwardSnapshot = wasActive ? hand._lastPoseValues : (isMultiClickHoldFamily ? poseDefaultValues : trig.forwardSnapshot)
    chp.tweenPosesResolved = (trig.loopPoses && trig.loopPoses.length >= 1) ? [chp.forwardSnapshot, ...trig.loopPoses] : null
    chp.phase = 'forward'
    chp.forwardStartTime = now
    chp.frozenSplayDeg = chp.pendingFrozenSplayDeg
    chp.frozenSpeedMs = chp.pendingFrozenSpeedMs
    chp.pendingClaimAt = 0
    chp.releasePending = false // a NEW hold-claim always starts fresh, regardless of a stale flag from a previous release
  }
  if (chp.phase === 'forward') {
    // Tween mode (added 2026-09-15, see makeClickHoldPoseGroup()'s own
    // comment) -- `chp.tweenPosesResolved` is built once at THIS hand's
    // own commit above (its own FROM snapshot + the hold's shared named
    // poses); only the named poses themselves are shared across hands,
    // same as before. Uses its own separate `${p}TweenSpeedMs`, not
    // `${p}TransitionSpeedMs` -- see makeClickHoldPoseGroup()'s comment.
    // No `forwardDelay` subtraction needed anymore -- that delay is now
    // fully spent BEFORE commit (see the pending-claim block above), so
    // visible movement starts immediately at `chp.forwardStartTime`.
    const isTween = cfg[`${p}Mode`] === 'Sequence'
    const elapsed = now - chp.forwardStartTime
    // Animation Speed Curve (Single Pose only) overrides the flat
    // TransitionSpeedMs slider when enabled -- `chp.frozenSpeedMs` was
    // computed once at this hand's own commit above.
    const speedMs = Math.max(isTween ? safeTweenSpeedMs(cfg[`${p}TweenSpeedMs`]) : (cfg[`${p}SpeedCurveEnabled`] ? chp.frozenSpeedMs : cfg[`${p}TransitionSpeedMs`]), 1)
    const progress = THREE.MathUtils.clamp(elapsed / speedMs, 0, 1)
    let values
    if (isTween) {
      if (!chp.tweenPosesResolved || chp.tweenPosesResolved.length < 2) return // nothing selected -- leave this hand's pose untouched
      values = lerpTweenSequence(chp.tweenPosesResolved, progress)
      // On Release Mode = 'Complete Sequence' (direct spec item) -- a
      // release happened WHILE this forward pass was still playing
      // (endClickHoldPose() left `chp.phase` untouched and only set
      // `chp.releasePending` in that case, see its own comment). Now
      // that this pass has genuinely finished naturally, stop right
      // here -- even if Loop Mode is active, "complete sequence" means
      // finish the ONE pass in progress, not start a brand new loop.
      if (progress >= 1 && chp.releasePending) {
        chp.lastAppliedValues = values
        applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
        applyOffsetRotationToHand(hand, p, progress)
        beginTweenReleaseStop(chp, trig, p, values, live, minLiveDist, liveDistRange, now)
        return
      }
      // Loop Mode -- direct follow-up request, ported from Double Click
      // Hold Tween's own Loop checkbox, then extended with an Oscillate
      // option (see makeClickHoldPoseGroup()'s own comment). Only
      // engages once the initial forward pass genuinely completes AND
      // there are >=2 poses to cycle through (a 1-pose "sequence" has no
      // meaningful loop/oscillate either way).
      const loopMode = cfg[`${p}LoopMode`]
      if (progress >= 1 && loopMode !== 'Off' && trig.loopPoses && trig.loopPoses.length >= 2) {
        chp.phase = 'looping'
        chp.loopStartTime = now
        chp.loopHoldEndTime = 0
        // Oscillate's first lap plays BACKWARD (last named pose -> first),
        // continuing seamlessly from where forward just ended -- direction
        // -1 means "start at the end (`segments`), head toward 0," see
        // the 'looping' phase's own comment. Loop mode ignores this
        // (always the same wrap direction).
        chp.loopDirection = -1
      }
    } else {
      const targetPose = (cfg.savedPoses || []).find((sp) => sp.name === cfg[`${p}TargetPose`])
      if (!targetPose) return // nothing selected -- leave this hand's pose untouched
      values = lerpPoseValues(chp.forwardSnapshot, targetPose, progress)
    }
    chp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, progress)
  } else if (chp.phase === 'looping') {
    // Continues for as long as the hold lasts. Both cycling styles share
    // this one phase, branching only on which lerp function to call --
    // `trig.loopPoses`/`trig.loopSegmentMs` (set once at hold-start,
    // shared by every hand) mean the same thing either way. `endClickHoldPose()`
    // reads `chp.lastAppliedValues` the same way regardless of whether
    // release happens during 'forward'/'looping' or mid-hold -- no
    // separate release handling needed for any of those.
    //
    // Hold Duration (direct follow-up request: "provide a slider to set
    // a hold duration at the end of a single sequence... sequence, hold,
    // repeat, hold, etc, OR sequence, hold, reverse sequence, hold,
    // etc") -- splits what used to be one continuous, never-restarting
    // cyclic formula into discrete LAPS, each ending in an optional
    // pause before the next one starts. A "lap" is one full wrap
    // (Loop) or one one-way traversal (Oscillate, reversing direction
    // each lap -- "reverse sequence" is literally alternating
    // `chp.loopDirection`).
    if (chp.loopHoldEndTime && now < chp.loopHoldEndTime) {
      // Mid-hold -- reapply the frozen end-of-lap pose (not a no-op:
      // other config-driven state can still change during a hold, same
      // convention as the 'paused' phase elsewhere in this file).
      applyPoseValuesToHand(hand, chp.lastAppliedValues, chp.frozenSplayDeg)
      applyOffsetRotationToHand(hand, p, 1) // looping only starts once the forward ramp is fully complete
      return
    }
    if (chp.loopHoldEndTime && now >= chp.loopHoldEndTime) {
      // Hold just ended -- start the next lap fresh from right now (not
      // from when the hold began), and flip direction for Oscillate so
      // "repeat" alternates forward/backward each lap.
      chp.loopHoldEndTime = 0
      chp.loopStartTime = now
      if (cfg[`${p}LoopMode`] === 'Oscillate') chp.loopDirection *= -1
    }
    const elapsedSegments = (now - chp.loopStartTime) / trig.loopSegmentMs
    let values, lapT
    if (cfg[`${p}LoopMode`] === 'Oscillate') {
      const segments = trig.loopPoses.length - 1
      const startPos = chp.loopDirection === 1 ? 0 : segments
      const endPos = chp.loopDirection === 1 ? segments : 0
      lapT = THREE.MathUtils.clamp(elapsedSegments / segments, 0, 1)
      const position = startPos + (endPos - startPos) * lapT
      values = lerpTweenSequence(trig.loopPoses, position / segments)
    } else {
      // "Start at the WRAP segment, not segment 0" -- the forward pass
      // just ended exactly at the last pose, so starting the cycle at
      // `loopPoses[0]` would jump backward. One full lap = advancing by
      // exactly `segments` (a complete wrap back to the same relative
      // position). `lapT` itself stays UNCLAMPED (so an overshoot frame
      // still gets detected as "past the boundary" below), but the value
      // actually applied uses a clamped elapsed count -- otherwise a slow
      // frame that overshoots past the true boundary before this check
      // ever runs would freeze the hold at that overshot, slightly-past-
      // the-pose interpolated value instead of the clean boundary pose
      // (confirmed live: without the clamp, a hold sometimes froze at an
      // arbitrary mid-transition value like -64 instead of the intended
      // -1).
      const segments = trig.loopPoses.length
      lapT = elapsedSegments / segments
      const tCyclic = (segments - 1) + Math.min(elapsedSegments, segments)
      values = lerpLoopSequence(trig.loopPoses, tCyclic)
    }
    chp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1) // looping only starts once the forward ramp is fully complete
    if (lapT >= 1) {
      // On Release Mode = 'Complete Sequence' -- a release happened
      // while this lap was already looping (see the forward phase's own
      // matching comment). Finish the CURRENT lap (just completed, right
      // above), then stop -- don't start another lap.
      if (chp.releasePending) {
        beginTweenReleaseStop(chp, trig, p, values, live, minLiveDist, liveDistRange, now)
      } else {
        const holdMs = Math.max(cfg[`${p}LoopHoldMs`] ?? 0, 0)
        if (holdMs > 0) chp.loopHoldEndTime = now + holdMs
        else chp.loopStartTime = now // no hold configured -- restart the lap clock seamlessly, same as the old always-continuous behavior
      }
    }
  } else if (chp.phase === 'stopping') {
    // Tween Stop Delay's own deceleration -- direct spec item, see
    // endClickHoldPose()'s own comment for the full reasoning and the
    // disclosed looping-vs-forward simplification. All per-hand staggers
    // (stoppingStartDelay/stoppingDelayMs) were already resolved once, at
    // release time, in endClickHoldPose() -- this phase just advances a
    // virtual elapsed-time accumulator at a linearly-decaying rate (1 ->
    // 0 over `chp.stoppingDelayMs`) instead of real wall-clock time, so
    // the tween's own effective playback speed visibly slows to a stop
    // rather than continuing at full speed until it's abruptly cut off.
    const dt = Math.max(0, now - chp.stoppingLastFrameTime)
    chp.stoppingLastFrameTime = now
    const elapsedSinceRelease = now - chp.stoppingStartTime
    if (elapsedSinceRelease < chp.stoppingStartDelay) {
      // Still waiting for this hand's own Tween Stop Start Time stagger
      // to begin -- completely frozen at whatever was already showing,
      // same convention as every other phase's own pre-stagger hold.
      applyPoseValuesToHand(hand, chp.lastAppliedValues, chp.frozenSplayDeg)
      applyOffsetRotationToHand(hand, p, 1)
      return
    }
    const tDecay = THREE.MathUtils.clamp((elapsedSinceRelease - chp.stoppingStartDelay) / chp.stoppingDelayMs, 0, 1)
    const decayFactor = 1 - tDecay // linear ease-out to 0 -- "progressively slowdown to a stop"
    let values
    if (chp.stoppingWasLooping) {
      // Disclosed simplification (see endClickHoldPose()'s own comment)
      // -- an already-cycling hand just holds its release-moment pose
      // for the whole delay rather than continuing to visibly animate.
      values = chp.lastAppliedValues
    } else {
      const speedMs = Math.max(safeTweenSpeedMs(cfg[`${p}TweenSpeedMs`]), 1)
      chp.stoppingVirtualElapsedMs += dt * decayFactor
      const progress = THREE.MathUtils.clamp((chp.stoppingBaseElapsedMs + chp.stoppingVirtualElapsedMs) / speedMs, 0, 1)
      values = (chp.tweenPosesResolved && chp.tweenPosesResolved.length >= 2) ? lerpTweenSequence(chp.tweenPosesResolved, progress) : chp.lastAppliedValues
    }
    chp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1)
    if (tDecay >= 1) {
      if (chp.stoppingFreezeAtEnd) { chp.phase = 'idle'; return } // "the hand will just stop where it is"
      chp.retransitionStart = values
      chp.retransitionStartTime = now
      chp.retransitionDelay = 0 // the deceleration itself already served as this hand's own stop stagger
      chp.phase = 'retransition'
    }
  } else if (chp.phase === 'retransition') {
    // Tween mode's own dedicated Retransition Speed (direct request --
    // see makeClickHoldPoseGroup()'s own comment) -- `chp.retransitionIsTween`
    // is captured once, in endClickHoldPose(), at the moment retransition
    // actually starts, so a live Mode change mid-retransition can't yank
    // this hand between the 2 settings pairs mid-flight.
    const elapsed = now - chp.retransitionStartTime
    const speedMs = Math.max(chp.retransitionIsTween ? cfg[`${p}TweenRetransitionSpeedMs`] : cfg[`${p}RetransitionSpeedMs`], 1)
    const progress = elapsed < chp.retransitionDelay ? 0 : THREE.MathUtils.clamp((elapsed - chp.retransitionDelay) / speedMs, 0, 1)
    const values = lerpPoseValues(chp.retransitionStart, poseDefaultValues, progress)
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1 - progress) // ramps back down to 0 as the hand returns to default, inverse of the forward ramp
    if (progress >= 1) chp.phase = 'idle' // fully settled at default -- stop overriding, normal cfg-driven posing (inert here since it only re-applies on slider change, not every frame) silently regains control
  }
}
function startClickHoldPose(p) {
  if (!cfg[`${p}Enabled`]) return
  const trig = clickHoldPoseTriggers[p]
  trig.active = true
  trig.holdStartTime = nowVirtual() // virtual clock (see its own declaration) so Global Pause doesn't shift this trigger's forward-phase elapsed time
  trig.forwardSnapshot = {}
  POSE_PRESET_KEYS.forEach((key) => { trig.forwardSnapshot[key] = cfg[key] })
  // Tween mode's own named-pose sequence (see updateClickHoldPoseForHand()'s
  // own comment) -- resolved once per hold-start, shared by every hand;
  // only each hand's own forward delay is staggered, same as Single Pose
  // mode. The sequence's own ANCHOR (what it transitions FROM) is
  // deliberately NOT built in here anymore -- each hand resolves its own
  // anchor at its own commit moment, from wherever it actually is right
  // then (see updateClickHoldPoseForHand()'s own pending-claim comment
  // for the full account, including dcHold's own preserved "always
  // starts from default when genuinely idle" exception).
  if (cfg[`${p}Mode`] === 'Sequence') {
    const seq = (cfg.savedTweenSequences || []).find((s) => s.name === cfg[`${p}TweenSelector`])
    const namedPoses = seq ? resolveTweenSequencePoses(seq.tweenPoses) : []
    // Loop/Oscillate's own cyclic sequence -- named poses ONLY, excluding
    // the anchor (briefly changed to include it, reverted same day -- "no
    // you're not meant to include the default pose... i guess we had it
    // correct previously," see this same function's own git history).
    // Paced by
    // this SAME hold's `${p}TweenSpeedMs`, divided across the named
    // poses. Computed regardless of whether Loop Mode is actually Off
    // (harmless) -- only consulted from updateClickHoldPoseForHand()
    // when it isn't.
    trig.loopPoses = namedPoses
    trig.loopSegmentMs = Math.max(safeTweenSpeedMs(cfg[`${p}TweenSpeedMs`]) / Math.max(namedPoses.length, 1), 1)
  } else {
    trig.loopPoses = null
  }
  // Direct request: "When a click and hold is occurring, during the
  // hold, moving the cursor should not trigger any panning. Instead, it
  // should continue holding the held state." This project's own
  // OrbitControls config maps BOTH left and right mouse buttons to Pan
  // (see its own setup comment) -- the exact same buttons Click Hold-
  // Pose's own pointerdown/pointerup listeners already use, so a hold-
  // and-drag was panning the camera underneath the pose transition.
  // Cursor-tracking rotation (hand.wrapper.quaternion, animate()'s own
  // separate per-frame step) is untouched by this -- it never went
  // through OrbitControls to begin with, so it keeps following the
  // cursor throughout, exactly as requested.
  controls.enablePan = false
}
// Fresh min/max live-distance snapshot for the retransition stagger,
// computed once right here (mirrors updateRenderOrder()'s own per-frame
// pass) rather than waiting for the next animation frame -- release
// should feel immediate, not delayed by up to one frame.
function endClickHoldPose(p) {
  const trig = clickHoldPoseTriggers[p]
  if (!trig.active) return // guard against a stray release with no matching press
  trig.active = false
  // Only restore panning once NONE of CLICK_HOLD_KEYS' own triggers are
  // still holding -- e.g. releasing the right button while the left is
  // still held shouldn't re-enable panning mid-hold. `dcHold` added
  // 2026-09-15 (see its own DEV_GROUPS comment) -- it now goes through
  // this exact same startClickHoldPose()/endClickHoldPose() pan-lock, a
  // disclosed side effect of the shared machinery it never had before
  // (moving the cursor during a double-click-hold used to pan the camera
  // underneath the tween, the same bug chp/rchp's own pan-lock was built
  // to fix). Generalized 2026-09-16 from 3 hardcoded names to iterating
  // CLICK_HOLD_KEYS -- tripleClickHold/quadClickHold need this exact same
  // check (a real gap otherwise: releasing chp while a still-active
  // quadClickHold hold was ongoing would have incorrectly re-enabled
  // panning out from under it, since neither new key was ever checked).
  if (CLICK_HOLD_KEYS.every((key) => !clickHoldPoseTriggers[key].active)) applyCameraLockState()
  const now = nowVirtual() // virtual clock -- feeds chp.retransitionStartTime below, an animation-timing field
  let minD = Infinity, maxD = -Infinity
  const dists = hands.map((hand) => {
    const d = hand.wrapper.position.distanceTo(cursorTarget)
    if (d < minD) minD = d
    if (d > maxD) maxD = d
    return d
  })
  const range = Math.max(maxD - minD, 0.001)
  hands.forEach((hand, i) => {
    const chp = getOrInitHandCHP(hand)[p]
    // A hand still 'idle' here never actually left it -- HoldConfirmMs
    // (see makeClickHoldPoseGroup()'s own control comment) never let it
    // enter 'forward' before this release arrived, so it was never
    // visibly touched and has nothing to retransition FROM. Skipping it
    // avoids kicking off a pointless (if harmless) retransition using a
    // stale/undefined `lastAppliedValues`. Also cancels any still-pending
    // DEFERRED claim (see updateClickHoldPoseForHand()'s own comment) --
    // this hand's own delay never elapsed before release, so it was never
    // actually claimed by this hold at all; whatever it was doing before
    // (idle, or mid some OTHER trigger's own transition, untouched this
    // whole time) simply continues on its own.
    if (chp.phase === 'idle') { chp.pendingClaimAt = 0; return }
    // Tween mode's own dedicated Retransition Speed/Curve/Range (direct
    // request) -- captured once, right now, rather than read live inside
    // the retransition phase itself, so a Mode change mid-retransition
    // can't yank an in-flight retransition between the 2 settings pairs.
    chp.retransitionIsTween = cfg[`${p}Mode`] === 'Sequence'
    // Retransition on/off (Single Pose only, direct spec item -- "NEW
    // behavioral gate"). Off = leave `chp.phase` at whatever it already
    // is ('forward'/'looping', i.e. genuinely mid-transition) WITHOUT
    // transitioning into 'retransition' -- the render-order loop's own
    // gate (`trig.active || chpAll[p].phase !== 'idle'`) keeps calling
    // updateClickHoldPoseForHand() every frame regardless, so a hand
    // still mid-forward-transition when released still finishes reaching
    // its target pose; it just never animates back to default afterward,
    // staying there forever -- "the hand stays at end pose forever."
    // Sequence/Tween mode's own release always retransitions (disclosed
    // scoping choice, see the control's own comment).
    // CORRECTED 2026-09-19: RetransitionEnabled now ALSO governs Sequence
    // mode's own 'Stop' path, not just Single Pose -- re-read the
    // verbatim spec text ("whether or not they retransition to the
    // default pose will depend on the settings i already described in
    // Click mode. If Retransition is turned off, the hand will just stop
    // where it is"), which directly contradicts this file's own earlier
    // "Sequence mode's own release always retransitions" scoping note.
    // Still early-returns immediately (freeze forever, same as Single
    // Pose) UNLESS Tween Stop Delay is also on, in which case the
    // deceleration below still needs to run before freezing -- see the
    // `tweenStopDelayOn` branch just below.
    const retransitionOff = cfg[`${p}RetransitionEnabled`] === false
    const tweenStopDelayOn = chp.retransitionIsTween && !!cfg[`${p}TweenStopDelayEnabled`]
    if (retransitionOff && !tweenStopDelayOn) return
    // On Release Mode = 'Complete Sequence' (Sequence mode only, direct
    // spec item) -- don't stop now; leave `chp.phase` exactly as it is
    // (still 'forward' or 'looping', genuinely mid-playback) and just
    // flag it. updateClickHoldPoseForHand()'s own forward/looping phases
    // check this flag at their own natural completion point (end of the
    // current pass/lap) and call beginTweenReleaseStop() from there --
    // see their own matching comments for the full account.
    if (chp.retransitionIsTween && cfg[`${p}OnReleaseMode`] === 'Complete Sequence') {
      chp.releasePending = true
      return
    }
    // Tween Stop Delay (Sequence mode's own 'Stop' path, direct spec
    // item, corrected 2026-09-19) -- instead of jumping straight to
    // retransition, the sequence keeps playing while its own tween speed
    // decays to zero over `${p}TweenStopDelayMs` ("so the pose does not
    // abruptly stop but instead slows down to a stop"). See
    // updateClickHoldPoseForHand()'s own 'stopping' phase for the actual
    // per-frame deceleration math. Simplification, disclosed: a hand
    // already in 'looping' (Loop Mode engaged) at release just HOLDS its
    // current pose for the delay's own duration rather than continuing
    // to visibly animate through it -- correctly decelerating an
    // in-progress FORWARD pass (the common case: releasing during the
    // initial tween-in) is fully implemented; decelerating an
    // already-cycling loop's own continued motion is not, since that
    // needs tracking which lap/direction/oscillate-state it was in, a
    // meaningfully bigger undertaking deferred for now.
    if (tweenStopDelayOn) {
      chp.stoppingStartTime = now
      chp.stoppingStartDelay = cfg[`${p}TweenStopStartTimeCurveEnabled`]
        ? computeStartDelayMs(dists[i], minD, range, trig.tweenStopStartCurveParsed, trig.tweenStopStartRangeParsed)
        : 0
      chp.stoppingDelayMs = Math.max(cfg[`${p}TweenStopDelayCurveEnabled`]
        ? computeStartDelayMs(dists[i], minD, range, trig.tweenStopDelayCurveParsed, trig.tweenStopDelayRangeParsed)
        : (cfg[`${p}TweenStopDelayMs`] || 0), 1)
      chp.stoppingLastFrameTime = now
      chp.stoppingWasLooping = chp.phase === 'looping'
      chp.stoppingBaseElapsedMs = chp.stoppingWasLooping ? 0 : Math.max(now - chp.forwardStartTime, 0)
      chp.stoppingVirtualElapsedMs = 0
      chp.stoppingFreezeAtEnd = retransitionOff
      chp.phase = 'stopping'
      return
    }
    chp.retransitionStart = chp.lastAppliedValues || { ...poseDefaultValues }
    chp.retransitionStartTime = now
    // Trigger All Hands (Sequence mode only, direct clarification --
    // AskUserQuestion, 2026-09-17) -- bypasses the normal per-hand
    // Tween Retransition stagger entirely (delay 0, every hand starts
    // together) instead of each hand computing its own distance-based
    // delay. Single Pose's own Retransition stagger is unaffected.
    const triggerAllHands = chp.retransitionIsTween && !!cfg[`${p}TriggerAllHands`]
    chp.retransitionDelay = triggerAllHands ? 0 : (chp.retransitionIsTween
      ? computeStartDelayMs(dists[i], minD, range, trig.tweenRetransitionCurveParsed, trig.tweenRetransitionRangeParsed)
      : computeStartDelayMs(dists[i], minD, range, trig.retransitionCurveParsed, trig.retransitionRangeParsed))
    chp.phase = 'retransition'
  })
}
// Window-level pointerdown/pointerup (same convention as the Mouse
// Tracking Log's own listeners) rather than canvas-only, so a hold that
// started on the canvas and drifted over the dev panel mid-drag still
// releases correctly -- only STARTING a hold is excluded while the
// pointer is over the dev panel (same guard the Mouse Tracking Log's own
// trigger-description logic uses), so clicking a slider/button doesn't
// also trigger every hand posing up. `blur` (window losing focus, e.g.
// alt-tabbing away mid-hold) is treated as an implicit release for both
// triggers, so a hand can never get stuck mid-transition forever with no
// way to reach it.
window.addEventListener('pointerdown', (e) => {
  if (e.target && e.target.closest && e.target.closest('.dp-panel')) return
  if (e.button === 0) { startClickHoldPose('chp'); startCustomHoldFunctions('Click+Hold') }
  else if (e.button === 2) { startClickHoldPose('rchp'); startCustomHoldFunctions('Right Click+Hold') }
})
// Direct user report ("for click hold, when i release, it seems to
// trigger the correct release, but then it calls it again. I suspect it
// is click hold interferring with click triggers" -- correct diagnosis):
// releasing a Click-Hold-Pose hold fires the SAME native `pointerup` the
// Click Pose / Double-Click Pose section (below) also listens for on the
// same left button, and that listener had no way to tell "this pointerup
// is ending a hold" apart from "this pointerup is a genuine standalone
// click" -- so every hold-release ALSO registered as a click, firing
// Click-Pose's own sequence on top of Click-Hold-Pose's own retransition.
// `lastPointerupWasHoldRelease` records, for THIS event, whether a hold
// was genuinely active on the SAME button being released -- checked here
// (BEFORE endClickHoldPose() below flips `.active` to false) and read by
// the Click Pose listener afterward, relying on this listener having been
// registered FIRST (addEventListener on the same element+event type fires
// in registration order) so the flag is already correct by the time that
// listener's own check runs for the same event.
// CORRECTED 2026-09-14 (direct user report: "i tested the new build and
// now i cant trigger click nor double click. i thinkn the click hold
// trigger probably overrides it" -- correct diagnosis of a genuine
// regression in this fix's own first version). Click-Hold-Pose has NO
// minimum press duration of its own -- `trig.active` becomes true the
// INSTANT the button goes down, so a plain, instant click (when both
// Click-Hold-Pose and Click-Pose happen to be enabled together) ALSO
// leaves `.active === true` right up until release, making the original
// `lastPointerupWasHoldRelease` check suppress EVERY click, not just
// genuine holds. Fixed by requiring the hold to have actually lasted a
// perceptible amount of time (reusing MOUSE_LOG_HELD_DRAG_MS, the SAME
// "was this a quick tap or a real hold" threshold the Mouse Tracking Log
// already uses for its own click-vs-drag-release classification) before
// treating a release as a hold-release worth suppressing -- a genuine
// sustained hold (the ORIGINAL interference report's own scenario) still
// correctly suppresses the extra click; a quick, instant click no longer
// does, restoring Click Pose/Double-Click Pose's own normal triggering.
let lastPointerupWasHoldRelease = false
// Split out from the combined flag above specifically for Right Click's
// own quick-tap listener (below) -- that listener only cares about the
// RIGHT button's own hold state, and by the time it runs (registered
// after this one, per addEventListener's same-event registration-order
// guarantee), endClickHoldPose('rchp') has already flipped
// clickHoldPoseTriggers.rchp.active back to false, so it can't recompute
// this itself.
let lastPointerupWasRchpHoldRelease = false
window.addEventListener('pointerup', (e) => {
  // Virtual clock -- holdStartTime (set in startClickHoldPose()) is now
  // ALSO in virtual-clock units, so this comparison must read the same
  // clock to stay in the same units; real wall-clock `performance.now()`
  // here would drift if a pause happened mid-hold.
  const now = nowVirtual()
  // Custom Click+Hold/Right-Click+Hold functions feed into this exact
  // same suppression check -- see isCustomHoldHeldLongEnough()'s own
  // comment for why (otherwise a custom hold function's own release
  // would ALSO fire the plain click/right-click triggers underneath it).
  const chpHeldLongEnough = e.button === 0 && ((clickHoldPoseTriggers.chp.active && (now - clickHoldPoseTriggers.chp.holdStartTime) >= MOUSE_LOG_HELD_DRAG_MS) || isCustomHoldHeldLongEnough('Click+Hold', now))
  const rchpHeldLongEnough = e.button === 2 && ((clickHoldPoseTriggers.rchp.active && (now - clickHoldPoseTriggers.rchp.holdStartTime) >= MOUSE_LOG_HELD_DRAG_MS) || isCustomHoldHeldLongEnough('Right Click+Hold', now))
  lastPointerupWasHoldRelease = chpHeldLongEnough || rchpHeldLongEnough
  lastPointerupWasRchpHoldRelease = rchpHeldLongEnough
  if (e.button === 0) { endClickHoldPose('chp'); endCustomHoldFunctions('Click+Hold') }
  else if (e.button === 2) { endClickHoldPose('rchp'); endCustomHoldFunctions('Right Click+Hold') }
})
// Generalized 2026-09-16 from 3 hardcoded names to iterating
// CLICK_HOLD_KEYS -- tripleClickHold/quadClickHold need this exact same
// "never stuck active forever" safety net (a real gap otherwise: alt-
// tabbing away mid-quadClickHold would have left it permanently active,
// since neither new key was ever released here). Also resets the click-
// hold chain's own tracking state -- an in-progress chain has no
// meaning across a focus loss.
window.addEventListener('blur', () => {
  CLICK_HOLD_KEYS.forEach((key) => endClickHoldPose(key))
  clickHoldChainCount = 0
  clickHoldChainActiveKey = null
  clickHoldChainDownInfo = null
  clickHoldChainLastCleanUpTime = -Infinity
})

// -----------------------------------------------------------------------
// Click Pose / Double-Click Pose -- fire-and-forget variant of Click
// Hold-Pose (direct follow-up request): no holding required. A single
// click (or double-click) starts every hand's own full sequence --
// transition to target, PAUSE at the target for a configurable duration,
// then retransition back to default -- which then runs to completion
// entirely on its own, regardless of anything the mouse does afterward.
// Both triggers live on the LEFT button, distinguished by click count
// (not left/right button the way Click Hold-Pose's own 2 groups are),
// since this is a genuinely different axis (count, not button) from
// Click Hold-Pose's own hold/release axis.
//
// Each hand's own phase transitions happen independently, per the
// request's own explicit requirement: "Retransition start time of a
// single [hand] does not consider whether every hand has completed
// their transition. It is independent to that hand specifically." A
// hand that started later (via the forward stagger) reaches its own
// target later, pauses starting from THAT moment, and begins ITS OWN
// retransition once ITS OWN pause elapses -- never gated on any other
// hand's progress. The retransition's own distance-based start-time
// stagger (same curve+range mechanism as every other stagger in this
// project) is computed fresh, per hand, at the exact moment THAT hand's
// pause ends (using that frame's live distance), not from one shared
// snapshot the way Click Hold-Pose's own endClickHoldPose() takes at a
// single release instant -- there's no single "release" event here to
// snapshot from, so per-hand-live is the natural equivalent.
//
// Reuses CLICK_HOLD_KEYS' own neighboring machinery directly:
// computeStartDelayMs(), lerpPoseValues(), applyPoseValuesToHand(),
// poseDefaultValues, POSE_PRESET_KEYS -- no new posing math, only a new
// per-hand phase sequence (forward -> paused -> retransition -> idle,
// one more phase than Click Hold-Pose's own forward/retransition pair).
// 'rc' (Right Click) added 2026-09-15 -- a 3rd instance of this same
// fire-and-forget family, on the right button, distinguished from 'chp'/
// 'rchp' (Click-Hold-Pose's own hold-based right-click instance) the same
// way 'click'/'dblclick' are distinguished from 'chp': quick tap, not a
// sustained hold -- see the right-button pointerup listener below. Unlike
// click/dblclick, 'rc' also supports a Tween target (cfg.rcMode) as an
// alternative to a single named Target Pose -- see updateClickPoseForHand()'s
// own comment for how the 2 modes share this same phase machine.
// `tripleClick`/`quadClick` added 2026-09-16 (direct request) --
// generalized the same way as CLICK_HOLD_KEYS/clickHoldPoseTriggers
// just above (see its own comment).
const CLICK_POSE_KEYS = ['click', 'dblclick', 'rc', 'tripleClick', 'quadClick']
const clickPoseTriggers = Object.fromEntries(CLICK_POSE_KEYS.map((p) => [p, {
  startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 },
  speedCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], speedRangeParsed: { min: 50, max: 2000 },
  tweenStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStartRangeParsed: { min: 0, max: 300 },
  retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 }
}]))
// Direct request 2026-09-17 ("rename the word Tween to Sequence") --
// every `${p}Mode` select's own OPTION VALUE (not just its label) is
// 'Single Pose'/'Sequence' now, not 'Single Pose'/'Tween'. Renaming the
// stored ENUM VALUE (not just where it's displayed) means any live
// production settings already saved with `chpMode: "Tween"` etc. would
// silently stop matching every `cfg[...] === 'Sequence'` check in this
// file the instant this ships -- devPanel.js's own 'select' control
// doesn't support a separate display-label-vs-stored-value split (only
// `{value, group}`, confirmed by reading normalizeOptions() before
// choosing this approach over forking that shared engine), so a real
// migration is the only option that doesn't need touching devPanel.js at
// all. Runs once, from `onRestore` (after real cfg values have actually
// landed, not the synchronous code defaults) -- normalizes every
// CLICK_HOLD_KEYS/CLICK_POSE_KEYS trigger's own `${p}Mode`, and pushes
// the fixed value through `syncValue()` so the dev panel's own dropdown
// (if already built) shows the corrected selection instead of a stale
// 'Tween' that no longer exists as an option.
function migrateModeTweenToSequence() {
  // 'rc' (Right Click) is already a CLICK_POSE_KEYS member -- its own
  // `rcMode` control (a hand-written group, not built via
  // makeClickPoseGroup()) still shares the exact same `${p}Mode` key
  // shape, so no separate entry is needed here.
  new Set([...CLICK_HOLD_KEYS, ...CLICK_POSE_KEYS]).forEach((p) => {
    const key = `${p}Mode`
    if (cfg[key] === 'Tween') {
      cfg[key] = 'Sequence'
      syncValue(key, 'Sequence')
    }
  })
}
function parseClickPoseConfig(p) {
  const t = clickPoseTriggers[p]
  try { t.startCurveParsed = JSON.parse(cfg[`${p}StartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.startRangeParsed = JSON.parse(cfg[`${p}StartTimeRange`]) } catch (e) { /* keep last-good value */ }
  // Animation Speed Curve's own distance->speed curve/range -- see
  // makeClickHoldPoseGroup()'s own control comment for the full
  // reasoning (reuses computeStartDelayMs()'s generic curve-eval math).
  try { t.speedCurveParsed = JSON.parse(cfg[`${p}SpeedCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.speedRangeParsed = JSON.parse(cfg[`${p}SpeedCurveRange`]) } catch (e) { /* keep last-good value */ }
  // Tween's own separate start-time curve/range -- see
  // makeClickHoldPoseGroup()'s own comment for why this is a genuinely
  // distinct pair, not an alias of the 2 lines above.
  try { t.tweenStartCurveParsed = JSON.parse(cfg[`${p}TweenStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.tweenStartRangeParsed = JSON.parse(cfg[`${p}TweenStartTimeRange`]) } catch (e) { /* keep last-good value */ }
  try { t.retransitionCurveParsed = JSON.parse(cfg[`${p}RetransitionStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.retransitionRangeParsed = JSON.parse(cfg[`${p}RetransitionStartTimeRange`]) } catch (e) { /* keep last-good value */ }
}
function getOrInitHandCP(hand) {
  if (!hand._cp) hand._cp = {}
  // `pendingClaimAt`/`pendingForwardSnapshot`/`pendingNamedPoses`/
  // `pendingFrozenSplayDeg`: the deferred-claim mechanism (direct
  // request -- see updateClickPoseForHand()'s own top comment for the
  // full account, mirroring Click-Hold-Pose's own). Per-key backfill
  // (not just a first-touch init) -- CORRECTED for Custom Click
  // Functions (Phase 4): CLICK_POSE_KEYS can now grow at RUNTIME
  // (addCustomClickFunction()), well after some hands' `_cp` was already
  // built for the original static keys -- an unconditional `if
  // (!hand._cp)` guard would leave a new custom id's own state slot
  // permanently missing on every already-touched hand, crashing the
  // very next frame this trigger fires for one of them. `if (!hand._cp[p])`
  // per key is cheap (a handful of keys) and makes this safe to call
  // again any time the key list changes.
  CLICK_POSE_KEYS.forEach((p) => {
    if (hand._cp[p]) return
    hand._cp[p] = { phase: 'idle', triggerTime: 0, forwardSnapshot: null, tweenPoses: null, pauseStartTime: 0, retransitionStart: null, retransitionStartTime: 0, retransitionDelay: 0, lastAppliedValues: null, frozenSplayDeg: 0, pendingClaimAt: 0, pendingForwardSnapshot: null, pendingNamedPoses: null, pendingFrozenSplayDeg: 0, frozenSpeedMs: 0, pendingFrozenSpeedMs: 0, sequenceLapIndex: 1, sequenceLapStartTime: 0, sequenceHoldEndTime: 0, sequenceDirection: 1 }
  })
  return hand._cp
}
// Right Click's own Sequence mode (cfg.rcMode === 'Sequence') shares this exact
// phase machine with the plain single-target-pose mode every other
// CLICK_POSE_KEYS entry uses -- only the 'forward' phase's own source of
// interpolation values differs (a resolved Tween Sequence, via
// lerpTweenSequence(), instead of a single named Target Pose, via
// lerpPoseValues()); pause/retransition are identical either way. 'click'/
// 'dblclick' have no `${p}Mode` control at all, so `cfg[`${p}Mode`]` is
// simply undefined for them and this always takes the single-pose branch,
// completely unchanged from before Right Click existed.
// CORRECTED 2026-09-16 (direct request -- see updateClickHoldPoseForHand()'s
// own top comment for the full account, this is the exact same fix
// applied to the fire-and-forget Click-Pose family). Previously
// triggerClickPose() claimed EVERY hand synchronously, for all of them at
// once, using one SHARED forwardSnapshot/tweenPoses -- a hand's own
// distance-based delay only delayed when it started VISIBLY moving, not
// when it got claimed, so a hand mid a PREVIOUS transition had its old
// phase silently overwritten immediately. Fixed the same way: `pendingClaimAt`
// defers the actual claim (phase overwrite) until THIS hand's own delay
// elapses; until then, whatever phase this function was already running
// for this hand (forward/paused/retransition) keeps running untouched.
function updateClickPoseForHand(hand, p, live, minLiveDist, liveDistRange, now) {
  const cp = getOrInitHandCP(hand)[p]
  const isTween = cfg[`${p}Mode`] === 'Sequence'
  if (cp.pendingClaimAt && now >= cp.pendingClaimAt) {
    // COMMIT -- FROM value is this hand's own live current pose
    // (`hand._lastPoseValues`) whenever `hand._wasOverriddenLastFrame`
    // confirms it was genuinely mid-SOMETHING as of last frame (any
    // trigger family); a genuinely idle hand falls back to the shared
    // trigger-time snapshot exactly as before.
    const wasActive = hand._wasOverriddenLastFrame && hand._lastPoseValues
    const anchor = wasActive ? hand._lastPoseValues : cp.pendingForwardSnapshot
    cp.forwardSnapshot = anchor
    cp.tweenPoses = (cp.pendingNamedPoses && cp.pendingNamedPoses.length >= 1) ? [anchor, ...cp.pendingNamedPoses] : null
    cp.phase = 'forward'
    cp.triggerTime = now
    cp.frozenSplayDeg = cp.pendingFrozenSplayDeg
    cp.frozenSpeedMs = cp.pendingFrozenSpeedMs
    cp.pendingClaimAt = 0
  }
  if (cp.phase === 'forward') {
    // No `forwardDelay` subtraction needed anymore -- that delay is now
    // fully spent BEFORE commit above, so visible movement starts
    // immediately at `cp.triggerTime` (now the COMMIT moment).
    const elapsed = now - cp.triggerTime
    // Tween's own separate `${p}TweenSpeedMs`, not `${p}TransitionSpeedMs`
    // -- see makeClickHoldPoseGroup()'s own comment for why these are 2
    // genuinely distinct values, not an aliased view of one field.
    // Animation Speed Curve (Single Pose only) overrides the flat
    // TransitionSpeedMs slider when enabled -- `cp.frozenSpeedMs` was
    // computed once per hand in triggerClickPose(), same "frozen at
    // trigger time" treatment as the splay.
    const speedMs = Math.max(isTween ? safeTweenSpeedMs(cfg[`${p}TweenSpeedMs`]) : (cfg[`${p}SpeedCurveEnabled`] ? cp.frozenSpeedMs : cfg[`${p}TransitionSpeedMs`]), 1)
    const progress = THREE.MathUtils.clamp(elapsed / speedMs, 0, 1)
    let values
    if (isTween) {
      if (!cp.tweenPoses || cp.tweenPoses.length < 2) { cp.phase = 'idle'; return } // nothing selected -- abandon this hand's sequence rather than get stuck
      values = lerpTweenSequence(cp.tweenPoses, progress)
    } else {
      const targetPose = (cfg.savedPoses || []).find((sp) => sp.name === cfg[`${p}TargetPose`])
      if (!targetPose) { cp.phase = 'idle'; return } // nothing selected -- abandon this hand's sequence rather than get stuck
      values = lerpPoseValues(cp.forwardSnapshot, targetPose, progress)
    }
    cp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, cp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, progress)
    if (progress >= 1) {
      // Sequence Mode - Count/Loop/Oscillate (Sequence mode only) -- see
      // makeClickPoseGroup()'s own control comment for the full
      // reasoning. This initial forward pass IS lap 1; a plain 'Count'
      // sequence with Count===1 (or Single Pose mode, which never
      // reaches this branch) behaves exactly as before, falling straight
      // into 'paused'.
      const playMode = isTween ? cfg[`${p}SequencePlayMode`] : null
      const totalLaps = playMode === 'Count' ? Math.max(cfg[`${p}SequenceCount`] || 1, 1) : Infinity
      if (isTween && (playMode === 'Loop' || playMode === 'Oscillate' || (playMode === 'Count' && totalLaps > 1))) {
        cp.sequenceLapIndex = 1
        cp.sequenceLapStartTime = now
        cp.sequenceHoldEndTime = 0
        cp.sequenceDirection = 1
        cp.phase = 'sequencePlaying'
      } else {
        cp.phase = 'paused'; cp.pauseStartTime = now
      }
    }
  } else if (cp.phase === 'sequencePlaying') {
    // Extra laps beyond the initial forward pass above, bounded by a
    // count (Count mode) or unbounded (top-level Loop/Oscillate -- runs
    // until a new trigger interrupts it, since a fire-and-forget click
    // has no release event to stop an infinite loop on). `lapStyle`
    // resolves Count mode's own nested Sequence Count Mode down to the
    // same 'Loop'/'Oscillate' vocabulary the top-level dropdown uses, so
    // the rest of this block doesn't need to branch 3 ways.
    const playMode = cfg[`${p}SequencePlayMode`]
    const lapStyle = playMode === 'Count' ? cfg[`${p}SequenceCountMode`] : playMode
    const totalLaps = playMode === 'Count' ? Math.max(cfg[`${p}SequenceCount`] || 1, 1) : Infinity
    const holdMs = Math.max(cfg[`${p}SequenceHoldMs`] || 0, 0)
    if (cp.sequenceHoldEndTime && now < cp.sequenceHoldEndTime) {
      applyPoseValuesToHand(hand, cp.lastAppliedValues, cp.frozenSplayDeg)
      applyOffsetRotationToHand(hand, p, 1)
      return
    }
    if (cp.sequenceHoldEndTime && now >= cp.sequenceHoldEndTime) {
      cp.sequenceHoldEndTime = 0
      cp.sequenceLapStartTime = now
      if (lapStyle === 'Oscillate') cp.sequenceDirection *= -1
    }
    const speedMs = Math.max(safeTweenSpeedMs(cfg[`${p}TweenSpeedMs`]), 1)
    const lapT = THREE.MathUtils.clamp((now - cp.sequenceLapStartTime) / speedMs, 0, 1)
    let values
    if (lapStyle === 'Oscillate') {
      const t = cp.sequenceDirection === 1 ? lapT : 1 - lapT
      values = lerpTweenSequence(cp.tweenPoses, t)
    } else if (cfg[`${p}SequenceLoopTransition`] === false) {
      // Instant jump back to frame 1 between laps -- each lap plays the
      // SAME forward pass (no smooth wrap segment), matching the
      // control's own "Off = instant jump back to frame 1" wording.
      values = lerpTweenSequence(cp.tweenPoses, lapT)
    } else {
      // Smooth wrap-back -- reuses lerpLoopSequence()'s own cyclic
      // segment math (same as Click Hold-Pose's own Loop Mode), an
      // unbroken interpolation across the poseN->pose1 wrap instead of a
      // teleport.
      const segments = cp.tweenPoses.length
      const tCyclic = (cp.sequenceLapIndex - 1) * segments + lapT * segments
      values = lerpLoopSequence(cp.tweenPoses, tCyclic)
    }
    cp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, cp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1)
    if (lapT >= 1) {
      cp.sequenceLapIndex++
      if (cp.sequenceLapIndex > totalLaps) {
        cp.phase = 'paused'
        cp.pauseStartTime = now
      } else if (holdMs > 0) {
        cp.sequenceHoldEndTime = now + holdMs
      } else {
        cp.sequenceLapStartTime = now
        if (lapStyle === 'Oscillate') cp.sequenceDirection *= -1
      }
    }
  } else if (cp.phase === 'paused') {
    // Hold at the fully-reached target -- keep reapplying (not a no-op,
    // since other config-driven state can still change during a hold).
    // CORRECTED 2026-09-14: now reapplies the frozen splay captured at
    // trigger time, not a live recompute -- see updateClickHoldPoseForHand()'s
    // own top comment for why Responsive Wrist Splay must not keep
    // recalculating throughout an explicit pose transition.
    applyPoseValuesToHand(hand, cp.lastAppliedValues, cp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1) // paused only reached once the forward ramp is fully complete
    // Retransition on/off (Single Pose only, direct spec item -- "NEW
    // behavioral gate"). Off = never leave 'paused' -- the hand keeps
    // reapplying its target pose forever, i.e. "stays at end pose
    // forever." Sequence/Tween mode's own release always retransitions
    // (disclosed scoping choice, see the control's own comment in
    // makeClickHoldPoseGroup()).
    if (!isTween && cfg[`${p}RetransitionEnabled`] === false) return
    const pauseDurationMs = Math.max(cfg[`${p}PauseDurationMs`], 0)
    if (now - cp.pauseStartTime >= pauseDurationMs) {
      cp.phase = 'retransition'
      cp.retransitionStart = cp.lastAppliedValues || { ...poseDefaultValues }
      cp.retransitionStartTime = now
      // Computed from THIS hand's own live distance right now, not a
      // shared snapshot -- see this section's own top comment for why.
      cp.retransitionDelay = computeStartDelayMs(live, minLiveDist, liveDistRange, clickPoseTriggers[p].retransitionCurveParsed, clickPoseTriggers[p].retransitionRangeParsed)
    }
  } else if (cp.phase === 'retransition') {
    const elapsed = now - cp.retransitionStartTime
    const speedMs = Math.max(cfg[`${p}RetransitionSpeedMs`], 1)
    const progress = elapsed < cp.retransitionDelay ? 0 : THREE.MathUtils.clamp((elapsed - cp.retransitionDelay) / speedMs, 0, 1)
    const values = lerpPoseValues(cp.retransitionStart, poseDefaultValues, progress)
    applyPoseValuesToHand(hand, values, cp.frozenSplayDeg)
    applyOffsetRotationToHand(hand, p, 1 - progress) // ramps back down to 0 as the hand returns to default, inverse of the forward ramp
    if (progress >= 1) cp.phase = 'idle'
  }
}
// Starts every hand's own full sequence at once -- unlike
// startClickHoldPose() (which only marks a trigger "active" and lets
// updateClickHoldPoseForHand() lazily enter 'forward' per hand next
// frame), there's no later "release" event to wait for here, so each
// hand's own forward delay is computed synchronously, right now, from a
// single combined distance snapshot (same technique endClickHoldPose()
// already uses for ITS OWN per-hand delays) -- a click should feel
// immediate, not delayed by up to one frame.
function triggerClickPose(p) {
  if (!cfg[`${p}Enabled`]) return
  const trig = clickPoseTriggers[p]
  const now = nowVirtual() // virtual clock -- feeds cp.triggerTime below, an animation-timing field
  // Fallback anchor for a genuinely idle hand (see updateClickPoseForHand()'s
  // own commit step) -- unchanged shared cfg-based snapshot, captured
  // once here at trigger time, same as before this round's interruption
  // fix. An ACTIVELY-transitioning hand no longer uses this at all -- it
  // resolves its own anchor from its own live current pose at commit
  // time instead (direct request, see updateClickPoseForHand()'s own top
  // comment for the full account).
  const forwardSnapshot = {}
  POSE_PRESET_KEYS.forEach((key) => { forwardSnapshot[key] = cfg[key] })
  const isTween = cfg[`${p}Mode`] === 'Sequence'
  let namedPoses = null
  if (isTween) {
    const seq = (cfg.savedTweenSequences || []).find((s) => s.name === cfg[`${p}TweenSelector`])
    const resolved = seq ? resolveTweenSequencePoses(seq.tweenPoses) : []
    if (resolved.length >= 1) namedPoses = resolved
  }
  let minD = Infinity, maxD = -Infinity
  const dists = hands.map((hand) => {
    const d = hand.wrapper.position.distanceTo(cursorTarget)
    if (d < minD) minD = d
    if (d > maxD) maxD = d
    return d
  })
  const range = Math.max(maxD - minD, 0.001)
  hands.forEach((hand, i) => {
    const cp = getOrInitHandCP(hand)[p]
    // Tween's own separate start-time curve/range (see
    // makeClickHoldPoseGroup()'s own comment) -- picked once here, same
    // as before; now schedules a DEFERRED claim instead of claiming
    // immediately (see updateClickPoseForHand()'s own commit step).
    // Start Time Curve on/off (Single Pose only) -- Off means no
    // distance-based stagger, every hand starts immediately.
    const delay = isTween
      ? computeStartDelayMs(dists[i], minD, range, trig.tweenStartCurveParsed, trig.tweenStartRangeParsed)
      : (cfg[`${p}StartTimeCurveEnabled`] === false ? 0 : computeStartDelayMs(dists[i], minD, range, trig.startCurveParsed, trig.startRangeParsed))
    cp.pendingClaimAt = now + delay
    cp.pendingForwardSnapshot = forwardSnapshot
    cp.pendingNamedPoses = namedPoses
    // Frozen for this hand's entire sequence (forward/paused/
    // retransition) -- see updateClickHoldPoseForHand()'s own top
    // comment for why Responsive Wrist Splay must not keep recomputing
    // live throughout an explicit pose transition.
    cp.pendingFrozenSplayDeg = computeResponsiveWristSplayDeg(dists[i], minD, range)
    // Animation Speed Curve (Single Pose only) -- same "frozen at
    // trigger time" treatment as the splay above.
    cp.pendingFrozenSpeedMs = (!isTween && cfg[`${p}SpeedCurveEnabled`]) ? computeStartDelayMs(dists[i], minD, range, trig.speedCurveParsed, trig.speedRangeParsed) : 0
  })
}
// Click / Double / Triple / Quadruple-Click Pose disambiguation: N
// underlying 'click' events can't be told apart from N-1 separate clicks
// (or N+1, etc.) without a short debounce window -- same problem, same
// fix, as the Mouse Tracking Log's own multi-click classification just
// above in this file, so this reuses that exact MOUSE_LOG_MULTICLICK_MS
// window (not a fresh, differently-tuned constant) for consistency. Left
// button only -- Click Hold-Pose's own right-click instance is
// unaffected. `CLICK_COUNT_CHAIN_KEYS[i]` is the trigger for `i+1`
// consecutive clicks; the LAST entry absorbs any count beyond its own
// (a 5th+ click still just re-fires quadClick, rather than needing a
// 5th tier no one asked for).
const CLICK_COUNT_CHAIN_KEYS = ['click', 'dblclick', 'tripleClick', 'quadClick']
// Whether any enabled custom 'Click' function's own Click Count selector
// asks for a 2nd/3rd/4th click -- see this section's own pointerup
// listener for why this needs checking alongside the hardcoded
// dblclick/tripleClick/quadClick Enabled flags.
function customFunctionsNeedClickChain() {
  return customClickFunctionIds.some(({ id, kind }) => kind !== 'hold' && cfg[`${id}Type`] === 'Click' && customFunctionClickCountOrdinal(id) > 1)
}
let clickPoseClickCount = 0
let clickPoseClickTimer = null
window.addEventListener('pointerup', (e) => {
  if (e.target && e.target.closest && e.target.closest('.dp-panel')) return
  if (e.button !== 0) return
  // This exact pointerup was releasing a Click-Hold-Pose hold, not a
  // standalone click -- see lastPointerupWasHoldRelease's own comment
  // (Click Hold-Pose section, above) for why this must never also count
  // toward Click Pose / Double-Click Pose's own click-count detection.
  if (lastPointerupWasHoldRelease) return
  // CORRECTED 2026-09-14 (direct user report: "why is there a delay
  // between the click and the triggered pose transition, even if the
  // minimum transition time is set to 0"): every click used to wait the
  // full MOUSE_LOG_MULTICLICK_MS window before triggerClickPose('click')
  // fired, EVEN when Double-Click Pose wasn't enabled at all -- there was
  // nothing to disambiguate FROM in that case, so the wait was pure,
  // avoidable latency. If NOTHING beyond a plain click is enabled, fire
  // 'click' immediately; the debounce is only genuinely needed when a
  // 2nd/3rd/4th click could still arrive and change the outcome.
  // Generalized 2026-09-16 from a dblclick-only check to "is anything
  // past plain click enabled" for the new triple/quad tiers. Extended
  // 2026-09-19 to ALSO check whether any custom 'Click' function wants a
  // 2nd/3rd/4th click (its own Click Count selector) -- without this, a
  // custom function set to "Triggers On (Nth Click): 2nd" would never see
  // anything but idx-0/ordinal-1 while every hardcoded multi-click tier
  // stayed disabled, since this early-fire branch skips the debounce/chain
  // entirely.
  if (!cfg.dblclickEnabled && !cfg.tripleClickEnabled && !cfg.quadClickEnabled && !customFunctionsNeedClickChain()) {
    clickPoseClickCount = 0
    clearTimeout(clickPoseClickTimer)
    triggerClickPose('click')
    triggerCustomPoseFunctions('Click', 1)
    return
  }
  clickPoseClickCount++
  clearTimeout(clickPoseClickTimer)
  clickPoseClickTimer = setTimeout(() => {
    const idx = Math.min(clickPoseClickCount, CLICK_COUNT_CHAIN_KEYS.length) - 1
    triggerClickPose(CLICK_COUNT_CHAIN_KEYS[idx])
    // Custom "Click" functions now DO have a click-count selector (Triggers
    // On (Nth Click)) -- triggerCustomPoseFunctions() itself does the
    // per-function ordinal match, so every resolved click count is passed
    // through, not just a plain single click.
    triggerCustomPoseFunctions('Click', idx + 1)
    clickPoseClickCount = 0
  }, cfg.multiClickWindowMs)
})
// Right Click -- direct request ("also provide another CLick function,
// the same as the others - 'Right Click'"): the right-button equivalent
// of the plain 'click' trigger above (quick tap, fire-and-forget, no
// double-click counterpart requested), reusing triggerClickPose('rc')
// unchanged -- the only new thing this feature needed at the trigger
// level is telling a genuine Right-Click Hold-Pose (rchp) release apart
// from a quick right-button tap, via `lastPointerupWasRchpHoldRelease`
// (set just above, in the SAME pointerup listener endClickHoldPose('rchp')
// already uses, so it's always current by the time this one runs).
window.addEventListener('pointerup', (e) => {
  if (e.target && e.target.closest && e.target.closest('.dp-panel')) return
  if (e.button !== 2) return
  if (lastPointerupWasRchpHoldRelease) return
  triggerClickPose('rc')
  triggerCustomPoseFunctions('Right Click')
})

// -----------------------------------------------------------------------
// Double / Triple / Quadruple Click Hold -- gesture DETECTION only.
// REBUILT 2026-09-15 for Double Click Hold (direct request, "make the
// available settings of double click and hold to match click hold... I
// want to also be able to select single pose/tween for double click
// hold" -- see this group's own DEV_GROUPS comment for the full
// account): the actual pose machinery is no longer a bespoke, shared-
// across-all-hands mechanism -- `dcHold`/`tripleClickHold`/`quadClickHold`
// are literal entries in CLICK_HOLD_KEYS, going through the exact same
// startClickHoldPose()/updateClickHoldPoseForHand()/endClickHoldPose()
// every hand-family trigger already uses (per-hand distance stagger,
// Single Pose/Tween Mode, Loop Mode/Oscillate, everything). Only this
// gesture-recognition layer is unique to this family: a genuine Nth
// consecutive click whose OWN press is HELD (not released quickly) --
// distinct from Click-Pose's own fire-and-forget tiers (recognized at
// the FINAL release, after the whole debounce window) and from Click-
// Hold-Pose's 'chp' (a single press-and-hold, no prior clicks required).
//
// GENERALIZED 2026-09-16 (direct request: "triple click hold, and
// quadruple click hold") from dcHold's own binary "was the immediately
// preceding release clean" flag into a running CHAIN COUNT
// (`clickHoldChainCount`), so a 3rd or 4th press -- each preceded by its
// own unbroken run of quick, clean prior releases -- can also become a
// hold. `CLICK_HOLD_CHAIN_KEYS[i]` is the trigger for the press that
// follows `i` consecutive clean releases (index 0 has no trigger -- a
// fresh, non-chained press is just chp/rchp's own plain press-and-hold,
// unrelated to this chain); the last real entry absorbs any longer chain
// the same way CLICK_COUNT_CHAIN_KEYS does for the fire-and-forget
// family, so a 5th+ press still just re-triggers quadClickHold rather
// than needing a tier no one asked for. A LEFT pointerdown arriving
// within MOUSE_LOG_MULTICLICK_MS of the last clean release is the NEXT
// press in the chain, so its corresponding hold starts immediately (no
// separate "was this held long enough" gate needed here -- the click
// chain itself is already the disambiguating signal, which is also why
// none of these strictly NEED their own Hold Confirm Delay the way
// chp/rchp do, even though each has that control available too as part
// of full settings parity). Deliberately independent of chp's own state
// otherwise (no cross-suppression) -- a disclosed simplification, same
// as the existing chp-vs-rchp "whichever runs last this frame wins"
// note. Also deliberately independent of the fire-and-forget click-count
// chain above (a quick release at any chain depth feeds BOTH mechanisms
// -- a disclosed, pre-existing overlap already true of dcHold-vs-dblclick
// before this round, just now extended symmetrically to 3/4 clicks
// rather than newly introduced by it).
const CLICK_HOLD_CHAIN_KEYS = [null, 'dcHold', 'tripleClickHold', 'quadClickHold']
let clickHoldChainCount = 0
let clickHoldChainDownInfo = null
let clickHoldChainLastCleanUpTime = -Infinity
let clickHoldChainActiveKey = null
// Custom Click+Hold functions with Click Count 2nd/3rd/4th (see
// customFunctionsNeedClickChain()'s own comment for the fire-and-forget
// mirror of this) piggyback on this SAME chain -- `clickHoldChainActiveOrdinal`
// records which chain position (2/3/4) was actually started this press, so
// the matching pointerup below ends exactly those, not the "1st" ones
// (those are chp's own separate always-fires-on-every-press listener,
// unaffected by this chain).
let clickHoldChainActiveOrdinal = 0
window.addEventListener('pointerdown', (e) => {
  if (e.target && e.target.closest && e.target.closest('.dp-panel')) return
  if (e.button !== 0) return
  const now = performance.now()
  if (now - clickHoldChainLastCleanUpTime <= cfg.multiClickWindowMs) {
    const chainIdx = Math.min(clickHoldChainCount, CLICK_HOLD_CHAIN_KEYS.length - 1)
    const key = CLICK_HOLD_CHAIN_KEYS[chainIdx]
    if (key) { clickHoldChainActiveKey = key; startClickHoldPose(key) }
    clickHoldChainActiveOrdinal = chainIdx + 1 // chainIdx is only ever reached here at >=1 (see this block's own history above), so this is always 2, 3, or 4
    startCustomHoldFunctions('Click+Hold', clickHoldChainActiveOrdinal)
  } else {
    clickHoldChainCount = 0 // too long since the last clean release -- this is a fresh chain, not a continuation
  }
  clickHoldChainDownInfo = { time: now, x: e.clientX, y: e.clientY }
})
// CORRECTED 2026-09-16, caught before shipping via live testing (not a
// user report): a chain-triggered hold starts IMMEDIATELY on press (see
// this section's own top comment -- "the hold starts immediately... the
// double-click itself is already the disambiguating signal"), so the
// 2nd press of a still-building TRIPLE/quad-click chain ALSO briefly
// pulses dcHold the instant it's pressed, same as a genuine double-
// click-then-hold would. The first version of this release handler
// treated "a chain hold was active" as proof the chain was OVER
// (`clickHoldChainCount = 0`), which incorrectly reset the chain on
// EVERY intermediate click of a longer chain -- confirmed live: a
// click-click-HOLD sequence (meant to become tripleClickHold) never
// committed even after 40 polling ticks, because the 2nd click's own
// brief dcHold pulse reset the count back to 0 before the 3rd press
// could ever see chainCount===2. Fixed by deciding "does the chain
// continue" purely from THIS release's own heldMs/moved classification
// (same as a normal click), independent of whether a hold happened to
// be pulsing on this exact press -- ending that pulse (`endClickHoldPose`)
// and continuing the chain are no longer coupled.
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return
  if (clickHoldChainActiveKey && clickHoldPoseTriggers[clickHoldChainActiveKey].active) {
    endClickHoldPose(clickHoldChainActiveKey)
  }
  if (clickHoldChainActiveOrdinal) endCustomHoldFunctions('Click+Hold', clickHoldChainActiveOrdinal)
  clickHoldChainActiveKey = null
  clickHoldChainActiveOrdinal = 0
  // Only a clean (not dragged) release extends the chain -- same
  // heldMs/moved classification as the Mouse Tracking Log's own wasDrag
  // check, independent constants/state so this feature never depends on
  // that log existing or being enabled.
  if (clickHoldChainDownInfo) {
    const heldMs = performance.now() - clickHoldChainDownInfo.time
    const moved = Math.hypot(e.clientX - clickHoldChainDownInfo.x, e.clientY - clickHoldChainDownInfo.y) > MOUSE_LOG_MOVE_THRESHOLD_PX
    if (heldMs <= MOUSE_LOG_HELD_DRAG_MS && !moved) {
      clickHoldChainCount++
      clickHoldChainLastCleanUpTime = performance.now()
    } else {
      // A genuine sustained hold (heldMs beyond the threshold) or a drag
      // -- either way the chain is over: a real hold consumed it, and a
      // drag was never a click at all.
      clickHoldChainCount = 0
      clickHoldChainLastCleanUpTime = -Infinity
    }
  }
  clickHoldChainDownInfo = null
})

// Generic versions of Arm Length's own 2 custom widgets (see
// buildArmLengthRangeWidget()/buildArmLengthCurveWidget() for the
// original, project-specific ones, deliberately left untouched) --
// Click-Hold-Pose needs 4 MORE instances of this same pair (start/
// retransition, x2 triggers), enough that hand-copying a 3rd/4th/5th/6th
// time stopped being the safer choice; these take a small `opts` object
// instead of hardcoding units/captions/defaults. Range bar handles do
// NOT cross-clamp each other here either (same reasoning as Wrist
// Splay's own range widget) -- kept flexible even though start-time
// bounds don't strictly need it, for one less special case to maintain.
function buildGenericRangeBarWidget(row, opts) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const { trackMin, trackMax, unit, defaultValue } = opts
  const toPct = (v) => THREE.MathUtils.clamp((v - trackMin) / (trackMax - trackMin) * 100, 0, 100)
  const fromPct = (pct) => Math.round(trackMin + (pct / 100) * (trackMax - trackMin))

  const wrap = elLocal('div', { flex: '1', padding: '6px 4px 2px' })
  const track = elLocal('div', { position: 'relative', height: '18px', margin: '0 9px', background: 'rgba(255,255,255,0.12)', borderRadius: '9px' })
  const fill = elLocal('div', { position: 'absolute', top: '0', bottom: '0', background: 'var(--dp-accent, #7d8cff)', opacity: '0.5', borderRadius: '9px' })
  const minHandle = elLocal('div', { position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px', background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none' })
  const maxHandle = elLocal('div', { position: 'absolute', top: '-3px', width: '18px', height: '24px', marginLeft: '-9px', background: 'var(--dp-accent, #7d8cff)', borderRadius: '4px', cursor: 'ew-resize', touchAction: 'none' })
  const readout = elLocal('div', { fontSize: '11px', textAlign: 'center', marginTop: '4px', opacity: '0.85' })
  track.appendChild(fill); track.appendChild(minHandle); track.appendChild(maxHandle)
  wrap.appendChild(track); wrap.appendChild(readout)
  row.appendChild(wrap)

  let current = { ...defaultValue }
  try { current = JSON.parse(input.value) } catch (e) { /* keep default */ }
  let lastSeenValue = input.value

  function redraw() {
    const minPct = toPct(current.min), maxPct = toPct(current.max)
    fill.style.left = Math.min(minPct, maxPct) + '%'
    fill.style.right = (100 - Math.max(minPct, maxPct)) + '%'
    minHandle.style.left = minPct + '%'
    maxHandle.style.left = maxPct + '%'
    readout.textContent = `Min: ${current.min}${unit}  Max: ${current.max}${unit}`
  }
  redraw()
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try { current = JSON.parse(input.value); redraw() } catch (e) { /* leave displayed state as-is */ }
  })
  function startDrag(handleKey) {
    return (downEv) => {
      downEv.preventDefault()
      function onMove(moveEv) {
        const rect = track.getBoundingClientRect()
        if (rect.width <= 0) return
        const pct = THREE.MathUtils.clamp((moveEv.clientX - rect.left) / rect.width, 0, 1) * 100
        current[handleKey] = fromPct(pct)
        redraw()
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        commitTextControl(input, JSON.stringify(current))
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
  }
  minHandle.addEventListener('pointerdown', startDrag('min'))
  maxHandle.addEventListener('pointerdown', startDrag('max'))
}
function buildGenericCurveWidget(row, opts) {
  const input = row.querySelector('.dp-text-input')
  if (!input) return
  input.style.display = 'none'
  row.style.flexDirection = 'column'
  row.style.alignItems = 'stretch'

  const W = 240, H = 120
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('width', W); svg.setAttribute('height', H)
  Object.assign(svg.style, { background: 'rgba(255,255,255,0.06)', borderRadius: '4px', marginTop: '6px', touchAction: 'none', cursor: 'crosshair' })
  const axisX = document.createElementNS(svgNS, 'line')
  axisX.setAttribute('x1', 0); axisX.setAttribute('y1', H - 1); axisX.setAttribute('x2', W); axisX.setAttribute('y2', H - 1)
  axisX.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  const axisY = document.createElementNS(svgNS, 'line')
  axisY.setAttribute('x1', 1); axisY.setAttribute('y1', 0); axisY.setAttribute('x2', 1); axisY.setAttribute('y2', H)
  axisY.setAttribute('stroke', 'rgba(255,255,255,0.25)')
  const curvePath = document.createElementNS(svgNS, 'path')
  curvePath.setAttribute('fill', 'none'); curvePath.setAttribute('stroke', 'var(--dp-accent, #7d8cff)'); curvePath.setAttribute('stroke-width', '2')
  svg.appendChild(axisX); svg.appendChild(axisY); svg.appendChild(curvePath)
  const caption = elLocal('div', { fontSize: '10px', opacity: '0.7', marginTop: '3px', textAlign: 'center' }, { text: opts.caption })
  row.appendChild(svg)
  row.appendChild(caption)

  let points = opts.defaultPoints.map((p) => ({ ...p }))
  try {
    const parsed = JSON.parse(input.value)
    if (Array.isArray(parsed) && parsed.length >= 2) points = parsed.sort((a, b) => a.x - b.x)
  } catch (e) { /* keep default */ }

  const toPx = (p) => ({ x: p.x * W, y: (1 - p.y) * H })
  const fromPx = (px, py) => ({ x: THREE.MathUtils.clamp(px / W, 0, 1), y: THREE.MathUtils.clamp(1 - py / H, 0, 1) })
  let circles = []

  function commitPoints() {
    points.sort((a, b) => a.x - b.x)
    commitTextControl(input, JSON.stringify(points))
  }
  const CURVE_SAMPLES = 48
  let handleEls = []
  // Bezier curve handles (direct spec item, this widget only -- the
  // project-specific Arm Length/Wrist Splay curve widgets are deliberately
  // separate copies, per their own comments, and are NOT extended here).
  // Alt+drag a point creates/drags its OUT handle (`h1`, shapes the
  // segment leaving it toward the NEXT point, never offered on the last
  // point); Shift+drag creates/drags its IN handle (`h2`, shapes the
  // segment arriving FROM the PREVIOUS point, never offered on the first
  // point). Dragging a handle back within a small pixel threshold of its
  // own point removes it on release, reverting that segment to the plain
  // Catmull-Rom spline -- the only way to remove one, deliberately
  // mirroring how a point itself only deletes via dblclick/right-click,
  // not a separate dedicated button. See evaluateArmLengthCurve()'s own
  // comment for the data format (`h1`/`h2` are optional {x,y} offsets,
  // absolute -- added directly to the point) and why every existing saved
  // curve (no handles) renders identically to before.
  const HANDLE_REMOVE_THRESHOLD_PX = 6
  function startHandleDrag(p, i, kind, downEv) {
    downEv.stopPropagation()
    downEv.preventDefault()
    const canHave = kind === 'h1' ? i < points.length - 1 : i > 0
    if (!canHave) return
    if (!p[kind]) p[kind] = { x: kind === 'h1' ? 0.08 : -0.08, y: 0 } // a small default offset, immediately visible/draggable rather than starting at zero-length
    function onMove(moveEv) {
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const np = fromPx(moveEv.clientX - rect.left, moveEv.clientY - rect.top)
      p[kind] = { x: np.x - p.x, y: np.y - p.y }
      redraw()
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const handlePx = toPx({ x: p.x + p[kind].x, y: p.y + p[kind].y })
      const pointPx = toPx(p)
      if (Math.hypot(handlePx.x - pointPx.x, handlePx.y - pointPx.y) <= HANDLE_REMOVE_THRESHOLD_PX) delete p[kind]
      redraw()
      commitPoints()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  function redraw() {
    let d = ''
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const x = i / CURVE_SAMPLES
      const y = THREE.MathUtils.clamp(evaluateArmLengthCurve(points, x), 0, 1)
      const px = toPx({ x, y })
      d += (i === 0 ? 'M' : 'L') + px.x.toFixed(2) + ',' + px.y.toFixed(2) + ' '
    }
    curvePath.setAttribute('d', d.trim())
    handleEls.forEach((el) => svg.removeChild(el))
    handleEls = []
    circles.forEach((c) => svg.removeChild(c))
    circles = points.map((p, i) => {
      // Handle line + marker (added to the DOM BEFORE the point's own
      // circle, so the circle renders on top) -- one per side, only when
      // that side's handle actually exists.
      ;['h1', 'h2'].forEach((kind) => {
        if (!p[kind]) return
        const px = toPx(p)
        const hx = toPx({ x: p.x + p[kind].x, y: p.y + p[kind].y })
        const line = document.createElementNS(svgNS, 'line')
        line.setAttribute('x1', px.x); line.setAttribute('y1', px.y); line.setAttribute('x2', hx.x); line.setAttribute('y2', hx.y)
        line.setAttribute('stroke', 'rgba(255,255,255,0.4)'); line.setAttribute('stroke-width', '1')
        svg.appendChild(line)
        handleEls.push(line)
        const marker = document.createElementNS(svgNS, 'rect')
        marker.setAttribute('x', hx.x - 3.5); marker.setAttribute('y', hx.y - 3.5); marker.setAttribute('width', 7); marker.setAttribute('height', 7)
        marker.setAttribute('fill', '#e0a030')
        Object.assign(marker.style, { cursor: 'grab' })
        marker.addEventListener('pointerdown', (downEv) => startHandleDrag(p, i, kind, downEv))
        svg.appendChild(marker)
        handleEls.push(marker)
      })
      const px = toPx(p)
      const c = document.createElementNS(svgNS, 'circle')
      c.setAttribute('cx', px.x); c.setAttribute('cy', px.y); c.setAttribute('r', 5)
      c.setAttribute('fill', 'var(--dp-accent, #7d8cff)')
      Object.assign(c.style, { cursor: 'grab' })
      let dragged = false
      c.addEventListener('pointerdown', (downEv) => {
        if (downEv.altKey) { startHandleDrag(p, i, 'h1', downEv); return }
        if (downEv.shiftKey) { startHandleDrag(p, i, 'h2', downEv); return }
        downEv.stopPropagation()
        dragged = false
        const isEndpoint = i === 0 || i === points.length - 1
        function onMove(moveEv) {
          const rect = svg.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          dragged = true
          const np = fromPx(moveEv.clientX - rect.left, moveEv.clientY - rect.top)
          if (isEndpoint) { p.y = np.y } else { p.x = np.x; p.y = np.y }
          redraw()
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (dragged) commitPoints()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      function deletePointIfRemovable() {
        if (points.length > 2 && i !== 0 && i !== points.length - 1) {
          points.splice(points.indexOf(p), 1)
          redraw()
          commitPoints()
        }
      }
      c.addEventListener('dblclick', (dblEv) => {
        dblEv.stopPropagation()
        deletePointIfRemovable()
      })
      c.addEventListener('contextmenu', (ctxEv) => {
        ctxEv.preventDefault()
        ctxEv.stopPropagation()
        deletePointIfRemovable()
      })
      svg.appendChild(c)
      return c
    })
  }
  svg.addEventListener('click', (clickEv) => {
    if (clickEv.target.tagName === 'circle') return
    const rect = svg.getBoundingClientRect()
    const np = fromPx(clickEv.clientX - rect.left, clickEv.clientY - rect.top)
    if (np.x <= 0 || np.x >= 1) return
    points.push(np)
    redraw()
    commitPoints()
  })
  redraw()
  let lastSeenValue = input.value
  armLengthWidgetResyncs.push(() => {
    if (input.value === lastSeenValue) return
    lastSeenValue = input.value
    try {
      const parsed = JSON.parse(input.value)
      if (Array.isArray(parsed) && parsed.length >= 2) { points = parsed.sort((a, b) => a.x - b.x); redraw() }
    } catch (e) { /* leave displayed state as-is */ }
  })
}
// Locates and builds all 4 of one trigger's own custom widgets (2 curve,
// 2 range) -- called once per trigger, right after initDevPanel(), same
// timing as buildArmLengthWidgets()/buildWristSplayWidgets().
const CLICK_HOLD_START_TIME_TRACK_MAX = 3000 // ms -- a deliberately smaller ceiling than the 5000ms Transition Speed sliders, since "start time" is meant to stagger WITHIN a transition, not span longer than one
function buildClickHoldPoseWidgets(p) {
  // Animation Speed Curve's own curve/range widgets -- a real gap left
  // over from when this control was first added (SpeedCurve/
  // SpeedCurveRange rendered as plain raw-JSON text boxes instead of the
  // interactive curve-graph widget every OTHER curve field gets), caught
  // and fixed while building this generalized widget-builder for custom
  // click functions. Distance->Speed, not distance->start-time, hence
  // its own caption/track ceiling (matches the control's own 50-2000ms
  // slider range, not the 0-3000ms start-time ceiling below).
  const speedCurveRow = document.querySelector(`.dp-row[data-key="${p}SpeedCurve"]`)
  const speedRangeRow = document.querySelector(`.dp-row[data-key="${p}SpeedCurveRange"]`)
  const speedCurveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Speed Fraction (0=Min, 1=Max)'
  if (speedCurveRow) buildGenericCurveWidget(speedCurveRow, { caption: speedCurveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (speedRangeRow) buildGenericRangeBarWidget(speedRangeRow, { trackMin: 50, trackMax: 2000, unit: 'ms', defaultValue: { min: 50, max: 2000 } })
  const startCurveRow = document.querySelector(`.dp-row[data-key="${p}StartTimeCurve"]`)
  const startRangeRow = document.querySelector(`.dp-row[data-key="${p}StartTimeRange"]`)
  const tweenStartCurveRow = document.querySelector(`.dp-row[data-key="${p}TweenStartTimeCurve"]`)
  const tweenStartRangeRow = document.querySelector(`.dp-row[data-key="${p}TweenStartTimeRange"]`)
  const retransCurveRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeCurve"]`)
  const retransRangeRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeRange"]`)
  const tweenRetransCurveRow = document.querySelector(`.dp-row[data-key="${p}TweenRetransitionStartTimeCurve"]`)
  const tweenRetransRangeRow = document.querySelector(`.dp-row[data-key="${p}TweenRetransitionStartTimeRange"]`)
  const curveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Start Time Fraction (0=Min, 1=Max)'
  if (startCurveRow) buildGenericCurveWidget(startCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (startRangeRow) buildGenericRangeBarWidget(startRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  // Tween's own separate curve/range widgets -- same shape/caption/track
  // ceiling as Single Pose's, just a genuinely distinct control (see
  // makeClickHoldPoseGroup()'s own comment).
  if (tweenStartCurveRow) buildGenericCurveWidget(tweenStartCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (tweenStartRangeRow) buildGenericRangeBarWidget(tweenStartRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  if (retransCurveRow) buildGenericCurveWidget(retransCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (retransRangeRow) buildGenericRangeBarWidget(retransRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  // Tween's own dedicated RETRANSITION curve/range (direct request) --
  // same shape as the pair immediately above, just Tween-mode's own.
  if (tweenRetransCurveRow) buildGenericCurveWidget(tweenRetransCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (tweenRetransRangeRow) buildGenericRangeBarWidget(tweenRetransRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  // Tween Stop's own 2 curve/range widgets -- same interactive-widget
  // treatment as every other curve field in this function.
  const tweenStopStartCurveRow = document.querySelector(`.dp-row[data-key="${p}TweenStopStartTimeCurve"]`)
  const tweenStopStartRangeRow = document.querySelector(`.dp-row[data-key="${p}TweenStopStartTimeRange"]`)
  if (tweenStopStartCurveRow) buildGenericCurveWidget(tweenStopStartCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (tweenStopStartRangeRow) buildGenericRangeBarWidget(tweenStopStartRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  const tweenStopDelayCurveRow = document.querySelector(`.dp-row[data-key="${p}TweenStopDelayCurve"]`)
  const tweenStopDelayRangeRow = document.querySelector(`.dp-row[data-key="${p}TweenStopDelayRange"]`)
  const tweenStopDelayCurveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Delay Fraction (0=Min, 1=Max)'
  if (tweenStopDelayCurveRow) buildGenericCurveWidget(tweenStopDelayCurveRow, { caption: tweenStopDelayCurveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (tweenStopDelayRangeRow) buildGenericRangeBarWidget(tweenStopDelayRangeRow, { trackMin: 0, trackMax: 5000, unit: 'ms', defaultValue: { min: 0, max: 2000 } })
}
// Runs now, not back up near the other widgets' own setup calls (parse-
// ArmLengthConfig()/buildWristSplayWidgets() etc.) -- this needs
// clickHoldPoseTriggers (declared just above) to already exist, and that
// const isn't hoisted the way a function declaration is.
CLICK_HOLD_KEYS.forEach((p) => { parseClickHoldConfig(p); buildClickHoldPoseWidgets(p) })
// Same widget shape as buildClickHoldPoseWidgets() above (this feature
// has no widgets of its own beyond the plain Pause Duration/Tween Speed/
// Loop controls, which need no custom widget) -- reuses the SAME
// CLICK_HOLD_START_TIME_TRACK_MAX ceiling too, since "start time" means
// the identical thing in both features.
function buildClickPoseWidgets(p) {
  // Animation Speed Curve's own curve/range widgets -- see
  // buildClickHoldPoseWidgets()'s own matching comment for the full
  // reasoning (a real gap fixed alongside it, shared word-for-word).
  const speedCurveRow = document.querySelector(`.dp-row[data-key="${p}SpeedCurve"]`)
  const speedRangeRow = document.querySelector(`.dp-row[data-key="${p}SpeedCurveRange"]`)
  const speedCurveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Speed Fraction (0=Min, 1=Max)'
  if (speedCurveRow) buildGenericCurveWidget(speedCurveRow, { caption: speedCurveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (speedRangeRow) buildGenericRangeBarWidget(speedRangeRow, { trackMin: 50, trackMax: 2000, unit: 'ms', defaultValue: { min: 50, max: 2000 } })
  const startCurveRow = document.querySelector(`.dp-row[data-key="${p}StartTimeCurve"]`)
  const startRangeRow = document.querySelector(`.dp-row[data-key="${p}StartTimeRange"]`)
  const tweenStartCurveRow = document.querySelector(`.dp-row[data-key="${p}TweenStartTimeCurve"]`)
  const tweenStartRangeRow = document.querySelector(`.dp-row[data-key="${p}TweenStartTimeRange"]`)
  const retransCurveRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeCurve"]`)
  const retransRangeRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeRange"]`)
  const curveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Start Time Fraction (0=Min, 1=Max)'
  if (startCurveRow) buildGenericCurveWidget(startCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (startRangeRow) buildGenericRangeBarWidget(startRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  if (tweenStartCurveRow) buildGenericCurveWidget(tweenStartCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (tweenStartRangeRow) buildGenericRangeBarWidget(tweenStartRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  if (retransCurveRow) buildGenericCurveWidget(retransCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (retransRangeRow) buildGenericRangeBarWidget(retransRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
}
// -----------------------------------------------------------------------
// Custom Click Functions (Phase 4) -- runtime-created pose triggers, both
// fire-and-forget ('pose' kind, reuses makeClickPoseGroup()) and hold-
// based ('hold' kind, reuses makeClickHoldPoseGroup()). See the "Custom
// Click Functions" DEV_GROUPS entry's own comment for the full scoping
// account. Each custom function joins CLICK_POSE_KEYS/clickPoseTriggers
// or CLICK_HOLD_KEYS/clickHoldPoseTriggers exactly like one of the 10
// hardcoded triggers -- updateClickPoseForHand()/updateClickHoldPoseForHand(),
// triggerClickPose()/startClickHoldPose()/endClickHoldPose(),
// getOrInitHandCP()/getOrInitHandCHP(), parseClickPoseConfig()/
// parseClickHoldConfig(), every visibility function, ALL already generic
// over `p` and already proven correct on the existing IDs, so a new ID
// needs ZERO changes there.
// -----------------------------------------------------------------------
let customClickFunctionIds = [] // [{id, title, kind, family}] -- kind: 'pose'|'hold'; family: 'desktop'|'mobile'. Mirrors cfg.customClickFunctionIds (JSON), kept in sync by persistCustomClickFunctionIds()
let nextCustomFunctionN = 1
function persistCustomClickFunctionIds() {
  const json = JSON.stringify(customClickFunctionIds)
  cfg.customClickFunctionIds = json
  syncValue('customClickFunctionIds', json)
}
// Delete-function button (direct spec item) -- see initDevPanel()'s own
// `onGroupDeleted` comment for why this piggybacks on devPanel.js's
// EXISTING Delete Group/Setting icon rather than a separate one. Removes
// this function from every generic pipeline registerCustomClickFunction()
// originally added it to: `customClickFunctionIds` (+ persisted), its
// `CLICK_POSE_KEYS`/`CLICK_HOLD_KEYS` slot, its own trigger-state object
// (clickPoseTriggers/clickHoldPoseTriggers), and every hand's own per-
// function state (`hand._cp`/`hand._chp`) -- a stale entry there would be
// harmless (never read again once the id is gone from CLICK_POSE_KEYS/
// CLICK_HOLD_KEYS, which is what the render-order loop's own dispatch
// actually iterates), but removing it fully still avoids leaking memory
// across many create/delete cycles in one long session. Deliberately NOT
// undo-aware -- see devPanel.js's own onGroupDeleted comment for why.
function cleanupDeletedCustomClickFunction(target) {
  if (!target || !target.classList || !target.classList.contains('dp-group')) return
  if (!target.dataset.customFunctionFamily) return // not a Custom Click Function's own group (a plain user-created group, or one of the 10 static triggers)
  const title = target.dataset.key
  const idx = customClickFunctionIds.findIndex((e) => e.title === title)
  if (idx === -1) return
  const { id, kind } = customClickFunctionIds[idx]
  customClickFunctionIds.splice(idx, 1)
  persistCustomClickFunctionIds()
  const keys = kind === 'hold' ? CLICK_HOLD_KEYS : CLICK_POSE_KEYS
  const triggers = kind === 'hold' ? clickHoldPoseTriggers : clickPoseTriggers
  const ki = keys.indexOf(id)
  if (ki !== -1) keys.splice(ki, 1)
  delete triggers[id]
  hands.forEach((hand) => {
    const perHand = kind === 'hold' ? hand._chp : hand._cp
    if (perHand) delete perHand[id]
  })
  refreshCustomFunctionConflictWarnings()
}
// Reads which dev-panel tab is currently showing, straight from the DOM
// (`.dp-tab-active`, devPanel.js's own class for the highlighted tab
// button) -- devPanel.js keeps `editingDevice` as a private closure
// variable with no exported getter, and adding one just for this would be
// a bigger devPanel.js change than reading the same state its own CSS
// class already exposes. Landscape counts as 'mobile' family -- it's a
// mobile-form-factor variant, not a 3rd device class, matching the
// original spec's own framing ("that click function will only be
// available to mobile and landscape tab, not desktop").
function getActiveDevPanelTab() {
  const activeBtn = document.querySelector('.dp-tab.dp-tab-active')
  const label = activeBtn ? activeBtn.textContent.trim() : 'Desktop'
  return (label === 'Mobile' || label === 'Landscape') ? 'mobile' : 'desktop'
}
// Type's own option list -- direct spec item ("Click Function Type
// should always include - Click, Click+Hold, Scroll, Right Click, Right
// Click+Hold for Desktop Mode... will always include - Click, Click+Hold,
// Multi-Point [for Mobile]"). `kind` already fixes Click-vs-Click+Hold (2
// different control batteries/state machines, decided at creation time via
// which button was pressed); `family` then narrows further (mobile drops
// the Right-Click variants entirely, matching "Dont show scroll or right
// click functions" on Mobile). Scroll is 'pose'-kind only -- there's no
// natural "hold" analog for a wheel gesture the way a mouse/touch button
// can be held, so it's grouped with Click/Right Click, not the +Hold
// pair, matching how the spec's own flat list lists it next to those.
// Multi-Point (a simultaneous-touch-point gesture, see
// multiPointRequiredTouches()'s own comment) genuinely CAN be either
// fire-and-forget or held, so it's offered for both kinds on mobile.
function customFunctionTypeOptions(kind, family) {
  if (kind === 'hold') return family === 'mobile' ? ['Click+Hold', 'Multi-Point'] : ['Click+Hold', 'Right Click+Hold']
  return family === 'mobile' ? ['Click', 'Multi-Point'] : ['Click', 'Right Click', 'Scroll']
}
// Shows/hides ONE custom function's group based on its own `family` vs.
// whichever tab is currently active -- devPanel.js has no per-tab DOM
// duplication (one shared groupsEl for all 3 devices) and no existing
// "hide on Desktop only" primitive (its own dynamicDevice checkboxes only
// ever hide FROM Mobile/Landscape, assuming Desktop is always the
// baseline), so this is a small, dedicated main.js-side mechanism rather
// than forcing an ill-fitting reuse of that one.
function updateCustomFunctionGroupVisibility(g, family) {
  if (!g) return
  const activeTab = getActiveDevPanelTab()
  g.style.display = (family === activeTab) ? '' : 'none'
}
// Refreshes every custom function's own group visibility -- called once
// right after a new one is created, and wired to fire again on every tab
// switch (see setupCustomFunctionTabVisibilitySync(), below).
function refreshAllCustomFunctionGroupVisibility() {
  document.querySelectorAll('.dp-group[data-custom-function-family]').forEach((g) => {
    updateCustomFunctionGroupVisibility(g, g.dataset.customFunctionFamily)
  })
}
// Wired once, right after initDevPanel() builds the panel's own tab
// buttons (see its own call site, above) -- registered AFTER devPanel.js's
// own tab-click listeners (same buttons, `addEventListener` fires
// same-event listeners in registration order), so `.dp-tab-active` has
// already been updated by the time this runs. A no-op (nothing to wire)
// on a non-DEV_MODE visitor, where the panel/tabs were never built.
function setupCustomFunctionTabVisibilitySync() {
  document.querySelectorAll('.dp-tab').forEach((btn) => {
    btn.addEventListener('click', () => refreshAllCustomFunctionGroupVisibility())
  })
}
// Type/Touch-Point-Count/Click-Count row visibility -- Type itself has no
// onChange elsewhere (the event-wiring further down reads
// `cfg[`${id}Type`]` live at trigger time, not through a visibility side
// effect), but the 2 rows spliced in right next to it DO need to show/hide
// as Type changes. Touch Point Count only means anything for Multi-Point;
// Click Count (which numbered click/press in this app's own existing
// left-button click/hold chains should fire this function) only has real
// chain infrastructure behind 'Click' and 'Click+Hold' -- Right Click/
// Right Click+Hold/Scroll/Multi-Point have no such chain to select a
// position within (disclosed simplification: those always fire on
// whichever single press/tap/scroll-tick actually happens, matching this
// app's own pre-existing "Right Click has no multi-click counterpart"
// behavior) -- see triggerCustomPoseFunctions()'s/startCustomHoldFunctions()'s
// own comments for where that's actually enforced.
function updateCustomFunctionTypeVisibility(id) {
  const type = cfg[`${id}Type`]
  const touchRow = document.querySelector(`.dp-row[data-key="${id}TouchPointCount"]`)
  if (touchRow) touchRow.style.display = type === 'Multi-Point' ? '' : 'none'
  const clickCountRow = document.querySelector(`.dp-row[data-key="${id}ClickCount"]`)
  if (clickCountRow) clickCountRow.style.display = (type === 'Click' || type === 'Click+Hold') ? '' : 'none'
}
// This function's own "collision bucket" -- every enabled custom function
// with the SAME (family, Type, selector) fires on the exact same real
// gesture. `selector` is Click Count for Click/Click+Hold (the only 2
// Types with a real chain position to pick), Touch Point Count for
// Multi-Point, and a constant for Right Click/Right Click+Hold/Scroll
// (no selector of their own -- ANY 2 enabled functions of one of those 3
// Types, same family, always collide). Returns `null` for a disabled
// function (nothing to collide with -- it never fires at all).
function customFunctionConflictBucketKey(id) {
  if (!cfg[`${id}Enabled`]) return null
  const entry = customClickFunctionIds.find((e) => e.id === id)
  if (!entry) return null
  const type = cfg[`${id}Type`]
  let selector
  if (type === 'Click' || type === 'Click+Hold') selector = cfg[`${id}ClickCount`] || '1st'
  else if (type === 'Multi-Point') selector = cfg[`${id}TouchPointCount`] || 2
  else selector = 'single'
  return `${entry.family}|${type}|${selector}`
}
// Automatic hold-timing conflict resolution (direct spec item) -- when a
// brand-new custom Click/Click+Hold function is created, default its own
// Click Count to the LOWEST ordinal (1st-4th) not already used by another
// currently-ENABLED custom function of the same Type+family, instead of
// always defaulting to '1st' (which would silently collide with whichever
// function already claimed it, both firing off the exact same press). Only
// meaningful for Click/Click+Hold -- Right Click/Right Click+Hold/Scroll/
// Multi-Point have no ordinal of their own (Multi-Point's equivalent,
// Touch Point Count, keeps its own plain numeric default -- 2 -- since
// there's no small fixed set of "positions" to auto-spread across the way
// there is for a 1st-4th click chain). Falls back to '1st' if all 4 slots
// are already taken -- a genuine collision at that point, which
// refreshCustomFunctionConflictWarnings() below will flag rather than
// silently hide.
function nextFreeCustomFunctionClickCountOrdinal(type, family) {
  if (type !== 'Click' && type !== 'Click+Hold') return 1
  const used = new Set()
  // Deliberately NOT gated on `${id}Enabled` -- a real bug caught live
  // 2026-09-19: every new custom function starts disabled by default
  // (Master On/Off), so checking Enabled here meant 2 functions created
  // back to back both saw an "empty" used-set and both defaulted to
  // '1st', the exact collision this helper exists to avoid the moment the
  // user turns them both on. The whole point is spreading NEW functions
  // across free slots regardless of whether earlier ones are turned on
  // yet -- refreshCustomFunctionConflictWarnings() is the one that
  // correctly cares about CURRENTLY-enabled state, for a real runtime
  // conflict; this is about not handing out the same slot twice.
  customClickFunctionIds.forEach(({ id, family: f }) => {
    if (f !== family || cfg[`${id}Type`] !== type) return
    used.add(customFunctionClickCountOrdinal(id))
  })
  for (let n = 1; n <= 4; n++) { if (!used.has(n)) return n }
  return 1
}
// Duplicate-setting validation (direct spec item) -- visually flags every
// custom function that shares its own collision bucket (see
// customFunctionConflictBucketKey()'s own comment) with at least one other
// ENABLED custom function, via a `.dp-group-conflict-warning` CSS class
// (thin warning-colored left border, see style.css) plus a tooltip on the
// group's own header explaining why. Non-blocking by design -- 2 functions
// sharing a gesture both simply fire together (same "whichever runs last
// this frame wins" disclosed pattern already true of chp-vs-rchp
// elsewhere in this file), so this is a heads-up, not a hard stop.
function refreshCustomFunctionConflictWarnings() {
  const bucketCounts = new Map()
  customClickFunctionIds.forEach(({ id }) => {
    const key = customFunctionConflictBucketKey(id)
    if (key) bucketCounts.set(key, (bucketCounts.get(key) || 0) + 1)
  })
  customClickFunctionIds.forEach(({ id }) => {
    const key = customFunctionConflictBucketKey(id)
    const conflicted = !!key && bucketCounts.get(key) > 1
    const row = document.querySelector(`.dp-row[data-key="${id}Enabled"]`)
    const g = row ? row.closest('.dp-group') : null
    if (!g) return
    g.classList.toggle('dp-group-conflict-warning', conflicted)
    const header = g.querySelector(':scope > .dp-group-header')
    if (header) header.title = conflicted ? 'Conflicts with another enabled custom function using the same Type + Click/Touch selector -- both will fire together on the same gesture.' : ''
  })
}
// Builds and renders ONE custom function's live group -- reuses
// makeClickPoseGroup()/makeClickHoldPoseGroup() verbatim (the SAME
// factories every hardcoded trigger already uses) for every control
// except Type/Touch Point Count/Click Count, spliced in right after
// Enabled. Newly-created groups are inserted right after the "Custom
// Click Functions" anchor group (direct request: "the new click function
// should be added right under that settings group, so it should be first
// in line") -- every new insert lands in that exact spot, so the newest
// custom function is always closest to the anchor, pushing earlier ones
// down one slot each time.
function renderCustomClickFunctionGroup(id, title, kind, family) {
  const base = kind === 'hold' ? makeClickHoldPoseGroup(id, title, {}) : makeClickPoseGroup(id, title, {})
  const controls = base.controls.slice()
  const typeOptions = customFunctionTypeOptions(kind, family)
  const defaultType = typeOptions[0]
  // Automatic hold-timing conflict resolution -- see
  // nextFreeCustomFunctionClickCountOrdinal()'s own comment. Only computed
  // from OTHER already-registered functions at this exact moment; this
  // function's own id isn't in `customClickFunctionIds` with `Enabled`
  // seeded yet either way, so it can't collide with itself here.
  const defaultClickCountOrdinal = nextFreeCustomFunctionClickCountOrdinal(defaultType, family)
  controls.splice(1, 0,
    { key: `${id}Type`, label: 'Type', type: 'select', def: defaultType, options: () => typeOptions, onChange: () => { updateCustomFunctionTypeVisibility(id); refreshCustomFunctionConflictWarnings() } },
    { key: `${id}TouchPointCount`, label: 'Touch Point Count', type: 'slider', min: 2, max: 10, step: 1, def: 2, onChange: () => refreshCustomFunctionConflictWarnings() },
    { key: `${id}ClickCount`, label: kind === 'hold' ? 'Triggers On (Nth Press-And-Hold)' : 'Triggers On (Nth Click)', type: 'select', def: ['1st', '2nd', '3rd', '4th'][defaultClickCountOrdinal - 1], options: () => ['1st', '2nd', '3rd', '4th'], onChange: () => refreshCustomFunctionConflictWarnings() }
  )
  // updateClickFunctionEnabledVisibility() (shared with the 10 static
  // triggers, which have no Type/Touch-Point/Click-Count concept at all)
  // unconditionally shows EVERY row in the body when re-enabled -- it has
  // no idea some of those rows are Type-gated. Wrap Enabled's own onChange
  // (real bug, caught live 2026-09-19: re-enabling a custom function
  // always re-showed Touch Point Count even for a plain 'Click' function)
  // so Type-specific visibility is re-applied right after.
  const enabledCtrl = controls.find((c) => c.key === `${id}Enabled`)
  if (enabledCtrl) {
    const baseOnChange = enabledCtrl.onChange
    enabledCtrl.onChange = () => { if (baseOnChange) baseOnChange(); updateCustomFunctionTypeVisibility(id) }
  }
  const g = renderDynamicGroup({ title, controls })
  if (g) {
    const anchor = document.querySelector('.dp-group[data-key="Custom Click Functions"]')
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(g, anchor.nextSibling)
    g.dataset.customFunctionFamily = family
    updateCustomFunctionGroupVisibility(g, family)
  }
  updateCustomFunctionTypeVisibility(id)
  refreshCustomFunctionConflictWarnings()
  if (kind === 'hold') {
    parseClickHoldConfig(id)
    buildClickHoldPoseWidgets(id)
    updateClickTriggerModeVisibility(id, [], ['LoopMode', 'OnReleaseMode', 'TriggerAllHands', 'TweenStopStartTimeCurveEnabled', 'TweenStopDelayEnabled'])
    updateLoopHoldVisibility(id)
    updateOffsetRotationVisibility(id)
    updateSingleTimingGateVisibility(id)
    updateTweenStopGateVisibility(id)
  } else {
    parseClickPoseConfig(id)
    buildClickPoseWidgets(id)
    updateClickTriggerModeVisibility(id, ['PauseDurationMs'])
    updateOffsetRotationVisibility(id)
    updateSingleTimingGateVisibility(id)
    updateSequencePlayModeVisibility(id)
  }
  // Same mandatory Offset/Rotation/Animation Speed Curve/Start Time
  // Curve/Retransition gated-subgroup wrapping the 10 static triggers
  // get -- see wrapClickFunctionGatedSubgroups()'s own comment.
  wrapClickFunctionGatedSubgroups(id)
  // Same Master On/Off "hide all settings when off" behavior the 10
  // static triggers get -- see updateClickFunctionEnabledVisibility()'s
  // own comment. Must run AFTER the wrapping above (it iterates the
  // group body's CURRENT direct children).
  updateClickFunctionEnabledVisibility(id)
}
// Registers a new (or, on restore, a previously-saved) custom function
// into every generic pipeline this project's existing 10 triggers
// already run through -- pushing into CLICK_POSE_KEYS/CLICK_HOLD_KEYS
// means the render-order loop's own dispatch (see its own comment
// further down) picks this id up automatically, no separate dispatch
// code needed. The trigger-state object mirrors the exact shape every
// other entry of its own kind already has (see clickPoseTriggers'/
// clickHoldPoseTriggers' own declarations).
function registerCustomClickFunction(id, title, kind, family) {
  if (kind === 'hold') {
    CLICK_HOLD_KEYS.push(id)
    clickHoldPoseTriggers[id] = {
      active: false, holdStartTime: 0, forwardSnapshot: null, loopPoses: null, loopSegmentMs: 1,
      startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 },
      speedCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], speedRangeParsed: { min: 50, max: 2000 },
      tweenStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStartRangeParsed: { min: 0, max: 300 },
      retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 },
      tweenRetransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenRetransitionRangeParsed: { min: 0, max: 300 },
      tweenStopStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStopStartRangeParsed: { min: 0, max: 300 },
      tweenStopDelayCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStopDelayRangeParsed: { min: 0, max: 2000 }
    }
  } else {
    CLICK_POSE_KEYS.push(id)
    clickPoseTriggers[id] = {
      startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 },
      speedCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], speedRangeParsed: { min: 50, max: 2000 },
      tweenStartCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], tweenStartRangeParsed: { min: 0, max: 300 },
      retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 }
    }
  }
  renderCustomClickFunctionGroup(id, title, kind, family)
}
// "+ Add Click Function"/"+ Add Click+Hold Function" buttons' own
// onClick -- `family` is read from whichever tab is active the MOMENT
// the button is clicked (direct request: "If I add a click function in
// the mobile tab, that click function will only be available to mobile
// and landscape tab, not desktop"), then frozen into the function's own
// bookkeeping permanently -- it does not follow the panel if the user
// later switches tabs again.
function addCustomClickFunction(kind) {
  const family = getActiveDevPanelTab()
  const id = `custom${nextCustomFunctionN}`
  const title = `Custom ${kind === 'hold' ? 'Click+Hold' : 'Click'} Function ${nextCustomFunctionN}`
  nextCustomFunctionN++
  customClickFunctionIds.push({ id, title, kind, family })
  registerCustomClickFunction(id, title, kind, family)
  persistCustomClickFunctionIds()
}
// Called once from onRestore (see initDevPanel()'s own opts, above) --
// `renderDynamicGroup()`'s own DOM rows are pure runtime state, gone on
// every fresh page load, so every previously-created custom function
// needs re-registering (NOT re-adding to `customClickFunctionIds`
// itself, which already came back correctly through the normal cfg
// restore pipeline -- see the DEV_GROUPS control's own comment) from
// scratch each load, same as `buildDevPanel()` itself does for the
// static 10. Iterates `saved` in its own stored (creation) order and
// inserts each one right after the anchor group, same as live creation
// -- the LAST one processed this way ends up closest to the anchor,
// exactly reproducing live creation's own newest-closest-to-anchor
// ordering (confirmed by tracing through: inserting A then B right after
// the anchor each time leaves the order anchor->B->A, matching what live
// creation of A-then-B would have produced).
function restoreCustomClickFunctions() {
  let saved = []
  try { saved = JSON.parse(cfg.customClickFunctionIds || '[]') } catch (e) { /* leave empty -- malformed value, nothing to restore */ }
  if (!Array.isArray(saved)) saved = []
  customClickFunctionIds = saved
  let maxN = 0
  saved.forEach((entry) => {
    if (!entry || !entry.id) return
    registerCustomClickFunction(entry.id, entry.title || entry.id, entry.kind || 'pose', entry.family || 'desktop')
    const m = /^custom(\d+)$/.exec(entry.id)
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10))
  })
  nextCustomFunctionN = maxN + 1
  refreshAllCustomFunctionGroupVisibility()
}
// Maps a Click-Count select value ('1st'/'2nd'/'3rd'/'4th') to its plain
// ordinal number, defaulting an unset/unrecognized value to 1 -- shared by
// every call site below that needs to compare a custom function's own
// setting against the ordinal a real gesture just resolved to.
function customFunctionClickCountOrdinal(id) {
  return { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 }[cfg[`${id}ClickCount`]] || 1
}
// Piggybacks every enabled 'pose'-kind custom function of the matching
// Type onto this project's EXISTING click/right-click/scroll detection
// (see the `pointerup`/`wheel` listeners below). `clickCount` is the
// ordinal this gesture just resolved to (1-4, defaulting to 1 for Types
// with no chain of their own -- Right Click/Scroll always pass the
// default) -- only 'Click' actually gates on it, since it's the only pose
// Type with a real multi-click CHAIN behind it in this app (see
// updateCustomFunctionTypeVisibility()'s own comment for why Right
// Click/Scroll/Multi-Point don't).
function triggerCustomPoseFunctions(type, clickCount = 1) {
  customClickFunctionIds.forEach(({ id, kind }) => {
    if (kind === 'hold' || cfg[`${id}Type`] !== type) return
    if (type === 'Click' && customFunctionClickCountOrdinal(id) !== clickCount) return
    triggerClickPose(id)
  })
}
// Piggybacks every enabled 'hold'-kind custom function of the matching
// Type onto this project's EXISTING chp/rchp/click-hold-chain pointerdown/
// pointerup hold-detection (see the listeners below) -- reuses
// startClickHoldPose()/endClickHoldPose() unchanged, so a custom hold
// function gets the exact same per-hand distance stagger, Single Pose/
// Sequence mode, Loop Mode, Offset/Rotation, On Release Mode, everything
// chp/rchp already have, for free. `ordinal` mirrors triggerCustomPoseFunctions()'s
// own `clickCount` param -- only 'Click+Hold' gates on it (the only hold
// Type with a real press-chain, chp/dcHold/tripleClickHold/quadClickHold,
// behind it); Right Click+Hold/Multi-Point always fire regardless (Right
// Click+Hold has no chain to begin with; Multi-Point is gated by its own
// separate Touch Point Count mechanism instead, see the touch listeners
// below).
function startCustomHoldFunctions(type, ordinal = 1) {
  customClickFunctionIds.forEach(({ id, kind }) => {
    if (kind !== 'hold' || cfg[`${id}Type`] !== type) return
    if (type === 'Click+Hold' && customFunctionClickCountOrdinal(id) !== ordinal) return
    startClickHoldPose(id)
  })
}
function endCustomHoldFunctions(type, ordinal = 1) {
  customClickFunctionIds.forEach(({ id, kind }) => {
    if (kind !== 'hold' || cfg[`${id}Type`] !== type) return
    if (type === 'Click+Hold' && customFunctionClickCountOrdinal(id) !== ordinal) return
    endClickHoldPose(id)
  })
}
// Scroll -- direct spec item ("Click Function Type should always include
// -- Click, Click+Hold, Scroll, Right Click, Right Click+Hold for Desktop
// Mode"). No existing gesture family to reuse: a real wheel gesture fires
// many `wheel` events per second, so this can't just call triggerCustomPoseFunctions
// on every one of them the way a plain click can -- debounced via the SAME
// `cfg.multiClickWindowMs` slider every other click/hold chain in this file
// already uses, so one real scroll swipe fires once, not dozens of times.
// Fires again after the window elapses if the user keeps scrolling
// (a deliberate "repeat rate," not a one-shot-per-page-load limit).
let scrollTriggerTimer = null
window.addEventListener('wheel', (e) => {
  if (e.target && e.target.closest && e.target.closest('.dp-panel')) return
  if (scrollTriggerTimer) return
  triggerCustomPoseFunctions('Scroll')
  scrollTriggerTimer = setTimeout(() => { scrollTriggerTimer = null }, cfg.multiClickWindowMs)
}, { passive: true })
// Multi-Point -- direct spec item ("That Click Function group for Type,
// will always include -- Click, Click+Hold, Multi-Point [for Mobile]").
// Tracks the live simultaneous touch-point count; a 'pose'-kind function
// fires once the INSTANT its own Touch Point Count is first reached (not
// repeated while those fingers stay down); a 'hold'-kind function starts
// at that same instant and ends the instant the count drops back below its
// own threshold -- independent per function, since 2 Multi-Point functions
// can have different Touch Point Count settings active at once.
let multiPointActiveTouchCount = 0
window.addEventListener('touchstart', (e) => {
  const prevCount = multiPointActiveTouchCount
  multiPointActiveTouchCount = e.touches.length
  customClickFunctionIds.forEach(({ id, kind }) => {
    if (cfg[`${id}Type`] !== 'Multi-Point') return
    const need = cfg[`${id}TouchPointCount`] || 2
    if (prevCount < need && multiPointActiveTouchCount >= need) {
      if (kind === 'hold') startClickHoldPose(id)
      else triggerClickPose(id)
    }
  })
}, { passive: true })
function multiPointHandleTouchEnd(e) {
  const prevCount = multiPointActiveTouchCount
  multiPointActiveTouchCount = e.touches.length
  customClickFunctionIds.forEach(({ id, kind }) => {
    if (kind !== 'hold' || cfg[`${id}Type`] !== 'Multi-Point') return
    const need = cfg[`${id}TouchPointCount`] || 2
    if (prevCount >= need && multiPointActiveTouchCount < need) endClickHoldPose(id)
  })
}
window.addEventListener('touchend', multiPointHandleTouchEnd, { passive: true })
window.addEventListener('touchcancel', multiPointHandleTouchEnd, { passive: true })
// Whether ANY custom hold function of the given Type has been held long
// enough to count as a genuine hold-release, not a quick tap -- feeds the
// SAME `lastPointerupWasHoldRelease`/`lastPointerupWasRchpHoldRelease`
// suppression chp/rchp already use (see that flag's own top comment),
// generalized so a custom Click+Hold/Right-Click+Hold function doesn't
// ALSO fire the plain click/right-click triggers on release, the exact
// bug class that suppression was originally built to prevent.
function isCustomHoldHeldLongEnough(type, now) {
  return customClickFunctionIds.some(({ id, kind }) => {
    if (kind !== 'hold' || cfg[`${id}Type`] !== type) return false
    const trig = clickHoldPoseTriggers[id]
    return trig && trig.active && (now - trig.holdStartTime) >= MOUSE_LOG_HELD_DRAG_MS
  })
}
// Shared by every Click-family trigger group with a Mode dropdown
// (originally Right Click's own "the relevant setting ui only show when
// i select either," then generalized to Click Hold-Pose/Right-Click
// Hold-Pose/Click Pose/Double-Click Pose per direct follow-up request --
// no existing devPanel.js mechanism shows/hides a row by another
// control's value, so this hand-toggles rows directly by their own
// data-key, same selector convention as buildClickPoseWidgets() above).
// CORRECTED, same day: originally only Target Pose vs. Tween Sequence
// toggled -- direct follow-up correction ("the pose transition, hold,
// retransition UI should only show when Single Pose is selected") widened
// this to the WHOLE transition/pause/retransition block, since none of
// that language describes playing through a Tween Sequence either.
// `extraSinglePoseKeys` covers the one shape difference between the 2
// families this is shared across: Click Pose/Double-Click Pose/Right
// Click have a Pause Duration slider (the 3-phase forward/paused/
// retransition machine); Click Hold-Pose/Right-Click Hold-Pose don't (a
// 2-phase forward/retransition machine, paced by how long the button is
// actually held) -- pass `[]` for those. Enabled, Mode, and (for the
// Hold-Pose family) Hold Confirm Delay stay visible regardless of mode --
// none of those describe posing TO a specific target, single or tweened.
// `extraTweenKeys` is the Tween-side mirror, currently only Loop (Click
// Hold-Pose/Right-Click Hold-Pose only -- Click Pose/Double-Click Pose/
// Right Click are fire-and-forget, no "held" state for a loop to run
// during, so they're always called with `[]` here).
function updateClickTriggerModeVisibility(p, extraSinglePoseKeys, extraTweenKeys = []) {
  const mode = cfg[`${p}Mode`]
  // StartTimeCurve/StartTimeRange and the Retransition trio moved OUT of
  // this hardcoded list and into updateSingleTimingGateVisibility()'s own
  // ownership (added alongside Animation Speed Curve/Start Time Curve/
  // Retransition's own on-off gates) -- that function now fully owns
  // their visibility (mode check included), so they're not double-
  // managed by 2 different functions racing to set the same row's
  // `display`.
  const singlePoseKeys = ['TargetPose', 'TransitionSpeedMs', ...extraSinglePoseKeys]
  // Tween's own dedicated speed/curve/range trios (see
  // makeClickHoldPoseGroup()'s own comment for why these are separate
  // fields from the Single Pose trio above, not just hidden duplicates).
  // The Retransition trio only exists for CLICK_HOLD_KEYS groups (chp/
  // rchp/dcHold) -- harmless no-op here for CLICK_POSE_KEYS callers
  // (click/dblclick/rc), whose own rows with these suffixes simply don't
  // exist, so the `document.querySelector` below just finds nothing.
  const tweenKeys = ['TweenSelector', 'TweenSpeedMs', 'TweenStartTimeCurve', 'TweenStartTimeRange', 'TweenRetransitionSpeedMs', 'TweenRetransitionStartTimeCurve', 'TweenRetransitionStartTimeRange', ...extraTweenKeys]
  // Inline style, not the `hidden` attribute -- devPanel.js's own
  // `.dp-row { display: flex }` stylesheet rule (style.css) is an author
  // rule, which wins the cascade over the UA stylesheet's `[hidden] {
  // display: none }` at equal specificity regardless of source order, so
  // setting `.hidden` alone would silently do nothing here.
  singlePoseKeys.forEach((suffix) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = mode !== 'Single Pose' ? 'none' : ''
  })
  tweenKeys.forEach((suffix) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = mode !== 'Sequence' ? 'none' : ''
  })
}
// Loop Hold Duration's own NESTED visibility (chp/rchp only) -- deliberately
// separate from updateClickTriggerModeVisibility() above: it needs a 2nd
// condition beyond "is Tween mode selected," namely "is Loop Mode
// anything other than Off" (a hold duration is meaningless with no
// looping happening at all). Called from BOTH Mode's own onChange (so
// switching away from Tween re-hides it regardless of LoopMode) and
// LoopMode's own onChange (so picking 'Off' hides it even while still in
// Tween mode) -- see both controls' own onChange in makeClickHoldPoseGroup().
function updateLoopHoldVisibility(p) {
  const row = document.querySelector(`.dp-row[data-key="${p}LoopHoldMs"]`)
  if (row) row.style.display = (cfg[`${p}Mode`] === 'Sequence' && cfg[`${p}LoopMode`] !== 'Off') ? '' : 'none'
}
// Owns StartTimeCurveEnabled/SpeedCurveEnabled/RetransitionEnabled's own
// rows (mode-gated only, always visible in Single Pose regardless of
// their OWN state -- they're the master toggles) plus the rows each one
// gates (mode AND its own on/off) -- StartTimeCurve/StartTimeRange used
// to be governed by updateClickTriggerModeVisibility()'s own hardcoded
// singlePoseKeys list; the Retransition trio the same. Both moved here
// so there's exactly one function deciding each row's `display`, not 2
// racing. Single-Pose-only per the original spec's own grouping
// ("Single-Pose-mode settings: ... Animation Speed Curve on/off [NEW],
// Start Time Curve on/off [wraps existing], ... Retransition on/off
// [NEW behavioral gate]") -- deliberately NOT extended to Tween mode's
// own separate Tween-prefixed trio, a disclosed scoping choice, not a
// literal instruction either way.
function updateSingleTimingGateVisibility(p) {
  const showBase = cfg[`${p}Mode`] === 'Single Pose'
  const setRow = (suffix, visible) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = visible ? '' : 'none'
  }
  // CORRECTED 2026-09-19: the 3 "Enabled" gate rows now live inside their
  // own nested group's HEADER (wrapGatedSubgroup(), see its own comment)
  // -- hiding just the row when `showBase` is false used to leave an
  // orphaned, empty-looking group behind (a title with no checkbox, no
  // visible members) whenever Mode isn't Single Pose. `setGateRow` also
  // hides the row's own closest `.dp-group` container in that case, so
  // the whole "Animation Speed Curve"/"Start Time Curve"/"Retransition"
  // group disappears entirely outside Single Pose mode instead of
  // leaving a hollow shell.
  const setGateRow = (suffix, visible) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (!row) return
    row.style.display = visible ? '' : 'none'
    const grp = row.closest('.dp-group')
    if (grp) grp.style.display = visible ? '' : 'none'
  }
  setGateRow('SpeedCurveEnabled', showBase)
  const speedOn = showBase && !!cfg[`${p}SpeedCurveEnabled`]
  setRow('SpeedCurve', speedOn)
  setRow('SpeedCurveRange', speedOn)
  setGateRow('StartTimeCurveEnabled', showBase)
  const startOn = showBase && cfg[`${p}StartTimeCurveEnabled`] !== false
  setRow('StartTimeCurve', startOn)
  setRow('StartTimeRange', startOn)
  setGateRow('RetransitionEnabled', showBase)
  const retransitionOn = showBase && cfg[`${p}RetransitionEnabled`] !== false
  setRow('RetransitionSpeedMs', retransitionOn)
  setRow('RetransitionStartTimeCurve', retransitionOn)
  setRow('RetransitionStartTimeRange', retransitionOn)
}
// Tween Stop's own sub-gating (Sequence mode only, hold-based triggers
// only) -- see the control's own DEV_GROUPS comment for the full
// reasoning. `TweenStopStartTimeCurveEnabled`/`TweenStopDelayEnabled`
// themselves are Mode-gated by updateClickTriggerModeVisibility()'s own
// extraTweenKeys list (called alongside this function everywhere it's
// called); this function owns the finer sub-visibility one level down
// (the curve/range pair under each Enabled checkbox, and
// TweenStopDelayCurveEnabled's own row, which only makes sense once
// TweenStopDelayEnabled is on). Re-checks `isSequence` itself too, so
// it stays correct even if called on its own outside the Mode-change
// handler.
function updateTweenStopGateVisibility(p) {
  const isSequence = cfg[`${p}Mode`] === 'Sequence'
  const setRow = (suffix, visible) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = visible ? '' : 'none'
  }
  const startCurveOn = isSequence && !!cfg[`${p}TweenStopStartTimeCurveEnabled`]
  setRow('TweenStopStartTimeCurve', startCurveOn)
  setRow('TweenStopStartTimeRange', startCurveOn)
  const delayOn = isSequence && !!cfg[`${p}TweenStopDelayEnabled`]
  setRow('TweenStopDelayMs', delayOn)
  setRow('TweenStopDelayCurveEnabled', delayOn)
  const delayCurveOn = delayOn && !!cfg[`${p}TweenStopDelayCurveEnabled`]
  setRow('TweenStopDelayCurve', delayCurveOn)
  setRow('TweenStopDelayRange', delayCurveOn)
}
// Sequence Mode - Count/Loop/Oscillate's own visibility, for the 5
// fire-and-forget triggers only (click/dblclick/rc/tripleClick/
// quadClick) -- see makeClickPoseGroup()'s own control comment for the
// full reasoning. Mode-gated (Sequence only, mirrors the Tween trio's
// own tweenKeys visibility), PLUS 2 further sub-gates: Sequence Count/
// Sequence Count Mode only under 'Count'; Loop Transition only under a
// Loop-style repeat (top-level 'Loop', or 'Count' + Count Mode 'Loop').
function updateSequencePlayModeVisibility(p) {
  const showBase = cfg[`${p}Mode`] === 'Sequence'
  const setRow = (suffix, visible) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = visible ? '' : 'none'
  }
  setRow('SequencePlayMode', showBase)
  const playMode = cfg[`${p}SequencePlayMode`]
  const isCount = showBase && playMode === 'Count'
  setRow('SequenceCount', isCount)
  setRow('SequenceCountMode', isCount)
  const isLoopStyle = showBase && (playMode === 'Loop' || (playMode === 'Count' && cfg[`${p}SequenceCountMode`] === 'Loop'))
  setRow('SequenceLoopTransition', isLoopStyle)
  setRow('SequenceHoldMs', showBase)
}
// Offset/Rotation rows are each gated by their own On/Off checkbox,
// independent of Mode -- unlike updateClickTriggerModeVisibility() above,
// these apply the same in Single Pose and Sequence mode alike, so Mode
// switching never touches this function.
function updateOffsetRotationVisibility(p) {
  const offsetOn = !!cfg[`${p}OffsetEnabled`]
  ;['OffsetX', 'OffsetY'].forEach((suffix) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = offsetOn ? '' : 'none'
  })
  const rotationOn = !!cfg[`${p}RotationEnabled`]
  ;['RotationX', 'RotationY', 'RotationZ'].forEach((suffix) => {
    const row = document.querySelector(`.dp-row[data-key="${p}${suffix}"]`)
    if (row) row.style.display = rotationOn ? '' : 'none'
  })
}
CLICK_POSE_KEYS.forEach((p) => { parseClickPoseConfig(p); buildClickPoseWidgets(p) })
// Every Click-family group's own Mode dropdown (Single Pose vs. Tween) --
// run once now that all of these rows definitely exist, same reasoning/
// timing as the widget builders directly above; each group's own Mode
// control's own onChange (DEV_GROUPS, above) keeps this current after
// that. Click Pose/Double-Click Pose/Right Click share CLICK_POSE_KEYS'
// own Pause Duration slider; Click Hold-Pose/Right-Click Hold-Pose don't.
CLICK_POSE_KEYS.forEach((p) => { updateClickTriggerModeVisibility(p, ['PauseDurationMs']); updateOffsetRotationVisibility(p); updateSingleTimingGateVisibility(p); updateSequencePlayModeVisibility(p) })
CLICK_HOLD_KEYS.forEach((p) => { updateClickTriggerModeVisibility(p, [], ['LoopMode', 'OnReleaseMode', 'TriggerAllHands', 'TweenStopStartTimeCurveEnabled', 'TweenStopDelayEnabled']); updateLoopHoldVisibility(p); updateOffsetRotationVisibility(p); updateSingleTimingGateVisibility(p); updateTweenStopGateVisibility(p) })
// Offset/Rotation/Animation Speed Curve/Start Time Curve/Retransition as
// "mandatory gated subgroups" -- direct request ("Offset, Rotation,
// Animaiton Speed Curve, Start Time Curve, Retransition will all be
// manditory subgroups within the click function. They will all have a
// checkbox within their labels that is the on off checkbox. If all are
// turned off, they will just show as empty setting groups"). Wraps each
// cluster's already-built flat rows (unchanged -- same buildRow()/
// commit()/data-key wiring every other control already has) into a real
// nested collapsible group, moving the "Enabled" row's own checkbox
// bodily into that group's own header (see wrapGatedSubgroup()'s own
// comment for exactly how, and devPanel.js's own matching
// `.dp-group-gate-row` click-guard for why the header doesn't ALSO
// toggle collapse on the same click). The existing visibility functions
// (updateOffsetRotationVisibility()/updateSingleTimingGateVisibility(),
// both unchanged) keep working with zero changes -- they select rows by
// `data-key` alone, which still resolves correctly no matter where in
// the tree a row currently lives.
function wrapGatedSubgroup(enabledKey, memberKeys, subgroupTitle) {
  const enabledRow = document.querySelector(`.dp-row[data-key="${enabledKey}"]`)
  if (!enabledRow) return null
  const parentBody = enabledRow.parentElement
  const g = createGroupElement(subgroupTitle)
  parentBody.insertBefore(g, enabledRow)
  const gb = g.querySelector(':scope > .dp-group-body')
  memberKeys.forEach((k) => {
    const row = parentBody.querySelector(`:scope > .dp-row[data-key="${k}"]`)
    if (row) gb.appendChild(row)
  })
  enabledRow.classList.add('dp-group-gate-row')
  g.querySelector(':scope > .dp-group-header').appendChild(enabledRow)
  return g
}
// Applies all 5 gated-subgroup wraps to ONE trigger `p` -- identical
// member-key lists for both the hold-based and fire-and-forget families
// (the Sequence-mode-only Tween Retransition trio is deliberately NOT
// part of the Retransition cluster -- it's ungated, always visible in
// Sequence mode, a separate concept from Single Pose's own Retransition
// on/off).
function wrapClickFunctionGatedSubgroups(p) {
  wrapGatedSubgroup(`${p}OffsetEnabled`, [`${p}OffsetX`, `${p}OffsetY`], 'Offset')
  wrapGatedSubgroup(`${p}RotationEnabled`, [`${p}RotationX`, `${p}RotationY`, `${p}RotationZ`], 'Rotation')
  wrapGatedSubgroup(`${p}SpeedCurveEnabled`, [`${p}SpeedCurve`, `${p}SpeedCurveRange`], 'Animation Speed Curve')
  wrapGatedSubgroup(`${p}StartTimeCurveEnabled`, [`${p}StartTimeCurve`, `${p}StartTimeRange`], 'Start Time Curve')
  wrapGatedSubgroup(`${p}RetransitionEnabled`, [`${p}RetransitionSpeedMs`, `${p}RetransitionStartTimeCurve`, `${p}RetransitionStartTimeRange`], 'Retransition')
}
// Called once for all 10 static triggers, right here (module init, after
// every one of their rows definitely exists AND after the widget-
// builders/visibility-sync calls directly above -- moving a row preserves
// its already-attached curve-widget children and already-set
// `style.display`, so order relative to those doesn't matter, but rows
// have to actually exist first). Custom Click Functions get the same
// treatment from their own renderCustomClickFunctionGroup(), right after
// creation.
function wrapAllClickFunctionGatedSubgroups() {
  ;[...CLICK_HOLD_KEYS, ...CLICK_POSE_KEYS].forEach(wrapClickFunctionGatedSubgroups)
}
wrapAllClickFunctionGatedSubgroups()
// "Click Function On/Off Checkbox. If Off, hide all settings for this
// function" -- direct spec item, corrected 2026-09-19 after re-reading
// the verbatim original spec text (previously unbuilt -- an earlier
// pass had only gated the trigger LOGIC on this checkbox, never the
// dev-panel VISIBILITY of its other settings). Blanket-hides every
// OTHER direct child of the trigger's own group body (every plain row
// -- Type/Mode/TargetPose/etc. -- AND every nested gated-subgroup
// container -- Offset/Rotation/Animation Speed Curve/Start Time Curve/
// Retransition, all now direct children after wrapGatedSubgroup()
// relocated their own member rows one level deeper) when Enabled is
// off, leaving only the Enabled checkbox itself visible. When turning
// back on, re-invokes the trigger's own finer-grained visibility
// functions afterward -- the blanket "show everything" sweep would
// otherwise incorrectly un-hide something those functions had already
// correctly hidden for an unrelated reason (e.g. a Sequence-mode
// trigger's own Single-Pose-only gated subgroups).
function updateClickFunctionEnabledVisibility(p) {
  const enabledRow = document.querySelector(`.dp-row[data-key="${p}Enabled"]`)
  if (!enabledRow) return
  const group = enabledRow.closest('.dp-group')
  if (!group) return
  const body = group.querySelector(':scope > .dp-group-body')
  if (!body) return
  const enabled = !!cfg[`${p}Enabled`]
  Array.from(body.children).forEach((child) => {
    if (child === enabledRow) return
    child.style.display = enabled ? '' : 'none'
  })
  // Cheap no-op for the 10 static triggers (only ever iterates
  // customClickFunctionIds); for a custom function, an Enabled toggle
  // changes whether it's even in the collision-bucket count at all -- see
  // refreshCustomFunctionConflictWarnings()'s own comment.
  refreshCustomFunctionConflictWarnings()
  if (!enabled) return // fully hidden -- nothing further to reconcile
  const isHoldKind = CLICK_HOLD_KEYS.includes(p)
  if (isHoldKind) {
    updateClickTriggerModeVisibility(p, [], ['LoopMode', 'OnReleaseMode', 'TriggerAllHands', 'TweenStopStartTimeCurveEnabled', 'TweenStopDelayEnabled'])
    updateLoopHoldVisibility(p)
    updateTweenStopGateVisibility(p)
  } else {
    updateClickTriggerModeVisibility(p, ['PauseDurationMs'])
    updateSequencePlayModeVisibility(p)
  }
  updateOffsetRotationVisibility(p)
  updateSingleTimingGateVisibility(p)
}
;[...CLICK_HOLD_KEYS, ...CLICK_POSE_KEYS].forEach(updateClickFunctionEnabledVisibility)
updateLoadingPreviewSequenceVisibility()
// Bug fix (direct user report, "I dont see any of the saved poses in the
// dropdown"): a `select` control's <option> list is populated by
// `displayValue()` during the host's own restore-from-storage step
// inside `initDevPanel()` itself -- which runs BEFORE `const cfg = ...`
// (below) finishes assigning, so `${p}TargetPose`'s own `options: () =>
// (cfg.savedPoses || [])...` closure hits `cfg` while it's still in the
// TDZ. devPanel.js's own `fillSelectOptions()` catches that error and
// silently treats it as "no options yet" (see its own doc comment) --
// exactly the empty-dropdown symptom reported. The 2 refreshSelectOptions()
// calls wired to `savedPoses`'s own onChange only fire on a FUTURE
// Save/Delete, never for poses that already existed at page load. This
// one-time call, now that `cfg` genuinely exists, re-populates both
// dropdowns for real. Goes through safeRefreshSelectOptions() (defined
// above, next to the 'savedPoses' onChange that also uses it), not a
// bare call, since 'rchpTargetPose' specifically was found via live
// testing to throw inside devPanel.js's own commit()/fillSelectOptions()
// for a cause not fully root-caused (isolated to this exact key --
// 'chpTargetPose' succeeds every time, 'rchpTargetPose' throws every
// time, even called alone) -- this must never take down the whole page.
safeRefreshSelectOptions('chpTargetPose')
safeRefreshSelectOptions('rchpTargetPose')
safeRefreshSelectOptions('clickTargetPose')
safeRefreshSelectOptions('dblclickTargetPose')
// Right Click's own 3 selects hit this same one-time TDZ-populated-empty
// symptom -- rcTargetPose for the same cfg.savedPoses reason as the 4
// calls above; rcMode (a plain literal array, no cfg dependency at all)
// and rcTweenSelector (cfg.savedTweenSequences) empty too, confirming
// this is a general "any `select` built before this point needs a
// one-time re-populate" issue, not specific to a cfg-reading closure.
safeRefreshSelectOptions('rcTargetPose')
safeRefreshSelectOptions('rcMode')
safeRefreshSelectOptions('rcTweenSelector')
// Same TDZ-populated-empty symptom, now that Mode + Tween Sequence were
// added to the other 4 Click-family groups too (2026-09-15) -- their own
// TargetPose selects were already covered by the 4 calls above, but
// Mode/TweenSelector are new keys needing their own first-time populate.
// LoopMode (chp/rchp only, a select since the same day's Oscillate
// follow-up) needs the same one-time populate too.
safeRefreshSelectOptions('chpMode')
safeRefreshSelectOptions('chpTweenSelector')
safeRefreshSelectOptions('chpLoopMode')
safeRefreshSelectOptions('rchpMode')
safeRefreshSelectOptions('rchpTweenSelector')
safeRefreshSelectOptions('rchpLoopMode')
safeRefreshSelectOptions('clickMode')
safeRefreshSelectOptions('clickTweenSelector')
safeRefreshSelectOptions('dblclickMode')
safeRefreshSelectOptions('dblclickTweenSelector')
// dcHold added 2026-09-15 (rebuilt as a 3rd makeClickHoldPoseGroup()
// instance -- see its own DEV_GROUPS comment) -- needs the same one-time
// populate as chp/rchp above, plus TargetPose specifically (a genuinely
// NEW control for this trigger; its own Tween Selector already existed
// before this rebuild but was NEVER added to this list, an existing gap
// this happens to also close).
safeRefreshSelectOptions('dcHoldMode')
safeRefreshSelectOptions('dcHoldTargetPose')
safeRefreshSelectOptions('dcHoldTweenSelector')
safeRefreshSelectOptions('dcHoldLoopMode')
// Sets this ONE hand's `clone.quaternion`/`clone.position` for its
// CURRENT arm-length value `hideT` -- called every frame, per hand, from
// updateRenderOrder()'s own existing per-hand loop (which already
// computes the live cursor distance this needs, see that function),
// replacing the old slider-triggered `updateClonePoseTransform()` now
// that `hideT` can differ per hand and change every frame under Reactive
// mode. Cheap enough at hundreds of hands (a handful of vector ops each,
// same order of cost as the render-order distance calc it rides along
// with); when Reactive is off `hideT` is constant across hands and
// frames, so this is doing slightly redundant work in that case too, but
// keeping ONE code path for both modes is simpler and not measurably
// slower.
//
// Math identical to the prior single-hideT version (see CHANGELOG.txt for
// the full derivation and the 2 bugs it took to get here): the "cut" point
// -- interpolated from the forearm-base bone (hideT=0) to the wrist bone
// (hideT=1), as an ABSOLUTE position in the mesh's own raw/bind-pose frame
// -- is solved to land exactly at this hand's own wrapper origin (its
// Field Layout grid point) for the CURRENT cloneBaseQuat, for ANY hideT.
const _cutPointRaw = new THREE.Vector3()
// Reads THIS hand's own `currentBaseQuat`, not the shared `cloneBaseQuat`
// directly -- for a hand that's never mid pose-transition, the 2 are kept
// identical every frame (see updateRenderOrder()'s own per-hand loop), so
// this is a no-op change for every use of Whole-Hand Rotation that
// predates Click-Hold-Pose/Click-Pose's own per-hand rotation transition.
// Reads 1 frame behind for a hand THAT IS mid-transition (this function
// runs before this frame's own pose-override step updates currentBaseQuat
// for the frame) -- a deliberate, disclosed simplification: at 60fps this
// is a ~16ms lag on the ARM-LENGTH POSITION ONLY (never the fingers,
// which read the fresh value the same frame), well below anything
// visually perceptible, and avoids restructuring the per-hand loop's own
// established bone-posing order.
function applyHandArmLength(hand, hideT) {
  const scaleFactor = computeBaseScale()
  const baseQuat = hand.currentBaseQuat
  _cutPointRaw.copy(forearmPosRaw).lerp(wristPosRaw, hideT)
  hand.clone.quaternion.copy(baseQuat)
  hand.clone.position.copy(_cutPointRaw).applyQuaternion(baseQuat).multiplyScalar(-scaleFactor)
}

// "Hide Wrist"/Arm Length clipping plane -- ported from HANDO's own
// wristClipPlane, but genuinely PER-HAND (own `THREE.Plane` instance per
// hand, see rebuildField()'s own `hand.wristClipPlane`): every hand faces
// a different direction (pointing at the cursor) and (under Reactive
// mode) has its OWN current arm-length value, so each needs its own
// plane geometry, recomputed from that hand's own live wrist/forearm bone
// world positions right before it draws (`onBeforeRender`, the same
// per-hand mechanism already used for the depth-clear technique -- see
// rebuildField()).
//
// CORRECTED 2026-09-13 (user-reported "arms disappearing completely,
// even with Crop Wrist off"): this used to be ONE shared `THREE.Plane`,
// mutated in place immediately before each hand's own draw call, on the
// (wrong) assumption that mutating it per-`onBeforeRender` would apply
// correctly per-draw-call even with `clippingPlanes` on a MATERIAL shared
// by every hand. Confirmed live (debug hook) this does NOT hold: with a
// shared material + shared plane, all but ~1-2 of 289 hands rendered
// nothing at their own correct, verified screen position -- stripping
// `clippingPlanes` off the shared material entirely restored 288/289.
// Root cause: `clippingPlanes` lives on the MATERIAL, not the mesh, so a
// shared material can only ever expose ONE clip-plane state per render
// pass regardless of how many `onBeforeRender` hooks mutate it -- most
// hands ended up clipped against a plane derived from some OTHER hand's
// bone positions, discarding their entire mesh. Fixed by giving every
// hand its own CLONED material (see rebuildField()) whose own
// `clippingPlanes` array holds only that hand's own Plane instance --
// `forEachToonMaterial()`/`forEachOutlineMaterial()` (see their own
// comment) keep every existing "change a shared material setting"
// control working across all the resulting per-hand clones.
// `material.clippingPlanes` (not `renderer.clippingPlanes`) confines the
// clip to hand geometry only, so the cursor target marker/grid helper are
// never affected regardless of draw order.
const _clipFarPos = new THREE.Vector3()
const _clipNearPos = new THREE.Vector3()
const _clipDir = new THREE.Vector3()
const _clipPoint = new THREE.Vector3()
function updateWristClipPlaneForHand(hand) {
  if (!hand.skinnedMesh) return
  const farBone = hand.skinnedMesh.skeleton.getBoneByName('rForearmBend')
  const nearBone = hand.skinnedMesh.skeleton.getBoneByName('rHand')
  if (!farBone || !nearBone) return
  farBone.getWorldPosition(_clipFarPos)
  nearBone.getWorldPosition(_clipNearPos)
  _clipDir.subVectors(_clipNearPos, _clipFarPos).normalize()
  const armToWristDist = _clipFarPos.distanceTo(_clipNearPos)
  // Reads this hand's OWN current arm-length value, computed and cached
  // this same frame by updateRenderOrder() (before composer.render() ever
  // fires this onBeforeRender callback) -- falls back to the non-reactive
  // value if that hasn't run yet for any reason (e.g. a manual render
  // before the first animate() frame).
  const t = hand.currentArmLengthT !== undefined ? hand.currentArmLengthT : cfg.hideWrist / 100
  _clipPoint.copy(_clipFarPos).addScaledVector(_clipDir, armToWristDist * t)
  hand.wristClipPlane.setFromNormalAndCoplanarPoint(_clipDir, _clipPoint)
}

// -----------------------------------------------------------------------
// Field layout
// -----------------------------------------------------------------------
// Fixed world-unit reference length for auto-fitting hand scale -- NOT
// derived from rowSpacing/columnSpacing, per direct request that spacing
// and scale be fully independent (previously, `computeBaseScale()` used
// `Math.min(rowSpacing, columnSpacing) * 0.8`, so dragging either spacing
// slider silently changed hand size too). Matches what that formula
// evaluated to at this project's own original spacing defaults (10, 11.5)
// so existing saved settings don't visually jump; `cfg.handScale` is now
// the ONLY thing that scales hands.
const HAND_SCALE_REFERENCE_LENGTH = 8
function computeBaseScale() {
  return (HAND_SCALE_REFERENCE_LENGTH / handLengthRaw) * cfg.handScale
}

function relayoutField() {
  if (!modelLoaded) return
  const rows = cfg.fieldRows, cols = cfg.fieldCols
  const rowSpacing = cfg.rowSpacing, colSpacing = cfg.columnSpacing
  const scaleFactor = computeBaseScale()
  const w = (cols - 1) * colSpacing
  const h = (rows - 1) * rowSpacing
  let i = 0
  for (let r = 0; r < rows; r++) {
    // Alternate mode: classic brick/hex stagger, every OTHER row shifted.
    // Progressive mode: each successive row shifts further than the last
    // (row 2 by 1x the setting, row 3 by 2x, etc, per direct spec).
    const rowOffsetX = cfg.useProgressiveOffset
      ? r * cfg.progressiveRowOffset
      : (r % 2 === 1 ? cfg.alternateRowOffset : 0)
    for (let c = 0; c < cols; c++) {
      const hand = hands[i++]
      if (!hand) continue
      hand.wrapper.position.set(c * colSpacing - w / 2 + rowOffsetX, r * rowSpacing - h / 2, 0)
      hand.clone.scale.setScalar(scaleFactor)
    }
  }
  // Arm-length position compensation now recomputes every frame (see
  // applyHandArmLength(), called from updateRenderOrder()) and reads
  // computeBaseScale() fresh each time, so it automatically picks up a
  // relayout-driven scale change on the very next frame -- nothing to
  // trigger here for that. cloneBaseQuat itself doesn't depend on layout
  // at all, but is kept current here too in case relayoutField() ever
  // runs before the first animate() frame.
  updateCloneBaseQuat()
}

// Rows/columns/spacing/offsets NEVER touch camera/lighting/target-plane
// framing (direct request: "Field layout shouldn't affect view scale") --
// that framing is derived from the field's size exactly ONCE (framedOnce),
// the very first time hands are built, and never revisited after that.
function rebuildField() {
  if (!modelLoaded) return
  hands.forEach((hand) => scene.remove(hand.wrapper))
  hands.length = 0
  const total = cfg.fieldRows * cfg.fieldCols
  for (let i = 0; i < total; i++) {
    const clone = cloneSkeletal(modelRoot)
    clone.quaternion.copy(alignQuat)
    const skinnedMesh = findSkinnedMesh(clone)
    // Own Plane + own cloned material per hand -- see
    // updateWristClipPlaneForHand()'s own corrected comment for why a
    // shared material/plane silently discarded almost every hand's mesh.
    const handWristClipPlane = new THREE.Plane()
    if (skinnedMesh && toonMaterial) {
      skinnedMesh.material = toonMaterial.clone()
      skinnedMesh.material.clippingPlanes = [handWristClipPlane]
      // `Material.clone()`/`.copy()` does NOT carry over a custom
      // `onBeforeCompile` override -- it isn't part of the property list
      // three.js's own `copy()` handles, so a clone silently reverts to
      // the prototype's no-op default. CONFIRMED live (user-reported: Key
      // Light color "no longer working" -- white showed real texture
      // colors, red visibly tinted, meaning the rim-light/toon-tint
      // duotone blend from createToonMaterial()'s own onBeforeCompile had
      // gone missing): read back a field hand's own actual compiled
      // fragment shader source post-fix-1 (the customProgramCacheKey
      // removal, which did NOT fix this) and confirmed it contained none
      // of the injected code at all. Re-assigning the function reference
      // explicitly after cloning is the fix.
      skinnedMesh.material.onBeforeCompile = toonMaterial.onBeforeCompile
    }
    const outlineMesh = skinnedMesh ? buildOutlineMesh(skinnedMesh) : null
    if (outlineMesh) { outlineMesh.material.clippingPlanes = [handWristClipPlane]; clone.add(outlineMesh) }
    // Depth-buffer-per-hand technique: both materials keep depthTest ON
    // (see createToonMaterial()'s own note) so a hand's own geometry
    // self-occludes correctly, but the depth buffer is wiped immediately
    // before each hand's own draw call -- so cross-hand stacking is still
    // decided purely by draw order (renderOrder, from cursor distance,
    // see updateRenderOrder()) rather than real camera depth, same as
    // before. Attached to BOTH meshes (not just one) because the outline
    // mesh is sometimes invisible (`updateOutlineVisibility()`) and
    // `onBeforeRender` never fires for an invisible object -- the fill
    // mesh's own clear must not depend on the outline mesh having run.
    // renderOrder ordering (outline drawn first, epsilon below fill, see
    // updateRenderOrder()) means fill's clear simply re-clears again right
    // after -- harmless, since the outline shell is deliberately expanded
    // (`outlineThickness`) to sit entirely behind the fill surface anyway.
    const wrapper = new THREE.Group()
    wrapper.add(clone)
    scene.add(wrapper)
    // `currentBaseQuat`: this hand's OWN, per-hand current Whole-Hand-
    // Rotation basis -- see the "per-hand Whole-Hand Rotation during
    // pose transitions" section (near applyPoseValuesToHand()) for why
    // this exists as a per-hand field at all, instead of every hand
    // simply reading the single shared `cloneBaseQuat` the way this
    // project did before that feature. Initialized to the current shared
    // value; kept in sync with it every frame for any hand NOT actively
    // mid pose-transition (see updateRenderOrder()'s own per-hand loop).
    // `everReposed`: see updateRenderOrder()'s own `needsIdleRepose` gate
    // comment -- ROOT CAUSE of a real production bug (direct user report,
    // 2026-09-15: "weird surface texture... rotation looks off" on
    // startup, fixed by any 1 click). `currentBaseQuat` right above is
    // seeded from `cloneBaseQuat` at THIS exact moment -- if that's still
    // its own module-load-time identity default (cfg not fully restored
    // yet when the field first builds), every hand's own `currentBaseQuat`
    // freezes on that stale identity forever, UNLESS something re-syncs
    // it. Before the idle-repose performance gate existed, that re-sync
    // ran unconditionally every single frame, so a stale snapshot self-
    // corrected within 1 frame, invisibly. The gate broke that guarantee
    // for anyone with Responsive Wrist Splay off -- `everReposed` restores
    // it explicitly: false until a hand's first REAL repose, forcing
    // exactly one guaranteed full sync regardless of the gate's other
    // conditions, then never forced again.
    const hand = { wrapper, clone, skinnedMesh, outlineMesh, wristClipPlane: handWristClipPlane, effectiveRenderOrder: 0, screenX: 0, screenY: 0, screenRadius: 0, currentBaseQuat: cloneBaseQuat.clone(), everReposed: false }
    // Also recomputes this hand's OWN Hide Wrist clip plane right before
    // it draws (see updateWristClipPlaneForHand()'s own comment) -- every
    // hand faces a different direction and (own material/plane now, see
    // above) can genuinely hold its own clip state independent of every
    // other hand.
    if (skinnedMesh) skinnedMesh.onBeforeRender = (r) => { updateWristClipPlaneForHand(hand); r.clearDepth() }
    if (outlineMesh) outlineMesh.onBeforeRender = (r) => { updateWristClipPlaneForHand(hand); r.clearDepth() }
    hands.push(hand)
  }
  relayoutField()
  // relayoutField() only recomputes clone.position/scale -- a freshly
  // rebuilt hand's own skeleton is a brand-new (bind-pose) clone, so every
  // finger/wrist Pose slider needs reapplying too, or a rebuild (e.g.
  // changing row/column count) would silently reset every hand back to
  // its bind pose.
  applyAllFingerPoses()
  updateOutlineVisibility()
  updateHandsVisibility()
  if (!framedOnce) {
    framedOnce = true
    const w = (cfg.fieldCols - 1) * cfg.columnSpacing
    const h = (cfg.fieldRows - 1) * cfg.rowSpacing
    sceneState.fieldRadius = Math.max(Math.sqrt(w * w + h * h) / 2, Math.min(cfg.rowSpacing, cfg.columnSpacing))
    updateKeyLightPosition()
  }
}

// -----------------------------------------------------------------------
// Load model
// -----------------------------------------------------------------------
function findSkinnedMesh(root) {
  let found = null
  root.traverse((obj) => { if (obj.isSkinnedMesh) found = obj })
  return found
}

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    const root = gltf.scene
    const skinned = findSkinnedMesh(root)
    if (!skinned) {
      loadingEl.textContent = 'No skinned mesh found in model.'
      return
    }
    root.traverse((obj) => { if (obj.isMesh && obj !== skinned) obj.visible = false })
    root.updateMatrixWorld(true)

    // Measured, not assumed -- the wrist ("rHand") to middle-fingertip
    // ("rMid3") world vector, at this GLB's own bind pose, IS the
    // direction this model "points" along. alignQuat rotates that
    // measured direction onto each wrapper's local -Z.
    const wristBone = skinned.skeleton.getBoneByName('rHand')
    const tipBone = skinned.skeleton.getBoneByName('rMid3')
    const wristPos = new THREE.Vector3()
    const tipPos = new THREE.Vector3()
    if (wristBone && tipBone) {
      wristBone.getWorldPosition(wristPos)
      tipBone.getWorldPosition(tipPos)
    } else {
      tipPos.set(0, 1, 0) // fallback: assume +Y if expected bone names are missing
    }
    const pointDir = tipPos.clone().sub(wristPos)
    handLengthRaw = Math.max(pointDir.length(), 0.001)
    pointDir.normalize()
    alignQuat = new THREE.Quaternion().setFromUnitVectors(pointDir, new THREE.Vector3(0, 0, -1))

    // Palm Face Rotation slider's own roll axis -- the wrist crop plane's
    // normal (forearm->wrist), NOT pointDir (wrist->fingertip); same bone
    // pair updateWristClipPlaneForHand() uses per-frame for the Arm Length
    // crop, measured here once in the same raw bind-pose frame as
    // pointDir/palmNormalRaw above.
    const forearmBaseBone = skinned.skeleton.getBoneByName('rForearmBend')
    if (forearmBaseBone) {
      const forearmBasePos = new THREE.Vector3()
      forearmBaseBone.getWorldPosition(forearmBasePos)
      const wristCropNormalRaw = wristPos.clone().sub(forearmBasePos).normalize()
      wristCropNormalAligned = wristCropNormalRaw.clone().applyQuaternion(alignQuat)
    }

    // Real mesh bounding sphere (see its own declaration comment) --
    // measured here, in the same identity-transform frame as the
    // measurements above, BEFORE any per-instance clone/scale/rotate.
    const boundsBox = new THREE.Box3().setFromObject(skinned)
    const boundsSphere = new THREE.Sphere()
    boundsBox.getBoundingSphere(boundsSphere)
    handBoundsCenterLocal.copy(boundsSphere.center)
    handBoundsRadiusLocal = boundsSphere.radius

    // Pose raw-frame measurements (see their own declaration comments) --
    // all taken here, in the same identity-transform frame as the
    // measurements above, BEFORE any per-instance clone/scale/rotate.
    // boneRestQuat MUST be captured before rebuildField() below ever
    // clones this skeleton, so every hand's own clone starts from the
    // true bind pose.
    skinned.skeleton.bones.forEach((bone) => { boneRestQuat[bone.name] = bone.quaternion.clone() })
    wristPosRaw.copy(wristPos)
    const forearmBone = skinned.skeleton.getBoneByName('rForearmBend')
    if (forearmBone) forearmBone.getWorldPosition(forearmPosRaw)

    toonMaterial = createToonMaterial(skinned.material.map || null)

    modelRoot = root
    modelLoaded = true
    // Was: rebuildField()/buildPosePreview()/window.__debug/hide-loading,
    // all directly here. Now deferred behind tryStartField()'s own gate
    // (see modelMeasurementsReady's declaration comment) -- these one-
    // time MODEL measurements above (alignQuat, handBoundsCenterLocal,
    // boneRestQuat, etc.) don't depend on settings and stay here
    // unchanged; only the settings-DEPENDENT build (rebuildField() reads
    // cfg.fieldRows/fieldCols/etc.) needed to wait.
    modelMeasurementsReady = true
    // Loading Preview -- built here, not from tryStartField(), so it can
    // start animating the instant the base model itself is ready, well
    // before the (usually slower) settings-restore half of the gate below
    // resolves. Same already-loaded GLB, no extra network fetch, same as
    // every other clone this file makes of it.
    buildLoadingPreview()
    // Real gap fixed 2026-09-17, direct report ("the Show Loading Preview
    // checkbox doesnt work"): if the "Show Loading Preview (Live)"
    // checkbox was already checked (restored from a saved setting, or
    // clicked while still on the "Loading hands..." screen) at the exact
    // moment setLoadingPreviewLiveVisible() ran, `modelMeasurementsReady`
    // was still false back then, so it silently no-op'd -- and nothing
    // re-checked it until tryStartField() eventually fired (which ALSO
    // waits on the settings-restore/min-time gates below, not just the
    // model). Re-running it here, the instant the model itself becomes
    // ready, closes that window instead of leaving the checkbox looking
    // checked but doing nothing until the real field happens to start.
    if (cfg.loadingPreviewShowLive) setLoadingPreviewLiveVisible(true)
    tryStartField()
  },
  undefined,
  (err) => {
    console.error('Failed to load hand model', err)
    loadingEl.textContent = 'Failed to load hand model — see console.'
  }
)

// -----------------------------------------------------------------------
// Render loop
// -----------------------------------------------------------------------
// window.innerWidth/innerHeight can read 0 at script-parse time in this
// environment (a real, intermittent early-page-life quirk -- same class
// already documented in this workspace's DOTFLICKO project, not unique to
// this one). Constructing the renderer/composer/OutlinePass at 0x0 leaves
// every internal render target permanently zero-sized (confirmed directly:
// GL_INVALID_FRAMEBUFFER_OPERATION "Attachment has zero size" spamming the
// console, `renderer.getSize()` reporting [0,0] long after load) -- a
// later real `resize` event fixes it, but nothing guarantees one ever
// fires. Self-heal every frame instead of relying solely on the resize
// event: same fix shape as DOTFLICKO's own canvas-size self-healing.
function applyRendererSize(w, h) {
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  composer.setSize(w, h)
  outlinePass.resolution.set(w, h)
}
window.addEventListener('resize', () => applyRendererSize(window.innerWidth, window.innerHeight))

// Global Pause (Debug group's own PAUSE button, direct request) -- every
// hand-pose/tween state machine in this file (Click Pose, Click-Hold-
// Pose, Right Click, Double Click, Double Click Hold, the Pose Preview's
// own "Run" tween) is driven entirely by comparing `performance.now()`
// against a stored start-time, per updateClickHoldPoseForHand()/
// updateClickPoseForHand()'s own `now` parameter. Simply skipping those
// update calls while paused freezes the VISUAL result correctly (nothing
// re-applies, so the skeleton stays exactly as last posed) -- but the
// stored start-times are still fixed points in real wall-clock time, so
// resuming and reading raw `performance.now()` again would make every
// elapsed-time calculation suddenly include the entire paused duration,
// jumping every in-flight transition forward (or straight to completion)
// instead of continuing smoothly from where it was.
// `nowVirtual()` fixes this: every animation-timing call site in this
// file (trigger start-times AND the per-frame "now" used to compute
// elapsed time against them) reads this instead of raw
// `performance.now()`. `pauseOffsetMs` accumulates exactly the real time
// spent paused, so `nowVirtual()` is continuous THROUGH a pause (frozen
// while paused, since nothing calls it during that window; picks up
// again post-resume having silently absorbed the gap). Deliberately NOT
// used for pure gesture-detection timing (mouse-log timestamps, click-
// vs-hold and double-click debounce windows) -- those aren't animation
// state and should keep reflecting real wall-clock time regardless of
// pause.
let isPaused = false
let pauseOffsetMs = 0
let pausedAtMs = 0
function nowVirtual() { return performance.now() - pauseOffsetMs }
function setPaused(v) {
  if (v === isPaused) return
  if (v) { isPaused = true; pausedAtMs = performance.now() }
  else { pauseOffsetMs += performance.now() - pausedAtMs; isPaused = false }
}
// The Pose Preview panel's own "Run" button (Saved Tween Sequences list-
// picker, direct request) -- plays the resolved named-pose sequence on
// the PREVIEW hand only (never the field), paced by the Tween group's own
// `tweenPreviewSpeedMs` slider. Always anchored from `poseDefaultValues`
// (there's no tracked "current pose values" for the preview hand to
// transition FROM -- its skeleton only ever gets posed via direct slider
// application, not a value object kept in sync -- so a deterministic
// anchor is the only feasible choice, same tradeoff already accepted
// elsewhere in this file). Deliberately NOT gated by Global Pause (direct
// request) -- see animate()'s own preview-render block.
let previewTweenPlay = null // { poses, startMs, speedMs }
function runTweenSequenceOnPreview(item) {
  if (!previewHand || !item) return
  const namedPoses = resolveTweenSequencePoses(item.tweenPoses)
  if (namedPoses.length < 1) return
  previewTweenPlay = { poses: [poseDefaultValues, ...namedPoses], startMs: nowVirtual(), speedMs: Math.max(safeTweenSpeedMs(cfg.tweenPreviewSpeedMs), 1) }
}
// Both Saved Tween Sequences' new "Edit"/"Run" buttons act on the list-
// picker's own currently-SELECTED row -- same convention as Saved Poses'
// own "Default" button (getSelectedSavedPoseItem()), just scoped to this
// different list-picker's own data-key.
function getSelectedTweenSequenceItem() {
  const selectedRow = document.querySelector('.dp-row[data-key="savedTweenSequences"] .dp-list-picker-row-selected')
  return selectedRow ? selectedRow.__item : null
}
// "Edit" (direct request: "This immediately sets the active Tween Poses
// (in order) data to that of the saved Tween i want to Edit. Thus i can
// easily edit and overwrite saved tweens") -- functionally identical to
// this same list-picker's built-in "Use" button (both ultimately call
// useTweenSequencePreset()), but given its own dedicated, clearly-labeled
// button per the direct request rather than relying on "Use" already
// covering this.
function editSelectedTweenSequence() {
  const item = getSelectedTweenSequenceItem()
  if (!item) return
  useTweenSequencePreset(item)
}
function runSelectedTweenSequenceOnPreview() {
  const item = getSelectedTweenSequenceItem()
  if (!item) return
  runTweenSequenceOnPreview(item)
}
// Injected into the Saved Tween Sequences list-picker's own button row,
// same DOM-injection pattern as buildPoseDefaultButton()/
// buildCameraDefaultButton() (devPanel.js's generic list-picker has no
// config hook for extra buttons; this project's convention is not to fork
// that shared engine).
function buildTweenSequenceButtons() {
  const actionsRow = document.querySelector('.dp-row[data-key="savedTweenSequences"] .dp-list-picker-actions')
  if (!actionsRow) return
  const useBtn = Array.from(actionsRow.querySelectorAll('button')).find((b) => b.textContent === 'Use')
  const editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.textContent = 'Edit'
  editBtn.addEventListener('click', () => editSelectedTweenSequence())
  if (useBtn && useBtn.nextSibling) actionsRow.insertBefore(editBtn, useBtn.nextSibling)
  else actionsRow.appendChild(editBtn)
  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.textContent = 'Run'
  runBtn.addEventListener('click', () => runSelectedTweenSequenceOnPreview())
  actionsRow.insertBefore(runBtn, editBtn.nextSibling)
  // "Import" -- direct request: "in the tween setting group, add an
  // 'Import' button. It imports whatever is in my clipboard. The
  // imported data will include both pose data and tween sequence data.
  // So in one import, you will be importing any new (or overwriting
  // existing) poses, as well as importing (or overwriting) any tween
  // sequences." A combined-payload sibling of the Saved Poses list-
  // picker's own existing single-list Import button (devPanel.js's
  // `ctrl.importable`, HANDY DANDIES' own savedPoses control) -- same
  // clipboard-JSON + same-name-overwrites-in-place merge rule, just
  // covering BOTH lists (`savedPoses` and `savedTweenSequences`) from
  // ONE pasted object in a single action, since devPanel.js's own
  // generic list-picker engine has no concept of a combined 2-list
  // import and this project's convention is not to fork that engine for
  // a one-off need. Placed here (not a brand-new standalone row) since
  // this is already the Tween group's own established action-button
  // location (Save/Overwrite/Use/Edit/Run/Rename/Delete/+Group).
  const importBtn = document.createElement('button')
  importBtn.type = 'button'
  importBtn.textContent = 'Import'
  importBtn.addEventListener('click', () => importPosesAndTweenSequences(importBtn))
  actionsRow.appendChild(importBtn)
}
buildTweenSequenceButtons()
// Same-name-overwrites-in-place merge rule as devPanel.js's own existing
// savedPoses Import button (see its own comment) -- applied here to
// BOTH `cfg.savedPoses` and `cfg.savedTweenSequences` from one shared
// clipboard payload, expected shaped `{ poses: [...], tweenSequences:
// [...] }` (the real HANDO-family export format this is meant to
// consume -- see importPosesAndTweenSequences()'s own comment for the
// exact accepted key names and why extra per-pose fields are tolerated).
// `syncValue()` (not `commit()`) is used, same as
// useTweenSequencePreset()'s own convention for an externally-driven
// update -- these values didn't come from the list-picker's own Save/
// Rename UI, so there's no live DOM edit to commit FROM; `syncValue`
// still correctly re-renders both list-pickers via its own
// `displayValue()` call. Dependent Target-Pose/Tween-Selector dropdowns
// are refreshed the same way their own onChange handlers already do
// (`syncValue` itself doesn't fire onChange, unlike a live user edit).
function mergeImportedListByName(existing, incoming) {
  let items = (existing || []).slice()
  let count = 0
  incoming.forEach((incomingItem) => {
    if (!incomingItem || typeof incomingItem.name !== 'string') return
    const idx = items.findIndex((it) => it.name === incomingItem.name)
    // Preserve the EXISTING item's own `.group` (if any) -- same
    // reasoning as devPanel.js's own single-list Import: an imported
    // item's own group membership from a DIFFERENT project/session is
    // meaningless here, but overwriting a name that's already been
    // organized into a local group here shouldn't silently un-group it.
    if (idx >= 0) items[idx] = { ...incomingItem, ...(items[idx].group ? { group: items[idx].group } : {}) }
    else items = items.concat([incomingItem])
    count++
  })
  return { items, count }
}
async function importPosesAndTweenSequences(btn) {
  let text
  try {
    text = await navigator.clipboard.readText()
  } catch (err) {
    // Clipboard read can be blocked (permissions, insecure context) --
    // prompt() as a manual-paste fallback, same convention as devPanel.js's
    // own single-list Import.
    text = prompt('Paste exported poses + tween sequences JSON:', '')
    if (!text) return
  }
  let incoming
  try { incoming = JSON.parse(text) } catch (err) { flashImportButton(btn, 'Invalid JSON'); return }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) { flashImportButton(btn, 'Expected an object'); return }
  // CORRECTED 2026-09-16 (direct correction): the real export format this
  // is meant to consume -- a HANDO-family "poses" + "tweenSequences" dump
  // (`{ tweenSequences: [{name, tweenPoses}], poses: [{name, ...pose
  // fields...}] }`) -- uses different top-level key names than this
  // project's own internal `cfg.savedPoses`/`cfg.savedTweenSequences`.
  // Accepts EITHER naming (the real "poses"/"tweenSequences" shape, or
  // this project's own "savedPoses"/"savedTweenSequences" shape, in case
  // a future export ever uses that instead) rather than assuming one.
  // Each imported pose object can carry extra fields this project's own
  // POSE_PRESET_KEYS doesn't define (HANDO's own richer rig has
  // hideWrist/shoulder*/elbow*/forearmTwist, none of which exist here) --
  // harmless to import as-is and simply never read, same "extra keys are
  // tolerated" convention lerpPoseValues()/previewPosePreset() already
  // use for a saved pose that predates a newer key, just in reverse.
  const incomingPoses = incoming.poses || incoming.savedPoses
  const incomingTweenSequences = incoming.tweenSequences || incoming.savedTweenSequences
  let posesCount = 0, tweensCount = 0
  if (Array.isArray(incomingPoses)) {
    const { items, count } = mergeImportedListByName(cfg.savedPoses, incomingPoses)
    cfg.savedPoses = items
    syncValue('savedPoses', items)
    posesCount = count
    safeRefreshSelectOptions('chpTargetPose'); safeRefreshSelectOptions('rchpTargetPose'); safeRefreshSelectOptions('clickTargetPose'); safeRefreshSelectOptions('dblclickTargetPose'); safeRefreshSelectOptions('rcTargetPose'); safeRefreshSelectOptions('dcHoldTargetPose'); safeRefreshMultiSelectOptions('tweenPoses')
  }
  if (Array.isArray(incomingTweenSequences)) {
    const { items, count } = mergeImportedListByName(cfg.savedTweenSequences, incomingTweenSequences)
    cfg.savedTweenSequences = items
    syncValue('savedTweenSequences', items)
    tweensCount = count
    safeRefreshSelectOptions('dcHoldTweenSelector'); safeRefreshSelectOptions('rcTweenSelector'); safeRefreshSelectOptions('chpTweenSelector'); safeRefreshSelectOptions('rchpTweenSelector'); safeRefreshSelectOptions('clickTweenSelector'); safeRefreshSelectOptions('dblclickTweenSelector')
  }
  if (posesCount === 0 && tweensCount === 0) { flashImportButton(btn, 'Nothing to import'); return }
  flashImportButton(btn, `Imported ${posesCount} pose(s), ${tweensCount} tween(s)!`)
}
function flashImportButton(btn, text) {
  const orig = btn.textContent
  btn.textContent = text
  setTimeout(() => { btn.textContent = orig }, 1400)
}

// Direct user report ("all my click functions stopped working"): every
// trigger's own state-machine logic (triggerClickPose/updateClickPoseForHand/
// applyPoseValuesToHand etc.) was confirmed correct by manually stepping it
// outside the render loop -- state (phase, lastAppliedValues) and actual
// skeleton bone rotations all updated exactly as expected. What ISN'T
// defended against: `requestAnimationFrame(animate)` (below) reschedules
// the NEXT frame before any of the rest of this function runs, so a single
// frame throwing partway through doesn't normally kill the loop OUTRIGHT --
// but if the SAME exception recurs every frame (e.g. a stray NaN that never
// clears on its own), `composer.render()` never gets reached on ANY
// subsequent frame, and the screen silently freezes at whatever was last
// successfully rendered -- indistinguishable from "clicking does nothing"
// to whoever's looking at it, even though every click is still correctly
// updating state underneath. One real path into exactly that was found and
// fixed directly (see safeTweenSpeedMs()'s own comment) -- this try/catch
// is the general-purpose backstop
// for that whole FAILURE MODE, not a fix for one specific bug: whatever
// throws, log it loudly and keep the loop alive rather than freezing silently.
//
// TEMPORARY live frame-cost profiler, 2026-09-16 -- direct follow-up
// after the renderer.compile() theory was directly measured and refuted
// (49.8ms for 240 hands on the user's OWN reported-laggy desktop,
// nowhere near enough). Rather than guess a 3rd time, this breaks down
// where REAL per-frame time is actually going -- updateRenderOrder()
// (per-hand trigger/idle-repose logic) vs. composer.render() (actual
// GPU draw submission) vs. everything else in animate() -- logged as a
// rolling 1-second-window average + instantaneous FPS, so a real
// before/after comparison across the "laggy startup" and "smooth
// afterward" periods the user described is possible from their own
// console, on their own hardware. Meant to be removed once the real
// bottleneck is identified from this data -- do not treat this as
// permanent instrumentation.
let __frameProfiler = { frames: 0, updateRenderOrderMs: 0, composerRenderMs: 0, windowStart: performance.now() }
function animate() {
  requestAnimationFrame(animate)
  try {
    renderer.getSize(rendererSizeCheck)
    if (window.innerWidth > 0 && window.innerHeight > 0 && (rendererSizeCheck.x !== window.innerWidth || rendererSizeCheck.y !== window.innerHeight)) {
      applyRendererSize(window.innerWidth, window.innerHeight)
    }
    // Camera navigation is a user-driven interaction, not "animation" --
    // OrbitControls damping/pan-extent/panel-sync keep running unchanged
    // regardless of Global Pause, so the user can still look around while
    // paused.
    controls.update()
    enforceCameraPanExtent()
    syncCameraPanelFromLive()
    armLengthWidgetResyncs.forEach((fn) => fn())
    // Global Pause (Debug group, see setPaused()'s own declaration) --
    // skipping cursor-target tracking, the cursor-follow rotation step,
    // and updateRenderOrder() (which drives every Click Pose/Click-Hold-
    // Pose/tween state machine, per hand) is what actually freezes every
    // animation exactly where it is; nothing here re-applies a pose or
    // advances a phase while `isPaused` is true.
    if (!isPaused) {
      updateCursorTarget()
      if (cfg.trackingEnabled) {
        // Per-hand now (not hoisted above the loop like before) -- with Palm
        // Faces Cursor on, each hand's own roll angle depends on ITS OWN
        // position relative to the live cursor (computeRadialRollDeg(), see
        // its own declaration comment), so it genuinely can't be computed
        // once for the whole field anymore. With it off, every hand still
        // gets the exact same roll (baseDeg=0, just the live slider), same
        // as before.
        hands.forEach((hand) => {
          const m = new THREE.Matrix4().lookAt(hand.wrapper.position, cursorTarget, UP)
          const desired = new THREE.Quaternion().setFromRotationMatrix(m)
          const baseDeg = cfg.palmFacesCursor ? computeRadialRollDeg(hand.wrapper.position, cursorTarget) : 0
          // Whole-wrapper rotation only, same mechanism as the default mode;
          // no skeleton/pose involvement either way.
          desired.multiply(computeRollQuat(baseDeg))
          hand.wrapper.quaternion.slerp(desired, cfg.trackingDamping)
        })
      }
      const __uroStart = performance.now()
      updateRenderOrder()
      __frameProfiler.updateRenderOrderMs += performance.now() - __uroStart
    }
    const __renderStart = performance.now()
    composer.render()
    __frameProfiler.composerRenderMs += performance.now() - __renderStart
    __frameProfiler.frames++
    {
      const elapsed = performance.now() - __frameProfiler.windowStart
      if (elapsed >= 1000) {
        const f = __frameProfiler.frames
        console.log(`[frame-profile] fps=${(f / (elapsed / 1000)).toFixed(1)} avgUpdateRenderOrder=${(__frameProfiler.updateRenderOrderMs / f).toFixed(2)}ms avgComposerRender=${(__frameProfiler.composerRenderMs / f).toFixed(2)}ms hands=${hands.length} over ${f} frames`)
        __frameProfiler = { frames: 0, updateRenderOrderMs: 0, composerRenderMs: 0, windowStart: performance.now() }
      }
    }
    // Pose Preview's own tiny render pass -- guarded by offsetParent (null
    // whenever the floating panel is hidden via display:none, i.e. the
    // "Show Pose Preview" checkbox is off) so an orbit-controllable mini-
    // viewport nobody can currently see doesn't still cost a render every
    // frame. The "Run" tween playback is deliberately NOT gated by Global
    // Pause (direct request: "Pause button should not pause the pose
    // preview hand") -- Pause only freezes the live FIELD's own
    // animations; the preview is a separate, isolated model the user is
    // actively previewing/tuning and shouldn't be affected by a control
    // meant for the field.
    if (previewRenderer && previewRenderer.domElement.offsetParent !== null) {
      resizePosePreview()
      previewControls.update()
      if (previewTweenPlay) {
        const elapsed = nowVirtual() - previewTweenPlay.startMs
        const progress = THREE.MathUtils.clamp(elapsed / previewTweenPlay.speedMs, 0, 1)
        previewPosePreset(lerpTweenSequence(previewTweenPlay.poses, progress))
        if (progress >= 1) previewTweenPlay = null
      }
      previewRenderer.render(previewScene, previewCamera)
    }
    // Loading Preview's own tiny render pass -- only while the loading
    // screen is actually still up (`!fieldStarted`); once the real field
    // reveals, this renderer is never touched again for the rest of the
    // session (no teardown needed -- it just stops being called). Its own
    // try/catch, separate from this function's outer one, so a bug in this
    // narrow, brand-new code path can never take down the main field's own
    // per-frame loop with it.
    if (!fieldStarted && loadingPreviewRenderer) {
      try {
        updateLoadingPreviewAnimation()
        syncLoadingPreviewCameraFromOrbit()
        loadingPreviewRenderer.render(loadingPreviewScene, loadingPreviewCamera)
      } catch (lpErr) {
        console.error('Loading Preview frame threw -- disabling it for this session:', lpErr)
        loadingPreviewRenderer = null
      }
    }
  } catch (err) {
    console.error('animate() frame threw -- rendering skipped for this frame, loop continues:', err)
  }
}
animate()

// Render-order stacking driven by distance from the cursor target, not
// real camera depth -- per direct request, hands FURTHEST from the
// cursor render on top, nearest render at the bottom. Requires
// depthTest:false on both hand materials (see createToonMaterial()'s own
// note) since three.js's normal depth-tested compositing would otherwise
// always let true camera-depth win regardless of draw/renderOrder. Each
// hand's own outline gets a SLIGHTLY lower renderOrder than its own fill
// mesh (same distance, minus a small epsilon) so the fill always draws on
// top of its own outline -- without this, disabling depthTest would let a
// later-drawn outline (an inverted, expanded backface shell) paint solid
// color over its own hand's entire visible fill instead of just peeking
// out at the silhouette edge.
// "Prevent Reordering Flash": approximates each hand's on-screen footprint
// as a circle (using the mesh's own measured bounding sphere -- see
// handBoundsCenterLocal/handBoundsRadiusLocal's declaration comment --
// projected to screen pixels via standard perspective scaling) since a
// precise silhouette-vs-silhouette overlap test isn't cheap to do every
// frame for a whole field of arbitrarily-rotated meshes. Good enough to
// catch "these 2 are visually fighting for the same pixels," which is the
// actual problem being solved -- not pixel-perfect, and disclosed as such.
// (An earlier version of this circle used `wrapper.position` as the
// center and half the wrist-to-fingertip bone length as the radius --
// both wrong: the real mesh includes a full forearm and is centered ~13
// units from the wrapper's own origin, so that circle was undersized by
// ~5x and mis-centered, missing the thumb/forearm at many rotations --
// see GOTCHAS.)
//
// CORRECTED 3 TIMES -- the first 2 pairwise-lock designs are kept here in
// comment form because they're a real, measured cautionary tale for
// anything that touches this function again.
//
// v1 froze a hand's ENTIRE render order the instant it overlapped
// ANYTHING, never re-syncing until every overlap cleared -- in a dense/
// zoomed-in view where most hands are ALWAYS touching some neighbor, no
// hand ever got a single overlap-free frame to unfreeze on, so the whole
// field froze solid PERMANENTLY the moment the checkbox was turned on.
// Confirmed via simulation: all 510 hands stuck, 0 order updates across
// 240 frames.
//
// v2 kept a per-pair lock but only nudged the "should stay on top" hand
// UP when its own raw live value dropped below its partner's -- otherwise
// it used its own raw value directly. That raw value can differ hugely,
// frame to frame, from the nudged value, so that hand silently teleported
// between 2 very different numbers depending on whether the nudge fired
// that frame. v3 tried to fix v2 by making the correction UNCONDITIONAL
// (partner's value + a fixed offset, always, while locked) -- this
// stopped the teleporting, but in a dense field, chains of simultaneous
// locks (A-under-B, B-under-C, C-under-D...) compound: EVERY hand in a
// long chain collapses toward the value of whichever hand anchors that
// chain, discarding their real distances almost entirely. Measured
// directly and unambiguously: sampling 87,000 random pairs whose TRUE
// distances differed by more than 15 world units (a large, unambiguous
// gap -- not a near-tie), 21% still rendered in the WRONG relative order
// under v3. That is exactly the reported bug ("certain hands render above
// a hand further from the cursor") and it was WORSE than doing nothing.
//
// This version abandons hard locking/pinning entirely. A hand's own
// effectiveRenderOrder tracks its OWN live cursor distance always --
// snapping instantly when it isn't overlapping anything, and blending
// toward the live value at REORDER_SMOOTHING per frame (an exponential
// lerp, not a freeze) only while it IS currently overlapping something.
// Nothing is ever derived from ANOTHER hand's value, so the v3 chain-
// collapse failure mode is structurally impossible -- and because the
// blend always keeps moving toward the true live value (never frozen),
// the v1 permanent-freeze failure mode is impossible too. Measured
// against the same 87,000-pair test: under 1% wrong-order rate at
// realistic cursor speed (vs. v3's 21%), and it still roughly halves the
// frame-to-frame flip rate for hands ACTUALLY overlapping on screen
// compared to no smoothing at all, at fast/erratic cursor movement.
const REORDER_SMOOTHING = 0.15
function updateRenderOrder() {
  idleReposeFrameCounter++
  const flashFixOn = cfg.preventReorderFlash
  if (flashFixOn) {
    const vFov = THREE.MathUtils.degToRad(camera.fov)
    const canvasHeight = renderer.domElement.clientHeight || window.innerHeight
    const canvasWidth = renderer.domElement.clientWidth || window.innerWidth
    hands.forEach((hand) => {
      // The overlap circle's center and radius come from the mesh's own
      // measured bounding sphere (handBoundsCenterLocal/Radius, see their
      // declaration comment), transformed through this hand's ACTUAL
      // current transform chain (scale -> alignQuat -> live wrapper
      // rotation -> wrapper position) -- NOT `wrapper.position` directly
      // and NOT a radius derived from wrist-to-fingertip bone length.
      // Using wrapper.position + handLengthRaw*0.5 (the original version)
      // put the circle's center ~13 world units from the mesh's real
      // center and undersized its radius by ~5x (confirmed by direct
      // measurement) -- small enough to miss the thumb/forearm entirely
      // at many rotations, which is exactly the reported "thumb pops
      // above the other hand" bug. A sphere's radius is unaffected by
      // rotation (only scale), so only the CENTER needs the full
      // rotate-then-translate chain; the radius only needs scaling.
      boundsCenterScratch.copy(handBoundsCenterLocal)
        .multiplyScalar(hand.clone.scale.x)
        .applyQuaternion(alignQuat)
        .applyQuaternion(hand.wrapper.quaternion)
        .add(hand.wrapper.position)
      const distToCamera = camera.position.distanceTo(boundsCenterScratch)
      const worldHeightAtDist = 2 * Math.tan(vFov / 2) * Math.max(distToCamera, 0.001)
      const pxPerWorldUnit = canvasHeight / worldHeightAtDist
      hand.screenRadius = handBoundsRadiusLocal * hand.clone.scale.x * pxPerWorldUnit
      projectScratch.copy(boundsCenterScratch).project(camera)
      hand.screenX = (projectScratch.x * 0.5 + 0.5) * canvasWidth
      hand.screenY = (-projectScratch.y * 0.5 + 0.5) * canvasHeight
      hand.isOverlapping = false
    })
    // O(n^2) pairwise check -- fine at hundreds of hands; would need a
    // spatial grid/broad-phase if the field grows into the low thousands.
    for (let i = 0; i < hands.length; i++) {
      const a = hands[i]
      for (let j = i + 1; j < hands.length; j++) {
        const b = hands[j]
        if (a.isOverlapping && b.isOverlapping) continue
        const dx = a.screenX - b.screenX
        const dy = a.screenY - b.screenY
        const combined = a.screenRadius + b.screenRadius
        if (dx * dx + dy * dy < combined * combined) { a.isOverlapping = true; b.isOverlapping = true }
      }
    }
  }
  // Reactive Arm Length's own distance normalization -- direct follow-up
  // request/bug report: "why is it that sometimes when i place the cursor
  // far away, the hands furthest from the cursor start disappearing, even
  // though i have a min length of more than 0." Root cause: the ORIGINAL
  // version normalized against a FIXED reference (`sceneState.fieldRadius
  // * ARM_LENGTH_DISTANCE_NORM`) -- once the cursor moves far enough from
  // the WHOLE field that every hand's distance exceeds that fixed value,
  // every hand clamps to the exact same extreme curve output, collapsing
  // all relative variation (confirmed directly: with the cursor placed
  // far outside the field, both the nearest and farthest hand measured
  // the identical value). Fixed by normalizing against the CURRENT
  // field's own actual live distance range instead of a fixed constant --
  // a quick pre-pass finds the min/max distance any hand ACTUALLY has to
  // the cursor this frame, so the curve's full 0-1 domain is always
  // spread across whatever hands are currently in the field, regardless
  // of how far the cursor wanders from it.
  let minLiveDist = Infinity, maxLiveDist = -Infinity
  const liveDistances = hands.map((hand) => {
    const d = hand.wrapper.position.distanceTo(cursorTarget)
    if (d < minLiveDist) minLiveDist = d
    if (d > maxLiveDist) maxLiveDist = d
    return d
  })
  const liveDistRange = Math.max(maxLiveDist - minLiveDist, 0.001)
  const nowMs = nowVirtual() // virtual clock (see its own declaration) -- one shared timestamp for every hand's own Click-Hold-Pose/Click-Pose progress this frame, not a separate call per hand; only reached at all while !isPaused (animate()'s own gate), so this line simply never runs during a pause
  hands.forEach((hand, i) => {
    const live = liveDistances[i]
    hand.effectiveRenderOrder = (flashFixOn && hand.isOverlapping)
      ? hand.effectiveRenderOrder + (live - hand.effectiveRenderOrder) * REORDER_SMOOTHING
      : live
    if (hand.skinnedMesh) hand.skinnedMesh.renderOrder = hand.effectiveRenderOrder
    if (hand.outlineMesh) hand.outlineMesh.renderOrder = hand.effectiveRenderOrder - 0.001
    // Arm Length (Hide Wrist) -- reuses this same live cursor-distance
    // value (`live`, unsmoothed -- Reactive mode intentionally tracks the
    // cursor instantly, no reason to inherit Reordering Flash's own
    // smoothing, a different feature solving a different problem) rather
    // than recomputing it. See computeArmLengthT()/applyHandArmLength()'s
    // own comments for why this now runs every frame, per hand.
    hand.currentArmLengthT = computeArmLengthT(hand, live, minLiveDist, liveDistRange)
    if (hand.skinnedMesh) applyHandArmLength(hand, hand.currentArmLengthT)
    // Click-Hold Pose takes over BOTH finger curls and wrist pose for
    // this hand whenever either trigger is globally active OR this hand
    // is still finishing its own retransition after release (checking
    // `trig.active` here, not just this hand's own phase, is what
    // correctly catches a hand entering 'forward' for the very first
    // time THIS frame) -- falls through to the normal Responsive Wrist
    // Splay + shared-cfg wrist pose (unchanged from before this feature
    // existed) only when NEITHER trigger is touching this hand at all.
    // If both triggers are simultaneously active for the same hand (an
    // edge case -- holding both mouse buttons at once), 'rchp' is
    // processed after 'chp' and so wins that frame's write -- a
    // disclosed simplification, not a designed priority system.
    if (hand.skinnedMesh) {
      const chpAll = getOrInitHandCHP(hand)
      let overridden = false
      CLICK_HOLD_KEYS.forEach((p) => {
        if (clickHoldPoseTriggers[p].active || chpAll[p].phase !== 'idle') {
          updateClickHoldPoseForHand(hand, p, live, minLiveDist, liveDistRange, nowMs)
          overridden = true
        }
      })
      // Click Pose / Double-Click Pose -- same "only touch this hand
      // while it's genuinely mid-sequence" gating as Click Hold-Pose
      // above, checked separately since these 2 features track separate
      // per-hand state (hand._cp, not hand._chp) and can be enabled
      // independently. If a hand is somehow mid-sequence in BOTH
      // families at once, whichever runs last here wins that frame's
      // write -- same disclosed simplification as the chp/rchp case.
      const cpAll = getOrInitHandCP(hand)
      CLICK_POSE_KEYS.forEach((p) => {
        // `|| cpAll[p].pendingClaimAt` -- a hand can be 'idle' in phase
        // while still WAITING on a deferred claim (see
        // updateClickPoseForHand()'s own top comment); it still needs to
        // be called every frame so that pending claim actually gets
        // checked/committed once its own delay elapses.
        if (cpAll[p].phase !== 'idle' || cpAll[p].pendingClaimAt) {
          updateClickPoseForHand(hand, p, live, minLiveDist, liveDistRange, nowMs)
          // Re-checked AFTER the call (not just the pre-call condition
          // above) -- a hand that was ONLY waiting on a pending claim,
          // still genuinely idle this exact frame, should still be
          // eligible for a normal idle repose below; only mark it
          // overridden once a claim actually commits (phase leaves
          // 'idle') or it was already active.
          if (cpAll[p].phase !== 'idle') overridden = true
        }
      })
      // PERFORMANCE (2026-09-15): this whole idle repose (wrist bone +
      // all 5 fingers, via rotateOnTrueWorldAxis()-style world-axis-
      // corrected bone math) is only actually necessary every frame when
      // Responsive Wrist Splay is live-changing the wrist angle every
      // frame -- with it off, nothing here changes frame-to-frame (a
      // manual slider/Default-pose change already triggers its own
      // repose via onChange, per the "CORRECTED AGAIN" comment below).
      // Still forced for exactly one frame right after a transition ends
      // (`hand._wasOverriddenLastFrame`), since retransition can leave
      // curl stale and this is what re-syncs it -- see the comment below.
      // Measured live: this block was ~38ms/frame at 255 hands, the
      // actual lag bottleneck, not rendering itself (~11ms).
      //
      // CORRECTED 2026-09-15 -- `!hand.everReposed` added, direct user
      // report ("weird surface texture as if overlapping 3d models...
      // rotation looks off" on a fresh hard refresh, fixed by any 1
      // click). Root cause: `hand.currentBaseQuat` is seeded from
      // `cloneBaseQuat` at hand-creation time (rebuildField()), which can
      // still be its own module-load-time identity default if cfg hasn't
      // finished restoring yet when the field first builds -- a hand born
      // this way renders with an IDENTITY base quaternion (raw GLB bind
      // pose: straight, uncurled fingers/forearm) until something
      // resyncs it. Before this performance gate existed, that resync
      // ran unconditionally every frame, so a stale snapshot self-
      // corrected within 1 frame, invisibly -- this gate broke that
      // guarantee for anyone with Responsive Wrist Splay off (confirmed
      // live: `hands[0].currentBaseQuat` read exactly `[0,0,0,1]`,
      // identity, on a fresh load with `wristSplayResponsiveEnabled:
      // false`, while `cloneBaseQuat` itself already held the correct
      // computed value). A click "fixing" it was `_wasOverriddenLastFrame`
      // incidentally forcing 1 catch-up frame, or the click's own
      // `applyPoseValuesToHand` independently recomputing a correct
      // `currentBaseQuat` from its target pose -- neither is a real fix,
      // both are lucky side effects. `everReposed` (false until this
      // branch runs for this hand at least once, see rebuildField()'s
      // own comment) forces exactly 1 guaranteed full repose regardless
      // of the other 2 conditions, closing the gap without reintroducing
      // the per-frame cost for every idle frame after that.
      //
      // CORRECTED AGAIN 2026-09-15, direct user report ("click functinos
      // still not working"): `!overridden` was MISSING from this
      // condition entirely -- the original code this performance fix
      // replaced was `if (!overridden) { ...idle repose... }`, and the
      // rewrite dropped that check, keeping only the 3 conditions above.
      // Concretely: `hand._wasOverriddenLastFrame` is true starting the
      // 2nd frame of ANY active trigger sequence (chp/rchp/click/
      // dblclick/rc/dcHold) and stays true every frame the sequence keeps
      // running -- so `needsIdleRepose` was ALSO true on every one of
      // those frames, meaning the idle branch ran RIGHT AFTER
      // `applyPoseValuesToHand()` had just written the transition's own
      // in-progress pose 20 lines up, and immediately overwrote it with
      // `cfg`'s plain DEFAULT/idle values instead. Net effect: every
      // trigger's pose only ever stuck for a single frame before being
      // stomped back to default, frame after frame -- at normal framerate,
      // visually indistinguishable from "the click did nothing at all."
      // `!overridden` restores the original mutual-exclusion (a hand is
      // EITHER actively driven by a trigger this frame, via the checks
      // above, OR eligible for idle repose -- never both in the same
      // frame) without touching any of the 3 legitimate optimization
      // conditions this fix already added.
      // STAGGER (2026-09-16): only the "master toggle is on, refresh this
      // hand's reactive splay" reason is spread across N frames via
      // wristSplayReposeStagger -- hand._wasOverriddenLastFrame and
      // !hand.everReposed stay unconditional/immediate, exactly as before
      // this stagger existed (see the field's own dev-panel comment and
      // this file's 2026-09-15 "CORRECTED AGAIN" gotcha above for why those
      // 2 must never be delayed).
      const staggerCount = Math.max(1, Math.round(cfg.wristSplayReposeStagger))
      const isThisHandsStaggerTurn = (idleReposeFrameCounter % staggerCount) === (i % staggerCount)
      const needsIdleRepose = !overridden && ((cfg.wristSplayResponsiveEnabled && isThisHandsStaggerTurn) || hand._wasOverriddenLastFrame || !hand.everReposed)
      if (needsIdleRepose) {
        hand.everReposed = true
        // Not mid any pose-transition this frame -- keep this hand's own
        // per-hand basis mirroring the single shared cloneBaseQuat every
        // idle hand has always used, so Whole-Hand Rotation's existing
        // (non-transition) behavior is completely unaffected by
        // currentBaseQuat's own existence. A hand that just finished a
        // transition syncs back to the shared value the very next frame,
        // same as it would have before this per-hand basis existed.
        hand.currentBaseQuat.copy(cloneBaseQuat)
        const extraSplay = computeResponsiveWristSplayDeg(live, minLiveDist, liveDistRange)
        applyWristPoseToSkeleton(hand.skinnedMesh.skeleton, cfg, extraSplay)
        // CORRECTED 2026-09-14, root cause behind the long-running "thumb
        // pose looks wrong" reports, independent of cursor movement. The
        // wrist bone gets re-posed with LIVE Responsive Wrist Splay every
        // single frame right above, but finger curl is normally only
        // recomputed on a slider change or "Default" click
        // (applyAllFingerPoses()), NOT every frame. `rotateOnTrueWorldAxis()`
        // converts a curl's intended WORLD-space axis into a LOCAL bone
        // rotation using the parent chain's CURRENT world orientation at
        // the instant curl is computed (see the wrist-before-fingers
        // fix's own comment) -- so ANY finger whose base joint is a
        // descendant of the wrist bone goes stale the moment the wrist
        // keeps moving afterward.
        //
        // CORRECTED AGAIN, same day -- the original version of this fix
        // only refreshed the thumb, on the belief (stated by an earlier
        // round of this saga, never re-verified) that the thumb is the
        // ONLY finger parented to the wrist bone (`rHand`). Direct
        // skeleton inspection proved that wrong: every finger's base
        // joint is parented to its own "carpal" bone (rCarpal1-4), and
        // EVERY one of those carpal bones is itself a child of `rHand` --
        // so all 5 fingers, not just the thumb, depend on the wrist's
        // current world orientation and all 5 need this same per-frame
        // refresh. Confirmed by the user's own real-device report after
        // the thumb-only fix: "the other fingers are all also slightly
        // uncurled" on mobile, and "if I turn off responsive wrist splay,
        // it's fine" -- exactly the signature of this mechanism, just
        // wider than first scoped. "Default" is correct for exactly the
        // one frame it's applied, then Responsive Wrist Splay keeps
        // rotating the wrist every frame after that while every finger's
        // curl stays stale -- same reason a hand returning to idle after
        // any Click-Hold/Click-Pose sequence shows the identical drift.
        FINGER_NAMES.forEach((name) => applyCurlToSkeleton(name, hand.skinnedMesh.skeleton, hand.currentBaseQuat, hand.wrapper.quaternion, cfg))
      }
      hand._wasOverriddenLastFrame = overridden
    }
  })
}
animate()
