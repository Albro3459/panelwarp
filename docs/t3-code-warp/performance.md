# Warp in T3 web: performance audit

Research from Nov 10, 2026. The target is one persistent Warp WASM runtime per T3 browser
tab, shared by that page's thread workspaces. One runtime is a fixed requirement. A maximum
of five Warp terminal tabs per thread is a tentative product limit, not measured capacity.

This is a source and artifact audit. It did not run a browser CPU/GPU profile or edit Warp.
The inspected Warp checkout is based on commit `c75f182d1` with local embedded-build
changes, so source observations describe that working tree rather than a clean upstream
checkout. The local WASM artifact's exact source provenance is unknown. The only existing
timings below came from earlier VS Code observations, not T3 web. See [the host contract](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/panelwarp-host-contract.md),
[thread tab research](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/per-thread-tabs.md), and [T3 surface research](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/t3code-surfaces.md) for related integration details.

## Finding

Keep one WASM runtime and one rendering surface per T3 browser tab as the design target.
Load Warp when the user first opens it. Give each T3 thread separately owned workspace state
inside that runtime. This avoids repeating application startup for every thread and avoids
multiplying renderer instances.

The research does not establish the live bottleneck. It has no browser profile for CPU,
browser RSS, GPU memory, first prompt, or thread switching. Separate renderers cost
resources, but current evidence does not show rendering to be the dominant cost. The most
concrete scaling risks in the source are accumulated pane history and processing output from
hidden live panes.

Do not treat “five tabs per thread” as a resource budget. A Warp tab can contain multiple
split panes, and memory depends on each pane's grid, scrollback, blocks, and workload. A
handful of output-heavy shells may cost more than many idle shells.

## Startup and repeat visits

The current host fetches WASM bytes, uses `WebAssembly.compileStreaming`, then initializes
Warp once via wasm-bindgen's `init`
(`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:98`). A persistent frontend means
thread switches do not fetch and initialize a new Warp app. First visit to a thread can
still cost time restoring its UI state and starting or attaching shells.

