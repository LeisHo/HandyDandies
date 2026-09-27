// ============================================================================
// visibility-tick-loop.js — a generic, dependency-free, drop-in helper for
// ANY requestAnimationFrame-based render/animation loop.
// ============================================================================
// Origin: built for the "3JS ENGINE" project (J:\CLAUDE\PROJECTS\3JS ENGINE)
// to fix 2 real, reported bugs in its own render loop and demo animation
// loop, then generalized into this standalone file specifically so it can
// be copied into ANY OTHER project with the same problem (HANDY DANDIES,
// CLICKO, HANDYSET, or any future one) -- confirmed, by direct investigation
// of all 3 of those projects' own source, that NONE has any existing
// mechanism for this (every one of their rAF loops is an independent,
// unconditional `requestAnimationFrame(loop)` recursion with no visibility
// or focus awareness at all; see the CURSOR/MOUSE TRACKING section below for
// the same finding about mouse-position tracking specifically). If you are
// reading this from a different project: this file has no dependency on
// 3JS ENGINE, Three.js, or anything else — copy the file itself, add the
// one <script> tag described below, and call registerTick(). Nothing else
// is required.
//
// WHAT PROBLEM THIS SOLVES
// -------------------------
// A raw `requestAnimationFrame` loop does NOT stop when its tab is hidden
// (a background tab, a minimized window) — browsers throttle it (commonly
// to ~1 callback/sec) but keep firing it. That's real, wasted CPU/GPU work
// for frames nobody can see, AND it means any consumer computing its own
// per-frame delta-time from `now` (e.g. `dt = (now - lastTime) / 1000`)
// will see one huge `dt` the moment something visible happens again --
// read literally as "advance this animation by however many seconds/
// minutes the tab was hidden," which looks like a sudden jump (an orbit
// animation snapping forward, a countdown skipping ahead, physics
// exploding).
//
// Being COVERED by another on-screen application window is a DIFFERENT
// problem that `document.hidden` alone does NOT catch — the tab is still
// the active tab in a still-"visible" browser window, so `document.hidden`
// stays false even though nothing on screen is actually looking at it.
// There is no standard browser API for genuine on-screen occlusion
// (browsers deliberately don't expose "is another app drawn on top of me,"
// for privacy/security reasons). The closest available, and the standard,
// widely-used proxy is `document.hasFocus()` / the window's own `blur`/
// `focus` events: bringing another application window to the front almost
// always takes OS focus away from the browser at the same moment a user
// covers it, so the two track together in the overwhelming majority of
// real cases. This file treats "paused" as EITHER signal (hidden OR
// unfocused) rather than `document.hidden` alone.
//
// Known, disclosed gaps in the focus-based proxy (not silently assumed
// away): (1) an exotic non-activating always-on-top overlay could visually
// cover the page without ever stealing OS focus — there is no way to
// detect that from web content at all; (2) opening the browser's own
// DevTools (docked or undocked) and clicking into it also clears
// `document.hasFocus()`, pausing the loop even though the page itself is
// still fully visible on screen — expected, not a bug, but worth knowing
// if a loop appears to "pause" while DevTools has focus.
//
// This file centralizes ALL of the above in one place:
//   1. While the page is paused (hidden OR unfocused), the shared rAF chain
//      stops rescheduling itself completely -- zero callbacks fire, zero
//      CPU/GPU cost, for every consumer, until it's active again.
//   2. The moment it becomes active again, the internal "last tick time" is
//      discarded (not just clamped) -- so the very next tick's `dt` is a
//      normal small value, and every consumer's own animation resumes
//      exactly where it left off instead of jumping forward to "catch up"
//      for the wall-clock time that passed while paused.
//
// Every project's OWN callback still decides what "paused" actually means
// for its own content (stop advancing a rotation, stop a countdown, still
// render a static last frame, whatever) -- this file only decides WHEN
// that callback is allowed to run, not what it does.
//
// CURSOR/MOUSE TRACKING -- a separate thing this file does NOT do for you
// -------------------------------------------------------------------------
// A raw `requestAnimationFrame` loop isn't the only kind of "keeps running
// while paused" cost. A project that tracks the cursor via its own
// `window.addEventListener('pointermove'/'mousemove', ...)` handler,
// writing straight into shared state read by the render loop every frame
// (e.g. a `cursorNDC` vector driving camera look or parallax), has the
// SAME class of problem: that handler keeps updating shared state for
// input the user can no longer see reacting to it, and depending on what
// consumes that state, a stale-vs-fresh mismatch across a pause/resume
// boundary can produce its own visible snap, exactly like the raw-rAF dt
// jump this file was built to fix.
//
// Investigated directly (not from docs/memory) whether HANDY DANDIES or
// HANDYSET already solve this, since the user believed they did: NEITHER
// does. Both track the cursor completely unconditionally (HANDY DANDIES'
// own `window.addEventListener('pointermove', ...)` writing straight into
// `cursorNDC`, no visibility/focus check at all; HANDYSET's own
// `handleMouseMoveFallback()`, same pattern) and gate their render loops
// only on a manual, user-toggled "Global Pause" button -- not on
// `document.hidden`/`hasFocus()`/`visibilitychange` anywhere. So there is
// no existing pattern here to port; this is a fresh recommendation, not a
// generalization of something already proven elsewhere.
//
// This file can't fix that FOR a consuming project (it doesn't know what
// state a project's own cursor tracker writes to, or how that state gets
// consumed), but it exposes exactly what's needed to fix it consistently
// with the rest of this mechanism: `window.VisibilityTickLoop.isPaused()`
// -- the SAME hidden-OR-unfocused signal the tick loop itself already
// uses. A project with its own persistent cursor tracker should gate it
// the same way, e.g.:
//
//   window.addEventListener('pointermove', (e) => {
//       if (window.VisibilityTickLoop.isPaused()) return; // don't track while hidden/covered
//       cursorNDC.set(/* ... */);
//   });
//
// -- so cursor-driven content stops being updated for the same reason, and
// over the same window, as everything else this file already pauses.
//
// USAGE
// -----
// 1. Copy this file into the target project (anywhere -- e.g. `lib/`).
// 2. Load it as a PLAIN script (NOT type="module"), before any module or
//    script that calls registerTick() -- this is what makes it reachable
//    from BOTH plain `<script>` code AND `type="module"` code in the same
//    page: a plain script's top-level declarations attach to `window`,
//    which any later script (module or not) can read.
//      <script src="lib/visibility-tick-loop.js"></script>
// 3. From ANY other script (module or plain) loaded AFTER the tag above:
//      const unregister = window.VisibilityTickLoop.registerTick((dt, now) => {
//        // dt: seconds since this SAME callback's own last active tick
//        //     (clamped to a sane per-frame maximum, and reset to 0 for
//        //     the first tick after a resume -- never the raw wall-clock
//        //     gap while paused).
//        // now: performance.now() timestamp of this tick, for consumers
//        //      that also want an absolute clock (e.g. FPS sampling).
//        controls.update();
//        renderer.render(scene, camera);
//      });
//      // later, if this specific consumer needs to stop (e.g. a demo
//      // mode being torn down) without affecting any other registered
//      // tick sharing this same loop:
//      unregister();
//
// Every registered callback shares ONE requestAnimationFrame chain and ONE
// set of pause/resume listeners for the whole page -- a project with
// several independent loops (e.g. a main render loop AND a separate demo/
// overlay animation loop, exactly 3JS ENGINE's own case) registers each of
// them here instead of each maintaining its own rAF id, its own pause
// check, and its own resume-reset logic. Registering a 2nd or 3rd consumer
// costs one more function call per frame, not one more rAF chain.
//
// A callback that throws is caught and logged, not allowed to break every
// OTHER registered callback sharing this same loop.
// ============================================================================
(function () {
    if (window.VisibilityTickLoop) return; // idempotent if this file is ever included twice

    // Paused whenever the tab itself isn't the visible one (a background
    // tab, a minimized window) OR the browser window isn't the OS-focused
    // one (covering the "another app window drawn on top" case) -- see the
    // header comment above for exactly why both signals are checked, and
    // the known gaps in the focus-based proxy.
    function isPaused() {
        return document.hidden || !document.hasFocus();
    }

    const callbacks = new Set();
    const resumeCallbacks = new Set();
    // null means "the next tick should report dt=0" -- true both before the
    // very first tick ever runs, and immediately after a resume-from-pause.
    let lastTime = null;
    let rafId = null;
    let wasPaused = isPaused();

    function tick(now) {
        rafId = null;
        // Checked FIRST, before anything else: if the page became paused
        // between this frame being scheduled and now, do not run any
        // callback and do not reschedule -- handlePauseStateChange() below
        // is solely responsible for restarting the chain once active
        // again. At most one already-queued frame can still fire right at
        // the moment the state flips; this check ensures it does no work.
        if (isPaused()) return;
        const dt = lastTime === null ? 0 : Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;
        callbacks.forEach(cb => {
            try { cb(dt, now); } catch (err) { console.error('[VisibilityTickLoop] a registered tick callback threw', err); }
        });
        schedule();
    }

    function schedule() {
        if (rafId === null && !isPaused() && callbacks.size > 0) {
            rafId = requestAnimationFrame(tick);
        }
    }

    // Shared by all 3 real-world ways the paused state can change:
    // visibilitychange (tab switched/minimized), window blur (another app
    // window took OS focus), window focus (it came back). Re-derives the
    // current state and only acts on an ACTUAL transition -- more than one
    // of these events can fire for the same real change (e.g. minimizing a
    // window commonly fires both visibilitychange and blur), and this
    // guard keeps a single change from double-resetting lastTime or
    // double-firing onResume callbacks.
    function handlePauseStateChange() {
        const paused = isPaused();
        if (paused === wasPaused) return;
        wasPaused = paused;
        if (paused) return; // tick()/schedule() already stop themselves; nothing else to do
        // Discards the entire paused-duration gap instead of letting it be
        // read as one huge dt on the next tick -- this is what makes every
        // registered consumer's own animation resume exactly where it left
        // off rather than jumping forward to "catch up".
        lastTime = null;
        resumeCallbacks.forEach(cb => {
            try { cb(); } catch (err) { console.error('[VisibilityTickLoop] a registered onResume callback threw', err); }
        });
        schedule();
    }

    document.addEventListener('visibilitychange', handlePauseStateChange);
    window.addEventListener('blur', handlePauseStateChange);
    window.addEventListener('focus', handlePauseStateChange);

    window.VisibilityTickLoop = {
        // Registers `cb(dt, now)` to run on every tick while active
        // (neither hidden nor unfocused). Returns a function that
        // unregisters ONLY this callback -- other consumers sharing this
        // same loop are unaffected.
        registerTick(cb) {
            callbacks.add(cb);
            schedule();
            return () => callbacks.delete(cb);
        },
        // For a consumer that wants to react to "just became active again"
        // directly (e.g. to re-sync something not driven by dt at all)
        // without polling isPaused() on its own. Returns an unregister
        // function, same shape as registerTick().
        onResume(cb) {
            resumeCallbacks.add(cb);
            return () => resumeCallbacks.delete(cb);
        },
        // The same hidden-OR-unfocused signal this file's own tick loop
        // gates on, exposed for anything else on the page that should stop
        // doing work under the same conditions -- e.g. a persistent
        // cursor/mouse-position tracker (see the CURSOR/MOUSE TRACKING
        // section in this file's header comment for a concrete example).
        isPaused,
    };
})();
