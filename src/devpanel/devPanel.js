// Generic dev-panel engine -- implements CLAUDE.md's project-wide Section 12
// standard (12a-12h): gated visibility, resize/move/hide/collapse, Copy/Save/
// Reset, reorderable groups/settings, click-to-type auto-expanding sliders,
// and (12f) separate Desktop/Mobile/Landscape tabs where a setting is either
// shared across all 3 or independently valued per device. Adapted from DICKOCLICKO's
// reference implementation (index.html) -- same DOM/CSS class names (dp-*) so
// the CSS block in style.css can be reused near-verbatim; built via JS DOM
// construction here instead of static HTML since this is a multi-file Vite
// app, not a single-file page.
//
// Each control in a group's `controls` array may set `perDevice: true` to get
// an independent value per Desktop/Mobile/Landscape tab (§12f) -- omit/false
// for a value shared across all 3 (the default). `cfg` is a live,
// mutated-in-place plain object -- other modules import `{ cfg }` and read
// current values directly; cfg[key] always reflects the value for the ACTUAL
// running device (matchMedia), not whichever tab happens to be open in the
// panel for editing -- editing the "other" device's tab previews/stores a
// value for that device without touching what's currently on screen. cfg is
// populated from each control's own `def` regardless of DEV_MODE, so the
// tuned defaults apply for every visitor; DEV_MODE only gates whether the
// tuning UI itself is shown.

export const DEV_MODE = (
  location.protocol === 'file:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  new URLSearchParams(location.search).get('dev') === '1'
)

export const cfg = {}

let devGroups = []
let storageKeyPrefix = 'devPanel'
// Text Edit Mode (CLAUDE.md-adjacent, ported from TEMPLATE_DEV_PANEL.html's
// own "Enable Label Rename Mode" checkbox): while enabled, clicking a group
// title or a setting's label opens an inline rename instead of its normal
// action (collapse-toggle / nothing). `textOverrides` is keyed by the
// control's own stable `key` (or a group's own stable `dataset.key`, its
// original title) -- unlike the template, HANDO's rows/groups already carry
// a stable identity separate from their displayed text, so no DOM-based key
// lookup is needed the way the template's own getSectionKey/getDevLabelKey
// were for its static-HTML structure.
let textEditModeEnabled = false
let textOverrides = {}
const numEls = {} // key -> { slider, numInput } | { type: 'color' } | { type: 'checkbox' }
// Set by initDevPanel()'s own saveSettings() closure (see its own comment) so
// the exported saveCurrentSettings() below can trigger a real persisted save.
let saveSettingsRef = null
// §12f: 3 device profiles, not 2 -- Landscape is a phone/tablet held
// sideways, a distinct profile from portrait Mobile, not merely a resize of
// it. DEVICES is the single source of truth every desktop/mobile-pair spot
// below loops over, so adding/renaming a device profile only ever touches
// this one array plus realDeviceClass()'s own classification logic.
const DEVICES = ['desktop', 'mobile', 'landscape']
const store = { desktop: {}, mobile: {}, landscape: {} } // per-device value store; shared controls are kept identical across all 3
let editingDevice = 'desktop' // which tab the panel UI is currently showing/editing

function round(v, d) {
  const m = Math.pow(10, d)
  return Math.round(v * m) / m
}

function settingsKey() { return `${storageKeyPrefix}.devSettings` }
function geomKeyPrefix() { return `${storageKeyPrefix}.devPanelGeom.` }
function savedStatesKey() { return `${storageKeyPrefix}.devSavedStates` }
// Landscape vs. Mobile is an orientation call, not a separate breakpoint --
// CLAUDE.md's own §12f text doesn't specify an exact rule, so this is a
// disclosed judgment call (matching ADA BATHROOM/DICKOCLICKO's own same-
// week choice for this exact generalization): once the viewport's SHORTER
// dimension drops under 768px, it's a phone/tablet-scale device -- Mobile
// if it's currently taller than wide (portrait), Landscape if wider than
// tall. A screen where even the shorter dimension is >=768px is Desktop
// regardless of aspect ratio.
function realDeviceClass() {
  const w = window.innerWidth, h = window.innerHeight
  if (Math.min(w, h) >= 768) return 'desktop'
  return w > h ? 'landscape' : 'mobile'
}
function currentGeomKey() { return geomKeyPrefix() + realDeviceClass() }

function el(tag, className, attrs) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (attrs) Object.entries(attrs).forEach(([k, v]) => { node[k] = v })
  return node
}

function findCtrl(key) {
  for (const group of devGroups) {
    const ctrl = group.controls.find((c) => c.key === key)
    if (ctrl) return ctrl
  }
  return null
}

// Writes a value into the store (both device slots if the control is
// shared) and, only when the change is actually visible on the CURRENT real
// device, updates the live `cfg` and fires the control's onChange.
function commit(ctrl, v) {
  if (ctrl.perDevice) {
    store[editingDevice][ctrl.key] = v
  } else {
    DEVICES.forEach((d) => { store[d][ctrl.key] = v })
  }
  if (!ctrl.perDevice || editingDevice === realDeviceClass()) {
    cfg[ctrl.key] = v
    if (ctrl.onChange) ctrl.onChange(v)
  }
}

// Repopulates one row's displayed value from the store for `device`, without
// committing/firing onChange -- used when switching tabs or loading a Reset,
// where the value shown needs to change but nothing should fire live effects
// unless it's actually the real device's own value.
function displayValue(ctrl, v) {
  const entry = numEls[ctrl.key]
  if (!entry) return
  if (ctrl.type === 'color') {
    const input = document.querySelector(`.dp-row[data-key="${CSS.escape(ctrl.key)}"] input[type=color]`)
    if (input) input.value = v
  } else if (ctrl.type === 'checkbox') {
    const input = document.querySelector(`.dp-row[data-key="${CSS.escape(ctrl.key)}"] input[type=checkbox]`)
    if (input) input.checked = v
  } else if (ctrl.type === 'text') {
    if (entry.input) entry.input.value = v
  } else if (ctrl.type === 'list-picker') {
    entry.items = (v || []).slice()
    entry.selectedItem = null
    // A pending (still-empty) group only exists in this render's own
    // in-memory state -- an externally-driven value refresh (Reset, tab
    // switch, remote restore) is a new source of truth, so anything not
    // backed by a real item's own .group field is correctly dropped here,
    // matching renderListPickerRows()'s own documented "doesn't survive a
    // reload while empty" behavior. Collapsed state is likewise session-
    // local (not persisted), so it isn't reset here -- keeping a group's
    // current expand/collapse across a background resync is the more
    // useful default and costs nothing since it just reads from the Set.
    entry.pendingGroups = []
    renderListPickerRows(entry)
  } else if (ctrl.type === 'select') {
    fillSelectOptions(ctrl, entry.select, v)
  } else if (ctrl.type === 'multi-select') {
    entry.values = (v || []).slice()
    renderMultiSelectRows(entry)
  } else if (entry.slider) {
    if (v > parseFloat(entry.slider.max)) entry.slider.max = v
    if (v < parseFloat(entry.slider.min)) entry.slider.min = v
    entry.slider.value = v
    entry.numInput.value = round(v, 3)
  }
}

// Pushes a value the HOST APP derived on its own (not from a user edit --
// e.g. a camera position tracked every frame from mouse-driven orbit/pan/
// zoom) into the store, live `cfg`, and the visible row, WITHOUT calling
// onChange -- the host is already the source of truth for that value, so
// firing onChange back at it would be redundant, and could even fight it
// (a live-tracked slider re-triggering the very code that's already
// setting it). Skips silently while the row's own input has focus, so it
// doesn't fight a user mid-drag/mid-type on that same control.
export function syncValue(key, v) {
  const ctrl = findCtrl(key)
  if (!ctrl) return
  const entry = numEls[key]
  if (entry && (document.activeElement === entry.slider || document.activeElement === entry.numInput)) return
  if (ctrl.perDevice) {
    if (editingDevice !== realDeviceClass()) return // don't clobber the OTHER device's own tab while it's being edited
    store[editingDevice][key] = v
  } else {
    DEVICES.forEach((d) => { store[d][key] = v })
  }
  cfg[key] = v
  displayValue(ctrl, v)
}

// Rebuilds entry.items (order + each item's .group) from the LIVE DOM after
// a drag-drop -- see setupReorder()'s own onDrop param. Ungrouped items
// (sitting directly in entry.ungroupedBody) always serialize first, then
// each .dp-lp-group in its current DOM order contributes its own rows with
// .group set to that group's name. Item identity is tracked via each row's
// own row.__item reference (set at render time), not by index -- indices
// are exactly what a reorder invalidates.
const LP_GROUP_PATH_SEP = '/'
//
// A group's full identity is a "/"-joined path (LP_GROUP_PATH_SEP) stored
// directly in item.group -- "Parent" for a top-level group, "Parent/Child"
// for a group nested one level inside it (the same one-level cap the outer
// settings panel's own groups already use, and for the same reason: it
// keeps this a flat string on each item rather than a second, separately-
// persisted tree structure to keep in sync).
function syncListPickerFromDom(entry) {
  const items = []
  const pending = []
  Array.from(entry.ungroupedBody.querySelectorAll(':scope > .dp-list-picker-row')).forEach((r) => {
    const it = r.__item
    if (!it) return
    delete it.group
    items.push(it)
  })
  Array.from(entry.listEl.querySelectorAll(':scope > .dp-lp-group')).forEach((g) => {
    const path = g.__groupName
    const directRows = g.querySelectorAll(':scope > .dp-lp-group-body > .dp-list-picker-row')
    directRows.forEach((r) => {
      const it = r.__item
      if (!it) return
      it.group = path
      items.push(it)
    })
    if (directRows.length === 0) pending.push(path)
    // One level of nesting only -- a subgroup's own rows get the joined
    // "Parent/Child" path; a subgroup can never itself contain a further
    // subgroup (setupReorder's own getTargets, in buildListPickerRow,
    // refuses to offer a group that already HAS subgroups as a nesting
    // target, so this can't arise from a real drag).
    g.querySelectorAll(':scope > .dp-lp-group-body > .dp-lp-group').forEach((sub) => {
      const subPath = path + LP_GROUP_PATH_SEP + sub.__groupName.split(LP_GROUP_PATH_SEP).pop()
      const subRows = sub.querySelectorAll(':scope > .dp-lp-group-body > .dp-list-picker-row')
      subRows.forEach((r) => {
        const it = r.__item
        if (!it) return
        it.group = subPath
        items.push(it)
      })
      if (subRows.length === 0) pending.push(subPath)
    })
  })
  entry.items = items
  entry.pendingGroups = pending
  commit(entry.ctrl, entry.items)
}

// Renders one item row (used both for ungrouped items and items inside a
// group body) -- click toggles selection (tracked by object reference,
// entry.selectedItem, not index, since drag-reorder makes indices
// unstable); the small drag handle is a SEPARATE hit-target from the rest
// of the row (setupReorder only starts a drag from '.dp-lp-row-handle'),
// so tapping the row body still just selects it.
function renderListPickerItemRow(entry, item) {
  const row = el('div', 'dp-list-picker-row' + (item === entry.selectedItem ? ' dp-list-picker-row-selected' : ''))
  row.appendChild(el('span', 'dp-lp-row-handle', { textContent: '⠿' }))
  // Export checkbox -- opt-in per control (ctrl.exportable), so only a
  // picker that actually wants cross-project export (HANDO's own
  // savedPoses, for exporting into HANDY DANDIES) grows this UI; every
  // other picker (Cameras/Lighting/Toon/Tween Sequences, and HANDY
  // DANDIES' own savedPoses, which only ever IMPORTS) renders unchanged.
  // Checked state lives in entry.exportChecked (a Set of item object
  // references, like entry.selectedItem/collapsedGroups) rather than on
  // the item itself -- it's transient UI state, not something that should
  // ever get serialized into the saved/exported data.
  if (entry.ctrl.exportable) {
    const checkbox = el('input', 'dp-lp-export-checkbox', { type: 'checkbox', checked: entry.exportChecked.has(item) })
    checkbox.addEventListener('click', (e) => e.stopPropagation())
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) entry.exportChecked.add(item)
      else entry.exportChecked.delete(item)
    })
    row.appendChild(checkbox)
  }
  row.appendChild(el('span', 'dp-lp-row-label', { textContent: item.name }))
  row.__item = item
  // Direct user report, 2026-09-11: on mobile, tapping a name and hitting
  // "Use" applied a DIFFERENT (adjacent) saved item's data, even though
  // the tapped name displayed correctly. Root cause: this used to call
  // the full renderListPickerRows(entry) again on every row click, which
  // tears down and recreates EVERY row's DOM element via innerHTML=''.
  // iOS Safari's first touch on a freshly-created element often only
  // registers as hover/focus, not a real click -- since every tap
  // rebuilt the whole list, every subsequent tap was hitting a "new"
  // element and silently failing to register, leaving the selection
  // stuck on whatever was selected before (Use then applied THAT stale
  // item while the just-tapped name sat correctly on screen). Fixed by
  // never destroying rows for a plain selection change -- only toggling
  // the highlight class on the existing, already-touched elements.
  row.addEventListener('click', () => {
    entry.selectedItem = item
    entry.listEl.querySelectorAll('.dp-list-picker-row').forEach((r) => {
      r.classList.toggle('dp-list-picker-row-selected', r.__item === item)
    })
  })
  return row
}

