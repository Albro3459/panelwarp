# WIP: Warp in T3 Code

Research from Nov 9–10, 2026. The T3 integration and server-owned Warp model are not built. Source inspection supports the proposed boundaries, but no T3 browser CPU, GPU, memory, or usable-prompt benchmark has been run.

The original integration notes target T3 Code 0.1.7. The terminal follow-up checks [T3 commit `73fb49d`](https://github.com/pingdotgg/t3code/tree/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be), including its singleton Ghostty runtime and server output protocol. Older `/Users/abrodsky/...` paths in the detailed notes identify the original research machine. Current Warp source was inspected at `/Users/alexbrodsky/GitHub/warp`, based on upstream `c75f182` with local embedded-build changes, so it is not a clean upstream source snapshot.

Read these together:

- [Performance evidence and profiling priorities](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md)
- [Server-owned state and the Ghostty comparison](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/server-state.md)
- [Thread ownership and implementation candidates](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/per-thread-tabs.md)
- [The existing host contract](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/panelwarp-host-contract.md)
- [T3 terminal source notes](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/t3code-terminal.md)
- [T3 surface integration notes](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/t3code-surfaces.md)

## Target

- A "Warp" entry with shortcut W in T3's surface launcher, next to Browser, Terminal, Files and Diff
- One Warp WASM runtime per T3 browser tab, started the first time the surface opens. Additional threads or projects must not create more runtimes or reload the WASM application
- A shared physical canvas and renderer is the preferred target. Its implementation and performance are unverified
- Each T3 thread owns its terminal tabs and UI state. Switching the visible thread must preserve that ownership. The internal workspace representation is still open
- A possible limit of five terminal tabs per thread. This is a product proposal, not a final limit or a memory budget. Splits, retained history, queued output, and the number of live threads also need bounds
- New tabs start in the thread's folder (`thread.worktreePath ?? project.workspaceRoot`)
- T3's own terminal stays as it is
- Web first. Desktop may reuse the browser surface and discover or start the same host later

## Short answer

Run a Warp host beside the T3 environment on the machine containing the project. A browser surface can use that host without replacing T3's existing terminal backend. The T3 server can stay stock if the separate service has an authenticated remote route, but that route and the client patch have not been exercised together.

There are two distinct backend designs to evaluate: a T3-like PTY/history host with bounded browser viewers, and a native Rust service owning Warp's parsed terminal state and command blocks. The latter could remove background parsing and large inactive models from the browser. It needs a new model boundary and snapshot/update protocol.

| Part | Where | State |
| --- | --- | --- |
| Web host replacing the VS Code bridge | panelwarp | Existing plain Node pieces can be reused, browser relay still needed |
| Thread-owned state within one runtime | Warp | Tab-set swapping is one candidate. Independent logical workspaces and server-owned state need prototypes |
| Optional server-owned parser and block model | Native Rust service beside T3 | Research only, no ready headless terminal service or live snapshot API |
| Warp surface and remote connection | T3 web client plus host routing | Original 0.1.7 surface patch is a small UI proposal, not an estimate for the whole system |

## What “instance” means

| Term | Scope |
| --- | --- |
| WASM runtime | One running browser application with its own state and linear memory. Fixed at one per T3 browser tab |
| Physical window / render surface | Owns platform graphics resources. Several windows can exist inside one native app runtime |
| Logical thread workspace | Owns one thread's tabs, active tab, undo/focus state, and layout. It should not require another WASM runtime |
| Terminal pane | Owns a terminal model and connects to a shell. A split tab contains multiple panes |
| PTY host | Owns the actual shell processes and can serve several browser tabs or windows |

Native Warp moves live pane/view state between windows inside a shared app context. Its windows still create separate renderers. Panelwarp runs a separate WASM application in each VS Code window and shares the PTY daemon. T3's Ghostty adapter already shares one browser WASM runtime while allocating separate terminal handles. These are different ownership boundaries.

## What exists today

| Piece | State |
| --- | --- |
| Warp WASM bundle | Current local artifact: `/Users/alexbrodsky/GitHub/warp/target/wasm32-unknown-unknown/release-wasm/bundle/wasm/warp_bg.wasm`, 99.4 MiB uncompressed. Its declared initial linear memory is 58.4 MiB before growth. Neither quantity is total browser RAM. Older bundle/compression figures are historical |
| PTY and static server | `/Users/abrodsky/GitHub/panelwarp/server.js` runs outside VS Code: `node server.js <bundle dir>` with `PTY_PORT`, `STATIC_PORT`, `WARP_PANEL_TOKEN`. A browser test passed on Nov 6 |
| Shells that survive reloads | `/Users/abrodsky/GitHub/panelwarp/daemon.js` and `/Users/abrodsky/GitHub/panelwarp/ptyHost.js` are plain Node |
| History, tab restore, workflows | `/Users/abrodsky/GitHub/panelwarp/history.js`, `/Users/abrodsky/GitHub/panelwarp/sessionStore.js`, `/Users/abrodsky/GitHub/panelwarp/workflows.js` are plain Node (need `node:sqlite`) |
| Settings files, AI, panel settings | `/Users/abrodsky/GitHub/panelwarp/settingsFile.js`, `/Users/abrodsky/GitHub/panelwarp/ai.js`, `/Users/abrodsky/GitHub/panelwarp/panelSettings.js` import `vscode` at the top. They need the `vscode` calls pulled out |
| Claude Code tabs, memory monitor | VS Code only. Drop them |

## How the VS Code extension scopes tabs

It does not share one instance. Each VS Code window runs its own wasm instance (`/Users/abrodsky/GitHub/panelwarp/extension.js:700`) and restores its own tab set once at startup, keyed by workspace file or folder (`/Users/abrodsky/GitHub/panelwarp/sessionStore.js:132`). The windows share the PTY daemon, the session database and the cached wasm.

So "one instance, tabs per thread" is new work. Warp's web build holds one window and one workspace (`/Users/abrodsky/GitHub/warp/app/src/workspace/view.rs:26745`).

## Part 1: panelwarp web host

`/Users/abrodsky/GitHub/panelwarp/media/host.html:174` switches to embedded mode whenever it runs in any iframe. It then sends clipboard, links, notifications, storage, history, tabs and AI requests to its parent with `postMessage` and waits for answers. In VS Code the parent is the webview page built in `/Users/abrodsky/GitHub/panelwarp/extension.js:553`, which relays to the extension. If the parent does not answer, copy, paste and links break.

New files in the panelwarp fork, no changes to the VS Code path:

- An entry point that starts the daemon with a token and serves a relay page
- The relay page, the browser twin of the webview page in `extension.js`
- A bridge that handles the messages `extension.js` handles today, without `vscode`

This also works alone in a browser tab, which is the first thing to try.

Order of work:

1. Relay page with clipboard, links, focus, notifications and a storage snapshot. Terminal, blocks, completions and splits work at this point
2. Daemon mode, `default_cwd` and `shell_path` in the URL
3. History and tab restore (reuse `history.js` and `sessionStore.js`)
4. Settings and keybindings files (split the `vscode` calls out of `settingsFile.js`)
5. AI with the OpenRouter key from the macOS Keychain or a 0600 file

## Part 2: thread-owned state

Separate a running server session from the browser model displaying it. A thread with a dev server running should not force its entire Warp UI and history to stay live in the browser forever. Keep a bounded set of recent frontend models if measurements justify it, and define how older ones restore.

The earlier recommendation swapped live tab vectors in and out of one Workspace. That remains a candidate, but parked tabs can surprise existing and future code that assumes the workspace contains all its tabs. Background exits, notifications, saving, undo-close, and pane lookup need explicit ownership. The estimated patch size and “one frame” switch latency were not validated.

Independent logical workspaces behind one canvas may preserve ownership better. They are not available through native multi-window support without changes: the current registry maps one Workspace per WindowId, and web window creation can replace the existing canvas. A one-runtime-per-thread or per-project implementation is outside the requirement.

A runtime shared per project would still need thread isolation, unless all project threads intentionally share terminals. Keep session identity scoped by environment and thread because threads in the same project can use different worktrees.

Server-owned state is a separate option. Prototype one headless Warp terminal that runs without a browser, preserves command blocks, and restores a viewer from a consistent snapshot. That result should inform the thread-workspace implementation before committing to a large UI refactor.

## Part 3: "Warp" surface in T3 Code

Surface kinds live only in the web app (`apps/web/src/rightPanelStore.ts`). The server and contracts do not know about them, and state is in localStorage. So the patch is client only:

| File | Edit |
| --- | --- |
| `apps/web/src/components/WarpSurface.tsx` | New. Renders an empty slot and reports the active thread id and cwd |
| `apps/web/src/warpFrameHost.ts` | New. Owns the single iframe on `document.body` and keeps it over the slot |
| `apps/web/src/rightPanelStore.ts` | About 4 lines: the new kind |
| `apps/web/src/components/RightPanelTabs.tsx` | About 25 lines: launcher row, "+" menu row, icon, shortcut W. Main conflict risk (about 26 commits a month) |
| `apps/web/src/components/RightPanelSurfaceContent.tsx` | About 4 lines: render case |
| `apps/web/src/components/ChatView.tsx` | 2 props |

The iframe must sit outside React. T3 unmounts every surface that is not the active tab, and an iframe that moves or unmounts reloads. T3's desktop browser surface already uses this slot pattern.

How to ship it without running a full fork:

1. Check out the release tag, apply the patch, build only `apps/web`
2. Copy `dist` over `/Users/abrodsky/.t3/runtime/versions/<v>/client`, `index.html` last
3. Run a pinned version (`npx t3@0.1.7 serve`) so `@latest` does not move to a build without the patch

The stock server keeps running and does not compare client and server versions. This build path is read from the source and not tested yet.

Fallback with no patched client: an injected script draws its own docked panel and uses the same iframe host. It cannot add a real surface. T3 shows an unknown kind as a blank tab, and letter keys that the launcher does not list go to the composer.

## Performance

No runtime profile establishes a single dominant bottleneck. The clearest scaling risks in source are retained terminal state and background output processing. Extra physical windows duplicate renderer resources, but renderer duplication has not been measured against those costs.

- Load and initialize the WASM application once. Later thread switches should bypass that path, although creating models, restoring history, and shell startup still take work
- Inactive attached panes still parse output and run wakeup handlers. Defer purely visual updates until visible while preserving parser correctness and terminal replies
- Wakeups are throttled per pane and window invalidations can be combined. The earlier claim that each pane adds 60 separate GPU repaints per second is unsupported
- A page-wide budget must account for live panes, grids/scrollback, blocks, and queued output. Five tabs per thread is not enough to bound RAM
- Historical VS Code measurements reported canvas detection at medians of 194 ms for cached bytes and 721 ms after a new build. They did not measure a painted frame or usable prompt and were not rerun in T3

The [performance audit](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md) records binary sizes, the difference between cached bytes and compiled code, renderer allocations, measurement gaps, and a profiling matrix.

Daemon limits to turn into settings:

- Detached shell lifetime, 10 minutes (`/Users/abrodsky/GitHub/panelwarp/server.js:60`). It applies after a page reload or a closed browser tab
- Idle exit, 5 minutes (`/Users/abrodsky/GitHub/panelwarp/daemon.js:12`)
- The `stty` poll runs once a second for every attached shell that is running a command. Twenty threads with dev servers means twenty `stty` calls a second

## Limits that stay

- T3's agents and project scripts keep using T3's terminal backend. Warp is a second terminal for you
- Browsers reserve Cmd+T, Cmd+W, Cmd+N and Cmd+1 to 9. Warp's tab shortcuts need other keys in `keybindings.yaml`, or the tab buttons
- T3's shortcuts do not fire while focus is inside the iframe, unless they are added to Warp's routed keys
- Build availability and source-directory defaults need to be checked on the implementation machine. The earlier missing-`wasm-opt` note was environment-specific, and a local release artifact was available for the follow-up audit
- T3 moves fast: 510 commits and one release between 0.1.7 and 0.1.8 in 5 days

## Security

Reasonable hardening for a tool that runs on localhost, a VPN or T3 Connect:

- Always start the PTY server with a token. Without one, any website can frame `http://127.0.0.1:8080/`, pass the PTY Origin check (`/Users/abrodsky/GitHub/panelwarp/server.js:245`) and send `warp-paste` and `warp-send-key` (`/Users/abrodsky/GitHub/panelwarp/media/host.html:460`). Read from the code, not exploited. The VS Code path always uses a token
- Send `Content-Security-Policy: frame-ancestors` for the T3 origin from the static server
- Check `e.origin` in host.html and the relay page, and post to exact origins. host.html posts to `'*'` today (`/Users/abrodsky/GitHub/panelwarp/media/host.html:213`)
- Over a VPN or T3 Connect the T3 origin is not `127.0.0.1`. The Warp servers bind `127.0.0.1` today, so remote use needs a route to them and the right origin in the checks above

## License

Warp's client and panelwarp are AGPL-3.0. T3 Code is MIT. Running both on your own machine has no extra duties. Sharing a T3 Code build that bundles the Warp wasm would bring AGPL duties for that bundle. Not legal advice.

## Next research checkpoints

1. Establish usable-prompt timing and memory for a standalone browser host using the existing daemon
2. Prototype a server-owned Warp model for one pane, including offscreen commands, alternate-screen programs, shell queries, and snapshot-plus-update attachment
3. Validate independent thread state inside one browser runtime and render surface. Exercise focus, undo-close, notifications, persistence, and switching between worktrees
4. Add the T3 surface and verify authenticated local and remote routing without hardcoded loopback addresses
5. Profile retained history and visible/hidden output, then choose viewer-cache and memory budgets

The original line counts and day estimates describe the earlier tab-swap/UI proposal. They do not cover a server-owned terminal model or establish the cost of sharing a renderer between independent workspaces. Re-estimate after the prototypes.

## Not verified yet

- Building `apps/web` alone at a tag and running it against the stock server
- T3 API response shapes for threads and projects (the research made no authenticated calls)
- The tab-set swap, independent workspaces behind one renderer, and server-owned Warp model
- Live memory per pane/workspace, browser process RAM, GPU allocations, and host/shell memory
- Cold/warm time to a usable prompt, switch/restore latency, parser CPU, layout cost, actual frame counts, and typing latency
- How Warp behaves when its iframe is hidden or resized to zero while shells run
- A complete state snapshot and ordered update protocol preserving Warp blocks, shell integration, alternate screen, and terminal modes
- Detached-session lifetime and history limits that permit browser model eviction without silently ending running programs
