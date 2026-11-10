# WIP: per-thread state in one Warp runtime

Original source research from Nov 9, 2026, revised Nov 10. Nothing is built. The fixed requirement is one WASM runtime per T3 browser tab. The earlier tab-set swap is an implementation candidate, not a proven performance winner. Current decisions are in the [overview](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/README.md), with separate [performance evidence](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md) and [server-state options](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/server-state.md).

Sources:

- panelwarp at `/Users/abrodsky/GitHub/panelwarp`, branch `dev` (`987b758`)
- Patched Warp at `/Users/abrodsky/GitHub/warp`, branch `vscode-panel` (`7bd5fcc6b`, upstream `c75f182` plus 67 commits)
- VS Code logs of the installed extension under `/Users/abrodsky/Library/Application Support/Code/logs/` and its storage in `/Users/abrodsky/Library/Application Support/Code/User/globalStorage/felixkrueckel.panelwarp/` (read only)

Everything was read in code or logs unless marked "unverified".

## Summary

- panelwarp runs one wasm instance per VS Code window, not one shared instance. The PTY daemon, the tab store and the wasm cache are shared. Each instance restores only its own workspace's tabs at startup and never switches.
- Native Warp has multiple windows inside one app runtime. Its web build assumes one window, and creating physical windows also creates renderer resources. A logical thread workspace need not be a physical window or another runtime.
- The current target is independent thread ownership inside one runtime, preferably sharing one physical canvas and renderer. Five tabs per thread is a possible product limit. It does not bound all panes, histories, or retained thread models.
- **D. Tab sets swapped in memory** was the original recommendation. It avoids changing many tab-list consumers, but it parks live tabs outside the Workspace's active list. Background events and future workspace features can violate that assumption. The line-count estimate and switch latency need a prototype.
- **E. Independent logical workspaces** and **F. Server-owned state** are now research candidates. T3's Ghostty implementation already separates host session lifetime from browser model lifetime, while sharing one WASM runtime. Avoid creating one runtime per thread or project.

## Terms and ownership

An app runtime owns application state and execution. A physical window owns a render surface, while a Workspace owns tabs and window UI state. A pane owns a terminal model, and the PTY host owns the shell. Those scopes coincide in some web paths today, but they are different concepts.

Keep logical thread identity scoped by environment and thread, even when several threads share one project. Their worktrees and terminal state can differ. A project-wide runtime would still need this thread isolation. Runtime scope remains the T3 browser tab, including when that tab switches projects or environments.

## 1. How panelwarp scopes tabs today

### One instance per VS Code window

Each VS Code window shows its own workspace's tabs and runs its own WASM application.

