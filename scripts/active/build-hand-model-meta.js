// Writes data/processed/hand-models-meta.json: for every built-in .glb listed in HAND_MODEL_BUILTINS (src/main.js) its
// file size, triangle count and two dates, keyed by the exact `url` string main.js uses. The Hand Models, Loading Preview Model and Skeleton Model
// selectors (list-pickers) show size / triangles and sorts by the dates from this file.
//
//   node scripts/active/build-hand-model-meta.js
//
// Re-run it (and commit the JSON) after adding or re-exporting a model; a model missing from the file shows "-".
//   bytes     file size on disk
//   tris      triangles of the skinned meshes (sum of index count / 3 from the glTF JSON chunk; Draco files keep the real counts in their accessors), without the baked OUTLINE shell primitives and
//             without helper meshes such as a clipping block. A model that carries several versions of a mesh (HAND_STUBBINS*: sub-hands, "First Joint" copies) counts all of them.
//   modified  file modification time (fs mtime)
//   uploaded  first commit that added the file (git), else the file's creation time
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const src = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8')
const start = src.indexOf('const HAND_MODEL_BUILTINS = [')
const end = src.slice(start).search(/\r?\n\]\r?\n/) + start // the array ends at the first line that is just "]"
const block = src.slice(start, end)
const urls = Array.from(block.matchAll(/url:\s*'([^']+\.glb)'/g)).map((m) => m[1]) // the entries are one-liners: { id, name, url, source }

function glbJson(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(20)
    fs.readSync(fd, head, 0, 20, 0)
    if (head.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a glb')
    const len = head.readUInt32LE(12)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 20)
    return JSON.parse(buf.toString('utf8'))
  } finally { fs.closeSync(fd) }
}
function triangles(j) {
  // Only skinned meshes count (a clipping block / helper mesh is not the model), and a primitive whose material is called OUTLINE is skipped (the baked outline shell repeats the hand's triangles). A file with no
  // skinned mesh at all counts every mesh.
  let only = new Set((j.nodes || []).filter((n) => n.mesh !== undefined && n.skin !== undefined).map((n) => n.mesh))
  if (!only.size) only = new Set((j.meshes || []).map((_, i) => i))
  let t = 0
  ;(j.meshes || []).forEach((m, mi) => {
    if (!only.has(mi)) return
    for (const p of m.primitives || []) {
      const mat = p.material !== undefined && j.materials ? j.materials[p.material] : null
      if (mat && /outline/i.test(mat.name || '')) continue
      const mode = p.mode === undefined ? 4 : p.mode
      const acc = p.indices !== undefined ? j.accessors[p.indices] : j.accessors[p.attributes.POSITION]
      const n = acc.count
      if (mode === 4) t += Math.floor(n / 3)
      else if (mode === 5 || mode === 6) t += Math.max(0, n - 2)
    }
  })
  return t
}
function firstCommit(rel) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', rel], { cwd: root, encoding: 'utf8' }).trim()
    const lines = out.split(/\r?\n/).filter(Boolean)
    return lines.length ? lines[lines.length - 1] : null
  } catch (err) { return null }
}

const out = {}
const seen = new Set()
for (const url of urls) {
  if (seen.has(url)) continue
  seen.add(url)
  const rel = decodeURIComponent(url.replace(/^\.\.\//, ''))
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) { console.warn('missing: ' + rel); continue }
  const st = fs.statSync(file)
  let tris = null
  try { tris = triangles(glbJson(file)) } catch (err) { console.warn('no triangle count for ' + rel + ': ' + err.message) }
  out[url] = {
    bytes: st.size,
    tris,
    modified: st.mtime.toISOString(),
    uploaded: firstCommit(rel) || (st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime).toISOString()
  }
}
const dest = path.join(root, 'data', 'processed', 'hand-models-meta.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n')
console.log('wrote ' + Object.keys(out).length + ' models to ' + path.relative(root, dest))