// Builds one group's header (used for both a top-level group and a nested
// subgroup -- `path` is that group's FULL path, e.g. "Parent" or
// "Parent/Child"; the displayed title is just its own last segment).
// Direct user request: rename (click the title text) and remove (the "x",
// stopPropagation'd so it doesn't also toggle collapse). Renaming a group
// that has its own subgroup(s) renames their shared path PREFIX too, so
// "Parent" -> "Renamed" turns "Parent/Child" into "Renamed/Child" -- for a
// leaf/nested group this prefix pass is simply a no-op (nothing else
// starts with its own exact path plus a separator).
function buildGroupHeader(entry, path) {
  const header = el('div', 'dp-lp-group-header')
  header.appendChild(el('span', 'dp-lp-group-handle', { textContent: '⠿' }))
  header.appendChild(el('span', 'arrow', { textContent: '▼' }))
  const titleSpan = el('span', 'dp-lp-group-title', { textContent: path.split(LP_GROUP_PATH_SEP).pop() })
  titleSpan.addEventListener('click', (e) => {
    e.stopPropagation()
    const oldLeaf = path.split(LP_GROUP_PATH_SEP).pop()
    const newLeaf = prompt('Rename group to:', oldLeaf)
    if (!newLeaf || newLeaf === oldLeaf) return
    if (newLeaf.includes(LP_GROUP_PATH_SEP)) { alert(`Group name can't contain "${LP_GROUP_PATH_SEP}"`); return }
    const segments = path.split(LP_GROUP_PATH_SEP)
    segments[segments.length - 1] = newLeaf
    const newPath = segments.join(LP_GROUP_PATH_SEP)
    const prefix = path + LP_GROUP_PATH_SEP
    const rename = (p) => (p === path ? newPath : (p.startsWith(prefix) ? newPath + LP_GROUP_PATH_SEP + p.slice(prefix.length) : p))
    entry.items.forEach((it) => { if (it.group) it.group = rename(it.group) })
    entry.pendingGroups = (entry.pendingGroups || []).map(rename)
    if (entry.collapsedGroups.has(path)) { entry.collapsedGroups.delete(path); entry.collapsedGroups.add(newPath) }
    commit(entry.ctrl, entry.items)
    renderListPickerRows(entry)
  })
  header.appendChild(titleSpan)
  const removeBtn = el('button', 'dp-lp-group-remove', { type: 'button', textContent: '×' })
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Reads entry.items directly (the live, current membership) rather
    // than a closure captured when this row was rendered -- a live drag
    // (setupReorder's onDrop -> syncListPickerFromDom) can add/remove this
    // group's members WITHOUT re-rendering the picker, which would leave
    // such a closure silently stale (confirmed live: removing a group
    // right after dragging a NEW item into it left that item still
    // assigned to the just-"removed" group). Exact-path match only --
    // removing "Parent" ungroups just Parent's own direct items, never
    // cascades into a "Parent/Child" subgroup's own members.
    entry.items.forEach((it) => { if (it.group === path) delete it.group })
    entry.pendingGroups = (entry.pendingGroups || []).filter((p) => p !== path)
    entry.collapsedGroups.delete(path)
    commit(entry.ctrl, entry.items)
    renderListPickerRows(entry)
  })
  header.appendChild(removeBtn)
  header.addEventListener('click', () => {
    const g = header.closest('.dp-lp-group')
    g.classList.toggle('collapsed')
    if (g.classList.contains('collapsed')) entry.collapsedGroups.add(path)
    else entry.collapsedGroups.delete(path)
  })
  return header
}

// Redraws a 'list-picker' control's item list from entry.items (grouped
// per each item's own .group field), highlighting entry.selectedItem.
// Called after Save/Rename/Delete/Overwrite/+Group and by displayValue (on
// Reset / tab switch / any host-driven syncValue push) -- NOT called after
// a drag-drop, which resyncs entry.items from the already-correct DOM
// instead (see syncListPickerFromDom above) rather than rebuilding it.
//
// Direct user request: let a list-picker's own items be organized into
// user-created groups (drag items into them, one level of NESTED groups
// too -- same cap as the outer settings panel's own groups) and freely
// reordered, the same way the outer settings-panel's own groups/rows
// already work (setupReorder, reused as-is -- see its own comment for why
// it's generic enough to cover this without modification beyond the
// onDrop param). Ungrouped items always render first, directly in the
// list (no header); groups render below as their own collapsible sub-
// sections, with any subgroups nested one level inside their own body. A
// group with 0 items still renders (entry.pendingGroups) so a freshly-
// created empty group has something to drag an item into -- it simply
// won't survive a reload if it's still empty at Save time (its existence
// isn't persisted separately from its members' own .group field, only
// inferred from them).
function renderListPickerRows(entry) {
  entry.listEl.innerHTML = ''
  // One-level tree: top[name] = { items, subs: { subName: { items } }, subOrder }
  const top = {}
  const topOrder = []
  const ungrouped = []
  function ensureTop(name) {
    if (!top[name]) { top[name] = { items: [], subs: {}, subOrder: [] }; topOrder.push(name) }
    return top[name]
  }
  entry.items.forEach((item) => {
    if (!item.group) { ungrouped.push(item); return }
    const segs = item.group.split(LP_GROUP_PATH_SEP)
    const t = ensureTop(segs[0])
    if (segs.length > 1) {
      const subName = segs.slice(1).join(LP_GROUP_PATH_SEP)
      if (!t.subs[subName]) { t.subs[subName] = { items: [] }; t.subOrder.push(subName) }
      t.subs[subName].items.push(item)
    } else {
      t.items.push(item)
    }
  })
  ;(entry.pendingGroups || []).forEach((path) => {
    const segs = path.split(LP_GROUP_PATH_SEP)
    const t = ensureTop(segs[0])
    if (segs.length > 1) {
      const subName = segs.slice(1).join(LP_GROUP_PATH_SEP)
      if (!t.subs[subName]) { t.subs[subName] = { items: [] }; t.subOrder.push(subName) }
    }
  })

  const ungroupedBody = el('div', 'dp-lp-ungrouped-body')
  ungrouped.forEach((item) => ungroupedBody.appendChild(renderListPickerItemRow(entry, item)))
  entry.listEl.appendChild(ungroupedBody)
  entry.ungroupedBody = ungroupedBody

  topOrder.forEach((name) => {
    const t = top[name]
    const g = el('div', 'dp-lp-group' + (entry.collapsedGroups.has(name) ? ' collapsed' : ''))
    g.__groupName = name
    g.appendChild(buildGroupHeader(entry, name))
    const body = el('div', 'dp-lp-group-body')
    t.items.forEach((item) => body.appendChild(renderListPickerItemRow(entry, item)))
    t.subOrder.forEach((subName) => {
      const subPath = name + LP_GROUP_PATH_SEP + subName
      const sg = el('div', 'dp-lp-group' + (entry.collapsedGroups.has(subPath) ? ' collapsed' : ''))
      sg.__groupName = subPath
      sg.appendChild(buildGroupHeader(entry, subPath))
      const subBody = el('div', 'dp-lp-group-body')
      t.subs[subName].items.forEach((item) => subBody.appendChild(renderListPickerItemRow(entry, item)))
      sg.appendChild(subBody)
      body.appendChild(sg)
    })
    g.appendChild(body)
    entry.listEl.appendChild(g)
  })
}

// A plain dropdown whose OPTION LIST is host-supplied and can change at
// runtime (e.g. "pick one of the currently saved poses") -- `ctrl.options`
// is a function returning an array of strings, called fresh every time
// this runs rather than once at construction, since the underlying list
// (another control's own value elsewhere in the panel) can grow/shrink
// after this row is already built. Preserves the current selection if
// it's still a valid option; falls back to the first option otherwise
// (or '' if the list is empty) rather than silently keeping a now-stale
// value selected.
function fillSelectOptions(ctrl, select, preferredValue) {
  // `ctrl.options()` can be called from `displayValue()` during the
  // host's own restore-from-storage step, which (per the TDZ note on the
  // 'select' branch of buildRow() above) can run before a host binding
  // the closure reads is safely initialized. Caught and treated as "no
  // options yet" rather than letting it propagate -- the host's own
  // later explicit `refreshSelectOptions()` call re-populates for real
  // once its own init has genuinely finished.
  let options = []
  try { options = (ctrl.options ? ctrl.options() : []) || [] } catch (err) { options = [] }
  select.innerHTML = ''
  options.forEach((opt) => select.appendChild(el('option', null, { value: opt, textContent: opt })))
  const next = options.includes(preferredValue) ? preferredValue : (options[0] || '')
  select.value = next
  return next
}
// Triggers a real persisted save (the same localStorage/remote write the
// panel's own Save/Sync button performs) programmatically -- e.g. for a
// host-app "set this as the startup default" action where waiting for
// the user to separately click Save would be the wrong UX. No-ops if
// initDevPanel() hasn't finished setting up saveSettingsRef yet, or if
// DEV_MODE is off (no panel, no save button, nothing to trigger).
export function saveCurrentSettings() {
  if (saveSettingsRef) saveSettingsRef()
}
// Call after the underlying option list changes (e.g. a 'list-picker'
// control's own onChange, once a Save/Delete alters what should be
// selectable elsewhere) to rebuild a 'select' control's <option> list
// in place. Re-commits the resulting value (which may differ from
// before, if the previous selection no longer exists) so `cfg` and any
// dependent onChange stay consistent with what's actually shown.
export function refreshSelectOptions(key) {
  const ctrl = findCtrl(key)
  const entry = numEls[key]
  if (!ctrl || !entry || entry.type !== 'select') return
  const next = fillSelectOptions(ctrl, entry.select, cfg[key])
  commit(ctrl, next)
}

// A growable/shrinkable LIST of 'select' dropdowns (e.g. "an ordered
// sequence of saved poses to tween through, add as many as you want") --
// cfg[key] is an array of strings, one per row, in order. Distinct from
// 'list-picker' (which manages a list of NAMED, independently
// Save/Use/Delete-able snapshots) -- this is a single control's own
// value being an array, with rows added/removed directly, no separate
// Save/Use step. Shares `fillSelectOptions()` with plain 'select' so
// both stay consistent (same TDZ-safe try/catch, same "preserve current
// value if still valid, else fall back to the first option" behavior).
function renderMultiSelectRows(entry) {
  const { ctrl, listEl, values } = entry
  listEl.innerHTML = ''
  values.forEach((val, i) => {
    const rowEl = el('div', 'dp-multi-select-row')
    // Drag handle, own dedicated element (never the row/select itself) --
    // same §12e convention as '.dp-lp-row-handle'/'.dp-row-handle':
    // reordering starts only from this icon, so clicking the dropdown or
    // Remove is never mistaken for a drag.
    const handle = el('span', 'dp-ms-row-handle', { textContent: '⠿' })
    const select = el('select')
    values[i] = fillSelectOptions(ctrl, select, val)
    select.addEventListener('change', () => {
      values[i] = select.value
      commit(ctrl, values.slice())
    })
    const removeBtn = el('button', 'dp-action-button', { type: 'button', textContent: 'Remove' })
    removeBtn.addEventListener('click', () => {
      values.splice(i, 1)
      commit(ctrl, values.slice())
      renderMultiSelectRows(entry)
    })
    rowEl.append(handle, select, removeBtn)
    listEl.appendChild(rowEl)
  })
}
function buildMultiSelectRow(ctrl, row) {
  const listEl = el('div', 'dp-multi-select-list')
  const addBtn = el('button', 'dp-action-button', { type: 'button', textContent: '+ Add' })
  row.appendChild(listEl)
  row.appendChild(addBtn)
  const entry = { type: 'multi-select', ctrl, listEl, values: (ctrl.def || []).slice() }
  numEls[ctrl.key] = entry
  addBtn.addEventListener('click', () => {
    let options = []
    try { options = (ctrl.options ? ctrl.options() : []) || [] } catch (err) { options = [] }
    entry.values.push(options[0] || '')
    commit(ctrl, entry.values.slice())
    renderMultiSelectRows(entry)
  })
  // Same TDZ caveat as plain 'select' (see its own buildRow case comment)
  // applies here via fillSelectOptions()'s own try/catch -- this initial
  // render may show 0 options per row until the host's later explicit
  // `refreshMultiSelectOptions()` call, once its own init has finished.
  renderMultiSelectRows(entry)
  // Drag-to-reorder -- reuses the SAME generic setupReorder() the list-
  // picker's own rows/groups already use (§12e: reorder only from the
  // handle icon). Only one container (this list is always flat, no
  // nesting like list-picker groups), so getTargets is just [listEl].
  // `entry.values` isn't DOM-order-derived during a render (it's the
  // array renderMultiSelectRows() walks to BUILD the DOM), so once a drag
  // genuinely drops, resync it from the now-reordered <select> elements'
  // own current values rather than assuming index i still matches.
  setupReorder(listEl, 'dp-multi-select-row', 'dp-ms-row-handle', () => [listEl], () => {
    entry.values = Array.from(listEl.querySelectorAll('.dp-multi-select-row select')).map((s) => s.value)
    commit(ctrl, entry.values.slice())
  })
}
// Call after the underlying option list changes (mirrors
// refreshSelectOptions() for the single-'select' case) -- re-resolves
// every row's own selection against the fresh option list and re-commits
// the resulting array.
export function refreshMultiSelectOptions(key) {
  const entry = numEls[key]
  if (!entry || entry.type !== 'multi-select') return
  renderMultiSelectRows(entry)
  commit(entry.ctrl, entry.values.slice())
}

