# Per-thread tabs in one Warp instance

Research from Nov 9, 2026. Nothing is built. This doc assumes the host contract in `/Users/abrodsky/.t3/worktrees/panelwarp/t3-code-warp/docs/t3-code-warp/panelwarp-host-contract.md` and the plan in `/Users/abrodsky/.t3/worktrees/panelwarp/t3-code-warp/docs/t3-code-warp/README.md`.

Sources:

- panelwarp at `/Users/abrodsky/GitHub/panelwarp`, branch `dev` (`987b758`)
- Patched Warp at `/Users/abrodsky/GitHub/warp`, branch `vscode-panel` (`7bd5fcc6b`, upstream `c75f182` plus 67 commits)
- VS Code logs of the installed extension under `/Users/abrodsky/Library/Application Support/Code/logs/` and its storage in `/Users/abrodsky/Library/Application Support/Code/User/globalStorage/felixkrueckel.panelwarp/` (read only)

Everything was read in code or logs unless marked "unverified".

## Summary

- panelwarp runs one wasm instance per VS Code window, not one shared instance. The PTY daemon, the tab store and the wasm cache are shared. Each instance restores only its own workspace's tabs at startup and never switches.
- The wasm app has code paths for several windows, but upstream treats the web build as one window, and each window would get its own canvas and GPU context. Not a good base.
- Recommended: **D. Tab sets swapped in memory.** Each thread owns a list of live tabs. On a thread switch, Warp moves the current `tabs` vector aside and puts the target thread's vector in its place. Shells stay connected, nothing reloads, and every tab feature (tab bar, vertical tabs, Cmd+1..9, cycling, close-last-tab) keeps working without changes because it only sees the active list. Threads not yet opened on this page restore from the host store with the existing restore and adoption code. Roughly 250 to 350 Rust lines, most in one new file, plus about 100 lines of JS.

## 1. How panelwarp scopes tabs today

### One instance per VS Code window

The user's belief is half right. Each window only shows its own workspace's tabs, but each window runs its own wasm instance.

| Piece | Scope | Evidence |
| --- | --- | --- |
| Extension host (`extension.js`) | One per VS Code window (VS Code runs one extension host per window) | `/Users/abrodsky/GitHub/panelwarp/extension.js:685` sets `provider.workspace` from that window's `vscode.workspace` |
| Webview view `warp.view` with the iframe and the wasm | One per window. Kept alive while hidden with `retainContextWhenHidden: true` | `/Users/abrodsky/GitHub/panelwarp/extension.js:700`, `/Users/abrodsky/GitHub/panelwarp/extension.js:701` |
| PTY host (`daemon.js` + `server.js`) | One per extension build, shared by every window | `/Users/abrodsky/GitHub/panelwarp/daemon.js:1`, `/Users/abrodsky/GitHub/panelwarp/extension.js:232` |
| `default_cwd`, `shell`, `shell_path` | Per window, in that window's `#pty_url` fragment | `/Users/abrodsky/GitHub/panelwarp/extension.js:233`, `/Users/abrodsky/GitHub/panelwarp/extension.js:237` |
| Tab store `warp.sqlite` | Shared file, each window has its own connection | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:24`, `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:25` |
| Static origin (wasm cache) | Shared. Port kept in `globalState['warp.staticPort']` | `/Users/abrodsky/GitHub/panelwarp/extension.js:224`, `/Users/abrodsky/GitHub/panelwarp/extension.js:249` |

So two VS Code windows mean two 111 MB wasm instances, each with its own tabs. Scoping happens because each instance asks for one key at startup.

### Session key

`workspaceKey` in `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:133`:

1. `workspace.workspaceFile` (a `.code-workspace` URI), else
2. the first folder's URI, else
3. `empty-window:<uuid>`, where the uuid lives in that window's `workspaceState` under `warp.emptyWindowId`, so it survives that window's reloads (`/Users/abrodsky/GitHub/panelwarp/sessionStore.js:136`)

The key is computed once at activation (`/Users/abrodsky/GitHub/panelwarp/extension.js:685`). "The latest window wins": two windows on the same folder overwrite one row (`/Users/abrodsky/GitHub/panelwarp/sessionStore.js:92`). Commits `f882fde` and `6c20292` on `dev` added this. Branch `per-workspace-tabs` holds older copies of the same commits (`847b9e9`, `5f8ad20` and later). Its tree differs from `dev` only by the newer settings-file work.

### What is saved and restored

| Data | Where | Limits | Evidence |
| --- | --- | --- | --- |
| Layout: windows, tabs, splits with flex, custom titles, tab color, pinned, each terminal pane's uuid, cwd, focus, vertical-tabs panel open | `panel_workspace_session (workspace, json, updated_at)` | 4 MB JSON, dropped after 30 days unsaved | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:30`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:555` |
| Finished blocks per pane | `panel_blocks (pane_uuid, json, saved_at)` | 100 per pane, 4 MB per block JSON, output cut to 5000 lines | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:13`, `/Users/abrodsky/GitHub/warp/app/src/terminal/model/block.rs:111` |
| Not saved | Tab groups (`group_id: None`, `tab_groups: Vec::new()`), non-terminal panes, left and right panels, AI conversations, scroll position, the live grid | | `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:821`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:833`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:580` |

