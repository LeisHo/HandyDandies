import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeletal } from 'three/addons/utils/SkeletonUtils.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { initDevPanel, syncValue } from './devpanel/devPanel.js?v=9'

const MODEL_URL = '../data/processed/HAND3D/Hand2.glb'
// Measured once after the first load -- the rig's own bind-pose "pointing"
// axis (wrist -> middle fingertip), not assumed to be +Y/-Z.
let alignQuat = new THREE.Quaternion()
// "Palm Faces Cursor" (Cursor Tracking group) -- a FIXED, one-time-measured
// correction, composed onto the per-frame lookAt quaternion (see the
// tracking code below) only while that mode is enabled. Whole-object
// rotation only -- never touches the skeleton/pose, per direct
// correction ("you shouldnt be doing any posing work" / "when i say
// rotate the hand... I just meant rotate the entire model").
let palmFaceCorrectionQuat = new THREE.Quaternion()
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
      { key: 'fieldRows', label: 'Rows (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 17, onChange: () => rebuildField() },
      { key: 'fieldCols', label: 'Columns (Count)', type: 'slider', min: 1, max: 40, step: 1, def: 30, onChange: () => rebuildField() },
      { key: 'rowSpacing', label: 'Row Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 10, onChange: () => relayoutField() },
      { key: 'columnSpacing', label: 'Column Spacing (World Units)', type: 'slider', min: 2, max: 40, step: 0.5, def: 11.5, onChange: () => relayoutField() },
      { key: 'handScale', label: 'Hand Scale (x)', type: 'slider', min: 0.1, max: 3, step: 0.05, def: 1.2, onChange: () => relayoutField() },
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
      { key: 'trackingDamping', label: 'Look-At Damping (x)', type: 'slider', min: 0.02, max: 1, step: 0.01, def: 0.07 },
      { key: 'targetDepthFactor', label: 'Cursor Target Depth (x Field Radius)', type: 'slider', min: -2, max: 2, step: 0.05, def: 0.6, onChange: updateTargetPlane },
      { key: 'showTargetMarker', label: 'Show Target Marker', type: 'checkbox', def: true, onChange: (v) => { if (targetMarker) targetMarker.visible = v } },
      // Direct request: aim each hand's PALM at the cursor instead of its
      // fingertip direction -- whole-object rotation only (see
      // palmFaceCorrectionQuat's own declaration comment), never the
      // skeleton/pose. Default off so nothing changes until opted in.
      { key: 'palmFacesCursor', label: 'Palm Faces Cursor', type: 'checkbox', def: false }
    ]
  },
  {
    title: 'Pose',
    controls: [
      // Ported from HANDO's own Pose group (identical rig/bone names, same
      // Hand2.glb asset) -- applies identically to every hand for now, per
      // direct request ("For now, the pose settings apply to every hand").
      { key: 'thumbCurl', label: 'Thumb Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 7, lockRange: true, onChange: () => applyCurl('thumb') },
      { key: 'thumbSplay', label: 'Thumb Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'thumbSplay2', label: 'Thumb Tip Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'curlBiasThumb', label: 'Thumb Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'tipTwistThumb', label: 'Thumb Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('thumb') },
      { key: 'curlIndex', label: 'Index Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 73, lockRange: true, onChange: () => applyCurl('index') },
      { key: 'splayIndex', label: 'Index Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'splayIndex2', label: 'Index 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'curlBiasIndex', label: 'Index Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'tipTwistIndex', label: 'Index Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('index') },
      { key: 'curlMiddle', label: 'Middle Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: -100, lockRange: true, onChange: () => applyCurl('middle') },
      { key: 'splayMiddle', label: 'Middle Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'splayMiddle2', label: 'Middle 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'curlBiasMiddle', label: 'Middle Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'tipTwistMiddle', label: 'Middle Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('middle') },
      { key: 'curlRing', label: 'Ring Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: -100, lockRange: true, onChange: () => applyCurl('ring') },
      { key: 'splayRing', label: 'Ring Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'splayRing2', label: 'Ring 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'curlBiasRing', label: 'Ring Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'tipTwistRing', label: 'Ring Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('ring') },
      { key: 'curlPinky', label: 'Pinky Curl (%)', type: 'slider', min: -200, max: 200, step: 1, def: 71, lockRange: true, onChange: () => applyCurl('pinky') },
      { key: 'splayPinky', label: 'Pinky Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'splayPinky2', label: 'Pinky 2nd Segment Splay (%)', type: 'slider', min: -200, max: 200, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'curlBiasPinky', label: 'Pinky Curl Bias (Base <-> Tip) (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'tipTwistPinky', label: 'Pinky Tip Twist (%)', type: 'slider', min: -100, max: 100, step: 1, def: 0, onChange: () => applyCurl('pinky') },
      { key: 'wristBend', label: 'Wrist Bend (Deg)', type: 'slider', min: -90, max: 90, step: 1, def: 0, onChange: () => applyWristPose() },
      { key: 'wristSplay', label: 'Wrist Splay (Deg)', type: 'slider', min: -30, max: 30, step: 1, def: 0, onChange: () => applyWristPose() },
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
        def: [],
        itemLabel: 'Pose',
        importable: true,
        captureCurrent: () => capturePosePreset(),
        onUse: (item) => previewPosePreset(item)
      },
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
      { key: 'hideWrist', label: 'Default Arm Length (Crop %, Reactive Off)', type: 'slider', min: 0, max: 100, step: 1, def: 0 },
      // Direct follow-up request: "make the crop or arm length dependent
      // on distance from the cursor, so the closer it is the shorter the
      // arm length." When on, computeArmLengthT() drives the crop % from
      // this hand's own live cursor distance through Length Scaling
      // Curve, remapped into the Min/Max Arm Length bounds below, instead
      // of the fixed Default Arm Length above.
      { key: 'reactiveArmLengthEnabled', label: 'Reactive Arm Length (By Cursor Distance)', type: 'checkbox', def: false },
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
      { key: 'armLengthRange', label: 'Min / Max Arm Length (Crop %)', type: 'text', def: '{"min":30,"max":90}', onChange: () => parseArmLengthConfig() },
      { key: 'armLengthCurve', label: 'Length Scaling Curve (Distance -> Crop)', type: 'text', def: '[{"x":0,"y":1},{"x":1,"y":0}]', onChange: () => parseArmLengthConfig() }
    ]
  },
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
      { key: 'cameraX', label: 'Camera X Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: -1.7981492385140072, onChange: (v) => applyCameraControl('cameraX', v) },
      { key: 'cameraY', label: 'Camera Y Position (x)', type: 'slider', min: -300, max: 300, step: 0.5, def: -1.3026242754855961, onChange: (v) => applyCameraControl('cameraY', v) },
      { key: 'cameraZ', label: 'Camera Z Position (x)', type: 'slider', min: 1, max: 500, step: 0.5, def: 259.0864928710401, onChange: (v) => applyCameraControl('cameraZ', v) },
      { key: 'cameraFov', label: 'Field Of View (Deg)', type: 'slider', min: 15, max: 90, step: 1, def: 35, onChange: (v) => applyCameraControl('cameraFov', v) },
      // Direct 2-way binding with scroll/pinch zoom, same pattern as the
      // X/Y/Z sliders above: this slider both SETS the camera's distance
      // to its own pan target (setCameraDistance(), below) and is kept in
      // sync FROM the live distance every frame (syncCameraPanelFromLive())
      // -- scrolling moves the slider, moving the slider zooms, per direct
      // request ("responsive to my wheel scroll and vice versa").
      { key: 'cameraZoom', label: 'Zoom (Distance To Pan Target) (x)', type: 'slider', min: 1, max: 800, step: 0.5, def: 259.1, onChange: (v) => applyCameraControl('cameraZoom', v) }
    ]
  },
  {
    title: 'Lighting',
    controls: [
      { key: 'keyAzimuth', label: 'Key Light Azimuth (Deg)', type: 'slider', min: 0, max: 360, step: 1, def: 231, onChange: updateKeyLightPosition },
      { key: 'keyElevation', label: 'Key Light Elevation (Deg)', type: 'slider', min: -89, max: 89, step: 1, def: 28, onChange: updateKeyLightPosition },
      { key: 'keyTargetHeight', label: 'Key Light Aim Height (%)', type: 'slider', min: -100, max: 100, step: 1, def: -100, onChange: updateKeyLightPosition },
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
      { key: 'toonStepThreshold', label: 'Toon Step Threshold (Bias)', type: 'slider', min: 0.2, max: 5, step: 0.05, def: 2.1, onChange: () => rebuildGradientMap() },
      { key: 'toonShadowFloor', label: 'Toon Shadow Floor (%)', type: 'slider', min: 0, max: 90, step: 1, def: 12, onChange: () => rebuildGradientMap() },
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
const cfg = initDevPanel(DEV_GROUPS, { storageKeyPrefix: 'handyDandies' })
onChangeByCtrl.forEach((fn, c) => { c.onChange = fn })
// Arm Length's 2 custom widgets (see their own declaration comments,
// Pose section below) -- parse whatever initDevPanel() just restored
// (saved or default) into the cached vars computeArmLengthT() reads every
// frame, then build the actual draggable UI on top of each control's own
// (now-hidden) generic text input.
parseArmLengthConfig()
buildArmLengthWidgets()
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
controls.enablePan = true
controls.enableZoom = true
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

function updateTargetPlane() {
  targetPlane.set(new THREE.Vector3(0, 0, 1), -sceneState.fieldRadius * cfg.targetDepthFactor)
}

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

function updateCursorTarget() {
  raycaster.setFromCamera(cursorNDC, camera)
  const hit = new THREE.Vector3()
  if (raycaster.ray.intersectPlane(targetPlane, hit)) cursorTarget.copy(hit)
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
const FINGER_TIP_TWIST_KEY = { thumb: 'tipTwistThumb', index: 'tipTwistIndex', middle: 'tipTwistMiddle', ring: 'tipTwistRing', pinky: 'tipTwistPinky' }
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
  const curlAxis = _curlAxisScratch.copy(FINGER_CURL_AXIS[fingerName]).applyQuaternion(baseQuat)
  const splayAxis = _splayAxisScratch.copy(FINGER_SPLAY_AXIS[fingerName]).applyQuaternion(baseQuat)
  const curlT = values[FINGER_CURL_KEY[fingerName]] / 100
  const splayT = values[FINGER_SPLAY_KEY[fingerName]] / 100
  const curlBias = values[FINGER_CURL_BIAS_KEY[fingerName]] / 100
  const tipTwistT = values[FINGER_TIP_TWIST_KEY[fingerName]] / 100
  const splayAngle = FINGER_SPLAY_SIGN[fingerName] * THREE.MathUtils.degToRad(FINGER_SPLAY_MAX_DEG[fingerName] * splayT)
  const splayJointIndex = FINGER_SPLAY_JOINT_INDEX[fingerName]
  const splay2JointIndex = FINGER_SPLAY2_JOINT_INDEX[fingerName]
  const splay2Axis = _splay2AxisScratch.copy(FINGER_SPLAY2_AXIS[fingerName]).applyQuaternion(baseQuat)
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
function applyWristPoseToSkeleton(skeleton, values = cfg) {
  const bone = skeleton.getBoneByName('rHand')
  const rest = boneRestQuat.rHand
  if (!bone || !rest) return
  bone.quaternion.copy(rest)
  bone.rotateX(THREE.MathUtils.degToRad(values.wristBend))
  bone.rotateZ(THREE.MathUtils.degToRad(values.wristSplay))
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
function applyAllFingerPoses() {
  FINGER_NAMES.forEach((name) => applyCurl(name))
  applyWristPose()
}

// Saved-pose capture -- every key a saved pose stores, listed once here so
// capture and Pose Preview's own apply (previewPosePreset(), below) can
// never drift apart. Ported from HANDO's own POSE_PRESET_KEYS/
// capturePosePreset(), with the Crop Wrist / Arm Length family
// deliberately left out -- see the 'savedPoses' control's own comment for
// why.
const POSE_PRESET_KEYS = [
  'thumbCurl', 'thumbSplay', 'thumbSplay2', 'curlBiasThumb', 'tipTwistThumb',
  'curlIndex', 'splayIndex', 'splayIndex2', 'curlBiasIndex', 'tipTwistIndex',
  'curlMiddle', 'splayMiddle', 'splayMiddle2', 'curlBiasMiddle', 'tipTwistMiddle',
  'curlRing', 'splayRing', 'splayRing2', 'curlBiasRing', 'tipTwistRing',
  'curlPinky', 'splayPinky', 'splayPinky2', 'curlBiasPinky', 'tipTwistPinky',
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
  FINGER_NAMES.forEach((name) => applyCurlToSkeleton(name, previewHand.skinnedMesh.skeleton, previewBaseQuat, null, values))
  applyWristPoseToSkeleton(previewHand.skinnedMesh.skeleton, values)
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
      c.addEventListener('dblclick', (dblEv) => {
        dblEv.stopPropagation()
        if (points.length > 2 && i !== 0 && i !== points.length - 1) {
          points.splice(points.indexOf(p), 1)
          redraw()
          commitPoints()
        }
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
function applyHandArmLength(hand, hideT) {
  const scaleFactor = computeBaseScale()
  _cutPointRaw.copy(forearmPosRaw).lerp(wristPosRaw, hideT)
  hand.clone.quaternion.copy(cloneBaseQuat)
  hand.clone.position.copy(_cutPointRaw).applyQuaternion(cloneBaseQuat).multiplyScalar(-scaleFactor)
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
    const hand = { wrapper, clone, skinnedMesh, outlineMesh, wristClipPlane: handWristClipPlane, effectiveRenderOrder: 0, screenX: 0, screenY: 0, screenRadius: 0 }
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
    updateTargetPlane()
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

    // "Palm Faces Cursor" -- measured the same way as pointDir/alignQuat
    // above (bind-pose bone positions, identity frame, before any
    // per-instance clone/scale/rotate): the palm-plane normal is
    // (pinky-base - wrist) x (index-base - wrist). Sign calibrated LIVE
    // against this project's own already-confirmed default-mode behavior
    // ("hands under the cursor show the back of their hand to the
    // camera... this is correct" -- direct user report): for a hand
    // below the cursor under the EXISTING pointDir-tracks-cursor
    // behavior, this exact cross-product direction measured facing AWAY
    // from the camera, matching "palm away / back toward camera" for
    // that hand -- confirming this is really the outward palm normal,
    // not the back-of-hand normal (the opposite cross-product order).
    // `palmFaceCorrectionQuat` rotates this direction (in the SAME
    // post-alignQuat local frame the live lookAt tracking already
    // operates in) onto local -Z -- composed onto the per-frame lookAt
    // quaternion below, it's what makes the palm (instead of the
    // fingertip direction) the axis that ends up aimed at the cursor.
    const indexBaseBone = skinned.skeleton.getBoneByName('rIndex1')
    const pinkyBaseBone = skinned.skeleton.getBoneByName('rPinky1')
    if (indexBaseBone && pinkyBaseBone) {
      const indexBasePos = new THREE.Vector3()
      const pinkyBasePos = new THREE.Vector3()
      indexBaseBone.getWorldPosition(indexBasePos)
      pinkyBaseBone.getWorldPosition(pinkyBasePos)
      const indexVec = indexBasePos.clone().sub(wristPos)
      const pinkyVec = pinkyBasePos.clone().sub(wristPos)
      const palmNormalRaw = pinkyVec.clone().cross(indexVec).normalize()
      const palmNormalAligned = palmNormalRaw.clone().applyQuaternion(alignQuat)
      palmFaceCorrectionQuat = new THREE.Quaternion().setFromUnitVectors(palmNormalAligned, new THREE.Vector3(0, 0, -1))
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
    window.__debug = { THREE, scene, camera, controls, renderer, composer, outlinePass, hands, cfg, sceneState, handLengthRaw, alignQuat, computeBaseScale, updateRenderOrder, cursorTarget, previewHand, previewScene, previewCamera, get previewControls() { return previewControls } }
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
  syncCameraPanelFromLive()
  updateCursorTarget()
  armLengthWidgetResyncs.forEach((fn) => fn())
  if (cfg.trackingEnabled) {
    hands.forEach((hand) => {
      const m = new THREE.Matrix4().lookAt(hand.wrapper.position, cursorTarget, UP)
      const desired = new THREE.Quaternion().setFromRotationMatrix(m)
      // "Palm Faces Cursor": composes a fixed correction (see its own
      // declaration comment) onto the same lookAt quaternion above, so
      // the palm -- not the fingertip direction -- ends up the axis
      // aimed at the cursor. Whole-wrapper rotation only, same mechanism
      // as the default mode; no skeleton/pose involvement either way.
      if (cfg.palmFacesCursor) desired.multiply(palmFaceCorrectionQuat)
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
  })
}
animate()