function buildRow(ctrl) {
  // Section 12j: no descriptive text/tooltips beyond the label itself --
  // dp-per-device is a plain CSS class (a color cue, not added text) so a
  // per-device setting is still visually distinguishable without prose.
  const row = el('div', 'dp-row' + (ctrl.perDevice ? ' dp-per-device' : ''))
  row.dataset.key = ctrl.key
  // Its own class, deliberately NOT also 'dp-drag-handle' -- that class is
  // reserved for a GROUP's own handle. Sharing it used to make grabbing a
  // row's handle also satisfy the group-reorder listener's own selector
  // (both listen on the same ancestor, groupsEl, and neither stops
  // propagation), starting a group-drag and a row-drag at the same time.
  const handle = el('span', 'dp-row-handle', { textContent: '⠿' })
  row.appendChild(handle)
  // A standalone action button (§12n's test/utility-button pattern) has no
  // value of its own to label separately -- its own text IS the label, so
  // the generic label span is skipped only for this one type.
  if (ctrl.type !== 'button') {
    const label = el('label', null, { textContent: ctrl.label })
    row.appendChild(label)
  }

  if (ctrl.type === 'button') {
    const btn = el('button', 'dp-action-button', { type: 'button', textContent: ctrl.label })
    btn.addEventListener('click', () => { if (ctrl.onClick) ctrl.onClick(btn) })
    row.appendChild(btn)
    numEls[ctrl.key] = { type: 'button' }
  } else if (ctrl.type === 'color') {
    const color = el('input', null, { type: 'color', value: ctrl.def })
    color.addEventListener('input', () => commit(ctrl, color.value))
    row.appendChild(color)
    numEls[ctrl.key] = { type: 'color' }
  } else if (ctrl.type === 'checkbox') {
    const cbox = el('input', null, { type: 'checkbox', checked: !!ctrl.def })
    cbox.addEventListener('change', () => commit(ctrl, cbox.checked))
    row.appendChild(cbox)
    numEls[ctrl.key] = { type: 'checkbox' }
  } else if (ctrl.type === 'text') {
    // A plain free-text string value -- distinct from a slider's own
    // `.dp-num` readout (also `type=text`, but numeric-only and narrow);
    // this one is unrestricted text, sized to actually hold a real string.
    const input = el('input', 'dp-text-input', { type: 'text', value: ctrl.def || '' })
    input.addEventListener('input', () => commit(ctrl, input.value))
    row.appendChild(input)
    numEls[ctrl.key] = { type: 'text', input }
  } else if (ctrl.type === 'list-picker') {
    row.style.flexDirection = 'column'
    row.style.alignItems = 'stretch'
    buildListPickerRow(ctrl, row)
  } else if (ctrl.type === 'multi-select') {
    row.style.flexDirection = 'column'
    row.style.alignItems = 'stretch'
    buildMultiSelectRow(ctrl, row)
  } else if (ctrl.type === 'select') {
    const select = el('select')
    select.addEventListener('change', () => commit(ctrl, select.value))
    row.appendChild(select)
    numEls[ctrl.key] = { type: 'select', select }
    // Deliberately does NOT call `ctrl.options()` here: buildRow() runs
    // synchronously inside the host's own `initDevPanel()` call, often
    // while the host is still assigning ITS OWN `cfg`-like binding from
    // that same call's return value -- an `options()` closure that reads
    // such a binding (e.g. "list every currently saved preset name") would
    // hit that binding's temporal dead zone right here and throw, exactly
    // the class of bug this engine's own host (main.js) already documents
    // hitting for onChange (see its own "Cannot access 'cfg' before
    // initialization" comment). Every other control type with a host-
    // supplied callback (list-picker's captureCurrent/onUse, button's
    // onClick) is the same way -- stored, but only ever INVOKED later, on
    // a real user action, never during construction. Left with no options
    // until the host explicitly calls the exported `refreshSelectOptions()`
    // once its own initialization has genuinely finished.
  } else {
    // slider (default type)
    const slider = el('input', null, { type: 'range', min: ctrl.min, max: ctrl.max, step: ctrl.step, value: ctrl.def })
    const numInput = el('input', 'dp-num', { type: 'text', value: ctrl.def })

    function apply(v) {
      v = parseFloat(v)
      if (isNaN(v)) return
      const mn = parseFloat(slider.min), mx = parseFloat(slider.max)
      if (ctrl.lockRange) {
        // Direct request, explicitly overriding Section 12h's normal
        // auto-expand for this control: a typed value beyond the bound
        // clamps to it instead of widening the slider's own range.
        v = Math.min(Math.max(v, mn), mx)
      } else {
        // Section 12h: typing beyond the current bound expands that bound
        // (typed value +/- 20%), not just a visual clamp of the slider handle.
        if (v > mx) slider.max = v + Math.max(Math.abs(v), Math.abs(mx - mn), 1) * 0.2
        if (v < mn) slider.min = v - Math.max(Math.abs(v), Math.abs(mx - mn), 1) * 0.2
      }
      slider.value = v
      numInput.value = round(v, 3)
      commit(ctrl, v)
    }
    slider.addEventListener('input', () => apply(slider.value))
    numInput.addEventListener('change', () => apply(numInput.value))
    numInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') numInput.blur() })

    row.appendChild(slider)
    row.appendChild(numInput)
    numEls[ctrl.key] = { slider, numInput }
  }
  return row
}

// A named-item picker (e.g. saved camera views): a scrollable list plus
// Save/Use/Rename/Delete buttons. Fully generic -- Save prompts for a name
// and calls ctrl.captureCurrent() (host-supplied) to snapshot whatever state
// the control represents; Use calls ctrl.onUse(item) with the selected
// item; Rename prompts for a new name and updates the item in place, keeping
// its saved data untouched; Delete just removes it from the array. The array
// itself (cfg[ctrl.key]) rides through the same store/Copy/Save/Reset
// pipeline as any other control's value -- no special-casing needed there.
// Ported from OKCILCOKCID's own single-file camera-preset UI
// (saveCameraPreset()/useCameraPreset()/deleteCameraPreset()), generalized
// here so devPanel.js stays camera-agnostic and any future saved-state
// picker can reuse it -- Rename (direct user request, "add the ability to
// rename any saved states") applies to every existing list-picker (Camera/
// Pose/Lighting/Toon Shading presets) with no per-project changes needed.
function buildListPickerRow(ctrl, row) {
  row.classList.add('dp-list-picker-row-container')
  const listEl = el('div', 'dp-list-picker')
  const btnRow = el('div', 'dp-list-picker-actions')
  const saveBtn = el('button', null, { type: 'button', textContent: 'Save' })
  const overwriteBtn = el('button', null, { type: 'button', textContent: 'Overwrite' })
  const useBtn = el('button', null, { type: 'button', textContent: 'Use' })
  const renameBtn = el('button', null, { type: 'button', textContent: 'Rename' })
  const deleteBtn = el('button', null, { type: 'button', textContent: 'Delete' })
  const addGroupBtn = el('button', null, { type: 'button', textContent: '+ Group' })
  btnRow.append(saveBtn, overwriteBtn, useBtn, renameBtn, deleteBtn, addGroupBtn)
  // Cross-project pose export/import (direct user request): export ships
  // whatever's CHECKED (entry.exportChecked) as a plain JSON array to the
  // clipboard -- the exact same navigator.clipboard pattern the panel's
  // own "Copy Settings" button already uses, so no new transport/backend
  // is needed. Import reads the clipboard back and MERGES by name (same-
  // name item overwrites in place, everything else untouched) using the
  // same "overwrite if the name already exists" rule Save's own button
  // already applies -- never wipes the rest of the list. Both are opt-in
  // per control (ctrl.exportable/ctrl.importable) since only HANDO's own
  // savedPoses control exports and only HANDY DANDIES' own savedPoses
  // control imports -- every other picker (Cameras/Lighting/Toon/Tween
  // Sequences) is untouched.
  let exportBtn = null
  let importBtn = null
  if (ctrl.exportable) {
    exportBtn = el('button', null, { type: 'button', textContent: 'Export Selected' })
    btnRow.appendChild(exportBtn)
  }
  if (ctrl.importable) {
    importBtn = el('button', null, { type: 'button', textContent: 'Import' })
    btnRow.appendChild(importBtn)
  }
  row.appendChild(listEl)
  row.appendChild(btnRow)
  const entry = {
    type: 'list-picker', ctrl, listEl, items: (ctrl.def || []).slice(),
    selectedItem: null, collapsedGroups: new Set(), pendingGroups: [], exportChecked: new Set()
  }
  numEls[ctrl.key] = entry

  saveBtn.addEventListener('click', () => {
    const label = ctrl.itemLabel || 'Item'
    const name = prompt(label + ' name:', label + ' ' + (entry.items.length + 1))
    if (!name) return
    const data = ctrl.captureCurrent ? ctrl.captureCurrent() : {}
    // Bug fix (direct user report, 2026-09-10, on the Pose picker
    // specifically): saving under a name that already exists used to
    // silently ADD a second, separate item with the same name rather than
    // updating the existing one -- 2 real, DIFFERENT saved poses both
    // ended up named "PRESNAP", and anything that looks a saved item up
    // BY NAME (the Tween group's own resolveTweenPoses(), main.js) always
    // resolved to the older of the two, while this picker's own "Use"
    // button (which selects by clicked list POSITION, never by name) kept
    // showing whichever one was actually clicked -- confusing on its own,
    // and a landmine for any future name-based lookup. Now asks before
    // overwriting instead of duplicating silently.
    const existing = entry.items.find((it) => it.name === name)
    if (existing) {
      if (!confirm(`"${name}" already exists. Overwrite it?`)) return
      // Preserves the existing item's .group -- overwriting by name isn't
      // supposed to silently evict an item from whatever group it's in.
      entry.items = entry.items.map((it) => (it === existing ? { name, ...data, ...(it.group ? { group: it.group } : {}) } : it))
    } else {
      entry.items = entry.items.concat([{ name, ...data }])
    }
    commit(ctrl, entry.items)
    renderListPickerRows(entry)
  })
  // Direct user request: "provide an overwrite button so i dont have to
  // type the name in" -- re-captures current state into whichever item is
  // already selected, keeping its name and group exactly as they are, no
  // prompt at all.
  overwriteBtn.addEventListener('click', () => {
    if (!entry.selectedItem) return
    const target = entry.selectedItem
    const data = ctrl.captureCurrent ? ctrl.captureCurrent() : {}
    entry.items = entry.items.map((it) => (it === target ? { name: it.name, ...data, ...(it.group ? { group: it.group } : {}) } : it))
    entry.selectedItem = entry.items.find((it) => it.name === target.name && it.group === target.group) || null
    commit(ctrl, entry.items)
    renderListPickerRows(entry)
  })
  useBtn.addEventListener('click', () => {
    if (entry.selectedItem && ctrl.onUse) ctrl.onUse(entry.selectedItem)
  })
  renameBtn.addEventListener('click', () => {
    if (!entry.selectedItem) return
    const target = entry.selectedItem
    const name = prompt('Rename to:', target.name)
    if (!name || name === target.name) return
    entry.items = entry.items.map((it) => (it === target ? { ...it, name } : it))
    entry.selectedItem = entry.items.find((it) => it === target) || null
    commit(ctrl, entry.items)
    renderListPickerRows(entry)
  })
  deleteBtn.addEventListener('click', () => {
    if (!entry.selectedItem) return
    entry.items = entry.items.filter((it) => it !== entry.selectedItem)
    entry.selectedItem = null
    commit(ctrl, entry.items)
    renderListPickerRows(entry)
  })
  // Direct user request: let a picker's own items be organized into groups.
  // Just adds an empty group header to drag items into -- see
  // renderListPickerRows()'s own comment for why an empty group doesn't
  // survive a reload until it actually has a member.
  addGroupBtn.addEventListener('click', () => {
    const existingNames = new Set([...entry.items.map((it) => it.group).filter(Boolean), ...entry.pendingGroups])
    let name = 'New Group'
    let n = 2
    while (existingNames.has(name)) { name = 'New Group (' + n + ')'; n++ }
    entry.pendingGroups = entry.pendingGroups.concat([name])
    renderListPickerRows(entry)
  })
  const flashBtn = (btn, msg) => { const orig = btn.textContent; btn.textContent = msg; setTimeout(() => { btn.textContent = orig }, 1400) }
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const checked = entry.items.filter((it) => entry.exportChecked.has(it))
      if (checked.length === 0) { flashBtn(exportBtn, 'Check items first'); return }
      // Strips .group -- the exporting project's own group organization is
      // meaningless (and could even collide) in whatever project imports
      // this; the imported items land ungrouped there, same as any other
      // freshly-Saved item.
      const payload = checked.map(({ group, ...rest }) => rest)
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
        flashBtn(exportBtn, `Copied ${checked.length}!`)
      } catch (err) { flashBtn(exportBtn, 'Copy failed') }
    })
  }
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      let text
      try {
        text = await navigator.clipboard.readText()
      } catch (err) {
        // Clipboard read can be blocked (permissions, insecure context) --
        // prompt() as a manual-paste fallback rather than a dead end.
        text = prompt('Paste exported poses JSON:', '')
        if (!text) return
      }
      let incoming
      try {
        incoming = JSON.parse(text)
        if (!Array.isArray(incoming)) throw new Error('not an array')
      } catch (err) { flashBtn(importBtn, 'Invalid JSON'); return }
      // Same "same-name overwrites, everything else untouched" rule as
      // Save's own button -- an import never wipes the existing list, and
      // never duplicates an already-present name.
      let items = entry.items.slice()
      incoming.forEach((incomingItem) => {
        if (!incomingItem || typeof incomingItem.name !== 'string') return
        const existingIndex = items.findIndex((it) => it.name === incomingItem.name)
        if (existingIndex >= 0) items[existingIndex] = { ...incomingItem, ...(items[existingIndex].group ? { group: items[existingIndex].group } : {}) }
        else items = items.concat([incomingItem])
      })
      entry.items = items
      commit(ctrl, entry.items)
      renderListPickerRows(entry)
      flashBtn(importBtn, `Imported ${incoming.length}!`)
    })
  }
  renderListPickerRows(entry)
  // Direct user request: drag-and-drop reordering, and dragging items
  // between groups -- reuses the exact same generic pointer-drag engine
  // the outer settings panel already uses for its own groups/rows
  // (setupReorder), scoped to just THIS picker's own listEl so different
  // pickers' items never interfere with each other. Called once here (not
  // inside renderListPickerRows, which reruns on every Save/Delete/etc --
  // re-attaching a pointerdown listener to listEl every render would stack
  // duplicates, since listEl itself survives innerHTML='' clears).
  // Groups reorder among top-level siblings by default (target: listEl
  // itself) and can ALSO be dragged into another TOP-LEVEL group's own
  // body to nest one level deep -- this picker's OWN cap, kept as-is
  // (out of scope for the 2026-09-14 unlimited-nesting change to the
  // OUTER settings panel's own groups, see buildDevPanel()'s own comment
  // -- the 2 group systems no longer share the same rule, corrected here
  // since this comment used to claim they did): a group that already
  // contains its own subgroup(s) is offered ONLY listEl (dragging it
  // into another group would bring its children along, producing 2
  // levels of nesting). Needs its own onDrop too (not
  // just the item-drag below) -- promoting/demoting a group changes every
  // one of its members' own .group PATH, which only syncListPickerFromDom
  // (reading the new DOM position) can resolve.
  setupReorder(listEl, 'dp-lp-group', 'dp-lp-group-handle', (item) => {
    if (item.querySelector('.dp-lp-group-body .dp-lp-group')) return [listEl]
    const topLevelBodies = Array.from(listEl.querySelectorAll(':scope > .dp-lp-group > .dp-lp-group-body'))
      .filter((b) => b.closest('.dp-lp-group') !== item)
    return [listEl, ...topLevelBodies]
  }, () => syncListPickerFromDom(entry))
  setupReorder(listEl, 'dp-list-picker-row', 'dp-lp-row-handle',
    () => Array.from(listEl.querySelectorAll('.dp-lp-group-body, .dp-lp-ungrouped-body')),
    () => syncListPickerFromDom(entry))
}