How it flows:

- Warp checks the layout every 2 s and sends it only when it changed (`AUTOSAVE_INTERVAL`, `LAST_SAVED`). `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:693`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:678`
- The save goes through `save_app` -> `host_session::save` -> `window.warpPanelSaveSession` -> `warp-save-session` -> `sessions.saveSession(this.workspace, json)`. `/Users/abrodsky/GitHub/warp/app/src/workspace/global_actions.rs:161`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:567`, `/Users/abrodsky/GitHub/panelwarp/extension.js:396`
- Each finished block is sent at once. `/Users/abrodsky/GitHub/warp/app/src/pane_group/pane/terminal_pane.rs:1018`
- At startup the host puts `sessions.load(workspace)` into the storage snapshot. Warp reads it once through `warpPanelSession()` in `initialize_app`. `/Users/abrodsky/GitHub/panelwarp/extension.js:301`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:565`, `/Users/abrodsky/GitHub/warp/app/src/lib.rs:1727`
- The restore runs through the normal desktop path: `open_from_restored` -> `RootView::new(NewWorkspaceSource::Restored)` -> `add_tab_with_pane_layout(PanesLayout::Snapshot)` per tab. `/Users/abrodsky/GitHub/warp/app/src/root_view.rs:759`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:4098`

Measured in this user's store (read only): 3 workspace rows with 1 to 2 tabs each, 297 to 604 bytes per layout, 119 blocks over 7 panes, 2 KB average and 17 KB max per block.

### How a restored pane takes over its running shell

1. Every remote pane sends its uuid as `pane=` and a restored pane also sends `cwd=`. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:307`, patch 0049 in `/Users/abrodsky/GitHub/panelwarp/warp-patches/0049-Take-over-a-pane-s-running-shell-after-a-page-reload.patch`
2. The server looks for a shell with that pane uuid and no socket. If one exists and its recorder can replay, it adopts it. If it is attached to another page, a new shell starts. If it lives in a previous build's PTY host, the socket is proxied there. `/Users/abrodsky/GitHub/panelwarp/server.js:278`, `/Users/abrodsky/GitHub/panelwarp/server.js:288`
3. Adoption sends `{"adopt": {session, session_ids, running}}`, then the replay, then `"adopted"`. `/Users/abrodsky/GitHub/panelwarp/server.js:447`
4. The replay (`shellRecorder.js`) is the shell's output from start to the end of Warp's bootstrap, the start of any SSH or subshell sessions, the latest title, then everything since the latest prompt. Warp's own in-band commands at the prompt are left out. `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:1`, `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:205`
5. Warp registers the replayed session ids, skips writing its bootstrap, drops terminal replies during the replay, and drops its own input for 1 s if a command runs. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:505`, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:98`
6. If a full-screen program runs, the server nudges the PTY size after 500 ms so it redraws. `/Users/abrodsky/GitHub/panelwarp/server.js:462`
7. Earlier finished blocks come from `panel_blocks`, not from the replay.

Measured replay sizes in `pty-host.log`: 39 takeovers, 71 KB minimum, 73 KB median, 684 KB maximum.

Two other reattach paths exist:

- A dropped socket (sleep, network change) reconnects with `session=<id>` and gets up to 2 MB of buffered output. Up to 200 tries. Patch 0026, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:90`, `/Users/abrodsky/GitHub/panelwarp/server.js:265`
- A closed tab keeps its shell during the undo window (60 s). Cmd+Shift+T brings it back running. When the close is final, Warp sends `{"close": true}` and the server kills the shell. Patch 0064, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/terminal_manager.rs:239`, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:492`, `/Users/abrodsky/GitHub/panelwarp/server.js:497`

