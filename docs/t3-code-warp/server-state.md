# Server-owned terminal state for Warp in T3

Research note, Nov 10, 2026. This is a design comparison, not an implementation plan with proven cost. No server-side Warp parser or snapshot protocol has been built or benchmarked.

The T3 source comparison uses the local clone at `/Users/alexbrodsky/.t3/scratch/2026-11-10-can-you-research-how-t3-4000ee20/t3code`, pinned at commit `73fb49d0b3a61bff74aebc362fc6c17d6c0d39be`. The public source is [pingdotgg/t3code at that commit](https://github.com/pingdotgg/t3code/tree/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be).

Warp source citations refer to the working tree at `/Users/alexbrodsky/GitHub/warp`, based on `c75f182d1` with local embedded-build changes. This shares the earlier research's upstream base, but it is not a clean upstream checkout or a pinned copy of the earlier patched working tree.

Related research: [Remote Per-Thread Terminal Performance fork](t3-thread://v2/d15cb9d9-075b-4ef1-89ab-cd02514e01c7/143a8fa3-a3a4-4354-ae07-36756a5dffee). See also the [performance audit](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md) and [thread-state candidates](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/per-thread-tabs.md).

## Fixed constraints

- One Warp WASM runtime per T3 browser tab. Loading a separate runtime for each T3 thread is out of scope.
- The target is one shared Warp canvas/physical renderer per browser tab, with separate logical terminal/workspace state for each thread. Warp's current web build does not yet support that arrangement.
- A tentative cap of five Warp tabs per thread needs to account for splits: one tab may contain several terminal panes and PTY sessions.
- Server-side processing is being considered to reduce browser memory and work. It must preserve Warp's command blocks and terminal behavior; moving bytes to a server alone does not do that.

## Three different meanings of “server-side”

| Level | Server owns | Browser owns | Effect |
| --- | --- | --- | --- |
| Existing Warp host | PTY process, raw output recorder, shell metadata, saved layout and finished blocks | WASM runtime, ANSI parser, active/alternate grids, live Warp `TerminalModel`, block lifecycle and renderer | Already survives a page disconnect and can replay enough output for a new page to adopt a shell. Does not remove live terminal state from WASM. |
| T3-like terminal service | PTY, bounded raw output history, status/cwd/size metadata, attach subscriptions, sequence/resync protocol | One WASM runtime, one terminal handle per pane, parser, grid/scrollback and drawing | Better lifecycle and reconnect behavior. Still parses and retains the terminal grid in the browser. |
| Warp parsed-state service | PTY, Warp parser, canonical per-pane grid and mode state, Warp command/block lifecycle, persisted history/snapshots | One WASM runtime and renderer, fed snapshots/updates for the selected thread | Could move much terminal memory and parsing to the project host. Requires extracting Warp's app-level terminal model and defining a new state protocol. |

Keep these levels distinct in design discussions. T3 demonstrates a useful PTY/session service; it does not demonstrate server-owned terminal grids. A single WASM runtime can still have many per-terminal handles and grids, so “one runtime” alone does not bound browser memory.

## What T3 actually moves

In the pinned source, T3 has one `libghostty-vt` WASM runtime per browser page and creates a separate Ghostty terminal handle for each terminal surface. The terminal adapter README identifies `runtime.ts` as the singleton runtime and `core.ts` as the owner of per-terminal handles and render snapshots: [`apps/web/src/terminal/ghostty/README.md`](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/README.md).

T3's server owns PTYs and terminal lifecycle. Its RPC contracts include `terminal.open`, `attach`, `observe`, `write`, `resize`, `clear`, and `close`. Attach streams start with a snapshot and then deliver output and state events; snapshot metadata includes sequence, history, status, cwd, and PTY dimensions. See [`packages/contracts/src/terminal.ts`](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/packages/contracts/src/terminal.ts) and [`apps/server/src/terminal/Manager.ts`](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/server/src/terminal/Manager.ts).

T3's output path sanitizes and bounds raw terminal history, persists it, and supports attach/resync and overflow handling. The client still feeds output into `libghostty-vt` to maintain the terminal grid. Its snapshot is replayable output, not a serialized parsed grid. This design is evidence for moving PTY ownership, session metadata, bounded buffers, stream subscriptions, and reconnect coordination to the server. It is not evidence that terminal parsing or grid memory moved there.

## What Warp already has

Panelwarp's [`server.js`](/Users/alexbrodsky/GitHub/panelwarp/server.js) owns PTYs and forwards raw bytes between each shell and the browser over WebSockets. [`shellRecorder.js`](/Users/alexbrodsky/GitHub/panelwarp/shellRecorder.js) records shell bootstrap output and recent prompt/output bytes so a reloaded browser can take over a still-running shell. The recorder recognizes Warp hook markers for replay boundaries; it is not Warp's ANSI terminal model or a canonical command-block store.

Warp's WASM host persists pane layouts and completed `SerializedBlock` values through the hooks in [`app/src/platform/wasm.rs`](/Users/alexbrodsky/GitHub/warp/app/src/platform/wasm.rs). The live parser, grids, current block, prompt lifecycle, and command metadata remain in the browser's Warp app. The existing restore path therefore has saved completed blocks plus a bounded shell replay, not a complete live state that another client can query.

There is a reusable foundation, but not a ready headless service:

- [`crates/warp_terminal/src/model/ansi/mod.rs`](/Users/alexbrodsky/GitHub/warp/crates/warp_terminal/src/model/ansi/mod.rs) implements an ANSI `Processor` that delegates parsed events to a `Handler`. The processor can be reused only with a handler that maintains the relevant state and responds to events.
- Warp's integrated byte loop is in [`app/src/terminal/remote_tty/event_loop.rs`](/Users/alexbrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs). It runs the parser against the app's `TerminalModel`, collects terminal replies, and sends those replies back to the shell.
- Warp's [`TerminalModel`](/Users/alexbrodsky/GitHub/warp/app/src/terminal/model/terminal_model.rs) and [`BlockList`](/Users/alexbrodsky/GitHub/warp/app/src/terminal/model/blocks.rs) implement more than VT parsing. They coordinate Warp `Precmd`/`Preexec` hooks, current and finished blocks, command metadata, SSH/subshell sessions, completions, in-band commands, secrets, and events tied to Warp views.
- The headless TUI reuses `warp::tui_export::TerminalModel` in `/Users/alexbrodsky/GitHub/warp/crates/warp_tui/src/terminal_session_view/state.rs` and proves that the app model is not restricted to the GPU UI. However, `/Users/alexbrodsky/GitHub/warp/crates/warp_tui/Cargo.toml` depends on the `warp` app crate and WarpUI core. It is a separate text UI frontend, not a small terminal daemon or a public remote snapshot API.
- `warp_terminal::GridStorage` has serde support, but serializing a grid alone does not serialize Warp's active block lifecycle, parser carry, terminal-manager state, selection/editor UI, or all session relationships.

## Main tradeoffs and failure modes

**Session ownership and model ownership are separate.** A T3-like service plus viewer eviction can reduce browser memory by freeing inactive models and unsubscribing from their output. Models that remain attached still parse bytes in the browser, and evicted models need replay on return. A server-owned parser can additionally keep canonical state current while no viewer exists, without asking the browser to reparse all detached output.

**Offloading shifts work rather than eliminating it.** On a remote project host it moves work off the browser device. When host and browser share a machine it can improve browser responsiveness without reducing total CPU or RAM, and duplicated active models can increase total memory. Sending a full grid on each update could use more bandwidth and add latency than raw output. Prefer bounded viewport updates and coalescing, a consistent display snapshot at attach/resync, and older history loaded on demand. Keep input editing, selection, and pointer interactions local where practical for responsiveness.

**Offloading does not automatically shrink the WASM build.** A browser still loading the whole Warp application may retain unused parser/model code. Reducing the download and startup footprint would require a separate client build boundary or feature selection after the server model is extracted.

**Keep one owner for terminal replies.** Warp answers terminal queries from shell output, and shells can wait for those replies during startup. If both a server parser and browser parser respond, the shell could receive duplicate replies. If the browser must answer, the server round trip may delay it. Pick one authoritative parser/reply path and measure shell-start latency.

**Attach needs an exact stream boundary.** A snapshot must represent state through sequence `N`, and the client must then apply only updates after `N`. Otherwise reconnect can omit or replay bytes. Bound queues; when a client falls behind, discard deltas and request a fresh snapshot rather than accumulating unbounded output.

**Canonical state is larger than visible characters.** The service must preserve active and alternate screens, scrollback and blocks, cursor, dimensions, modes, attributes, hyperlinks/images where supported, parser partial escape/DCS state, shell bootstrap identity, and unfinished command lifecycle. A thin viewer needs a consistent display snapshot and references to retained history, not necessarily the server's internal parser state. If a client resumes parsing raw bytes, or a checkpoint must restart the parser, its pending state must also transfer or be reconstructed at a safe boundary. A grid alone is insufficient for that case.

**Thread switches resize the PTY.** A full-screen application depends on its PTY dimensions. The protocol must coordinate browser viewport size, server model size, and PTY resize, including multiple viewers and quick thread switches. T3 chooses among attached viewer sizes; Warp would need a compatible rule for a single active renderer with parked thread models.

**Current replay limits remain material.** Panelwarp's detached shell timeout is ten minutes, and its recorder retains bounded bootstrap/recent output. That is adequate for its current reattach design, but it cannot preserve arbitrary full-fidelity Warp block history for a thread that was never parsed or saved as canonical blocks. Server ownership only fixes this after the server actually maintains that state.

## A staged prototype

1. Establish the existing one-pane browser/PTY host as a baseline. Record what the current replay preserves and where attachment, queue bounds, and session lifetime differ from T3. A T3-like service boundary is a lower-scope option if browser models can be evicted with acceptable restoration cost.
2. The next extraction experiment is one server-owned Warp parser/model in a native Rust service. Keep the one-WASM-per-browser-tab constraint and shared renderer target. Feed the service real Warp bootstrap hooks, shell queries, alternate-screen traffic, and a full-screen app while no browser is attached; send a consistent display snapshot followed by sequenced updates when a viewer attaches. Do this before choosing a broad thread-workspace refactor.
3. Measure browser WASM memory, browser CPU, host CPU/RAM, bytes transferred, shell-start time, reattach time, and interactive latency. Compare one active pane, several panes, and multiple parked threads with idle and streaming output.
4. Decide from those results whether server parsing is worth the extraction and protocol cost. A reasonable first acceptance case is: a terminal can run a command and a full-screen program, survive a disconnect, then resume with its Warp blocks and screen correct and no duplicate terminal replies.

No code implements this parsed-state service today. The research establishes architectural boundaries and a prototype target; it does not prove feasibility, performance gains, or implementation effort.