// Opens an inline rename editor in place of `displayEl`'s text (a group's
// title span, or a row's label) -- `key` is the STABLE identity to store the
// override under (a group's original title, or a control's own `.key`),
// `originalText` is what to show/restore when no override is set. Enter
// commits, Escape (or blur with no real change) reverts to the plain text.
function openTextEditFor(displayEl, key, originalText) {
  if (displayEl.querySelector('textarea')) return
  const currentValue = key in textOverrides ? textOverrides[key] : originalText
  const originalHTML = displayEl.innerHTML
  const input = el('textarea', null, { rows: 1, value: currentValue })
  displayEl.textContent = ''
  displayEl.appendChild(input)
  input.focus()
  input.select()
  // Stop this element's own drag-reorder pointerdown listener (setupReorder)
  // from ever seeing events that originate inside the textarea.
  input.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  input.addEventListener('click', (ev) => ev.stopPropagation())
  let settled = false
  function commit() {
    if (settled) return
    settled = true
    const typed = input.value
    if (typed === '' || typed === originalText) delete textOverrides[key]
    else textOverrides[key] = typed
    displayEl.textContent = key in textOverrides ? textOverrides[key] : originalText
  }
  function cancel() {
    if (settled) return
    settled = true
    displayEl.innerHTML = originalHTML
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); input.blur() }
    else if (ev.key === 'Escape') cancel()
  })
}

// Re-applies every stored override to the DOM -- called after Reset/a fresh
// load populates `textOverrides` from saved state, and once up front so a
// custom group recreated by applyOrder() (built via this same function)
// picks up its own override too.
function applyTextOverrides() {
  document.querySelectorAll('.dp-group-title-text').forEach((titleText) => {
    const group = titleText.closest('.dp-group')
    const key = group ? group.dataset.key : null
    if (key) titleText.textContent = key in textOverrides ? textOverrides[key] : key
  })
  document.querySelectorAll('.dp-row > label').forEach((label) => {
    const row = label.closest('.dp-row')
    const ctrl = row ? findCtrl(row.dataset.key) : null
    if (ctrl) label.textContent = ctrl.key in textOverrides ? textOverrides[ctrl.key] : ctrl.label
  })
}

// Builds one group's DOM shell (header w/ drag handle + collapse-arrow +
// title, plus an empty body) -- shared by buildDevPanel() (the project's
// own code-defined groups), addCustomGroup() (a group the user creates via
// "+ Add Group"), and applyOrder() (recreating a user-created group that
// doesn't exist in DEV_GROUPS at all -- the only way one survives a reload).
function createGroupElement(title) {
  const g = el('div', 'dp-group')
  g.dataset.key = title
  const h = el('div', 'dp-group-header')
  const titleText = el('span', 'dp-group-title-text', { textContent: title })
  h.append(el('span', 'dp-drag-handle', { textContent: '⠿' }), el('span', 'arrow', { textContent: '▼' }), titleText)
  const gb = el('div', 'dp-group-body')
  h.addEventListener('click', (e) => {
    if (e.target.closest('.dp-drag-handle')) return
    if (textEditModeEnabled) { openTextEditFor(titleText, title, title); return }
    g.classList.toggle('collapsed')
  })
  g.appendChild(h)
  g.appendChild(gb)
  return g
}

// "+ Add Group" -- lets the user organize existing settings into their own
// groupings (drag rows into it, see setupReorder's cross-group support
// below) without a code change. Checked against every group currently in
// the DOM (code-defined and user-created alike) so a default name can't
// collide with one already there.
function addCustomGroup(groupsEl) {
  const existing = new Set(Array.from(groupsEl.querySelectorAll(':scope > .dp-group')).map((g) => g.dataset.key))
  let name = 'New Group'
  let n = 2
  while (existing.has(name)) { name = 'New Group (' + n + ')'; n++ }
  const g = createGroupElement(name)
  groupsEl.appendChild(g)
  g.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// Generic pointer-based drag-to-reorder. Used both for groups (single
// container: groupsEl itself, no `getTargets`) and for settings rows
// (cross-container: a row can be dragged out of its own group's body into
// any OTHER group's body, per direct user request -- "move settings
// between groups"). `getTargets` is (re-)called at the START of each drag
// (not cached across drags) so a group created mid-session via
// addCustomGroup(), or restored via applyOrder(), is immediately a valid
// drop target with no extra wiring.
function setupReorder(container, itemClass, handleClass, getTargets, onDrop) {
  let dragEl = null
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.' + handleClass)
    if (!handle) return
    const item = handle.closest('.' + itemClass)
    if (!item) return
    e.preventDefault()
    dragEl = item
    dragEl.classList.add('dp-dragging')
    try { handle.setPointerCapture(e.pointerId) } catch (err) { /* best-effort only */ }
    const targets = getTargets ? getTargets(item) : [item.parentElement]

    function move(ev) {
      if (!dragEl) return
      // Picks the SMALLEST (most specific) matching container, not just the
      // FIRST -- with group nesting, a nested group's own body sits visually
      // INSIDE its parent's body, so the pointer can be over both at once.
      // .find() used to always resolve to whichever container happened to
      // come first in `targets`' own array order (usually the larger
      // enclosing one), silently making it impossible to ever target the
      // more specific nested container.
      let targetContainer = null
      let smallestHeight = Infinity
      targets.forEach((c) => {
        const r = c.getBoundingClientRect()
        if (ev.clientY >= r.top && ev.clientY <= r.bottom && r.height < smallestHeight) {
          smallestHeight = r.height
          targetContainer = c
        }
      })
      if (!targetContainer) {
        let minDist = Infinity
        targets.forEach((c) => {
          const r = c.getBoundingClientRect()
          const dist = Math.abs(ev.clientY - (r.top + r.height / 2))
          if (dist < minDist) { minDist = dist; targetContainer = c }
        })
      }
      if (!targetContainer) return
      const siblings = Array.from(targetContainer.children).filter((c) => c.classList.contains(itemClass) && c !== dragEl)
      let placed = false
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) { targetContainer.insertBefore(dragEl, sib); placed = true; break }
      }
      if (!placed) targetContainer.appendChild(dragEl)
    }
    function up(ev) {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      const dropped = dragEl
      if (dragEl) dragEl.classList.remove('dp-dragging')
      dragEl = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      // Optional: lets a caller whose data model isn't just "DOM order" (the
      // list-picker's own entry.items array + per-item group) resync itself
      // from the DOM once a drag genuinely completes, rather than treating
      // the DOM as the source of truth forever.
      if (dropped && onDrop) onDrop(dropped)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}

function buildDevPanel(groupsEl) {
  devGroups.forEach((group) => {
    const g = createGroupElement(group.title)
    const gb = g.querySelector('.dp-group-body')
    group.controls.forEach((ctrl) => gb.appendChild(buildRow(ctrl)))
    groupsEl.appendChild(g)
  })
  // Groups reorder among top-level siblings by default (target: groupsEl
  // itself) and can ALSO be dragged into ANY other group's own body, at
  // ANY depth -- UNLIMITED nesting (corrected 2026-09-14, matching
  // TEMPLATE_DEV_PANEL.html's own unlimited-depth engine, per direct
  // request: "I currently cant nest groups within each other"). This used
  // to cap at one level (`:scope > .dp-group > .dp-group-body` only ever
  // matched a TOP-LEVEL group's body, and a group that already had its
  // own nested children was excluded from nesting further, specifically
  // to prevent a 2nd level from ever forming) -- that whole restriction
  // is gone now. The only remaining constraint is a correctness one, not
  // a depth cap: `item.contains(...)` excludes the dragged group's OWN
  // body and every one of its own descendants' bodies, since dropping a
  // group into itself (or into one of its own children) would create a
  // circular structure. `captureGroup()`/`applyOrder()` (save/restore)
  // were ALREADY genuinely recursive before this change -- the 1-level
  // cap only ever lived here, in what the live drag was willing to
  // offer as a target, confirmed by reading both functions before
  // touching anything.
  setupReorder(groupsEl, 'dp-group', 'dp-drag-handle', (item) => {
    const allBodies = Array.from(groupsEl.querySelectorAll('.dp-group > .dp-group-body'))
      .filter((b) => !item.contains(b.closest('.dp-group')))
    return [groupsEl, ...allBodies]
  })
  // Cross-group: recomputes the live list of every group's body (top-level
  // AND nested, since this selector isn't :scope-restricted) at the start
  // of each individual drag, so a group added/removed/nested since the last
  // drag (addCustomGroup(), or one recreated by applyOrder()) is always
  // current.
  setupReorder(groupsEl, 'dp-row', 'dp-row-handle', () => Array.from(groupsEl.querySelectorAll('.dp-group-body')))
}