## 2. Warp's tab model

### Data

| Item | Where |
| --- | --- |
| `Workspace` is one per window. Fields: `window_id`, `tabs: Vec<TabData>`, `active_tab_index: usize`, `tab_mru_order: Vec<EntityId>` (for Ctrl+Tab), `tab_groups: HashMap<TabGroupId, TabGroup>`, `hovered_tab_index` | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:1050` |
| `TabData`: `pane_group: ViewHandle<PaneGroup>`, mouse states, colors, `detached`, `group_id: Option<TabGroupId>`, `in_multi_selection`, `pinned` | `/Users/abrodsky/GitHub/warp/app/src/tab.rs:353` |
| `TabGroup`: id, name, color, `collapsed`, `pinned`. Behind `FeatureFlag::GroupedTabs`, which is in the default cargo features | `/Users/abrodsky/GitHub/warp/app/src/workspace/tab_group.rs:1`, `/Users/abrodsky/GitHub/warp/app/Cargo.toml:671` |
| `WorkspaceRegistry`: `WindowId -> Workspace` | `/Users/abrodsky/GitHub/warp/app/src/workspace/registry.rs:11` |

Everything indexes `self.tabs` directly. `view.rs` alone has 257 uses of `self.tabs`.

### Listing and switching

| Behavior | How | Where |
| --- | --- | --- |
| Horizontal tab bar | `tab_bar_slots()` walks all of `self.tabs`, one slot per ungrouped tab or per run of a group | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:28522` |
| Vertical tabs panel (on by default in embedded builds, patch 0004) | `visible_tabs` is every tab, or the search matches. Group members render inside a group container. Collapsed groups hide rows, but the tabs stay in `workspace.tabs` | `/Users/abrodsky/GitHub/warp/app/src/workspace/view/vertical_tabs.rs:1793`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view/vertical_tabs.rs:3099` |
| Next and previous tab | `active_tab_index ± 1` with wraparound. With a vertical-tabs search, only matches (`matching_tab_indices`). Collapsed groups are not skipped | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12282`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view/vertical_tabs.rs:1177` |
| Cmd+1..8 | `ActivateTabByNumber(n)` -> `activate_tab(n - 1)` | `/Users/abrodsky/GitHub/warp/app/src/workspace/mod.rs:549`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:24256` |
| Cmd+9 | `ActivateLastTab` | `/Users/abrodsky/GitHub/warp/app/src/workspace/mod.rs:613`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12331` |
| Activate | `activate_tab_internal`: closes the palette, sets the index, focuses, updates the title | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:5510` |
| New tab | `add_tab_with_pane_layout` inserts at `new_tab_index_and_group()`: after the current tab (joining its group) or at the end, per the `NewTabPlacement` setting | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:13121`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:13148` |
| Close tab | `close_tab` -> `remove_tab`. Panes are hidden for undo, then detached as `Closed` | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12615`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12383` |
| Close the last tab (patch 0055) | Under `remote_tty`, `remove_tab` first adds a new tab when `tabs.len() == 1`. `close_tab` no longer treats it as "last". `CloseWindow` is a no-op | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12399`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12622`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:25684` |
| Tab closes when its shell exits (patch 0050) | `{"exited"}` -> `terminal_model.exit(ShellProcessExited)` -> `pane_group::Event::Exited`. If it was the only tab, a new tab starts first | `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:533`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:16388` |
| Keep a pane alive while moving it | `remove_tab_without_undo` (no detach) and `DetachType::Moved`, used by cross-window tab drag | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:28670`, `/Users/abrodsky/GitHub/warp/app/src/pane_group/pane/mod.rs:541` |

### More than one window in the wasm build

Code paths exist, but nothing in the web build uses them.

- `open_from_restored` calls `ctx.add_window` once per saved window, so a saved layout with two windows would open two. `/Users/abrodsky/GitHub/warp/app/src/root_view.rs:780`, `/Users/abrodsky/GitHub/warp/app/src/root_view.rs:841`
- On wasm, each window makes a new winit canvas. It is appended to `<body>`, or replaces the children of `#wasm-container` if that element exists. `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:1263`
- Each window builds its own wgpu `Resources` and `Renderer` (a separate WebGL2 context and glyph atlas). `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:733`
- An upstream comment says the web build hosts a single window, and that creating another replaces `#wasm-container` and orphans the live session. `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:26745`
- `hide_window` calls winit `set_visible(false)`. Winit does not support that on the web (unverified). `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:276`
- host.html sizes every `canvas` to `100vw x 100vh`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:9`
- The host session format already carries `windows: Vec<Window>` and `active_window_index`. VS Code always sends one. `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:555`

Verdict: one canvas, one workspace in practice. Several windows might render, but focus, sizing and hiding are untested (unverified).

## 3. Designs for one instance with tabs scoped per thread

### A. Tab groups with a hidden flag

Every `TabData` gets a thread key (or reuses `group_id` with one `TabGroup` per thread). The host sends "set active group". Every place that walks or indexes `self.tabs` skips other groups.

| Item | Detail |
| --- | --- |
| Rust files | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs` (tab bar slots, next and previous, Cmd+1..9, last tab, Ctrl+Tab MRU, close other tabs, close tabs to the right, move tab left and right, drag reorder, close-last-tab in `remove_tab`, `close_tab` and the `Exited` handler, undo close, `snapshot`, restore), `/Users/abrodsky/GitHub/warp/app/src/workspace/view/vertical_tabs.rs` (render list, search matches, binding hints), `/Users/abrodsky/GitHub/warp/app/src/tab.rs` (`tab_activate_binding_name`, menus), `/Users/abrodsky/GitHub/warp/app/src/search/command_palette/tabs/data_source.rs`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs` (key in the saved layout, JS hook) |
| JS files | `/Users/abrodsky/GitHub/panelwarp/media/host.html` (message to hook, `default_cwd`), the web host's session store keyed by page with a group key per tab |
| Size | 400 to 700 lines over 15 to 20 touch points (estimate) |
| Switch latency | One frame |
| Memory and CPU | Same as D. Plus every tab-bar render and every search walks hidden tabs too |
| What the user notices | Instant switch. Any missed touch point leaks another thread's tabs. "Close other tabs" that misses the filter kills other threads' shells |
| Conflicts | Patches 0050 and 0055 count `self.tabs.len() == 1`, which must become "tabs in the active group". Upstream `view.rs` had 42 commits from Aug 5 to Oct 5, 2026 (`git log c75f182`). Tab groups and pinning are active upstream work (`c72f36d6a` on Sep 14). This design touches most of that code |

### B. Session swap

On a switch, save the current tab set, drop those tabs while their shells stay in the daemon, then restore the target set with the reload path and adopt its shells.

| Item | Detail |
| --- | --- |
| Rust files | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs` (remove every tab without `Closed` detach and without the undo stack, skip the 0055 "add a tab" step, then add tabs from a snapshot), `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs` (hook that returns the current layout now and takes a layout to restore, parse a layout at runtime), `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/terminal_manager.rs` (no `Shutdown` on this kind of detach) |
| JS files | host.html (hooks), web host (store per thread), `/Users/abrodsky/GitHub/panelwarp/server.js` (longer detached lifetime) |
| Size | 150 to 250 Rust lines, about 80 JS lines (estimate) |
| Switch latency | One WebSocket per pane, one replay per pane (73 KB median, up to 12 MB cap), parse of up to 100 saved blocks per pane, new views. Estimate 100 ms to over 1 s depending on panes and blocks (unverified). The tab bar empties and refills |
| Memory and CPU | Lowest wasm memory: only the active thread's terminal models exist. The daemon holds each detached shell's recorder (bootstrap plus tail, up to 8 + 4 MB) and up to 2 MB pending. Detached shells are not polled by `stty` |
| What the user notices | Visible reload on every switch. Scroll position, selection, find bar, open AI panels and input state are lost (input state unverified). Only the last 100 blocks per pane return, each cut to 5000 lines. Output of a running command is kept only from its prompt, middle dropped past 4 MB. After 10 minutes away, the shells are gone (`DETACHED_TIMEOUT_MS`) and the tabs come back with fresh shells |
| Conflicts | Must not trip patch 0064 (`Closed` detach sends `{"close": true}`) or patch 0055 (removing the last tab adds one). Patch 0026 reconnects a dropped socket on its own, so the pane models must be dropped, not just disconnected. Smaller upstream footprint than A |

