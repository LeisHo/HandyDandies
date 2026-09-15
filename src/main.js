import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeletal } from 'three/addons/utils/SkeletonUtils.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { initDevPanel, syncValue, organizeGroupSubgroups, refreshSelectOptions, saveCurrentSettings } from './devpanel/devPanel.js?v=13'

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
const MOUSE_LOG_MULTICLICK_MS = 350
const MOUSE_LOG_HELD_DRAG_MS = 500
let mouseLogClickCount = 0
let mouseLogClickTimer = null
let mouseLogPendingClick = null
let mouseLogDownInfo = null
let mouseLogLastViewport = null

let modelRoot = null
let modelLoaded = false
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
    controls: [
      { key: 'fieldRows', label: 'Rows (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 15, onChange: () => rebuildField() },
      { key: 'fieldCols', label: 'Columns (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 17, onChange: () => rebuildField() },
      { key: 'rowSpacing', label: 'Row Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 9.5, onChange: () => relayoutField() },
      { key: 'columnSpacing', label: 'Column Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 14, onChange: () => relayoutField() },
      { key: 'handScale', label: 'Hand Scale (x)', type: 'slider', min: 0.1, max: 3, step: 0.05, def: 1.55, onChange: () => relayoutField() },
      // Classic brick/hex stagger: shifts every OTHER row sideways (along
      // the column axis, i.e. perpendicular to how rows themselves stack
      // in the row direction) by a fixed amount -- the standard reading of
      // "alternate row offset." If a Z-depth stagger was actually meant
      // instead, this is a 1-line change (see relayoutField()).
      { key: 'alternateRowOffset', label: 'Alternate Row Offset (World Units)', type: 'slider', min: -20, max: 20, step: 0.5, def: -5.5, onChange: () => relayoutField() },
      { key: 'progressiveRowOffset', label: 'Progressive Row Offset (World Units / Row)', type: 'slider', min: -20, max: 20, step: 0.5, def: 0, onChange: () => relayoutField() },
      { key: 'useProgressiveOffset', label: 'Use Progressive Offset (Off = Alternate)', type: 'checkbox', def: false, onChange: () => relayoutField() }
    ]
  },
  {
    title: 'Cursor Tracking',
    controls: [
      { key: 'trackingEnabled', label: 'Tracking Enabled', type: 'checkbox', def: true },
      { key: 'trackingDamping', label: 'Look-At Damping (x)', type: 'slider', min: 0.02, max: 1, step: 0.01, def: 1 },
      // No onChange needed -- updateCursorTarget() (called every frame)
      // reads cfg.targetDepthFactor live when it sets cursorTarget.z, so
      // there's no cached per-depth state to refresh on a slider change
      // anymore (see that function's own 2026-09-14 correction comment).
      { key: 'targetDepthFactor', label: 'Cursor Target Depth (x Field Radius)', type: 'slider', min: -2, max: 2, step: 0.05, def: 0.6 },
      { key: 'showTargetMarker', label: 'Show Target Marker', type: 'checkbox', def: false, onChange: (v) => { if (targetMarker) targetMarker.visible = v } },
      // REDEFINED 2026-09-14 (see computeRadialRollDeg()'s own comment
      // for the full account and the user's own exact reference points):
      // rotates each hand, around the wrist-crop-plane axis, by the
      // angle from that hand's OWN position to the live cursor -- a 2D
      // "compass needle" roll in the field's own XY plane, computed
      // fresh per hand per frame, not a fixed 3D palm-normal-aim (the
      // prior mechanism this replaced). Default off so nothing changes
      // until opted in.
      { key: 'palmFacesCursor', label: 'Palm Faces Cursor', type: 'checkbox', def: true },
      // Adds directly onto whatever angle is already in effect --
      // computeRadialRollDeg()'s own dynamic angle when Palm Faces
      // Cursor is on, or 0 (just this slider alone) when it's off --
      // per direct instruction ("My Palm Face rotation slider wil then
      // just add onto that rotation number"). Rotates around the wrist
      // crop plane's own normal (see computeRollQuat()'s own comment for
      // why that axis) -- CLAUDE.md 12n, "feel/response curves are
      // sliders, not constants."
      { key: 'palmFaceRotationOffset', label: 'Palm Face Rotation (Deg)', type: 'slider', min: -180, max: 180, step: 1, def: 0 }
    ]
  },
  {
    title: 'Pose',
    controls: [
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
        onChange: () => { safeRefreshSelectOptions('chpTargetPose'); safeRefreshSelectOptions('rchpTargetPose'); safeRefreshSelectOptions('clickTargetPose'); safeRefreshSelectOptions('dblclickTargetPose') }
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
  {
    // Direct user request: "provide me a collapsible pose viewer within
    // the dev panel itself" -- deliberately 0 controls here. buildPosePreview()
    // (below, called once the model loads) injects its own <canvas> +
    // independent Three.js scene/camera/renderer/OrbitControls directly
    // into this group's OWN .dp-group-body DOM element, found by its
    // data-key (== this title) -- collapsing/expanding it is then just
    // the SAME existing generic group-collapse mechanism every other
    // group already has, no new devPanel.js code needed for that part.
    title: 'Pose Preview',
    controls: []
  },
  {
    title: 'Camera',
    controls: [
      // Position sliders only (no Yaw/Pitch/Zoom-as-distance like HANDO's
      // own Camera group) -- this camera never rotates (see OrbitControls
      // setup below: enableRotate is false, only pan + zoom), so a look-
      // direction concept doesn't apply here the way it does for HANDO's
      // orbiting camera. Defaults are static (NOT derived from field size,
      // per the "field layout shouldn't affect view scale" request) --
      // frame the view by dragging (pan) / scrolling (zoom) instead.
      { key: 'cameraX', label: 'Camera X Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: 6.638529594915686, onChange: (v) => applyCameraControl('cameraX', v) },
      { key: 'cameraY', label: 'Camera Y Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: 13.373156794075216, onChange: (v) => applyCameraControl('cameraY', v) },
      { key: 'cameraZ', label: 'Camera Z Position (x)', type: 'slider', min: 1, max: 500, step: 0.5, def: 259.74194092345493, onChange: (v) => applyCameraControl('cameraZ', v) },
      { key: 'cameraFov', label: 'Field Of View (Deg)', type: 'slider', min: 15, max: 90, step: 1, def: 35, onChange: (v) => applyCameraControl('cameraFov', v) },
      // Direct 2-way binding with scroll/pinch zoom, same pattern as the
      // X/Y/Z sliders above: this slider both SETS the camera's distance
      // to its own pan target (setCameraDistance(), below) and is kept in
      // sync FROM the live distance every frame (syncCameraPanelFromLive())
      // -- scrolling moves the slider, moving the slider zooms, per direct
      // request ("responsive to my wheel scroll and vice versa").
      { key: 'cameraZoom', label: 'Zoom (Distance To Pan Target) (x)', type: 'slider', min: 1, max: 800, step: 0.5, def: 260.17068872666084, onChange: (v) => applyCameraControl('cameraZoom', v) },
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
      { key: 'lockCameraPan', label: 'Lock Camera Pan', type: 'checkbox', def: false, onChange: () => applyCameraLockState() },
      { key: 'lockCameraZoom', label: 'Lock Camera Zoom', type: 'checkbox', def: false, onChange: () => applyCameraLockState() },
      { key: 'cameraMaxExtentsEnabled', label: 'Set Default Camera As Max Extents', type: 'checkbox', def: false, onChange: () => updateCameraMaxExtentsBound() }
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
      { key: 'ambientGroundColor', label: 'Ambient Ground Color', type: 'color', def: '#000000', onChange: (v) => { hemiLight.groundColor.set(v) } }
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
      { key: 'clearMouseLogBtn', label: 'Clear Mouse Tracking Log', type: 'button', onClick: () => clearMouseTrackingLog() }
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
  remoteSave: { endpoint: SAVE_SETTINGS_ENDPOINT, secret: DEV_PANEL_SAVE_SECRET }
})
onChangeByCtrl.forEach((fn, c) => { c.onChange = fn })
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
function describeMouseLogTrigger(e) {
  const inPanel = !!e.target?.closest?.('.dp-panel')
  if (inPanel) return 'Dev Panel interaction'
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
  // `e.target` isn't guaranteed to be an Element (e.g. `document` itself,
  // which has no `.closest()`) -- confirmed live as a real crash while
  // testing with a synthetic event dispatched directly on `document`; a
  // genuine user click always targets a real element in practice, but the
  // optional-chaining guard costs nothing and removes the failure mode
  // entirely rather than relying on that always being true.
  const trigger = describeMouseLogTrigger(down ? { target: down.target, button: down.button } : e)
  const x = Math.round(e.clientX), y = Math.round(e.clientY)
  const heldMs = down ? Math.round(performance.now() - down.time) : 0
  const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOUSE_LOG_MOVE_THRESHOLD_PX : false
  if (down && down.button === 2) {
    logMouseTrackingEvent(`Right-click at (${x}, ${y}) -> ${trigger}`)
    return
  }
  if (down && (heldMs > MOUSE_LOG_HELD_DRAG_MS || moved)) {
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
  }, MOUSE_LOG_MULTICLICK_MS)
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
  headerRow.appendChild(label)
  const btnRow = elLocal('div', { display: 'flex', gap: '4px' })
  btnRow.appendChild(copyBtn)
  btnRow.appendChild(saveBtn)
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
const FINGER_SIGN = { thumb: -1, index: 1, middle: -1, ring: -1, pinky: 1 }
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
POSE_PRESET_KEYS.forEach((key) => { poseDefaultValues[key] = cfg[key] !== undefined ? cfg[key] : POSE_KEY_DEFAULTS[key] })
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
function makeClickHoldPoseGroup(p, title, defaults = {}) {
  return {
    title,
    controls: [
      // Direct user request ("provide a checkbox to turn that feature on
      // and off") -- gates startClickHoldPose(), same master on/off
      // pattern as Crop Wrist / Responsive Wrist Splay's own checkboxes.
      { key: `${p}Enabled`, label: `${title} (Master On/Off)`, type: 'checkbox', def: defaults.enabled ?? false },
      { key: `${p}TargetPose`, label: 'Target Pose', type: 'select', def: defaults.targetPose ?? '', options: () => (cfg.savedPoses || []).map((sp) => sp.name) },
      { key: `${p}TransitionSpeedMs`, label: 'Pose Transition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.transitionSpeedMs ?? 400 },
      { key: `${p}StartTimeCurve`, label: 'Pose Transition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.startTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}StartTimeRange`, label: 'Pose Transition Min / Max Start Time (Ms)', type: 'text', def: defaults.startTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}RetransitionSpeedMs`, label: 'Pose Retransition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.retransitionSpeedMs ?? 400 },
      { key: `${p}RetransitionStartTimeCurve`, label: 'Pose Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.retransitionStartTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickHoldConfig(p) },
      { key: `${p}RetransitionStartTimeRange`, label: 'Pose Retransition Min / Max Start Time (Ms)', type: 'text', def: defaults.retransitionStartTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickHoldConfig(p) }
    ]
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
    controls: [
      { key: `${p}Enabled`, label: `${title} (Master On/Off)`, type: 'checkbox', def: defaults.enabled ?? false },
      { key: `${p}TargetPose`, label: 'Target Pose', type: 'select', def: defaults.targetPose ?? '', options: () => (cfg.savedPoses || []).map((sp) => sp.name) },
      { key: `${p}TransitionSpeedMs`, label: 'Pose Transition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.transitionSpeedMs ?? 400 },
      { key: `${p}StartTimeCurve`, label: 'Pose Transition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.startTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}StartTimeRange`, label: 'Pose Transition Min / Max Start Time (Ms)', type: 'text', def: defaults.startTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}PauseDurationMs`, label: 'Pause Duration At Target (Ms)', type: 'slider', min: 0, max: 5000, step: 10, def: defaults.pauseDurationMs ?? 500 },
      { key: `${p}RetransitionSpeedMs`, label: 'Pose Retransition Speed (Ms)', type: 'slider', min: 0, max: 700, step: 10, def: defaults.retransitionSpeedMs ?? 400 },
      { key: `${p}RetransitionStartTimeCurve`, label: 'Pose Retransition Start Time Curve (Distance -> Start Time)', type: 'text', def: defaults.retransitionStartTimeCurve ?? '[{"x":0,"y":0},{"x":1,"y":1}]', onChange: () => parseClickPoseConfig(p) },
      { key: `${p}RetransitionStartTimeRange`, label: 'Pose Retransition Min / Max Start Time (Ms)', type: 'text', def: defaults.retransitionStartTimeRange ?? '{"min":0,"max":300}', onChange: () => parseClickPoseConfig(p) }
    ]
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
// Applies a camera preset (a Saved Camera item OR cameraDefaultValues
// itself, both the same shape) directly to the live camera + pan target,
// then syncs the panel's own sliders to match -- deliberately sets
// camera.position/controls.target directly rather than going through
// applyCameraControl()'s own delta-preserving math, so this is fully
// deterministic regardless of whatever view was live beforehand.
function applyCameraPreset(item) {
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
  const item = getSelectedSavedCameraItem()
  if (!item) return
  applyCameraPreset(item)
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
const previewBaseQuat = new THREE.Quaternion()
const _previewWholeHandRotEuler = new THREE.Euler()

// Called once, right after the main model loads (modelRoot/alignQuat/
// boneRestQuat/toonMaterial all ready by then) -- clones the SAME already-
// loaded GLB one more time (no extra network fetch), same as rebuildField()
// clones it per field hand.
function buildPosePreview() {
  const body = document.querySelector('.dp-group[data-key="Pose Preview"] .dp-group-body')
  if (!body) return
  const canvas = document.createElement('canvas')
  canvas.className = 'dp-pose-preview-canvas'
  body.appendChild(canvas)

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

  // Framed from the SAME bounding-sphere measurement taken once at load
  // (handBoundsCenterLocal/handBoundsRadiusLocal) the main scene's own
  // one-time auto-frame already uses -- no separate measurement needed.
  // Aimed at the mesh's own measured center (rotated by alignQuat, the
  // same transform the clone itself carries), NOT the raw origin -- this
  // asset's visible mesh includes a full forearm hanging below the wrist
  // (documented in handBoundsCenterLocal's own declaration comment), so
  // the bounding sphere's center sits well away from the wrist/bone-
  // origin point; aiming at (0,0,0) framed mostly forearm instead of the
  // hand+fingers.
  const previewTarget = handBoundsCenterLocal.clone().applyQuaternion(alignQuat)
  previewCamera.position.copy(previewTarget).add(new THREE.Vector3(0, handBoundsRadiusLocal * 0.15, handBoundsRadiusLocal * 2.4))
  previewControls = new OrbitControls(previewCamera, canvas)
  previewControls.target.copy(previewTarget)
  previewControls.enableDamping = true
  previewControls.update()

  resizePosePreview()
  window.addEventListener('resize', resizePosePreview)
}
// canvas.clientWidth/Height (CSS layout size) drives the resize, same
// self-heal reasoning as the main scene's own applyRendererSize() --
// re-read on demand (called after building, on window resize, and every
// frame's render call below is cheap to guard with this) rather than
// assumed fixed, since the group's own resizable dev-panel width means
// this canvas's real displayed size can change at any time.
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
function evaluateArmLengthCurve(points, x) {
  if (!points || points.length === 0) return 1
  if (points.length === 1) return points[0].y
  const sorted = points // already kept sorted by the widget itself
  if (x <= sorted[0].x) return sorted[0].y
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i], p2 = sorted[i + 1]
    if (x >= p1.x && x <= p2.x) {
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
const CLICK_HOLD_KEYS = ['chp', 'rchp']
const clickHoldPoseTriggers = {
  chp: { active: false, holdStartTime: 0, forwardSnapshot: null, startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 }, retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 } },
  rchp: { active: false, holdStartTime: 0, forwardSnapshot: null, startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 }, retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 } }
}
function parseClickHoldConfig(p) {
  const t = clickHoldPoseTriggers[p]
  try { t.startCurveParsed = JSON.parse(cfg[`${p}StartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.startRangeParsed = JSON.parse(cfg[`${p}StartTimeRange`]) } catch (e) { /* keep last-good value */ }
  try { t.retransitionCurveParsed = JSON.parse(cfg[`${p}RetransitionStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.retransitionRangeParsed = JSON.parse(cfg[`${p}RetransitionStartTimeRange`]) } catch (e) { /* keep last-good value */ }
}
function getOrInitHandCHP(hand) {
  if (!hand._chp) {
    hand._chp = {}
    CLICK_HOLD_KEYS.forEach((p) => { hand._chp[p] = { phase: 'idle', forwardDelay: 0, retransitionDelay: 0, retransitionStart: null, retransitionStartTime: 0, lastAppliedValues: null, frozenSplayDeg: 0 } })
  }
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
}
function computeStartDelayMs(distanceToCursor, minLiveDist, liveDistRange, curveParsed, rangeParsed) {
  const normDist = THREE.MathUtils.clamp((distanceToCursor - minLiveDist) / liveDistRange, 0, 1)
  const curveY = THREE.MathUtils.clamp(evaluateArmLengthCurve(curveParsed, normDist), 0, 1)
  return rangeParsed.min + (rangeParsed.max - rangeParsed.min) * curveY
}
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
function updateClickHoldPoseForHand(hand, p, live, minLiveDist, liveDistRange, now) {
  const trig = clickHoldPoseTriggers[p]
  const chp = getOrInitHandCHP(hand)[p]
  if (trig.active && chp.phase !== 'forward') {
    // A fresh hold just started (or one started again before this
    // hand's own prior retransition finished) -- (re)enter 'forward'
    // and lock in this hand's own start delay from ITS distance right
    // now, per this section's own "computed once, not live" design.
    // frozenSplayDeg is captured the same way, for the same reason --
    // see this section's own top note on why Responsive Wrist Splay
    // must NOT keep recomputing live throughout a pose transition.
    chp.phase = 'forward'
    chp.forwardDelay = computeStartDelayMs(live, minLiveDist, liveDistRange, trig.startCurveParsed, trig.startRangeParsed)
    chp.frozenSplayDeg = computeResponsiveWristSplayDeg(live, minLiveDist, liveDistRange)
  }
  if (chp.phase === 'forward') {
    const targetPose = (cfg.savedPoses || []).find((sp) => sp.name === cfg[`${p}TargetPose`])
    if (!targetPose || !trig.forwardSnapshot) return // nothing selected / nothing to transition FROM yet -- leave this hand's pose untouched
    const elapsed = now - trig.holdStartTime
    const speedMs = Math.max(cfg[`${p}TransitionSpeedMs`], 1)
    const progress = elapsed < chp.forwardDelay ? 0 : THREE.MathUtils.clamp((elapsed - chp.forwardDelay) / speedMs, 0, 1)
    const values = lerpPoseValues(trig.forwardSnapshot, targetPose, progress)
    chp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
  } else if (chp.phase === 'retransition') {
    const elapsed = now - chp.retransitionStartTime
    const speedMs = Math.max(cfg[`${p}RetransitionSpeedMs`], 1)
    const progress = elapsed < chp.retransitionDelay ? 0 : THREE.MathUtils.clamp((elapsed - chp.retransitionDelay) / speedMs, 0, 1)
    const values = lerpPoseValues(chp.retransitionStart, poseDefaultValues, progress)
    applyPoseValuesToHand(hand, values, chp.frozenSplayDeg)
    if (progress >= 1) chp.phase = 'idle' // fully settled at default -- stop overriding, normal cfg-driven posing (inert here since it only re-applies on slider change, not every frame) silently regains control
  }
}
function startClickHoldPose(p) {
  if (!cfg[`${p}Enabled`]) return
  const trig = clickHoldPoseTriggers[p]
  trig.active = true
  trig.holdStartTime = performance.now()
  trig.forwardSnapshot = {}
  POSE_PRESET_KEYS.forEach((key) => { trig.forwardSnapshot[key] = cfg[key] })
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
  // Only restore panning once NEITHER trigger is still holding -- e.g.
  // releasing the right button while the left is still held shouldn't
  // re-enable panning mid-hold.
  if (!clickHoldPoseTriggers.chp.active && !clickHoldPoseTriggers.rchp.active) applyCameraLockState()
  const now = performance.now()
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
    chp.retransitionStart = chp.lastAppliedValues || { ...poseDefaultValues }
    chp.retransitionStartTime = now
    chp.retransitionDelay = computeStartDelayMs(dists[i], minD, range, trig.retransitionCurveParsed, trig.retransitionRangeParsed)
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
  if (e.button === 0) startClickHoldPose('chp')
  else if (e.button === 2) startClickHoldPose('rchp')
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
window.addEventListener('pointerup', (e) => {
  const now = performance.now()
  const chpHeldLongEnough = e.button === 0 && clickHoldPoseTriggers.chp.active && (now - clickHoldPoseTriggers.chp.holdStartTime) >= MOUSE_LOG_HELD_DRAG_MS
  const rchpHeldLongEnough = e.button === 2 && clickHoldPoseTriggers.rchp.active && (now - clickHoldPoseTriggers.rchp.holdStartTime) >= MOUSE_LOG_HELD_DRAG_MS
  lastPointerupWasHoldRelease = chpHeldLongEnough || rchpHeldLongEnough
  if (e.button === 0) endClickHoldPose('chp')
  else if (e.button === 2) endClickHoldPose('rchp')
})
window.addEventListener('blur', () => { endClickHoldPose('chp'); endClickHoldPose('rchp') })

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
const CLICK_POSE_KEYS = ['click', 'dblclick']
const clickPoseTriggers = {
  click: { startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 }, retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 } },
  dblclick: { startCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], startRangeParsed: { min: 0, max: 300 }, retransitionCurveParsed: [{ x: 0, y: 0 }, { x: 1, y: 1 }], retransitionRangeParsed: { min: 0, max: 300 } }
}
function parseClickPoseConfig(p) {
  const t = clickPoseTriggers[p]
  try { t.startCurveParsed = JSON.parse(cfg[`${p}StartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.startRangeParsed = JSON.parse(cfg[`${p}StartTimeRange`]) } catch (e) { /* keep last-good value */ }
  try { t.retransitionCurveParsed = JSON.parse(cfg[`${p}RetransitionStartTimeCurve`]).sort((a, b) => a.x - b.x) } catch (e) { /* keep last-good value */ }
  try { t.retransitionRangeParsed = JSON.parse(cfg[`${p}RetransitionStartTimeRange`]) } catch (e) { /* keep last-good value */ }
}
function getOrInitHandCP(hand) {
  if (!hand._cp) {
    hand._cp = {}
    CLICK_POSE_KEYS.forEach((p) => { hand._cp[p] = { phase: 'idle', triggerTime: 0, forwardSnapshot: null, forwardDelay: 0, pauseStartTime: 0, retransitionStart: null, retransitionStartTime: 0, retransitionDelay: 0, lastAppliedValues: null, frozenSplayDeg: 0 } })
  }
  return hand._cp
}
function updateClickPoseForHand(hand, p, live, minLiveDist, liveDistRange, now) {
  const cp = getOrInitHandCP(hand)[p]
  if (cp.phase === 'forward') {
    const targetPose = (cfg.savedPoses || []).find((sp) => sp.name === cfg[`${p}TargetPose`])
    if (!targetPose || !cp.forwardSnapshot) { cp.phase = 'idle'; return } // nothing selected -- abandon this hand's sequence rather than get stuck
    const elapsed = now - cp.triggerTime
    const speedMs = Math.max(cfg[`${p}TransitionSpeedMs`], 1)
    const progress = elapsed < cp.forwardDelay ? 0 : THREE.MathUtils.clamp((elapsed - cp.forwardDelay) / speedMs, 0, 1)
    const values = lerpPoseValues(cp.forwardSnapshot, targetPose, progress)
    cp.lastAppliedValues = values
    applyPoseValuesToHand(hand, values, cp.frozenSplayDeg)
    if (progress >= 1) { cp.phase = 'paused'; cp.pauseStartTime = now }
  } else if (cp.phase === 'paused') {
    // Hold at the fully-reached target -- keep reapplying (not a no-op,
    // since other config-driven state can still change during a hold).
    // CORRECTED 2026-09-14: now reapplies the frozen splay captured at
    // trigger time, not a live recompute -- see updateClickHoldPoseForHand()'s
    // own top comment for why Responsive Wrist Splay must not keep
    // recalculating throughout an explicit pose transition.
    applyPoseValuesToHand(hand, cp.lastAppliedValues, cp.frozenSplayDeg)
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
  const now = performance.now()
  const forwardSnapshot = {}
  POSE_PRESET_KEYS.forEach((key) => { forwardSnapshot[key] = cfg[key] })
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
    cp.phase = 'forward'
    cp.triggerTime = now
    cp.forwardSnapshot = forwardSnapshot
    cp.forwardDelay = computeStartDelayMs(dists[i], minD, range, trig.startCurveParsed, trig.startRangeParsed)
    // Frozen for this hand's entire sequence (forward/paused/
    // retransition) -- see updateClickHoldPoseForHand()'s own top
    // comment for why Responsive Wrist Splay must not keep recomputing
    // live throughout an explicit pose transition.
    cp.frozenSplayDeg = computeResponsiveWristSplayDeg(dists[i], minD, range)
  })
}
// Click vs. double-click disambiguation: a genuine double-click's 2
// underlying 'click' events can't be told apart from 2 separate single
// clicks without a short debounce window -- same problem, same fix, as
// the Mouse Tracking Log's own multi-click classification just above in
// this file, so this reuses that exact MOUSE_LOG_MULTICLICK_MS window
// (not a fresh, differently-tuned constant) for consistency. Left button
// only -- Click Hold-Pose's own right-click instance is unaffected.
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
  // avoidable latency. If Double-Click Pose is off, fire 'click'
  // immediately; the debounce is only genuinely needed when a 2nd click
  // could arrive and change the outcome.
  if (!cfg.dblclickEnabled) {
    clickPoseClickCount = 0
    clearTimeout(clickPoseClickTimer)
    triggerClickPose('click')
    return
  }
  clickPoseClickCount++
  clearTimeout(clickPoseClickTimer)
  clickPoseClickTimer = setTimeout(() => {
    if (clickPoseClickCount === 1) triggerClickPose('click')
    else if (clickPoseClickCount >= 2) triggerClickPose('dblclick')
    clickPoseClickCount = 0
  }, MOUSE_LOG_MULTICLICK_MS)
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
// Locates and builds all 4 of one trigger's own custom widgets (2 curve,
// 2 range) -- called once per trigger, right after initDevPanel(), same
// timing as buildArmLengthWidgets()/buildWristSplayWidgets().
const CLICK_HOLD_START_TIME_TRACK_MAX = 3000 // ms -- a deliberately smaller ceiling than the 5000ms Transition Speed sliders, since "start time" is meant to stagger WITHIN a transition, not span longer than one
function buildClickHoldPoseWidgets(p) {
  const startCurveRow = document.querySelector(`.dp-row[data-key="${p}StartTimeCurve"]`)
  const startRangeRow = document.querySelector(`.dp-row[data-key="${p}StartTimeRange"]`)
  const retransCurveRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeCurve"]`)
  const retransRangeRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeRange"]`)
  const curveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Start Time Fraction (0=Min, 1=Max)'
  if (startCurveRow) buildGenericCurveWidget(startCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (startRangeRow) buildGenericRangeBarWidget(startRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  if (retransCurveRow) buildGenericCurveWidget(retransCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (retransRangeRow) buildGenericRangeBarWidget(retransRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
}
// Runs now, not back up near the other widgets' own setup calls (parse-
// ArmLengthConfig()/buildWristSplayWidgets() etc.) -- this needs
// clickHoldPoseTriggers (declared just above) to already exist, and that
// const isn't hoisted the way a function declaration is.
CLICK_HOLD_KEYS.forEach((p) => { parseClickHoldConfig(p); buildClickHoldPoseWidgets(p) })
// Same 4-widget shape as buildClickHoldPoseWidgets() above (this feature
// has no widgets of its own beyond the plain Pause Duration slider,
// which needs no custom widget) -- reuses the SAME
// CLICK_HOLD_START_TIME_TRACK_MAX ceiling too, since "start time" means
// the identical thing in both features.
function buildClickPoseWidgets(p) {
  const startCurveRow = document.querySelector(`.dp-row[data-key="${p}StartTimeCurve"]`)
  const startRangeRow = document.querySelector(`.dp-row[data-key="${p}StartTimeRange"]`)
  const retransCurveRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeCurve"]`)
  const retransRangeRow = document.querySelector(`.dp-row[data-key="${p}RetransitionStartTimeRange"]`)
  const curveCaption = 'X: Distance From Cursor (%, Nearest→Farthest Hand At Trigger Time)  ·  Y: Start Time Fraction (0=Min, 1=Max)'
  if (startCurveRow) buildGenericCurveWidget(startCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (startRangeRow) buildGenericRangeBarWidget(startRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
  if (retransCurveRow) buildGenericCurveWidget(retransCurveRow, { caption: curveCaption, defaultPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  if (retransRangeRow) buildGenericRangeBarWidget(retransRangeRow, { trackMin: 0, trackMax: CLICK_HOLD_START_TIME_TRACK_MAX, unit: 'ms', defaultValue: { min: 0, max: 300 } })
}
CLICK_POSE_KEYS.forEach((p) => { parseClickPoseConfig(p); buildClickPoseWidgets(p) })
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
    const hand = { wrapper, clone, skinnedMesh, outlineMesh, wristClipPlane: handWristClipPlane, effectiveRenderOrder: 0, screenX: 0, screenY: 0, screenRadius: 0, currentBaseQuat: cloneBaseQuat.clone() }
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
    rebuildField()
    buildPosePreview()
    window.__debug = { THREE, scene, camera, controls, renderer, composer, outlinePass, hands, cfg, sceneState, handLengthRaw, alignQuat, computeBaseScale, updateRenderOrder, cursorTarget, previewHand, previewScene, previewCamera, get previewControls() { return previewControls }, poseDefaultValues, setSelectedPoseAsDefault, getSelectedSavedPoseItem, updateCursorTarget, targetPlane, cursorNDC, applyAllFingerPoses, applyPoseValuesToHand, get cloneBaseQuat() { return cloneBaseQuat }, triggerClickPose, startClickHoldPose, endClickHoldPose, updateClickPoseForHand, updateClickHoldPoseForHand, getOrInitHandCP, getOrInitHandCHP, computeResponsiveWristSplayDeg, applyWristPoseToSkeleton, applyCurlToSkeleton, FINGER_NAMES, FINGER_JOINTS, boneRestQuat, FINGER_CURL_AXIS, cameraDefaultValues, applyCameraPreset, captureCameraPreset, setSelectedCameraAsDefault, updateCameraMaxExtentsBound, enforceCameraPanExtent, applyCameraLockState }
    loadingEl.classList.add('hidden')
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

function animate() {
  requestAnimationFrame(animate)
  renderer.getSize(rendererSizeCheck)
  if (window.innerWidth > 0 && window.innerHeight > 0 && (rendererSizeCheck.x !== window.innerWidth || rendererSizeCheck.y !== window.innerHeight)) {
    applyRendererSize(window.innerWidth, window.innerHeight)
  }
  controls.update()
  enforceCameraPanExtent()
  syncCameraPanelFromLive()
  updateCursorTarget()
  armLengthWidgetResyncs.forEach((fn) => fn())
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
  updateRenderOrder()
  composer.render()
  // Pose Preview's own tiny render pass -- guarded by offsetParent (null
  // whenever an ancestor is display:none, i.e. the "Pose Preview" group
  // is collapsed, or the whole dev panel is hidden/collapsed) so an
  // orbit-controllable mini-viewport nobody can currently see doesn't
  // still cost a render every frame.
  if (previewRenderer && previewRenderer.domElement.offsetParent !== null) {
    resizePosePreview()
    previewControls.update()
    previewRenderer.render(previewScene, previewCamera)
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
  const nowMs = performance.now() // one shared timestamp for every hand's own Click-Hold-Pose progress this frame, not a separate call per hand
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
        if (cpAll[p].phase !== 'idle') {
          updateClickPoseForHand(hand, p, live, minLiveDist, liveDistRange, nowMs)
          overridden = true
        }
      })
      if (!overridden) {
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
    }
  })
}
animate()