// Organizes the built-in "Dev Panel" group's own (flat, just-built) rows
// into nested subgroups, matching TEMPLATE_DEV_PANEL.html's own
// `applyDefaultDevPanelSubgroupOrder()` EXACTLY -- same group names, same
// nesting (TEXT holds 5 further subgroups), same per-group control
// membership and order (2026-09-14 port round, direct request: "Port the
// template's Dev Panel Group settings names, ordering, groups, sub
// groups, group nesting, and ordering"). Relies on the unlimited-nesting
// fix directly above this function existing -- TEXT's own 5 children are
// a 2nd nesting level, which the drag-reorder engine only started
// allowing this same round. Called once, right after buildDevPanel()
// creates the flat structure, BEFORE resetSettings() runs -- a genuine
// saved order (if any) is applied afterward and takes precedence over
// this default organization, the same relationship the template's own
// idempotent version has to a live user reorder, achieved here simply by
// running before rather than needing a marker-group check of its own.
// CORRECTED 2026-09-14 (see organizeGroupSubgroups()'s own comment for
// the full account): `makeSub()` now reuses an existing same-titled
// subgroup instead of always creating a fresh one, and initDevPanel()
// calls this function a 2nd time after resetSettings() -- a saved order
// predating this structure used to flatten it right back out the moment
// resetSettings()'s own applyOrder() ran, with nothing to undo that.
function organizeDevPanelSubgroups(groupsEl) {
  const devPanelGroup = groupsEl.querySelector(':scope > .dp-group[data-key="Dev Panel"]')
  if (!devPanelGroup) return
  const body = devPanelGroup.querySelector(':scope > .dp-group-body')
  const rowsByKey = {}
  body.querySelectorAll(':scope > .dp-row[data-key]').forEach((r) => { rowsByKey[r.dataset.key] = r })
  function makeSub(title, keys, parentBody) {
    let g = parentBody.querySelector(`:scope > .dp-group[data-key="${CSS.escape(title)}"]`)
    if (!g) {
      g = createGroupElement(title)
      parentBody.appendChild(g)
    }
    const gb = g.querySelector(':scope > .dp-group-body')
    keys.forEach((k) => { const row = rowsByKey[k]; if (row) gb.appendChild(row) })
    return g
  }
  makeSub('MECHANICS', ['dp_scrollStrength'], body)
  makeSub('PANEL UI', ['dp_bgColor', 'dp_accentColor', 'dp_sliderColor', 'dp_opacity'], body)
  const text = makeSub('TEXT', ['dp_fontFamily'], body)
  const textBody = text.querySelector(':scope > .dp-group-body')
  makeSub('Dev Panel Title', ['dp_boldTitle', 'dp_capsTitleText', 'dp_titleFontSize', 'dp_titleLetterSpacing', 'dp_titleLineHeight', 'dp_buttonTextBorder', 'dp_titleColor'], textBody)
  makeSub('Group Title', ['dp_boldGroup', 'dp_capsGroupNames', 'dp_groupTitleFontSize', 'dp_groupLetterSpacing', 'dp_groupLineHeight', 'dp_groupTextColor', 'dp_groupLabelBgColor'], textBody)
  makeSub('Setting Title', ['dp_capsSettingsText', 'dp_boldSettings', 'dp_settingsTitleFontSize', 'dp_valueFontSize', 'dp_settingsLineHeight', 'dp_settingsLetterSpacing', 'dp_textColor', 'dp_valueTextColor'], textBody)
  makeSub('TABS', ['dp_boldTab', 'dp_capsTabText', 'dp_tabFontSize', 'dp_tabLetterSpacing', 'dp_tabLineHeight', 'dp_tabTextColor'], textBody)
  makeSub('BUTTONS', ['dp_boldButton', 'dp_capsButtonText', 'dp_buttonFontSize', 'dp_buttonLetterSpacing', 'dp_buttonLineHeight', 'dp_buttonTextColor', 'dp_buttonHeight'], textBody)
}

// Generic version of organizeDevPanelSubgroups() above, for a PROJECT's
// own group instead of the built-in "Dev Panel" one -- same "flat rows,
// just built by buildDevPanel(), into named subgroups" shape, but
// parameterized by group title + an ordered `[{title, keys}]` spec
// instead of a hardcoded structure, so this file stays generic (a
// project supplies its own spec via `initDevPanel(groups, {
// organizeSubgroups: (groupsEl) => organizeGroupSubgroups(groupsEl,
// 'GroupTitle', SPEC) })` rather than this engine knowing any
// project-specific group/control names).
//
// CORRECTED 2026-09-14, direct user report ("you didnt move the
// settings into the groups"): a SAVED order predating this structure
// (this project's own already-documented "stale localStorage" gotcha,
// hit earlier this same session with organizeDevPanelSubgroups() too,
// but only ever worked around by manually clearing localStorage in a
// test tab, never actually fixed) flattens the freshly-built subgroups
// right back out the moment `resetSettings()` runs its own
// `applyOrder()` -- that function only runs ONCE, right after
// `buildDevPanel()`, with nothing to re-apply it afterward. Fixed 2
// ways: (1) idempotent now -- reuses an EXISTING subgroup element (found
// by its own title, if `initDevPanel()` already called this once and a
// stale order flattened its contents back out) instead of always
// creating a fresh one, so calling this twice never produces duplicate
// empty subgroup shells; (2) `initDevPanel()` now calls the
// `organizeSubgroups` hook a 2nd time, right after `resetSettings()`,
// so whatever a stale order just flattened gets correctly re-nested
// immediately afterward. A GENUINE saved order that already reflects
// the nested structure (e.g. after the user drags a row somewhere else
// post-port and saves) is unaffected either way -- this only ever moves
// a listed key INTO its spec'd subgroup, never out of wherever a real
// saved order legitimately placed it.
//
// Nesting a spec's OWN subgroups further (matching TEXT's 2nd level in
// organizeDevPanelSubgroups() above) works the same way: call this again,
// targeting the just-created subgroup's own body via a second, deeper
// call -- not built in here, since no current caller needs it.
export function organizeGroupSubgroups(groupsEl, groupTitle, subgroupSpecs) {
  const targetGroup = groupsEl.querySelector(`:scope > .dp-group[data-key="${CSS.escape(groupTitle)}"]`)
  if (!targetGroup) return
  const body = targetGroup.querySelector(':scope > .dp-group-body')
  const rowsByKey = {}
  body.querySelectorAll(':scope > .dp-row[data-key]').forEach((r) => { rowsByKey[r.dataset.key] = r })
  subgroupSpecs.forEach((spec) => {
    let g = body.querySelector(`:scope > .dp-group[data-key="${CSS.escape(spec.title)}"]`)
    if (!g) {
      g = createGroupElement(spec.title)
      if (spec.collapsed) g.classList.add('collapsed')
      body.appendChild(g)
    }
    const gb = g.querySelector(':scope > .dp-group-body')
    spec.keys.forEach((k) => { const row = rowsByKey[k]; if (row) gb.appendChild(row) })
  })
}

// Extra clamp margin from the left/right viewport edge, mobile only --
// matches TEMPLATE_DEV_PANEL.html's DEV_PANEL_MOBILE_EDGE_GESTURE_MARGIN_PX:
// keeps the panel's drag/resize hit-zones off the physical screen edge,
// where an OS edge-swipe-back gesture can steal a touch before it ever
// reaches the page.
const MOBILE_EDGE_GESTURE_MARGIN_PX = 20
function edgeMarginX() { return window.innerWidth < 768 ? MOBILE_EDGE_GESTURE_MARGIN_PX : 0 }

function initPanelDrag(panel, header) {
  let dragging = false, startX, startY, startLeft, startTop
  function end(e) {
    if (!dragging) return
    dragging = false
    if (e && e.pointerId !== undefined && header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId)
  }
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dp-icon-btn')) return
    dragging = true
    try { header.setPointerCapture(e.pointerId) } catch (err) { /* best-effort only */ }
    const r = panel.getBoundingClientRect()
    startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top
    panel.style.right = 'auto'
  })
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return
    // Recovery for a dropped gesture (a touch-drag whose pointerdown fired
    // but no further pointerup/cancel ever arrived, e.g. an iOS gesture-
    // recognizer interruption) -- without this, `dragging` gets stuck true.
    if (e.buttons === 0) { end(e); return }
    // Clamp against the panel's own CURRENT rendered size (not a fixed
    // sliver like the old innerWidth-40/innerHeight-40) so every edge --
    // and therefore every resize corner -- stays reachable within the
    // viewport at all times, per direct user request. Re-read every move
    // rather than cached once, since width/height don't change during a
    // pure drag but this keeps it correct if they ever do (e.g. a window
    // resize mid-drag). Math.max(margin, ...) on the bound itself is what
    // degrades gracefully if the panel is ever wider/taller than the
    // viewport (mobile) -- it still clamps to the margin instead of going
    // negative.
    const rect = panel.getBoundingClientRect()
    const mx = edgeMarginX()
    const maxLeft = Math.max(mx, window.innerWidth - rect.width - mx)
    const maxTop = Math.max(0, window.innerHeight - rect.height)
    panel.style.left = Math.max(mx, Math.min(maxLeft, startLeft + (e.clientX - startX))) + 'px'
    panel.style.top = Math.max(0, Math.min(maxTop, startTop + (e.clientY - startY))) + 'px'
  })
  header.addEventListener('pointerup', end)
  header.addEventListener('pointercancel', end)
  // Fires whenever the browser/OS revokes capture for any reason (including
  // a native gesture recognizer stepping in mid-touch) -- a more direct
  // signal than waiting for pointerup/pointercancel, which can both simply
  // never arrive. Matches TEMPLATE_DEV_PANEL.html's own drag handler.
  header.addEventListener('lostpointercapture', end)
}

// Section 12c: resizable from all 4 edges and all 4 corners.
function initResizeHandles(panel) {
  panel.querySelectorAll('.dp-resize').forEach((handle) => {
    const dir = handle.dataset.dir
    let active = false, sx, sy, startRect
    function end(e) {
      if (!active) return
      active = false
      if (e && e.pointerId !== undefined && handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
    }
    handle.addEventListener('pointerdown', (e) => {
      active = true
      try { handle.setPointerCapture(e.pointerId) } catch (err) { /* best-effort only */ }
      sx = e.clientX; sy = e.clientY
      startRect = panel.getBoundingClientRect()
      panel.style.right = 'auto'
      // CSS's max-height:88vh (the panel's initial height cap) otherwise
      // silently overrides any inline height this handler sets once the
      // panel is already at/near that cap, so a resize that tries to grow
      // TALLER (n/s and every corner) appears to do nothing -- confirmed
      // live: e/w (width-only) worked, every direction with a vertical
      // component didn't move past 88vh. Clearing it here, once the user
      // actually starts resizing, is safe: the math below already clamps
      // height to window.innerHeight itself.
      panel.style.maxHeight = 'none'
    })
    handle.addEventListener('pointermove', (e) => {
      if (!active) return
      // Recovery for a dropped gesture -- see initPanelDrag's own comment.
      if (e.buttons === 0) { end(e); return }
      const mx = edgeMarginX()
      const dx = e.clientX - sx, dy = e.clientY - sy
      let { left, top, width, height } = startRect
      const minW = 220, minH = 140
      if (dir.includes('e')) width = Math.max(minW, Math.min(window.innerWidth - left - mx, startRect.width + dx))
      if (dir.includes('s')) height = Math.max(minH, Math.min(window.innerHeight - top, startRect.height + dy))
      // 'w'/'n' grow the panel from its OPPOSITE edge as the cursor moves
      // toward/past that edge -- unlike 'e'/'s' above, the un-clamped math
      // let `left`/`top` track the cursor past 0 with nothing stopping it,
      // pushing that edge (and its resize corners) off-screen. Clamping the
      // available growth to what's actually left before hitting 0 keeps the
      // resulting left/top pinned at >= 0 by construction, matching the
      // same "every edge stays in frame" requirement as the drag-move fix.
      if (dir.includes('w')) {
        const maxGrowW = startRect.left + startRect.width - mx
        width = Math.max(minW, Math.min(maxGrowW, startRect.width - dx))
        left = startRect.left + (startRect.width - width)
      }
      if (dir.includes('n')) {
        const maxGrowH = startRect.top + startRect.height
        height = Math.max(minH, Math.min(maxGrowH, startRect.height - dy))
        top = startRect.top + (startRect.height - height)
      }
      // Defense in depth: the w/n branches above derive left/top from the
      // clamped width/height and should algebraically stay within [margin,
      // viewport - size], but clamp explicitly anyway (matching
      // initPanelDrag's own move handler) rather than trust that derivation
      // never drifts -- found the panel's left CAN end up off-screen
      // negative in practice (confirmed live), even though it isn't
      // supposed to be reachable by the math above.
      left = Math.max(mx, Math.min(window.innerWidth - width - mx, left))
      top = Math.max(0, Math.min(window.innerHeight - height, top))
      panel.style.width = width + 'px'
      panel.style.height = height + 'px'
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
    })
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
  })
}

// Section 12e: a group's collapsed/expanded state persists through Copy/
// Save/Reset the same way group/setting ORDER already does -- direct user
// request ("when i hit save or copy. it should also save the collapsed
// state of the dev panel settings groups"), matching DICKOCLICKO/
// OKCILCOKCID's own already-shipped behavior (this shared engine, copied
// from ADA BATHROOM, had never captured it).
// Captures one group's own key/collapsed/settings, plus any subgroups
// nested directly inside its body -- genuinely recursive (calls itself
// on each direct child group below), so this already correctly handles
// UNLIMITED nesting depth despite the drag-reorder engine only recently
// (2026-09-14) allowing more than 1 level to actually be built live --
// this function itself never had a depth cap of its own to remove.
// Every query is :scope-scoped to this group's OWN direct body -- an
// unscoped querySelectorAll('.dp-row') would also reach a nested
// child's own rows, double-counting them under both the parent and the
// child.
function captureGroup(g) {
  return {
    key: g.dataset.key,
    collapsed: g.classList.contains('collapsed'),
    settings: Array.from(g.querySelectorAll(':scope > .dp-group-body > .dp-row')).map((r) => r.dataset.key),
    subgroups: Array.from(g.querySelectorAll(':scope > .dp-group-body > .dp-group')).map((sub) => captureGroup(sub)),
  }
}
function getPanelOrder(groupsEl) {
  return Array.from(groupsEl.querySelectorAll(':scope > .dp-group')).map((g) => captureGroup(g))
}

function applyOrder(groupsEl, order) {
  if (!order) return
  // A GLOBAL map, not scoped per-group -- a row saved under a DIFFERENT
  // group than the one buildDevPanel() originally put it in (the user
  // dragged it there) has to be found wherever it currently lives in the
  // DOM, not just within the group it's about to be placed into.
  const rowsByKey = {}
  groupsEl.querySelectorAll('.dp-row[data-key]').forEach((r) => { rowsByKey[r.dataset.key] = r })
  // Places one saved group (and, recursively, every one of its own saved
  // subgroups at any depth) into parentContainer -- either groupsEl
  // itself (top-level) or another group's own .dp-group-body (nested).
  // Like captureGroup() above, this was already genuinely recursive
  // before the 2026-09-14 unlimited-nesting change -- nothing here
  // needed to change for deeper saved structures to round-trip
  // correctly.
  function placeGroup(savedGroup, parentContainer) {
    // Not scoped to parentContainer -- a group can be found wherever it
    // currently lives in the DOM (same "find it, don't assume where it is"
    // pattern as rowsByKey above), since it may have moved top-level<->nested
    // since the last save.
    let groupEl = groupsEl.querySelector(`.dp-group[data-key="${CSS.escape(savedGroup.key)}"]`)
    if (!groupEl) {
      // Not a mistake -- this is how a user-created group (see
      // addCustomGroup()) survives a reload: it doesn't exist in the
      // code-defined `devGroups` at all, only in this saved order.
      groupEl = createGroupElement(savedGroup.key)
    }
    parentContainer.appendChild(groupEl)
    groupEl.classList.toggle('collapsed', !!savedGroup.collapsed)
    const groupBody = groupEl.querySelector('.dp-group-body')
    ;(savedGroup.settings || []).forEach((k) => {
      const rowEl = rowsByKey[k]
      if (rowEl) groupBody.appendChild(rowEl)
    })
    ;(savedGroup.subgroups || []).forEach((sub) => placeGroup(sub, groupBody))
  }
  order.forEach((g) => placeGroup(g, groupsEl))
}

// Loads a saved { desktop:{...}, mobile:{...}, landscape:{...} } values blob
// into the store and refreshes every row's display for the currently-editing
// tab. Does NOT go through commit() (which would fire onChange for every
// control) -- instead applies live cfg/onChange only once per control, for
// whichever device is actually real right now, matching how a page load
// itself would behave.
function applyStoredValues(values) {
  if (!values) return
  const real = realDeviceClass()
  devGroups.forEach((group) => group.controls.forEach((ctrl) => {
    DEVICES.forEach((d) => {
      const v = values[d] ? values[d][ctrl.key] : undefined
      if (v !== undefined) store[d][ctrl.key] = v
    })
    const realValue = store[real][ctrl.key]
    if (realValue !== undefined) {
      cfg[ctrl.key] = realValue
      if (ctrl.onChange) ctrl.onChange(realValue)
    }
  }))
  refreshRowDisplaysForEditingTab()
}

function refreshRowDisplaysForEditingTab() {
  devGroups.forEach((group) => group.controls.forEach((ctrl) => {
    const v = store[ctrl.perDevice ? editingDevice : 'desktop'][ctrl.key]
    if (v !== undefined) displayValue(ctrl, v)
  }))
}

// Optional generic remote-save tier (CLAUDE.md §12l): pass
// `initDevPanel(groups, { remoteSave: { endpoint, secret } })` to route
// Save/Reset through a server endpoint (a Vercel serverless function
// backed by GitHub's Contents API, e.g. DICKOCLICKO/OKCILCOKCID/HANDO's own
// api/save-settings.js) instead of localStorage. Single-tier when
// configured (matches those projects' own M5: getting one path working
// end-to-end, not layering a fallback) -- an unreachable/misconfigured
// endpoint surfaces an honest error rather than silently falling back to
// localStorage, so a broken remote save is never mistaken for a working
// one. Panel geometry (position/size) always stays in localStorage
// regardless -- it's a per-device/per-screen-size UI preference, not
// something that makes sense to sync globally.
//
// GET-merges before POSTing rather than overwriting: the endpoint's saved
// JSON may carry fields this generic engine knows nothing about (e.g.
// HANDO's own "Save Camera As Default" stashes a `defaultCamera` field
// alongside `values`/`order` via its own independent fetch) -- a blind
// overwrite here would silently erase those the next time a normal Save
// happens. Only `values`/`order` are ever replaced; every other top-level
// field in the existing remote JSON is preserved untouched.
async function remoteSaveSnapshot(remoteSave, snapshot) {
  let base = {}
  try {
    const getResp = await fetch(remoteSave.endpoint, { cache: 'no-store' })
    const getBody = await getResp.json().catch(() => ({}))
    if (getResp.ok && getBody.ok === true && getBody.settings && typeof getBody.settings === 'object') {
      base = getBody.settings
    }
  } catch (err) { /* fall through -- POST below still proceeds from an empty base */ }
  const merged = { ...base, values: snapshot.values, order: snapshot.order, textOverrides: snapshot.textOverrides }
  try {
    const postResp = await fetch(remoteSave.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Panel-Secret': remoteSave.secret },
      body: JSON.stringify(merged)
    })
    const postBody = await postResp.json().catch(() => ({}))
    if (postResp.ok && postBody.ok === true) return { ok: true }
    return { ok: false, error: postBody.error || ('HTTP ' + postResp.status) }
  } catch (err) {
    return { ok: false, error: 'offline/unreachable' }
  }
}