### C. One Warp window per thread

Open a window per thread, draw only the active one.

| Item | Detail |
| --- | --- |
| Rust files | `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs` (a canvas container per window, hide with CSS), `/Users/abrodsky/GitHub/warp/app/src/root_view.rs` (open a window per thread on demand), `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs` (hook, per-window save), focus and frontmost window handling |
| JS files | host.html (canvas CSS, hook) |
| Size | 150 to 300 lines (estimate), with unknown fixes after |
| Switch latency | One frame if hiding works |
| Memory and CPU | Highest. Each window has its own WebGL2 context, renderer, glyph atlas and a full `Workspace` with its palette, settings pane and other views. Browsers cap WebGL contexts per page, around 16 in Chrome (unverified) |
| What the user notices | Instant switch if it works |
| Conflicts | Goes against an upstream assumption (`/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:26745`). Winit web hide is unsupported (unverified). A hidden `display: none` canvas may resize to 0 and shrink every PTY (unverified) |

### D. Tab sets swapped in memory (recommended)

Like A for the user, built like B. The `Workspace` keeps one live tab set per thread key. Only the active set is in `self.tabs`. On a switch, Warp moves `tabs`, `active_tab_index`, `tab_mru_order` and `tab_groups` into a map under the old key, then moves the target set in. Tabs are not closed, panes are not detached, sockets stay open. Upstream code that walks `self.tabs` needs no change, because it only ever sees the active thread.