The loader explicitly caches WASM response bytes in Cache Storage, keyed by URL and ETag
(`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:98`). That does not prove compiled
machine code survives a page reload. [V8 documents compiled-code caching](https://v8.dev/docs/wasm-compilation-pipeline) as an engine
optimization, while a [WASM module](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module) is stateless compiled code and a
[WASM instance](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Instance) contains runtime state. One
runtime per page avoids reinitializing Warp while that page stays open regardless of disk
code-cache behavior.

The cold loader clones the response for progress and Cache Storage
(`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:121`). The [Response.clone API](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone) tees its body stream;
a slower branch can buffer data. This could increase transient memory during cold startup,
but there is no evidence it currently causes a problem. If cold-start peak memory is high,
profile this path and consider one-pass progress/cache handling.

The branch's earlier [timing table](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/per-thread-tabs.md) reports 194 ms median for a cached load (15 observations) and
721 ms for a new build (2 observations). These are VS Code measurements and should not be
presented as T3 browser performance.

The phase names overstate their measurements. `compiled` records time since page navigation
once `compileStreaming` resolves; it is not an isolated compile duration. `initialized`
records after `init` returns. `rendered` is recorded when a `<canvas>` element exists,
before verifying that a frame was presented
(`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:53`,
`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:94`,
`/Users/alexbrodsky/GitHub/panelwarp/media/host.html:156`). The overlay fades
later. None of these markers measure the first usable shell prompt. The existing data
therefore cannot tell us network/decompression time, module instantiation time, first
visible frame, PTY host startup, or prompt latency separately.

## Artifact size and memory

The inspected artifact is `/Users/alexbrodsky/GitHub/warp/target/wasm32-unknown-unknown/release-wasm/bundle/wasm/warp_bg.wasm`. Its binary sections were read directly, without instantiating or running Warp.

The artifact is 104,263,096 bytes (99.4 MiB). Its code
section is 47,675,439 bytes (45.5 MiB), its data section is 56,382,839 bytes (53.8 MiB), and
the module declares 934 initial 64-KiB pages (61,210,624 bytes, 58.4 MiB) of linear memory.
These values came from the code section (10), data section (11), and declared memory minimum in section 5. The memory can grow during app startup. These numbers are for that local artifact only; it
may not correspond to the inspected source checkout or a reproducible clean build.

These are binary properties, not browser RSS or GPU-memory measurements. Total runtime cost
also includes compiled machine code, JS objects, temporary download/decompression buffers,
Warp's live state, and graphics allocations. The large data section deserves attribution
before trying to shrink the bundle; its contents were not analyzed here. Stripping debug
names alone would not remove most of this artifact.

Warp creates renderer resources for each platform window in [`window.rs`](/Users/alexbrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:733). Each added window therefore
risks its own graphics state. Glyph cache pages are 1024 × 1024 RGBA8, or 4 MiB of texels
each, before driver overhead. Pages are allocated as glyphs are needed, not all eagerly
(`/Users/alexbrodsky/GitHub/warp/crates/warpui/src/rendering/glyph_cache.rs:13`,
`/Users/alexbrodsky/GitHub/warp/crates/warpui/src/rendering/wgpu/texture_with_bind_group.rs:25`).
Surface buffers also depend on physical canvas size and device-pixel ratio. These facts make
extra renderers an avoidable fixed cost; they do not prove renderer memory dominates
terminal state.

The native cell-size test reports 24 bytes, but it is not a wasm32 allocation profile. Warp
has compact flat scrollback storage as well as grids, blocks, editors, searches, and other
state. Do not estimate total per-pane RAM as “rows × columns × 24 bytes.” Existing block
estimators in
[`block.rs`](/Users/alexbrodsky/GitHub/warp/app/src/terminal/model/block.rs:2894) can help
instrument state but omit some fields. Heap allocation and wasm linear-memory capacity are
not the same as process RSS; freeing objects may allow reuse without returning pages to the
browser.

## CPU, output, and rendering

The remote PTY event loop receives output and parses bytes into terminal state while a pane
is hidden (`/Users/alexbrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:341`,
`/Users/alexbrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:707`). Hidden state still needs correct terminal parsing so that returning to a thread
shows the right screen. Separately, each terminal wakeup can refresh filters, block layout,
and children before notifying the view
(`/Users/alexbrodsky/GitHub/warp/app/src/terminal/view.rs:10195`). Suppressing purely visual
work for inactive workspaces may reduce UI CPU while preserving parser state.

The earlier claim that a hidden pane causes 60 separate GPU frames each second is
unsupported. The per-pane wakeup throttle is not a count of presented frames. WarpUI
coalesces invalidated view IDs before presentation
(`/Users/alexbrodsky/GitHub/warp/crates/warpui_core/src/core/app.rs:4112`); the presenter
processes invalidations and builds a scene
(`/Users/alexbrodsky/GitHub/warp/crates/warpui_core/src/presenter.rs:318`). Hidden output
may still cause repeated wakeup-handler work or invalidate the visible scene. Measure
handler time, scene/layout time, and actual frames before labeling the renderer the
bottleneck.

The WebSocket client has no built-in receive backpressure ([MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)). The current host
forwards PTY output directly (`/Users/alexbrodsky/GitHub/panelwarp/server.js:350`), with no
app-level consumption acknowledgement in that path. During output floods, observe queued
bytes and main-thread task time. Any batching or queue bound must preserve terminal byte
order and parser correctness; dropping arbitrary ANSI bytes can corrupt screen state.
Detaching a quiet frontend also needs a sound replay/snapshot policy.

The PTY host runs `stty` once per second for attached shells whose foreground process is not
the shell (`/Users/alexbrodsky/GitHub/panelwarp/server.js:86`). This is host CPU and
process-spawn cost, separate from browser rendering. Actual dev servers, builds, and agents
consume their own host CPU and memory. Profile these separately from the Warp frontend.

## Architectural consequences

One runtime per T3 page does not automatically mean one canvas or one renderer. Native Warp
supports multiple windows under one application runtime, but its web target is effectively
single-window: creating a window attaches a canvas and may replace the canvas already in
`#wasm-container`
(`/Users/alexbrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:1263`). Each
added window initializes its own renderer resources. So one WASM runtime with a distinct
renderer per thread may still multiply GPU and UI overhead.

Conversely, one shared canvas/renderer with several thread-owned logical workspaces is not a
drop-in use of native windows. Warp's
[`WorkspaceRegistry`](/Users/alexbrodsky/GitHub/warp/app/src/workspace/registry.rs:11) maps
a window ID to one workspace. A real shared-renderer design needs explicit per-thread
workspace ownership plus correct routing for focus, persistence, notifications, pane events,
menus, and future UI features. Moving each thread's tabs into and out of one workspace could
avoid multiple renderers, but parked views and events have unresolved lifecycle assumptions.
Treat these as prototype options, not established architecture.

## Measurements to choose the work

Use one T3 browser tab and a representative environment. Record the browser, OS, device-
pixel ratio, Warp build, and T3 version. Keep shell workload and rendering workload
distinct.

1. Measure cold open, warm open, first presented frame, and first usable prompt separately.
   Timestamp response bytes, decompression, compile resolution, wasm initialization,
   renderer/font initialization, PTY host connection, shell spawn, and prompt. Repeat enough
   times to report distributions, not only one timing.

2. Starting from an empty page, add workspaces, terminal tabs, split panes, and scrollback
   separately. Record wasm memory pages, browser process memory, JS heap, GPU allocations,
   block estimates, and shell/host memory. Measure a workspace after closing and after
   restoring it.

3. Compare idle panes, ordinary dev-server output, and controlled high-volume output in both
   active and inactive workspaces. Measure PTY bytes/second, queue depth, parser time,
   wakeup-handler time, long tasks, input latency, layout/scene time, presented frames, GPU
   frame time, and host `stty` process count.

4. Switch among warm workspaces, then revisit
   a newly created or evicted workspace. Measure switch latency, prompt latency, peak and
   retained memory, replay size/time, and whether interactive programs remain correct.

Optimize in measured order. First avoid loading Warp for users who never open it; keep one
frontend alive per page. Next address any measured high-volume hidden-pane UI work and bound
resource growth with a real memory budget. Start with the shared render-surface target, then
use GPU and frame profiles to justify deeper renderer changes. Reduce artifact size or compile time if cold-open
measurements show those phases dominate user wait.

No browser profile, memory benchmark, or T3 startup measurement has been run for this audit.
The existing 194/721 ms observations are historical VS Code canvas-detection markers, not
end-to-end performance claims.