// Used only by the BOOT-TIME restore fetch (`resetSettings()`'s own
// `opts.remoteSave` branch), not by `remoteSaveSnapshot()`'s Save/Set-
// as-Default GET-merge-POST (a user-initiated action already has its own
// visible "Save failed: ..." flash on failure -- retrying that silently
// in the background would hide a real failure instead of surfacing it).
// Direct user request, after a real report of "really old settings" on
// a fresh mobile load traced to this exact fetch's own single-attempt,
// silent-fallback-to-defaults behavior (see CHANGELOG.txt): "can't you
// write a thing so that it keeps trying to fetch it until it works?"
// Retries with exponential backoff (500ms doubling up to a 10s cap)
// FOREVER rather than a fixed attempt count -- a flaky mobile connection
// might take longer than any fixed number of quick retries to recover,
// and an open tab left idle costs nothing extra to keep quietly retrying
// every 10s in the background. The app still renders immediately with
// the shipped defaults already populated in `cfg` (this function's
// caller doesn't block anything on it) -- once a fetch finally succeeds,
// `applyStoredValues()` hot-swaps in the real settings over whatever
// was showing, the same "apply now, override once real data arrives"
// pattern `loadDefaultCameraIfSaved()`/`loadDefaultPoseIfSaved()` in
// main.js already use for their own post-load overrides.
async function fetchRemoteSettingsUntilSuccess(remoteSave, onSuccess) {
  let delay = 500
  const maxDelay = 10000
  for (;;) {
    try {
      const resp = await fetch(remoteSave.endpoint, { cache: 'no-store' })
      const body = await resp.json().catch(() => ({}))
      if (resp.ok && body.ok === true && body.settings) {
        onSuccess(body.settings)
        return
      }
    } catch (err) { /* offline/unreachable this attempt -- fall through to retry */ }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, maxDelay)
  }
}