Threads the page has not shown yet: if the host has a saved layout for that key, Warp restores it into the empty set with the same code it uses at startup (`add_tab_with_pane_layout(PanesLayout::Snapshot)` per tab, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:4130`). Panes then adopt their running shells. If there is no saved layout, Warp opens one new tab, which starts in the thread's cwd.

Work list:

| # | Change | File | Lines (estimate) |
| --- | --- | --- | --- |
| 1 | `tab_sets: HashMap<String, TabSet>` and `active_tab_set: String` fields, init | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:1050`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:3457` | 15 |
| 2 | `switch_tab_set(key, layout, ctx)`: close menus, palette and rename editors, clear hover and search, swap the vectors, restore or open a tab, activate, notify | new `/Users/abrodsky/GitHub/warp/app/src/workspace/view/tab_sets.rs` (same pattern as `tab_grouping.rs` and `startup_directory.rs`) | 100 |
| 3 | Move the restore loop out of `configure_new_workspace` into a function both paths call | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:4130` | 30 (moved code) |
| 4 | `Exited` from a parked tab: drop it from its set (today the handler finds no index and does nothing) | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:16388` | 15 |
| 5 | Tag undo-close entries with the set key, or clear them on switch, so Cmd+Shift+T does not bring thread A's tab into thread B | near `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:12793` | 10 to 20 |
| 6 | `window.warpPanelSetTabSet(key, layoutJson)` hook with the `host_settings::Reload` pattern (Closure + channel + singleton model), plus a parser from host JSON to `WindowSnapshot` and blocks, reusing `host_session::load` internals | `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:886`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:620`, `/Users/abrodsky/GitHub/warp/app/src/lib.rs:2093` | 60 to 80 |
| 7 | Save with the key: send the active set's layout with its key, and save the outgoing set once at switch time (a parked set's layout does not change) | `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:665` | 20 |
| 8 | host.html: `warp-set-thread {key, cwd, session}` -> rewrite `default_cwd` in `location.hash` with `history.replaceState`, then call the hook. Send `key` with `warp-save-session` | `/Users/abrodsky/GitHub/panelwarp/media/host.html:460`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:567` | 30 |
| 9 | Web host: store layouts by thread key (`sessionStore.js` works as is with a key like `t3-thread:<id>`), answer a layout request for a key | web host relay (new) | 40 to 60 |

Total about 250 to 350 Rust lines, about 9 touch points in existing files, about 100 JS lines.

| Item | Detail |
| --- | --- |
| Switch latency | Threads already shown on this page: one frame plus the PTY resize of the new active tab (coalesced 50 ms, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:101`). First visit of a thread with saved tabs: same as a page-reload restore for those tabs only |
| Memory | Every thread shown on this page keeps its terminal models in wasm memory, the same as background tabs today. Wasm linear memory only grows, so closing threads does not return memory to the OS (standard wasm behavior) |
| CPU | Hidden tabs cost what background tabs cost today (see section 4) |
| What the user notices | Instant switches. Each thread has its own tab bar, vertical tabs, Cmd+1..9 and cycling. Running programs keep running and their output is there on return |
| Conflicts | Patches 0050, 0055 and 0064 keep working as is, because they act on `self.tabs`, which is the active set. Upstream churn hits only the small hooks in `view.rs`. Cross-window drag code assumes one `tabs` list per window, but cross-window drag cannot happen on wasm |

