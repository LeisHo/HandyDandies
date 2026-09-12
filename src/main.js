import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeletal } from 'three/addons/utils/SkeletonUtils.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { initDevPanel, syncValue } from './devpanel/devPanel.js'

const MODEL_URL = '../data/processed/HAND3D/Hand2.glb'
// Measured once after the first load -- the rig's own bind-pose "pointing"
// axis (wrist -> middle fingertip), not assumed to be +Y/-Z.
let alignQuat = new THREE.Quaternion()
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
// what lets updateClonePoseTransform() reconstruct exactly where the
// current "cut" point sits relative to the model's own raw content-space
// origin -- a direction+distance pair alone can't do that (it was tried
// first and produced a real, measured bug: correct with Hide Wrist alone,
// wrong once combined with Whole-Hand Rotation -- see CHANGELOG.txt for
// the measured before/after).
const wristPosRaw = new THREE.Vector3()
const forearmPosRaw = new THREE.Vector3()

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
      { key: 'showTargetMarker', label: 'Show Target Marker', type: 'checkbox', def: true, onChange: (v) => { if (targetMarker) targetMarker.visible = v } }
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
      // Cuts away the forearm from a percentage down from the wrist -- 0%
      // clips nothing, 100% cuts off exactly at the wrist joint (hiding
      // the entire forearm). Per direct request, the whole hand shifts to
      // compensate (see updateClonePoseTransform()) so the newly-visible
      // cut base stays at this hand's own Field Layout grid point, rather
      // than drifting away from it as more of the forearm gets clipped.
      { key: 'hideWrist', label: 'Hide Wrist (%)', type: 'slider', min: 0, max: 100, step: 1, def: 0, onChange: () => updateClonePoseTransform() }
    ]
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
      { key: 'toonBaseTint', label: 'Toon Base Tint', type: 'color', def: '#ffffff', onChange: (v) => { if (toonMaterial) toonMaterial.color.set(v) } },
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
        if (outlineMaterial) outlineMaterial.uniforms.outlineColor.value.set(v)
        if (outlinePass) { outlinePass.visibleEdgeColor.set(v); outlinePass.hiddenEdgeColor.set(v) }
      } },
      { key: 'hullThickness', label: 'Hull Outline Thickness (% Of Hand Length)', type: 'slider', min: 0, max: 6, step: 0.05, def: 6, onChange: (v) => { if (outlineMaterial) outlineMaterial.uniforms.outlineThickness.value = (v / 100) * handLengthRaw } },
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
      { key: 'showWireframe', label: 'Show Wireframe', type: 'checkbox', def: false, onChange: (v) => { if (toonMaterial) toonMaterial.wireframe = v } },
      // Freezes a hand's own render-order value (see animate()'s own
      // overlap-detection block) the instant it starts visually
      // overlapping another hand, instead of letting cursor-distance
      // render ordering keep re-sorting it live -- direct request: 2
      // overlapping hands' stacking must not flash/flip while they're
      // still overlapping, only once they visibly clear each other.
      { key: 'preventReorderFlash', label: 'Prevent Reordering Flash (Freeze Order While Overlapping)', type: 'checkbox', def: false }
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
})

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
  toonMaterial.gradientMap = makeGradientTexture(cfg.toonSteps, cfg.toonShadowFloor, cfg.toonLightCeiling, cfg.toonStepThreshold)
  toonMaterial.needsUpdate = true
}
// Ported from HANDO's own createToonMaterial() -- a MeshToonMaterial with
// an onBeforeCompile injecting rim lighting + a duotone texture-tint blend
// (see HANDO's own code for why duotone rather than a flat color swap).
// Dropped: HANDO's `clippingPlanes`/wrist-hide support -- not a feature
// this project has.
function createToonMaterial(map) {
  const material = new THREE.MeshToonMaterial({
    map,
    color: new THREE.Color(cfg.toonBaseTint),
    gradientMap: makeGradientTexture(cfg.toonSteps, cfg.toonShadowFloor, cfg.toonLightCeiling, cfg.toonStepThreshold),
    wireframe: cfg.showWireframe,
    // Hide Wrist (Pose group) -- see wristClipPlane's own declaration
    // comment for why this is a single shared Plane mutated per-hand,
    // not a per-material array.
    clippingPlanes: [wristClipPlane]
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
      clippingPlanes: [wristClipPlane]
      // depthTest stays ON -- see createToonMaterial()'s own note; matches
      // the fill material's depth-clear-per-hand approach.
    })
  }
  return outlineMaterial
}
function buildOutlineMesh(sourceMesh) {
  const mesh = sourceMesh.clone()
  mesh.material = ensureOutlineMaterial()
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
// updateClonePoseTransform()), passed in rather than read from a
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
function applyCurlToSkeleton(fingerName, skeleton, baseQuat, wrapperQuat) {
  const joints = FINGER_JOINTS[fingerName]
  const maxDegs = FINGER_MAX_DEG[fingerName]
  const sign = FINGER_SIGN[fingerName]
  const curlAxis = _curlAxisScratch.copy(FINGER_CURL_AXIS[fingerName]).applyQuaternion(baseQuat)
  const splayAxis = _splayAxisScratch.copy(FINGER_SPLAY_AXIS[fingerName]).applyQuaternion(baseQuat)
  const curlT = cfg[FINGER_CURL_KEY[fingerName]] / 100
  const splayT = cfg[FINGER_SPLAY_KEY[fingerName]] / 100
  const curlBias = cfg[FINGER_CURL_BIAS_KEY[fingerName]] / 100
  const tipTwistT = cfg[FINGER_TIP_TWIST_KEY[fingerName]] / 100
  const splayAngle = FINGER_SPLAY_SIGN[fingerName] * THREE.MathUtils.degToRad(FINGER_SPLAY_MAX_DEG[fingerName] * splayT)
  const splayJointIndex = FINGER_SPLAY_JOINT_INDEX[fingerName]
  const splay2JointIndex = FINGER_SPLAY2_JOINT_INDEX[fingerName]
  const splay2Axis = _splay2AxisScratch.copy(FINGER_SPLAY2_AXIS[fingerName]).applyQuaternion(baseQuat)
  const splay2T = cfg[FINGER_SPLAY2_KEY[fingerName]] / 100
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
function applyWristPoseToSkeleton(skeleton) {
  const bone = skeleton.getBoneByName('rHand')
  const rest = boneRestQuat.rHand
  if (!bone || !rest) return
  bone.quaternion.copy(rest)
  bone.rotateX(THREE.MathUtils.degToRad(cfg.wristBend))
  bone.rotateZ(THREE.MathUtils.degToRad(cfg.wristSplay))
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

// Whole-Hand Rotation X/Y/Z + Hide Wrist's own position compensation --
// both change `clone.quaternion`/`clone.position` (never `wrapper`'s own
// transform, which the per-frame cursor look-at owns exclusively, see
// animate()), so they compose cleanly with tracking and never need to run
// per frame, only when a Pose slider actually changes (or the field is
// relaid-out, since the position term scales with hand scale).
//
// Hide Wrist's own grid-alignment is treated as the hard, always-exact
// invariant (the direct request: "the cut wrist base should still
// correspond to the Field Layout points") -- Whole-Hand Rotation
// therefore pivots around the CURRENT cut point (wherever Hide Wrist has
// it), not a fixed palm-center point the way HANDO's own
// `updateModelRootRotation()` does. A single position value can't
// satisfy "pivot around the palm center" AND "keep the cut point exactly
// on the grid point" at the same time for an arbitrary rotation (they're
// 2 different points on the mesh) -- measured directly: an earlier
// version of this function DID preserve the palm-center pivot instead,
// and a combined Whole-Hand Rotation + Hide Wrist test showed a real,
// non-negligible 0.27-world-unit drift off the grid point (vs. exactly 0
// with Whole-Hand Rotation alone at 0). Since grid-alignment was the
// explicit, "main thing" request and palm-pivoting is a ported HANDO
// convenience rather than something asked for here, correctness was
// resolved in grid-alignment's favor. Trade-off, flagged to the user: with
// Hide Wrist > 0%, Whole-Hand Rotation now visibly pivots around the cut
// point instead of the palm center (at Hide Wrist = 0%, it pivots around
// the original forearm-base point instead -- also not the palm center,
// a behavior change from HANDO even in the DEFAULT case; revisit if a
// closer-to-HANDO pivot feel is wanted later).
const wholeHandRotQuat = new THREE.Quaternion()
const cloneBaseQuat = new THREE.Quaternion()
const _wholeHandRotEuler = new THREE.Euler()
const _cutPointRaw = new THREE.Vector3()
function updateClonePoseTransform() {
  if (!modelLoaded) return
  wholeHandRotQuat.setFromEuler(_wholeHandRotEuler.set(
    THREE.MathUtils.degToRad(cfg.modelRotX),
    THREE.MathUtils.degToRad(cfg.modelRotY),
    THREE.MathUtils.degToRad(cfg.modelRotZ)
  ))
  cloneBaseQuat.copy(alignQuat).multiply(wholeHandRotQuat)
  const scaleFactor = computeBaseScale()
  // The "cut wrist base" point, as an ABSOLUTE position in the mesh's own
  // raw/bind-pose frame -- linearly interpolated from the forearm-base
  // bone (t=0, clips nothing) to the wrist bone (t=1, clips the entire
  // forearm), matching updateWristClipPlaneForHand()'s own live version
  // of this same interpolation. Solved so THIS point always lands exactly
  // at this hand's own wrapper origin (its Field Layout grid point) for
  // the CURRENT cloneBaseQuat: worldOffset = clone.position +
  // scale*cloneBaseQuat.applied(cutPointRaw) must equal (0,0,0) -- solving
  // for clone.position gives the negative of the 2nd term directly, exact
  // for any rotation, not just identity.
  const hideT = cfg.hideWrist / 100
  _cutPointRaw.copy(forearmPosRaw).lerp(wristPosRaw, hideT)
  const finalPos = _cutPointRaw.clone().applyQuaternion(cloneBaseQuat).multiplyScalar(-scaleFactor)
  hands.forEach((hand) => {
    hand.clone.quaternion.copy(cloneBaseQuat)
    hand.clone.position.copy(finalPos)
  })
}
// Whole-Hand Rotation's own axes are re-expressed relative to
// cloneBaseQuat (see applyCurlToSkeleton()'s own `baseQuat` parameter) --
// changing modelRotX/Y/Z therefore requires BOTH updating the transform
// AND re-applying every finger's curl/splay with the new axis basis, or
// an already-posed finger would keep its OLD (now stale) rotation.
function onWholeHandRotationChange() {
  updateClonePoseTransform()
  applyAllFingerPoses()
}

// "Hide Wrist" clipping plane -- ported from HANDO's own wristClipPlane,
// but PER-HAND rather than a single global plane: every hand faces a
// different direction (pointing at the cursor), so each needs its own
// plane geometry, recomputed from that hand's own live wrist/forearm bone
// world positions right before it draws (`onBeforeRender`, the same
// per-hand mechanism already used for the depth-clear technique -- see
// rebuildField()). A single shared `THREE.Plane`, mutated in place
// immediately before each hand's own draw call, works correctly even
// though the fill/outline materials are shared across all 510 hands.
// `material.clippingPlanes` (not `renderer.clippingPlanes`) confines the
// clip to hand geometry only, so the cursor target marker/grid helper are
// never affected regardless of draw order.
const wristClipPlane = new THREE.Plane()
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
  const t = cfg.hideWrist / 100
  _clipPoint.copy(_clipFarPos).addScaledVector(_clipDir, armToWristDist * t)
  wristClipPlane.setFromNormalAndCoplanarPoint(_clipDir, _clipPoint)
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
  // Hide Wrist's own position compensation scales with hand scale, so any
  // relayout (spacing, rows/cols, hand scale itself) needs to recompute it
  // too, not just Pose-slider changes.
  updateClonePoseTransform()
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
    if (skinnedMesh && toonMaterial) skinnedMesh.material = toonMaterial
    const outlineMesh = skinnedMesh ? buildOutlineMesh(skinnedMesh) : null
    if (outlineMesh) clone.add(outlineMesh)
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
    const hand = { wrapper, clone, skinnedMesh, outlineMesh, effectiveRenderOrder: 0, screenX: 0, screenY: 0, screenRadius: 0 }
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
    // Also recomputes this hand's OWN Hide Wrist clip plane right before
    // it draws (see updateWristClipPlaneForHand()'s own comment) -- every
    // hand faces a different direction, so this can't be done once for
    // the whole shared material the way the fixed depth-clear can.
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
    window.__debug = { THREE, scene, camera, controls, renderer, composer, outlinePass, hands, cfg, sceneState, handLengthRaw, alignQuat, computeBaseScale, updateRenderOrder, cursorTarget }
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
  if (cfg.trackingEnabled) {
    hands.forEach((hand) => {
      const m = new THREE.Matrix4().lookAt(hand.wrapper.position, cursorTarget, UP)
      const desired = new THREE.Quaternion().setFromRotationMatrix(m)
      hand.wrapper.quaternion.slerp(desired, cfg.trackingDamping)
    })
  }
  updateRenderOrder()
  composer.render()
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
  hands.forEach((hand) => {
    const live = hand.wrapper.position.distanceTo(cursorTarget)
    hand.effectiveRenderOrder = (flashFixOn && hand.isOverlapping)
      ? hand.effectiveRenderOrder + (live - hand.effectiveRenderOrder) * REORDER_SMOOTHING
      : live
    if (hand.skinnedMesh) hand.skinnedMesh.renderOrder = hand.effectiveRenderOrder
    if (hand.outlineMesh) hand.outlineMesh.renderOrder = hand.effectiveRenderOrder - 0.001
  })
}
animate()