function getPanelGeometry(panel) {
  const r = panel.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function applyPanelGeometry(panel, geom) {
  if (!geom) return
  panel.style.right = 'auto'
  panel.style.left = geom.left + 'px'
  panel.style.top = geom.top + 'px'
  panel.style.width = geom.width + 'px'
  panel.style.maxHeight = 'none' // see initResizeHandles' pointerdown for why
  panel.style.height = geom.height + 'px'
}

export function initDevPanel(groups, opts = {}) {
  devGroups = groups
  storageKeyPrefix = opts.storageKeyPrefix || 'devPanel'
  editingDevice = realDeviceClass()
  // cfg/store are populated from defaults regardless of DEV_MODE -- these
  // values are the app's real, shipped defaults for every visitor; DEV_MODE
  // only gates whether the tuning UI itself is shown.
  groups.forEach((g) => g.controls.forEach((c) => {
    DEVICES.forEach((d) => { store[d][c.key] = c.def })
    cfg[c.key] = c.def
  }))
  // A real device-class change (resizing an actual browser across the
  // breakpoint) must re-derive cfg for every per-device control from the now-
  // current real device, and fire onChange so the live app updates too.
  window.addEventListener('resize', () => {
    const real = realDeviceClass()
    devGroups.forEach((group) => group.controls.forEach((ctrl) => {
      if (!ctrl.perDevice) return
      const v = store[real][ctrl.key]
      if (cfg[ctrl.key] !== v) {
        cfg[ctrl.key] = v
        if (ctrl.onChange) ctrl.onChange(v)
      }
    }))
  })
  if (!DEV_MODE) return cfg

  const panel = el('div', 'dp-panel', { id: 'devPanel' })
  // Section 12i: a built-in "Dev Panel" settings group, standing scaffolding
  // present on every project's panel (not something requested per-project),
  // controlling the panel chrome's OWN text sizing/coloring/opacity via CSS
  // custom properties (defaults match the plain hardcoded look in
  // style.css, so this is a no-op until actually touched). Font sizes are
  // perDevice (the same size/position heuristic as any other setting, per
  // §12f) since a dev session on an actual mobile screen often wants larger
  // panel text; opacity/colors are shared, no reason to differ by device.
  const setVar = (name) => (v) => panel.style.setProperty(name, typeof v === 'number' ? v + 'px' : v)
  const toggleClass = (className) => (v) => panel.classList.toggle(className, !!v)
  // CORRECTED 2026-09-14 (2nd pass, direct follow-up requests: "I also
  // wanted Dev panel colors to be ported too" / "we currently have some
  // yellow text in our Dev Panel group. fix that. Just match the
  // template"): the FIRST port (below, same day) kept every default at
  // this project's OWN pre-existing look and marked several controls
  // perDevice that shouldn't have been -- this pass instead matches
  // TEMPLATE_DEV_PANEL.html's own `devPanelStyle`/`DEV_PANEL_STYLE_SHARED_KEYS`
  // EXACTLY: real default VALUES (Verdana font, #005f8f accent, etc, a
  // deliberate, disclosed visual change, not a no-op) and the CORRECT
  // shared-vs-perDevice split. `DEV_PANEL_STYLE_SHARED_KEYS` there lists
  // font-size/line-height/button-height/button-text-border as per-tab
  // and (surprisingly, but ported faithfully rather than "corrected")
  // only TITLE's own letter-spacing as per-tab -- tab/group/settings/
  // button letter-spacing are all SHARED there, which is what this
  // project's own `dp_row.dp-per-device` yellow-label styling had been
  // incorrectly firing on for those 4 (they were wrongly marked
  // `perDevice: true` in the first pass): that yellow tint is gone now
  // that they're shared, matching the template, not a separate CSS fix.
  const builtInGroup = {
    title: 'Dev Panel',
    controls: [
      { key: 'dp_titleFontSize', label: 'Dev Panel Title Font Size', type: 'slider', min: 8, max: 24, step: 1, def: 17, defMobile: 11, defLandscape: 22, perDevice: true, onChange: setVar('--dp-title-font-size') },
      { key: 'dp_tabFontSize', label: 'Tab Font Size', type: 'slider', min: 8, max: 24, step: 1, def: 12, perDevice: true, onChange: setVar('--dp-tab-font-size') },
      { key: 'dp_groupTitleFontSize', label: 'Collapsible Group Title Font Size', type: 'slider', min: 8, max: 24, step: 1, def: 14, defMobile: 11, defLandscape: 11, perDevice: true, onChange: setVar('--dp-group-title-font-size') },
      // No separate "Body Text Font Size" control (CLAUDE.md §12i, corrected
      // 2026-09-08): it was a redundant duplicate of this one -- the 2 always
      // meant the same cascading base size. Merged into this control's own
      // onChange instead (sets BOTH CSS variables) so every existing CSS
      // rule referencing --dp-body-font-size still resolves correctly,
      // without reintroducing a 2nd slider for the same thing.
      { key: 'dp_settingsTitleFontSize', label: 'Settings Title Font Size', type: 'slider', min: 8, max: 24, step: 1, def: 12, defMobile: 10, perDevice: true, onChange: (v) => { setVar('--dp-settings-title-font-size')(v); setVar('--dp-body-font-size')(v) } },
      { key: 'dp_opacity', label: 'Dev Panel Opacity', type: 'slider', min: 0.1, max: 1, step: 0.05, def: 1, onChange: setVar('--dp-opacity') },
      { key: 'dp_bgColor', label: 'Dev Panel Background Color', type: 'color', def: '#000000', onChange: setVar('--dp-bg-color') },
      { key: 'dp_titleColor', label: 'Dev Panel Title Text Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-title-color') },
      { key: 'dp_textColor', label: 'Dev Panel Non-Title Text Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-text-color') },
      { key: 'dp_accentColor', label: 'Dev Panel Accent Color', type: 'color', def: '#005f8f', onChange: setVar('--dp-accent-color') },
      { key: 'dp_sliderColor', label: 'Dev Panel Slider Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-slider-color') },
      { key: 'dp_groupLabelBgColor', label: 'Group Label Background Color', type: 'color', def: '#005f8f', onChange: setVar('--dp-group-label-bg-color') },
      {
        key: 'dp_fontFamily', label: 'Dev Panel Font', type: 'select',
        def: 'Helvetica, Arial, sans-serif',
        options: () => [
          'Arial, Helvetica, sans-serif', 'Helvetica, Arial, sans-serif', "'Segoe UI', Arial, sans-serif",
          'Verdana, Geneva, sans-serif', 'Tahoma, Geneva, sans-serif', "'Trebuchet MS', Arial, sans-serif",
          "'Century Gothic', Arial, sans-serif", 'Calibri, Arial, sans-serif', "'Lucida Sans Unicode', Arial, sans-serif",
          "'Open Sans', Arial, sans-serif", "Futura, 'Century Gothic', Arial, sans-serif",
        ],
        onChange: setVar('--dp-font-family'),
      },
      // 4 independent toggles (CLAUDE.md §12i), not one shared "capitalize
      // everything" checkbox -- per-category so each text kind can be
      // capitalized on its own. true/true/true/false, matching the
      // template's own current defaults.
      { key: 'dp_capsButtonText', label: 'Capitalize Button Text', type: 'checkbox', def: true, onChange: toggleClass('dp-caps-button-text') },
      { key: 'dp_capsTabText', label: 'Capitalize Tab Text', type: 'checkbox', def: true, onChange: toggleClass('dp-caps-tab-text') },
      { key: 'dp_capsGroupNames', label: 'Capitalize Group Names', type: 'checkbox', def: true, onChange: toggleClass('dp-caps-group-names') },
      { key: 'dp_capsSettingsText', label: 'Capitalize Settings Text', type: 'checkbox', def: false, onChange: toggleClass('dp-caps-settings-text') },
      // Rides through the normal control pipeline (Copy/Save/Reset already
      // cover it via `store`/`cfg` with no extra code) -- only its onChange
      // needs to actually flip the module-level flag setupTextEditClicks()
      // and each group header's own click handler read from.
      { key: 'dp_textEditMode', label: 'Enable Label Rename Mode', type: 'checkbox', def: false, onChange: (v) => { textEditModeEnabled = v } },
      // Below: ported from TEMPLATE_DEV_PANEL.html's own expanded "Dev
      // Panel" group. "Scroll Strength" (below, own control) turned out
      // to genuinely belong here too -- an earlier pass wrongly excluded
      // it as project-specific before actually reading its wiring; it
      // controls THIS panel's own body-scroll intensity (see the wheel
      // listener on `body` above), corrected once that was confirmed.
      { key: 'dp_capsTitleText', label: 'Capitalize Title', type: 'checkbox', def: false, onChange: toggleClass('dp-caps-title-text') },
      { key: 'dp_boldTitle', label: 'Bold Title', type: 'checkbox', def: true, onChange: (v) => panel.style.setProperty('--dp-title-weight', v ? '600' : '400') },
      { key: 'dp_boldTab', label: 'Bold Tab', type: 'checkbox', def: true, onChange: (v) => panel.style.setProperty('--dp-tab-weight', v ? '600' : '400') },
      { key: 'dp_boldGroup', label: 'Bold Group Text', type: 'checkbox', def: true, onChange: (v) => panel.style.setProperty('--dp-group-weight', v ? '600' : '400') },
      { key: 'dp_boldSettings', label: 'Bold Settings Text', type: 'checkbox', def: false, onChange: (v) => panel.style.setProperty('--dp-settings-weight', v ? '600' : '400') },
      { key: 'dp_boldButton', label: 'Bold Button', type: 'checkbox', def: true, onChange: (v) => panel.style.setProperty('--dp-button-weight', v ? '600' : '400') },
      // Only Title's own letter spacing is perDevice, per
      // DEV_PANEL_STYLE_SHARED_KEYS -- tab/group/settings/button letter-
      // spacing are all SHARED there (ported faithfully, not "fixed" to
      // be consistent with title's own perDevice choice).
      { key: 'dp_titleLetterSpacing', label: 'Dev Panel Title Letter Spacing (Px)', type: 'slider', min: -2, max: 10, step: 0.1, def: 2.3, defMobile: 0, defLandscape: 0, perDevice: true, onChange: setVar('--dp-title-letter-spacing') },
      { key: 'dp_titleLineHeight', label: 'Dev Panel Title Line Spacing (X)', type: 'slider', min: 0.8, max: 3, step: 0.05, def: 1.2, perDevice: true, onChange: (v) => panel.style.setProperty('--dp-title-line-height', v) },
      { key: 'dp_tabLetterSpacing', label: 'Tab Letter Spacing (Px)', type: 'slider', min: -2, max: 10, step: 0.1, def: 0, onChange: setVar('--dp-tab-letter-spacing') },
      { key: 'dp_tabLineHeight', label: 'Tab Line Spacing (X)', type: 'slider', min: 0.8, max: 3, step: 0.05, def: 1.2, perDevice: true, onChange: (v) => panel.style.setProperty('--dp-tab-line-height', v) },
      { key: 'dp_groupLetterSpacing', label: 'Group Letter Spacing (Px)', type: 'slider', min: -2, max: 10, step: 0.1, def: 0.8, onChange: setVar('--dp-group-letter-spacing') },
      { key: 'dp_groupLineHeight', label: 'Group Line Spacing (X)', type: 'slider', min: 0.8, max: 3, step: 0.05, def: 1.2, perDevice: true, onChange: (v) => panel.style.setProperty('--dp-group-line-height', v) },
      { key: 'dp_settingsLetterSpacing', label: 'Settings Letter Spacing (Px)', type: 'slider', min: -2, max: 10, step: 0.1, def: 0, onChange: setVar('--dp-settings-letter-spacing') },
      { key: 'dp_settingsLineHeight', label: 'Settings Line Spacing (X)', type: 'slider', min: 0.8, max: 3, step: 0.05, def: 1.2, perDevice: true, onChange: (v) => panel.style.setProperty('--dp-settings-line-height', v) },
      { key: 'dp_buttonFontSize', label: 'Button Text Font Size', type: 'slider', min: 6, max: 30, step: 1, def: 10, perDevice: true, onChange: setVar('--dp-button-font-size') },
      { key: 'dp_buttonLetterSpacing', label: 'Button Letter Spacing (Px)', type: 'slider', min: -2, max: 10, step: 0.1, def: 0, onChange: setVar('--dp-button-letter-spacing') },
      { key: 'dp_buttonLineHeight', label: 'Button Line Spacing (X)', type: 'slider', min: 0.8, max: 3, step: 0.05, def: 1.2, perDevice: true, onChange: (v) => panel.style.setProperty('--dp-button-line-height', v) },
      { key: 'dp_buttonHeight', label: 'Button Height (Px)', type: 'slider', min: 0, max: 60, step: 1, def: 21, defMobile: 24, perDevice: true, onChange: setVar('--dp-button-height') },
      { key: 'dp_buttonTextBorder', label: 'Button Text Border (Px)', type: 'slider', min: 0, max: 20, step: 1, def: 0, perDevice: true, onChange: setVar('--dp-button-text-border') },
      { key: 'dp_valueFontSize', label: 'Setting Number Font Size', type: 'slider', min: 6, max: 30, step: 1, def: 10, perDevice: true, onChange: setVar('--dp-value-font-size') },
      { key: 'dp_groupTextColor', label: 'Group Text Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-group-text-color') },
      { key: 'dp_buttonTextColor', label: 'Button Text Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-button-text-color') },
      { key: 'dp_valueTextColor', label: 'Setting Number Text Color', type: 'color', def: '#5cc9ff', onChange: setVar('--dp-value-text-color') },
      { key: 'dp_tabTextColor', label: 'Tab Text Color', type: 'color', def: '#ffffff', onChange: setVar('--dp-tab-text-color') },
      // Genuinely belongs here (see comment above) -- controls the
      // panel's own body-scroll wheel intensity, wired on `body` right
      // after its own creation, above.
      { key: 'dp_scrollStrength', label: 'Scroll Strength (X)', type: 'slider', min: 0.2, max: 5, step: 0.1, def: 0.2, defMobile: 1, perDevice: true },
    ]
  }
  devGroups = [builtInGroup, ...devGroups]
  // `defMobile`/`defLandscape` are optional per-control overrides (added
  // for template-parity, matching Clicko's own genuinely different tuned
  // Mobile/Landscape defaults for some per-device fields, e.g. Title Font
  // Size 17/11/22) -- a control with neither just uses `def` for all 3
  // devices, same as before this existed.
  builtInGroup.controls.forEach((c) => {
    DEVICES.forEach((d) => {
      store[d][c.key] = d === 'mobile' && c.defMobile !== undefined ? c.defMobile
        : d === 'landscape' && c.defLandscape !== undefined ? c.defLandscape
        : c.def
    })
    cfg[c.key] = c.def
  })
  const header = el('div', 'dp-header', { id: 'dpHeader' })
  header.appendChild(el('span', 'dp-title', { textContent: 'DEV' }))
  const collapseBtn = el('button', 'dp-icon-btn', { type: 'button', textContent: '–', title: 'Collapse' })
  header.appendChild(collapseBtn)
  panel.appendChild(header)

  const body = el('div', 'dp-body', { id: 'dpBody' })
  // Ported from TEMPLATE_DEV_PANEL.html's own [JS-13c]-adjacent scroll-
  // strength wheel handler (2026-09-14 port round) -- controls how far
  // the panel's own body scrolls per wheel notch. `cfg.dp_scrollStrength`
  // is read live (not captured into a closure) so the control's own
  // onChange (a plain cfg/store write, no DOM work needed) is all that's
  // required to wire it up. strength===1 is treated as "just let the
  // browser's own native scroll happen" (matching the template), not a
  // no-op multiply-by-1 -- deltaY's own native scaling already varies by
  // browser/OS/input device, so replacing it with `deltaY * 1` would NOT
  // reliably reproduce native scroll feel.
  body.addEventListener('wheel', (e) => {
    const strength = cfg.dp_scrollStrength
    if (strength === undefined || strength === 1) return
    e.preventDefault()
    body.scrollTop += e.deltaY * strength
  }, { passive: false })

  // Section 12f: Desktop / Mobile / Landscape tabs.
  const tabs = el('div', 'dp-tabs')
  const tabButtons = {
    desktop: el('button', 'dp-tab', { type: 'button', textContent: 'Desktop' }),
    mobile: el('button', 'dp-tab', { type: 'button', textContent: 'Mobile' }),
    landscape: el('button', 'dp-tab', { type: 'button', textContent: 'Landscape' }),
  }
  tabs.append(tabButtons.desktop, tabButtons.mobile, tabButtons.landscape)
  body.appendChild(tabs)
  function updateTabButtonStyles() {
    DEVICES.forEach((d) => tabButtons[d].classList.toggle('dp-tab-active', editingDevice === d))
  }
  let userSwitchedTab = false
  function switchTab(device) {
    editingDevice = device
    userSwitchedTab = true
    updateTabButtonStyles()
    refreshRowDisplaysForEditingTab()
  }
  DEVICES.forEach((d) => tabButtons[d].addEventListener('click', () => switchTab(d)))
  updateTabButtonStyles()
  // Self-heal the INITIAL active tab, same rationale/shape as this
  // project's own documented `window.innerWidth`/`innerHeight`-can-read-
  // wrong-at-script-parse-time gotcha (see main.js's own animate()
  // renderer-size self-heal): `editingDevice` above was set once,
  // synchronously, from `realDeviceClass()` at the very top of this
  // function -- if the viewport read wrong at that exact early moment (a
  // real user-reported case: the panel opened on the Landscape tab on an
  // actual desktop-sized window), nothing ever corrected it afterward --
  // the `resize` listener above only re-syncs per-device VALUES for a
  // genuine later resize, never which tab is shown as active, and
  // doesn't fire at all if the viewport was simply wrong once at load
  // with no resize following it. Re-checks for a short window of frames
  // after load and corrects once if the real device class differs --
  // stops immediately the moment the user manually picks a tab
  // themselves (never fights an intentional selection), and stops after
  // ~0.5s regardless so a later real resize's own tab-follow story isn't
  // silently changed by this -- this is specifically a load-time
  // correction, not a standing "tab always follows resize" behavior.
  let healFramesLeft = 30
  function healActiveTabOnce() {
    if (userSwitchedTab || healFramesLeft <= 0) return
    healFramesLeft--
    const real = realDeviceClass()
    if (real !== editingDevice) {
      editingDevice = real
      updateTabButtonStyles()
      refreshRowDisplaysForEditingTab()
    }
    requestAnimationFrame(healActiveTabOnce)
  }
  requestAnimationFrame(healActiveTabOnce)

  const actions = el('div', 'dp-actions')
  const copyBtn = el('button', null, { type: 'button', textContent: 'Copy' })
  const saveBtn = el('button', null, { type: 'button', textContent: 'Save' })
  const resetBtn = el('button', null, { type: 'button', textContent: 'Reset' })
  actions.append(copyBtn, saveBtn, resetBtn)
  body.appendChild(actions)
  const groupsEl = el('div', 'dp-groups', { id: 'dpGroups' })
  const addGroupRow = el('div', 'dp-add-group-row')
  const addGroupBtn = el('button', null, { type: 'button', textContent: '+ Add Group' })
  addGroupBtn.addEventListener('click', () => addCustomGroup(groupsEl))
  addGroupRow.appendChild(addGroupBtn)
  body.appendChild(addGroupRow)
  body.appendChild(groupsEl)
  panel.appendChild(body)
  ;['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach((dir) => {
    const handle = el('div', `dp-resize dp-resize-${dir}`)
    handle.dataset.dir = dir
    panel.appendChild(handle)
  })
  document.body.appendChild(panel)

  buildDevPanel(groupsEl)
  organizeDevPanelSubgroups(groupsEl)
  // Direct request ("move the Enable Label Rename Mode checkbox outside
  // of any group. Place it above Add group") -- CORRECTED 2026-09-14:
  // still a REGISTERED control (stays inside builtInGroup.controls, see
  // its own comment, so cfg/store/Copy/Save/Reset all keep working with
  // zero extra code), just relocated after buildDevPanel() renders it --
  // its row is found inside the Dev Panel group (where it's built, since
  // organizeDevPanelSubgroups() already deliberately leaves it as that
  // group's one flat, non-subgrouped row) and moved to sit directly in
  // `body`, above `addGroupRow`, a true panel-level standalone control
  // matching the template's own placement for this same checkbox.
  const textEditModeRow = groupsEl.querySelector('.dp-row[data-key="dp_textEditMode"]')
  if (textEditModeRow) body.insertBefore(textEditModeRow, addGroupRow)
  // Generic hook for a PROJECT's own group (e.g. main.js's "Pose"), same
  // "flat rows -> named subgroups, once, before a real saved order takes
  // over" shape as organizeDevPanelSubgroups() above but not hardcoded to
  // any one group name -- kept out of THIS function (which stays
  // Dev-Panel-specific) so a project supplies its own structure via
  // organizeGroupSubgroups() (below) instead of forking this file.
  if (opts.organizeSubgroups) opts.organizeSubgroups(groupsEl)
  initPanelDrag(panel, header)
  initResizeHandles(panel)

  // Delegated (not one listener per row -- there can be 100+) rename click
  // for settings labels; a group's own title is wired directly in
  // createGroupElement() instead, since collapse-toggle already lives there.
  // Capture phase so this wins before anything else attached to a label
  // (nothing currently is, but matches the template's own precaution).
  panel.addEventListener('click', (e) => {
    if (!textEditModeEnabled) return
    const label = e.target.closest('label')
    const row = label && label.parentElement
    if (!label || !row || !row.classList.contains('dp-row') || label.querySelector('textarea')) return
    const ctrl = findCtrl(row.dataset.key)
    if (!ctrl) return
    e.preventDefault()
    e.stopPropagation()
    openTextEditFor(label, ctrl.key, ctrl.label)
  }, true)

  function saveSettings() {
    const flash = (msg) => { const orig = saveBtn.textContent; saveBtn.textContent = msg; setTimeout(() => { saveBtn.textContent = orig }, 900) }
    const snapshot = { values: Object.fromEntries(DEVICES.map((d) => [d, { ...store[d] }])), order: getPanelOrder(groupsEl), textOverrides: { ...textOverrides } }
    if (opts.remoteSave) {
      remoteSaveSnapshot(opts.remoteSave, snapshot).then((result) => {
        flash(result.ok ? 'Saved!' : ('Save failed: ' + result.error))
      })
      return
    }
    try {
      localStorage.setItem(settingsKey(), JSON.stringify(snapshot))
      localStorage.setItem(currentGeomKey(), JSON.stringify(getPanelGeometry(panel)))
      flash('Saved!')
    } catch (err) { flash('Save failed') /* localStorage unavailable -- dev-only convenience */ }
  }
  // Exposes this call's own saveSettings() closure to the module-level
  // saveCurrentSettings() export below, so a host app can trigger a real
  // persisted save programmatically (e.g. a "set this as the startup
  // default" action) without simulating a click on the actual Save
  // button -- the same kind of host hook syncValue()/refreshSelectOptions()
  // already are, just for "persist now" instead of "push a value."
  saveSettingsRef = saveSettings
  function resetSettings() {
    if (opts.remoteSave) {
      fetchRemoteSettingsUntilSuccess(opts.remoteSave, (settings) => {
        applyOrder(groupsEl, settings.order)
        applyStoredValues(settings.values)
        textOverrides = settings.textOverrides || {}
        applyTextOverrides()
      })
      let remoteGeom = null
      try { remoteGeom = JSON.parse(localStorage.getItem(currentGeomKey())) } catch (err) { remoteGeom = null }
      applyPanelGeometry(panel, remoteGeom)
      return
    }
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(settingsKey())) } catch (err) { saved = null }
    if (saved) {
      applyOrder(groupsEl, saved.order)
      applyStoredValues(saved.values)
      textOverrides = saved.textOverrides || {}
      applyTextOverrides()
    }
    let geom = null
    try { geom = JSON.parse(localStorage.getItem(currentGeomKey())) } catch (err) { geom = null }
    applyPanelGeometry(panel, geom)
  }
  // Shared by Copy Settings (clipboard export) and Named Setting States
  // below ([JS-13b]-equivalent port) -- both need the exact same "entire
  // panel" snapshot shape (values for all 3 devices + group/row order +
  // text-rename overrides + per-device panel geometry, the last read from
  // localStorage for whichever 2 devices aren't the current real one,
  // since only one device can ever be "live" at a time).
  function captureFullPanelState() {
    const real = realDeviceClass()
    const panelGeometry = { [real]: getPanelGeometry(panel) }
    DEVICES.filter((d) => d !== real).forEach((d) => {
      try { panelGeometry[d] = JSON.parse(localStorage.getItem(geomKeyPrefix() + d)) } catch (err) { panelGeometry[d] = null }
    })
    return {
      values: Object.fromEntries(DEVICES.map((d) => [d, { ...store[d] }])),
      order: getPanelOrder(groupsEl),
      textOverrides: { ...textOverrides },
      panelGeometry
    }
  }
  // Applies a captureFullPanelState() snapshot live -- used by both "Use"
  // (a reversible try, see below) and "Set as Default" (which additionally
  // runs the result through saveSettings() right after). Writes the OTHER
  // 2 devices' geometry straight to their own localStorage geom keys (never
  // visually applied here, since only one device is ever live) so a later
  // switch to that device/a resize picks up this state's geometry for it
  // too, matching what Copy Settings' own multi-device capture already
  // assumes is possible.
  function applyFullPanelState(state) {
    if (!state) return
    applyOrder(groupsEl, state.order)
    applyStoredValues(state.values)
    textOverrides = { ...(state.textOverrides || {}) }
    applyTextOverrides()
    if (state.panelGeometry) {
      const real = realDeviceClass()
      if (state.panelGeometry[real]) applyPanelGeometry(panel, state.panelGeometry[real])
      DEVICES.filter((d) => d !== real).forEach((d) => {
        if (!state.panelGeometry[d]) return
        try { localStorage.setItem(geomKeyPrefix() + d, JSON.stringify(state.panelGeometry[d])) } catch (err) { /* ignore */ }
      })
    }
  }
  function copySettings() {
    const text = JSON.stringify(captureFullPanelState(), null, 2)
    const flash = (msg) => { const orig = copyBtn.textContent; copyBtn.textContent = msg; setTimeout(() => { copyBtn.textContent = orig }, 900) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash('Copied!')).catch(() => flash('Copy failed'))
    } else {
      flash('Copy failed')
    }
  }

  copyBtn.addEventListener('click', copySettings)
  saveBtn.addEventListener('click', saveSettings)
  resetBtn.addEventListener('click', resetSettings)

  // ------------------------------------------------------------------
  // Named Setting States (Save/Use/Delete/Set as Default) -- CLAUDE.md
  // §12d's optional upgrade, ported from TEMPLATE_DEV_PANEL.html's own
  // [JS-13b] (itself modeled on HANDO's buildListPickerRow(), generalized
  // from one control's own saved presets to the WHOLE panel's state).
  // Reuses captureFullPanelState()/applyFullPanelState() above -- the
  // exact same snapshot Copy/Save/Reset already use -- so a saved state
  // round-trips through the identical values/order/textOverrides/geometry
  // shape. "Use" applies a state live without touching what Save/Reset
  // would restore (a reversible "try it"); "Set as Default" applies it
  // AND runs it through saveSettings(), so it becomes what Reset/a fresh
  // load restores. A plain <select>, not a custom scrollable list widget
  // (matching the template's own simpler choice here over HANDO's richer
  // per-control picker -- no Rename requested for this whole-panel case).
  // Sits directly under the Copy/Save/Reset row by default (first group
  // in groupsEl, above "Dev Panel") -- but IS a genuine member of
  // groupsEl, built via the same createGroupElement() every other group
  // uses, specifically so it gets a real drag-handle and participates in
  // setupReorder()/getPanelOrder()/applyOrder() like any other group, per
  // direct request ("Save Dev Settings should also be movable"). Its own
  // select+button row isn't a registered dev-panel control (no data-key),
  // so captureGroup() only ever captures/restores the GROUP's own
  // position -- the select/buttons stay exactly where they already are in
  // the DOM, never touched by applyOrder()'s row-placement logic.
  const savedStatesGroup = createGroupElement('Saved Dev Settings')
  const savedStatesBody = savedStatesGroup.querySelector(':scope > .dp-group-body')
  const savedStatesSelect = el('select', null, { style: 'width:100%; margin-bottom:5px;' })
  const savedStatesBtnRow = el('div', 'dp-actions')
  const saveStateBtn = el('button', null, { type: 'button', textContent: 'Save' })
  const useStateBtn = el('button', null, { type: 'button', textContent: 'Use' })
  const deleteStateBtn = el('button', null, { type: 'button', textContent: 'Delete' })
  const setDefaultStateBtn = el('button', null, { type: 'button', textContent: 'Set Default' })
  savedStatesBtnRow.append(saveStateBtn, useStateBtn, deleteStateBtn, setDefaultStateBtn)
  savedStatesBody.append(savedStatesSelect, savedStatesBtnRow)
  groupsEl.insertBefore(savedStatesGroup, groupsEl.firstChild)

  function getSavedStates() {
    try {
      const raw = localStorage.getItem(savedStatesKey())
      return raw ? JSON.parse(raw) : {}
    } catch (err) { return {} }
  }
  function setSavedStates(states) {
    try { localStorage.setItem(savedStatesKey(), JSON.stringify(states)) } catch (err) { /* ignore -- storage full/unavailable, same tolerance as saveSettings() */ }
  }
  function renderSavedStatesList() {
    const states = getSavedStates()
    const prevValue = savedStatesSelect.value
    savedStatesSelect.innerHTML = ''
    Object.keys(states).forEach((name) => {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      savedStatesSelect.appendChild(opt)
    })
    if (states[prevValue]) savedStatesSelect.value = prevValue
  }
  function saveNamedState() {
    const name = window.prompt('Save current settings as:')
    if (!name) return
    const states = getSavedStates()
    if (states[name] && !window.confirm(`"${name}" already exists. Overwrite it?`)) return
    states[name] = captureFullPanelState()
    setSavedStates(states)
    renderSavedStatesList()
    savedStatesSelect.value = name
  }
  function useNamedState() {
    const name = savedStatesSelect.value
    if (!name) return
    const states = getSavedStates()
    if (states[name]) applyFullPanelState(states[name])
  }
  function deleteNamedState() {
    const name = savedStatesSelect.value
    if (!name) return
    if (!window.confirm(`Delete "${name}"?`)) return
    const states = getSavedStates()
    delete states[name]
    setSavedStates(states)
    renderSavedStatesList()
  }
  function setNamedStateAsDefault() {
    const name = savedStatesSelect.value
    if (!name) return
    const states = getSavedStates()
    const state = states[name]
    if (!state) return
    applyFullPanelState(state)
    saveSettings()
  }
  saveStateBtn.addEventListener('click', saveNamedState)
  useStateBtn.addEventListener('click', useNamedState)
  deleteStateBtn.addEventListener('click', deleteNamedState)
  setDefaultStateBtn.addEventListener('click', setNamedStateAsDefault)
  renderSavedStatesList()
  // `.dp-collapsed`'s own CSS only hides `.dp-body`/`.dp-resize` -- it
  // can't also shrink the PANEL's own box, for 2 separate reasons that
  // BOTH had to be fixed: `panel.style.height` is set as an explicit
  // inline px value (for resize-drag persistence, see geom restore below)
  // which always wins over a stylesheet rule, AND `.dp-panel`'s own
  // `min-height: 140px` (its floor for normal resizing) applies
  // unconditionally too, so even overriding `height` alone left the box
  // floored at 140px instead of shrinking to the header. Left unfixed,
  // collapsing hid the settings but left the panel's own box at its full
  // (or 140px-floored) pre-collapse height -- a real, reported bug ("the
  // settings disappear but the full panel is still there"). Fixed by
  // explicitly swapping BOTH `height` and `minHeight` to the header's own
  // natural height on collapse, and restoring both real (resize-drag-set)
  // values on expand.
  let heightBeforeCollapse = null
  let minHeightBeforeCollapse = null
  collapseBtn.addEventListener('click', () => {
    const collapsing = !panel.classList.contains('dp-collapsed')
    panel.classList.toggle('dp-collapsed')
    collapseBtn.textContent = panel.classList.contains('dp-collapsed') ? '+' : '–'
    if (collapsing) {
      heightBeforeCollapse = panel.style.height
      minHeightBeforeCollapse = panel.style.minHeight
      panel.style.height = header.offsetHeight + 'px'
      panel.style.minHeight = header.offsetHeight + 'px'
    } else {
      panel.style.height = heightBeforeCollapse
      panel.style.minHeight = minHeightBeforeCollapse
      heightBeforeCollapse = null
      minHeightBeforeCollapse = null
    }
  })
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'd' || e.key === 'D') panel.classList.toggle('hidden')
    else if (e.key === 'r' || e.key === 'R') resetSettings()
  })

  resetSettings() // load last-saved values/order/geometry, if any (falls back to defaults otherwise)
  // Re-apply both, in case a saved order predating either structure just
  // flattened it back out via applyOrder() above -- see
  // organizeDevPanelSubgroups()'s and organizeGroupSubgroups()'s own
  // comments for the full account. Safe to call again even when nothing
  // needed fixing (both are idempotent).
  organizeDevPanelSubgroups(groupsEl)
  if (opts.organizeSubgroups) opts.organizeSubgroups(groupsEl)
  return cfg
}