Known gaps in D to handle:

- Features that look up a pane across all tabs (`activate_tab_by_pane_group_id`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:5374`, and the Agents panel's "running in Warp" status from patch 0054) will not see parked tabs. That is right for scoping. A notification click could ask the host to switch threads later
- Warp's own tab groups inside a thread work, because `tab_groups` moves with the set

### Recommendation

D, for these reasons:

1. Switch speed equals A. Nothing reloads, no sockets reconnect.
2. Patch size and upstream conflicts are close to B. Tab bar, vertical tabs, Cmd+1..9, cycling, Ctrl+Tab, close-last-tab and close-other-tabs need no change, so nothing can leak across threads.
3. Shells of shown threads stay attached, so the 10-minute detached timeout does not apply while the page is open.
4. It reuses the existing restore and adoption path (patches 0048, 0049) for the first visit of each thread.

Add later if memory grows: evict the least recently shown tab set after N sets or M minutes hidden. Eviction saves its layout, drops its views without `Closed` detach (B's path), and leaves its shells detached in the daemon. This needs B's "drop without close" step and a longer detached lifetime.

Uncertain:

- Whether parked `PaneGroup` views have code that assumes they are in `self.tabs` (subscriptions, `WorkingDirectoriesModel`, AI models). Found one case (`Exited`), more are likely (unverified)
- Restore at runtime calls code written for window creation. That it has no startup-only state is unverified
- Memory per thread was not measured

## 4. Cost of a hidden tab

| Question | Answer | Evidence |
| --- | --- | --- |
| Is PTY output parsed while hidden? | Yes. Each pane's WebSocket stream feeds `process_pty_bytes`, which runs the ANSI parser into the terminal model whether or not the tab shows | `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:341`, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:707` |
| Does it trigger renders? | Yes. Each wakeup (throttled to 60 per second per pane) runs `handle_terminal_wakeup`, which always ends with `ctx.notify()`. A notify on any view invalidates its window. The window then re-renders that view and lays out and paints the whole visible tree | `/Users/abrodsky/GitHub/warp/app/src/terminal/view.rs:620`, `/Users/abrodsky/GitHub/warp/app/src/terminal/view.rs:3803`, `/Users/abrodsky/GitHub/warp/app/src/terminal/view.rs:10195`, `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/core/app.rs:4112`, `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/presenter.rs:318` |
| Redraw only on change? | Yes. A frame is requested only when a window is invalidated. "An invalidation will repaint the entire element tree for that window" | `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/core/app.rs:2679`, `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/core/mod.rs:194`, `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:1715` |
| Timers | Cursor blink (500 ms) runs only in the focused editor of the active window. A long-running block sends one delayed wakeup. Reconnect timers only after a drop | `/Users/abrodsky/GitHub/warp/app/src/editor/view/mod.rs:136`, `/Users/abrodsky/GitHub/warp/app/src/editor/view/mod.rs:7575`, `/Users/abrodsky/GitHub/warp/app/src/terminal/model/block.rs:2552` |
| Host side | While attached, the server runs `stty` once per second for every shell whose foreground process is not the shell, until it sees a password prompt. Detached shells skip it | `/Users/abrodsky/GitHub/panelwarp/server.js:86` |
| Memory hints | 24 bytes per grid cell. Up to 50,000 rows per block by default (`terminal.maximum_grid_size`). Restored blocks: 100 per pane, 5000 lines each. Daemon per shell: replay median 73 KB measured, caps 8 MB bootstrap + 4 MB tail, plus 2 MB pending while detached. No per-tab measurement exists | `/Users/abrodsky/GitHub/warp/crates/warp_terminal/src/model/grid/cell_tests.rs:14`, `/Users/abrodsky/GitHub/warp/app/src/terminal/settings.rs:153`, `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:26` |

So an idle hidden tab costs memory and almost no CPU. A hidden tab with streaming output (a dev server, a build) parses all of it and causes up to 60 repaints per second of the visible tab. With D, many threads running dev servers multiply this, plus one `stty` spawn per second per running command in the daemon.

Cheap follow-ups:

- Skip `ctx.notify()` in `handle_terminal_wakeup` for panes not in the active tab and notify once when the tab becomes active (needs a way for the view to know, unverified)
- Turn the `stty` poll off or slow it for shells whose pane is in a parked set
- After load, host.html leaves `#loading` at `opacity: 0` with the infinite `pulse` animation still on `.mark`. It could set `display: none` after the fade. `/Users/abrodsky/GitHub/panelwarp/media/host.html:17`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:18`

When the T3 drawer hides the iframe, browsers may throttle `requestAnimationFrame` in hidden cross-origin iframes (unverified). WebSocket messages still arrive, so parsing continues.

## 5. Startup cost

### Measured

host.html logs phase times, in ms from the iframe's page start, through `warp-loaded` (`/Users/abrodsky/GitHub/panelwarp/media/host.html:91`, `/Users/abrodsky/GitHub/panelwarp/extension.js:287`). From the VS Code output logs (for example `/Users/abrodsky/Library/Application Support/Code/logs/20261109T160014/window1/exthost/output_logging_20261109T160015/1-Warp Terminal for VS Code.log`), 17 loads today:

| Source | Loads | Cache checked | Settings received | Compiled | Canvas shown |
| --- | --- | --- | --- | --- | --- |
| Cache Storage hit | 15 | 10 ms median | 21 ms | 151 ms median (129 to 240) | 194 ms median (172 to 409) |
| Network (new wasm build, 14 MB brotli from localhost) | 2 | 238 ms | 466 ms | 533 ms | 721 ms |

"Canvas shown" is when the `<canvas>` exists. It does not include the shell prompt, the VS Code webview itself, or the PTY host start. Prompt time was not measured.

Not measured anywhere: wasm instance memory, linear memory size, renderer RSS. The memory monitor watches VS Code processes and warns above `host.memory_warning_gb` (default 3.5 GB, `/Users/abrodsky/GitHub/panelwarp/panelSettings.js:24`). Its comment says VS Code crashed one process at about 3.2 GB (`/Users/abrodsky/GitHub/panelwarp/memoryMonitor.js:106`). That is about VS Code processes in general, not Warp.

### How the compiled code stays cached

1. Stable origin: the static port is saved in `globalState['warp.staticPort']` and reused. A taken port falls back to a random one, which means a cold cache. `/Users/abrodsky/GitHub/panelwarp/extension.js:229`, `/Users/abrodsky/GitHub/panelwarp/server.js:585`
2. `ETag: "<size>-<mtimeMs>"` with `Cache-Control: no-cache`, 304 on match. `/Users/abrodsky/GitHub/panelwarp/server.js:118`, `/Users/abrodsky/GitHub/panelwarp/server.js:555`
3. `?wasm=<etag>` in the page URL lets host.html skip the `HEAD` request. `/Users/abrodsky/GitHub/panelwarp/extension.js:556`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:101`
4. host.html keeps the wasm in Cache Storage (`warp-wasm`), replaces old copies, and compiles with `compileStreaming(response)`, which lets the browser reuse its compiled code. `/Users/abrodsky/GitHub/panelwarp/media/host.html:98`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:148`

For T3: pin the static port, pass `wasm=<etag>`, and keep the iframe origin the same across T3 restarts.

### Lazy first open versus a hidden preload

| | Lazy first open | Preload in a hidden iframe |
| --- | --- | --- |
| Time to canvas on first terminal open | About 0.2 s from cache, about 0.7 s after a new build (measured in VS Code), plus shell start | About 0 |
| Cost when the user never opens a terminal | None | The full instance memory (not measured) and background compile CPU on every T3 page load |
| Risk | None new | A `display: none` iframe gives the canvas 0 size. Shells may start at a tiny size and then resize (unverified). Use an offscreen iframe with real size instead |

Lazy load is cheap enough. A preload after T3 is idle is an option if 0.2 s matters (opinion).

## 6. cwd for new tabs at runtime

- Patch 0061 stops new tabs from inheriting the active tab's directory under `remote_tty`. `/Users/abrodsky/GitHub/warp/app/src/workspace/view/startup_directory.rs:94`
- A new tab then sends no `cwd`, unless the user set a custom startup directory in Warp's settings, which still wins. `/Users/abrodsky/GitHub/warp/app/src/workspace/view/startup_directory.rs:160`
- The server uses `cwd` if it exists, else `default_cwd` from the URL, else its own `cwd` option (`$HOME`). `/Users/abrodsky/GitHub/panelwarp/server.js:314`
- Split panes inherit the current pane's directory (`NewSessionSource::SplitPane`), which stays inside the thread. `/Users/abrodsky/GitHub/warp/app/src/pane_group/mod.rs:6634`

`default_cwd` is not read once. `create_session_endpoint()` reads `window.location.hash` every time a pane opens a session (`/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:43`, called from `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:315`). Nothing in Warp listens for `hashchange` or `popstate` (searched `app/src` and `crates`).

Smallest change, no Rust: host.html handles a new message, for example `warp-set-default-cwd {cwd}`, and rewrites the `default_cwd` parameter inside `#pty_url=...` with `history.replaceState`. The next new tab starts there. Keep `token`, `shell` and `shell_path` as they are, because `remote_shell_type()` also reads the hash (`/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:58`).

Per active group: with design D, the active thread is the only place a new tab can open, so updating `default_cwd` on every thread switch is enough. With design A, the same holds as long as new tabs always join the active group.

## 7. Daemon limits for many threads

| Constant | Value | Effect with many threads | Where |
| --- | --- | --- | --- |
| `DETACHED_TIMEOUT_MS` | 10 min | A shell with no page dies after this. With D, shown threads stay attached while the page is open. After the T3 page closes or reloads, every thread's shells die after 10 min, and their tabs restore later with fresh shells and saved blocks | `/Users/abrodsky/GitHub/panelwarp/server.js:60` |
| `DETACHED_BUFFER_BYTES` | 2 MB | Output buffered for a dropped socket. Not used for adoption, which uses the recorder | `/Users/abrodsky/GitHub/panelwarp/server.js:61` |
| `IDLE_EXIT_MS` | 5 min (checked every 10 s) | The daemon exits with no shells and no page requests | `/Users/abrodsky/GitHub/panelwarp/daemon.js:12` |
| Max shells | None | No cap anywhere | `/Users/abrodsky/GitHub/panelwarp/server.js:239` |
| `MAX_BOOTSTRAP_BYTES` | 8 MB | A shell that prints more before its bootstrap ends cannot be adopted | `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:26` |
| `TAIL_HEAD_BYTES`, `MAX_TAIL_BYTES` | 256 KB, 4 MB | Output since the latest prompt kept for adoption, middle dropped | `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:29` |
| `PASSWORD_POLL_MS` | 1 s | One `stty` per running command per second while attached | `/Users/abrodsky/GitHub/panelwarp/server.js:78` |
| `MAX_BLOCKS_PER_PANE` | 100 | Blocks restored per pane | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:13` |
| `MAX_AGE_MS` | 30 days | Layouts and blocks of threads not saved for 30 days are dropped | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:15` |
| Previous PTY hosts | 5 | After an update, older hosts keep their shells and the new one proxies to them | `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:99` |
| Warp reconnect tries | 200 | Per pane after a drop | `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:90` |

Threads not looked at for hours:

- D, page open: their shells keep running and stay attached. Their output keeps being parsed into wasm memory. Nothing times out.
- D, page closed, or B: shells are detached and die 10 min later. The tabs return later with fresh shells in their saved cwd and saved blocks. Running programs (dev servers, agents) are lost.

Constants to make settings: `DETACHED_TIMEOUT_MS` (with "never" as an option for T3), `IDLE_EXIT_MS`, `PASSWORD_POLL_MS` or an off switch, a new max shells or max tab sets limit, and `MAX_BLOCKS_PER_PANE` and `MAX_AGE_MS` in the store. The recorder caps can stay.

## Surprises

- The `#pty_url` fragment is read for every new session, so the cwd for new tabs can change at runtime with no Warp patch.
- Upstream already has tab groups (`TabData::group_id`, `TabGroup`, on by default). panelwarp's host session drops them on save. `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:833`
- A hidden tab with streaming output repaints the visible tab up to 60 times per second. This affects panelwarp today, not only the T3 plan.
- The `stty` poll runs every second for every attached shell that runs a command. With many threads running dev servers, that adds up.
- `Workspace` already moves tabs in and out of `self.tabs` without killing panes for cross-window drag (`remove_tab_without_undo`, `insert_transferred_tab_at_index`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:28442`). That is the precedent for design D.
