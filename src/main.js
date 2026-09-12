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
    // depthTest off (depthWrite stays on) -- per direct request, stacking
    // between DIFFERENT hands is driven entirely by renderOrder (set every
    // frame from each hand's own distance to the cursor target, see
    // animate()), not by each hand's real camera-depth. See that same
    // request's own note in animate() for the outline-vs-fill draw-order
    // consequence this has within a single hand.
    depthTest: false
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
      depthTest: false // see createToonMaterial()'s own note -- matches the fill material
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
// Field layout
// -----------------------------------------------------------------------
function computeBaseScale() {
  return (Math.min(cfg.rowSpacing, cfg.columnSpacing) * 0.8 / handLengthRaw) * cfg.handScale
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
    const wrapper = new THREE.Group()
    wrapper.add(clone)
    scene.add(wrapper)
    hands.push({ wrapper, clone, skinnedMesh, outlineMesh, effectiveRenderOrder: 0, screenX: 0, screenY: 0, screenRadius: 0 })
  }
  relayoutField()
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
const projectScratch = new THREE.Vector3()
// "Prevent Reordering Flash": approximates each hand's on-screen footprint
// as a circle (world radius = half the measured hand length, projected to
// screen pixels via standard perspective scaling) since a precise
// silhouette-vs-silhouette overlap test isn't cheap to do every frame for
// a whole field of arbitrarily-rotated meshes. Good enough to catch "these
// 2 are visually fighting for the same pixels," which is the actual
// problem being solved -- not pixel-perfect, and disclosed as such.
function updateRenderOrder() {
  const flashFixOn = cfg.preventReorderFlash
  if (flashFixOn) {
    const vFov = THREE.MathUtils.degToRad(camera.fov)
    const canvasHeight = renderer.domElement.clientHeight || window.innerHeight
    const canvasWidth = renderer.domElement.clientWidth || window.innerWidth
    const worldRadius = handLengthRaw * 0.5
    hands.forEach((hand) => {
      const distToCamera = camera.position.distanceTo(hand.wrapper.position)
      const worldHeightAtDist = 2 * Math.tan(vFov / 2) * Math.max(distToCamera, 0.001)
      const pxPerWorldUnit = canvasHeight / worldHeightAtDist
      hand.screenRadius = worldRadius * hand.clone.scale.x * pxPerWorldUnit
      projectScratch.copy(hand.wrapper.position).project(camera)
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
    const dist = hand.wrapper.position.distanceTo(cursorTarget)
    // Live-update the effective order UNLESS the flash-fix is on AND this
    // hand is currently overlapping another one -- in that case, keep
    // whatever order it already had (frozen) until it clears every
    // overlap it's currently in, per direct request.
    if (!flashFixOn || !hand.isOverlapping) hand.effectiveRenderOrder = dist
    if (hand.skinnedMesh) hand.skinnedMesh.renderOrder = hand.effectiveRenderOrder
    if (hand.outlineMesh) hand.outlineMesh.renderOrder = hand.effectiveRenderOrder - 0.01
  })
}
animate()