| Piece | Scope | Evidence |
| --- | --- | --- |
| Extension host (`extension.js`) | One per VS Code window (VS Code runs one extension host per window) | `/Users/abrodsky/GitHub/panelwarp/extension.js:685` sets `provider.workspace` from that window's `vscode.workspace` |
| Webview view `warp.view` with the iframe and the wasm | One per window. Kept alive while hidden with `retainContextWhenHidden: true` | `/Users/abrodsky/GitHub/panelwarp/extension.js:700`, `/Users/abrodsky/GitHub/panelwarp/extension.js:701` |
| PTY host (`daemon.js` + `server.js`) | One per extension build, shared by every window | `/Users/abrodsky/GitHub/panelwarp/daemon.js:1`, `/Users/abrodsky/GitHub/panelwarp/extension.js:232` |
| `default_cwd`, `shell`, `shell_path` | Per window, in that window's `#pty_url` fragment | `/Users/abrodsky/GitHub/panelwarp/extension.js:233`, `/Users/abrodsky/GitHub/panelwarp/extension.js:237` |
| Tab store `warp.sqlite` | Shared file, each window has its own connection | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:24`, `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:25` |
| Static origin (wasm cache) | Shared. Port kept in `globalState['warp.staticPort']` | `/Users/abrodsky/GitHub/panelwarp/extension.js:224`, `/Users/abrodsky/GitHub/panelwarp/extension.js:249` |

Two VS Code windows mean two running WASM applications, each with its own tabs. The earlier 111 MB figure described a WASM file, not the RAM cost of one instance. No per-instance browser memory measurement was made. Scoping happens because each instance asks for one key at startup.

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

Current behavior is one canvas and one workspace in practice. Several physical windows might render, but focus, sizing, hiding, and duplicated renderer memory are untested. Independent logical workspaces on one physical surface require different plumbing: the [registry](/Users/alexbrodsky/GitHub/warp/app/src/workspace/registry.rs:11) currently maps one Workspace per WindowId.

## 3. Designs within one runtime

The estimates below describe the original source-based candidates. None was implemented or benchmarked, and they do not establish which architecture performs best. Keeping every visited thread live is a separate retention choice, not a consequence of sharing one runtime.

### A. Tab groups with a hidden flag

Every `TabData` gets a thread key (or reuses `group_id` with one `TabGroup` per thread). The host sends "set active group". Every place that walks or indexes `self.tabs` skips other groups.

| Item | Detail |
| --- | --- |
| Rust files | `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs` (tab bar slots, next and previous, Cmd+1..9, last tab, Ctrl+Tab MRU, close other tabs, close tabs to the right, move tab left and right, drag reorder, close-last-tab in `remove_tab`, `close_tab` and the `Exited` handler, undo close, `snapshot`, restore), `/Users/abrodsky/GitHub/warp/app/src/workspace/view/vertical_tabs.rs` (render list, search matches, binding hints), `/Users/abrodsky/GitHub/warp/app/src/tab.rs` (`tab_activate_binding_name`, menus), `/Users/abrodsky/GitHub/warp/app/src/search/command_palette/tabs/data_source.rs`, `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs` (key in the saved layout, JS hook) |
| JS files | `/Users/abrodsky/GitHub/panelwarp/media/host.html` (message to hook, `default_cwd`), the web host's session store keyed by page with a group key per tab |
| Size | 400 to 700 lines over 15 to 20 touch points (estimate) |
| Switch latency | Expected in-memory switch, unmeasured |
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
| Memory and CPU | Limits live frontend models to the active thread. Relative memory savings are unmeasured, and the WASM allocator may reuse freed memory without shrinking linear memory. The daemon holds detached recorders and pending output. Detached shells skip the password poll |
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
| Memory and CPU | Duplicates renderer resources, glyph caches, and a full Workspace per physical window. The actual GPU/RAM cost and its ranking against other designs have not been measured |
| What the user notices | Instant switch if it works |
| Conflicts | Goes against an upstream assumption (`/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:26745`). Winit web hide is unsupported (unverified). A hidden `display: none` canvas may resize to 0 and shrink every PTY (unverified) |

### D. Tab sets swapped in memory

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
| 7 | Save with the key: send the active set's layout with its key, save at switch time, and handle parked-set changes such as shell exits and directory updates | `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:665` | Original estimate 20, lifecycle coverage unverified |
| 8 | host.html: `warp-set-thread {key, cwd, session}` -> rewrite `default_cwd` in `location.hash` with `history.replaceState`, then call the hook. Send `key` with `warp-save-session` | `/Users/abrodsky/GitHub/panelwarp/media/host.html:460`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:567` | 30 |
| 9 | Web host: store layouts by an environment/thread key, such as `t3-thread:<environmentId>:<threadId>`, and answer a layout request for that key | web host relay (new) | 40 to 60 |

Original estimate: about 250 to 350 Rust lines, about 9 touch points in existing files, and about 100 JS lines. This is not a validated estimate for lifecycle correctness, independent workspaces, or server-owned models.

| Item | Detail |
| --- | --- |
| Switch latency | An already live set should avoid application startup and replay, but the proposed one-frame switch has not been measured. First restoration still creates models, replays history, and may start or attach shells |
| Memory | An unbounded map retains every visited thread's models. Eviction can allow heap reuse, but there is no portable WASM linear-memory shrink operation or guarantee that browser RSS immediately falls |
| CPU | Hidden tabs cost what background tabs cost today (see section 4) |
| What the user notices | Intended behavior is fast switches and a thread-specific tab bar, cycling, and live shells. Correct restoration and background lifecycle handling remain unverified |
| Conflicts | Much active-tab code could stay intact. Parked-tab exits, saving, pane lookup, undo-close, focus, notifications, and future workspace features still need review |

Known gaps in D to handle:

- Features that look up a pane across all tabs (`activate_tab_by_pane_group_id`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:5374`, and the Agents panel's "running in Warp" status from patch 0054) will not see parked tabs. That is right for scoping. A notification click could ask the host to switch threads later
- Warp's own tab groups inside a thread work, because `tab_groups` moves with the set

### E. Independent logical workspaces on one render surface

Keep thread-owned tabs and UI state in separate logical workspaces, then select which workspace the shared physical window renders. This preserves a complete ownership boundary instead of parking tabs outside their owning list.

This is a proposed refactor. The existing WindowId-to-Workspace registry, focus routing, session saving, and global pane lookup need to understand it. Native multi-window support shares an app runtime but creates separate renderers, so it is not a drop-in implementation of this design.

### F. Server-owned Warp state

Keep shells and parsed terminal/block state in a native service beside T3. The one browser runtime renders the active workspace and requests snapshots, changed content, and history as needed. Background sessions need no continuously live frontend model.

This requires a new state service and synchronization protocol. The existing host owns shells and replay bytes, while the browser currently builds Warp's blocks. T3's own server also retains raw history rather than a parsed terminal screen. See [server-owned state](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/server-state.md) for the extraction boundary and prototype.

### Current recommendation

Keep one browser runtime as the fixed constraint and evaluate explicit thread ownership before choosing the representation. Prototype a server-owned model for one pane and a shared-render-surface workspace switch. Use actual memory and output-processing profiles to decide how much frontend state to retain.

A T3-like bounded viewer cache is useful even if the parser initially stays in the browser. Eviction saves the layout and drops views without closing shells, then restores from retained state on return. The current ten-minute detached timeout and truncated replay are not sufficient for an indefinite, exact-state guarantee. Define longer session lifetimes, recovery fidelity, and page-wide history/pane budgets as part of the design.

Uncertain:

- Whether parked `PaneGroup` views have code that assumes they are in `self.tabs` (subscriptions, `WorkingDirectoriesModel`, AI models). Found one case (`Exited`), more are likely (unverified)
- Restore at runtime calls code written for window creation. That it has no startup-only state is unverified
- Memory per thread was not measured

## 4. Cost of a hidden tab

| Question | Answer | Evidence |
| --- | --- | --- |
| Is PTY output parsed while hidden? | Yes. Each pane's WebSocket stream feeds `process_pty_bytes`, which runs the ANSI parser into the terminal model whether or not the tab shows | `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:341`, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:707` |
| Does it trigger UI work? | Each wakeup, throttled to 60 per second per pane, can update filters, heights, child views, and call `ctx.notify()`. Invalidation collects updated views and can be combined before presentation. Wakeup count is not a separately presented GPU-frame count | `/Users/alexbrodsky/GitHub/warp/app/src/terminal/view.rs:620`, `/Users/alexbrodsky/GitHub/warp/app/src/terminal/view.rs:10195`, `/Users/alexbrodsky/GitHub/warp/crates/warpui_core/src/core/app.rs:4112`, `/Users/alexbrodsky/GitHub/warp/crates/warpui_core/src/presenter.rs:318` |
| Redraw only on change? | Yes. A frame is requested only when a window is invalidated. "An invalidation will repaint the entire element tree for that window" | `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/core/app.rs:2679`, `/Users/abrodsky/GitHub/warp/crates/warpui_core/src/core/mod.rs:194`, `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:1715` |
| Timers | Cursor blink (500 ms) runs only in the focused editor of the active window. A long-running block sends one delayed wakeup. Reconnect timers only after a drop | `/Users/abrodsky/GitHub/warp/app/src/editor/view/mod.rs:136`, `/Users/abrodsky/GitHub/warp/app/src/editor/view/mod.rs:7575`, `/Users/abrodsky/GitHub/warp/app/src/terminal/model/block.rs:2552` |
| Host side | While attached, the server runs `stty` once per second for every shell whose foreground process is not the shell, until it sees a password prompt. Detached shells skip it | `/Users/abrodsky/GitHub/panelwarp/server.js:86` |
| Memory hints | The native Cell-size test expects 24 bytes, not a verified wasm32 per-cell cost. Compact flat scrollback also exists, so multiplying all history by a Cell size is misleading. Grid limits, restored blocks, and recorder caps are ceilings rather than eager allocations. No per-pane browser memory measurement exists | `/Users/alexbrodsky/GitHub/warp/crates/warp_terminal/src/model/grid/cell_tests.rs:14`, `/Users/alexbrodsky/GitHub/warp/crates/warp_terminal/src/model/grid/flat_storage/mod.rs:1`, `/Users/alexbrodsky/GitHub/warp/app/src/terminal/model/block.rs:2894` |

An idle hidden tab retains memory. A hidden tab with streaming output continues parsing and can request UI work for the shared window. Many such panes multiply parsing and handler work, but source inspection does not establish 60 separate GPU repaints per pane per second. The daemon's password polling is a separate host CPU cost. None of these costs has been ranked with a live profile.

Cheap follow-ups:

- Defer purely visual wakeup work and notifications for inactive panes, then refresh on activation. Keep parser state, terminal replies, and lifecycle events correct. Skipping only the final `ctx.notify()` would leave earlier handler work intact
- Turn the `stty` poll off or slow it for shells whose pane is in a parked set
- After load, host.html leaves `#loading` at `opacity: 0` with the infinite `pulse` animation still on `.mark`. It could set `display: none` after the fade. `/Users/abrodsky/GitHub/panelwarp/media/host.html:17`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:18`

When the T3 drawer hides the iframe, browsers may throttle `requestAnimationFrame` in hidden cross-origin iframes (unverified). WebSocket messages still arrive, so parsing continues.

## 5. Startup cost

### Measured

The original audit recorded cumulative phase timestamps in ms from iframe startup through `warp-loaded`. These are 17 historical VS Code loads, not T3 benchmarks or measurements rerun in the follow-up. Sources were `/Users/abrodsky/GitHub/panelwarp/media/host.html:91`, `/Users/abrodsky/GitHub/panelwarp/extension.js:287`, and VS Code logs under `/Users/abrodsky/Library/Application Support/Code/logs/20261109T160014/window1/exthost/output_logging_20261109T160015/1-Warp Terminal for VS Code.log`.

| Source | Loads | Cache checked | Settings received | Compile promise resolved | Canvas detected |
| --- | --- | --- | --- | --- | --- |
| Cache Storage hit | 15 | 10 ms median | 21 ms | 151 ms median (129 to 240) | 194 ms median (172 to 409) |
| Network (new wasm build, 14 MB brotli from localhost) | 2 | 238 ms | 466 ms | 533 ms | 721 ms |

“Canvas detected” is when a `<canvas>` exists. It does not establish a presented frame or usable prompt. The loading overlay fades later. The compile marker is cumulative and may include other waits before the promise is observed, not an isolated compiler duration. PTY host startup, first paint, and shell readiness were not measured.

Live WASM linear memory, browser RSS, and GPU allocations remain unmeasured. The later binary audit found a declared initial linear-memory minimum, which is not a live allocation profile. The VS Code process memory warning is not a per-Warp runtime measurement. See the [performance audit](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md).

### How the compiled code stays cached

1. Stable origin: the static port is saved in `globalState['warp.staticPort']` and reused. A taken port falls back to a random one, which means a cold cache. `/Users/abrodsky/GitHub/panelwarp/extension.js:229`, `/Users/abrodsky/GitHub/panelwarp/server.js:585`
2. `ETag: "<size>-<mtimeMs>"` with `Cache-Control: no-cache`, 304 on match. `/Users/abrodsky/GitHub/panelwarp/server.js:118`, `/Users/abrodsky/GitHub/panelwarp/server.js:555`
3. `?wasm=<etag>` in the page URL lets host.html skip the `HEAD` request. `/Users/abrodsky/GitHub/panelwarp/extension.js:556`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:101`
4. The loader keeps WASM bytes in Cache Storage (`warp-wasm`) and uses `compileStreaming(response)`. Compiled-code caching is a separate browser mechanism. A byte-cache hit does not prove a code-cache hit. `/Users/alexbrodsky/GitHub/panelwarp/media/host.html:98`

For T3: pin the static port, pass `wasm=<etag>`, and keep the iframe origin the same across T3 restarts.

### Lazy first open versus a hidden preload

| | Lazy first open | Preload in a hidden iframe |
| --- | --- | --- |
| Loader cost at first terminal open | Historical canvas detection around 0.2 s from cached bytes and 0.7 s after a new build. Usable-prompt timing unknown | Can move some startup earlier if it finishes before opening, unmeasured |
| Cost when the user never opens a terminal | None | The full instance memory (not measured) and background compile CPU on every T3 page load |
| Risk | None new | A `display: none` iframe gives the canvas 0 size. Shells may start at a tiny size and then resize (unverified). Use an offscreen iframe with real size instead |

Load once on first open as the initial policy. Measure cold/warm first-prompt timing on the intended web clients before deciding whether idle preloading is useful. A thread switch within the already running runtime should bypass the application loader entirely.

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
- Hidden streaming output still reaches the parser and wakeup handlers. The resulting GPU frame rate needs measurement because invalidations can be combined.
- The `stty` poll runs every second for every attached shell that runs a command. With many threads running dev servers, that adds up.
- `Workspace` already moves tabs in and out of `self.tabs` without killing panes for cross-window drag (`remove_tab_without_undo`, `insert_transferred_tab_at_index`, `/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:28442`). That is the precedent for design D.
