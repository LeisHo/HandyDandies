// Top-level load check for src/main.js (added 2026-10-04 after a SECOND
// production outage of the same kind: a module-level `const` declared far
// below the top-level code that reads it -> temporal-dead-zone
// ReferenceError -> the whole module aborts -> no hands, no Pause button).
// `node --check` cannot see this (it is valid syntax, a RUNTIME error), and
// the local static server in this environment usually truncates main.js so
// the page can't be loaded to catch it either.
//
// This executes main.js's top level in a vm under permissive stubs for
// three.js / the DOM / devPanel.js. A ReferenceError from load order fires
// no matter what the stubs return, so it is reliably caught; the stubs do
// NOT catch genuine logic bugs, and async paths (onRestore ->
// restoreCustomClickFunctions(), the animation loop) are never reached.
//
// Usage:  node tests/top-level-load-check.js [path/to/main.js]
// Exit code 0 = reached the end of top level; 1 = threw (message printed).
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const file = process.argv[2] || path.join(__dirname, '..', 'src', 'main.js')
let src = fs.readFileSync(file, 'utf8').replace(/\r/g, '')
src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

function makeStub(name) {
  const fn = function () {}
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0
      if (p === 'then') return undefined
      if (p === 'length') return 0
      if (p === 'prototype') return t.prototype
      if (p === Symbol.iterator) return function* () {}
      return makeStub(name + '.' + String(p))
    },
    set() { return true },
    has() { return true },
    apply() { return makeStub(name + '()') },
    construct() { return makeStub('new ' + name) }
  })
}

const sandbox = {}
;['THREE', 'GLTFLoader', 'cloneSkeletal', 'OrbitControls', 'EffectComposer', 'RenderPass', 'OutlinePass', 'OutputPass', 'ShaderPass',
  'syncValue', 'organizeGroupSubgroups', 'refreshSelectOptions', 'refreshMultiSelectOptions', 'saveCurrentSettings', 'renderDynamicGroup',
  'createGroupElement', 'realDeviceClass', 'applyTextOverrides', 'setDevTextOverride', 'isDevRowVisible', 'setDevVisibility',
  'forEachDynamicDeviceDescendant', 'refreshRowDisplaysForEditingTab', 'window', 'document', 'navigator', 'performance',
  'localStorage', 'sessionStorage', 'location'].forEach((n) => { sandbox[n] = makeStub(n) })
sandbox.initDevPanel = () => new Proxy({}, { get: (t, p) => t[p], set: (t, p, v) => { t[p] = v; return true } })
Object.assign(sandbox, {
  console, Promise, URLSearchParams,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  requestAnimationFrame: () => 0, addEventListener: () => {},
  fetch: () => new Promise(() => {})
})
vm.createContext(sandbox)

try {
  vm.runInContext(src, sandbox, { filename: path.basename(file), timeout: 20000 })
  console.log('OK: reached the end of main.js top level')
} catch (e) {
  console.log('FAIL: ' + e.name + ': ' + e.message)
  console.log((e.stack || '').split('\n').slice(0, 4).join('\n'))
  process.exit(1)
}
