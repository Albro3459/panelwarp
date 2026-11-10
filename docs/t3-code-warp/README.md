# Warp in T3 Code: what it would take

Research from Nov 9, 2026. Nothing is built yet. T3 Code facts are for 0.1.7 (web mode, `t3 serve` on port 3773).

Detail lives in four companion docs in `/Users/abrodsky/.t3/worktrees/panelwarp/t3-code-warp/docs/t3-code-warp`:

- `panelwarp-host-contract.md`: what the Warp wasm app needs from its host, and which parts of panelwarp are tied to VS Code
- `t3code-terminal.md`: how T3 Code's terminal works and where another terminal can plug in
- `t3code-surfaces.md`: how T3 Code's right-panel surfaces work and what adding one takes
- `per-thread-tabs.md`: how one Warp instance can show a separate tab set per T3 thread

## Target

- A "Warp" entry with shortcut W in T3's surface launcher, next to Browser, Terminal, Files and Diff
- One Warp wasm instance per browser page, started the first time the surface opens
- Each T3 thread sees only its own tabs. Switching threads swaps the tab set without a reload
- New tabs start in the thread's folder (`thread.worktreePath ?? project.workspaceRoot`)
- T3's own terminal stays as it is

## Short answer

Doable in three parts. Only the T3 part touches T3 Code, and it is a small additive patch to the web client. The server stays stock.

| Part | Where | Size |
| --- | --- | --- |
| 1. Web host that replaces the VS Code extension | panelwarp fork, new files | Largest part |
| 2. Tab sets per thread | Warp patch (about 250 to 350 Rust lines) plus about 100 lines of JS | Medium, needs a wasm rebuild |
| 3. "Warp" surface | T3 web client: 2 new files plus about 35 added lines in 4 files | Small, but re-applied on each T3 release |

## What exists today

| Piece | State |
| --- | --- |
| Warp wasm bundle | Built. `/Users/abrodsky/GitHub/warp/target/wasm32-unknown-unknown/release-wasm/bundle` (111 MB wasm, 14 MB with brotli) and `.../wasm-fast/bundle` (200 MB) |
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

## Part 2: tab sets per thread

Keep one live tab set per thread inside the single instance. On a thread switch, swap the workspace's `tabs` vector, its active index, its Ctrl+Tab order and its tab groups for the target thread's. Warp already moves tabs between windows without ending their shells, and this follows that pattern.

- The tab bar, vertical tabs, Cmd+1 to 9 and tab cycling only ever see the active thread's tabs, so no tab can show in the wrong thread
- Switch time is one frame for a thread already opened on this page
- A thread opened for the first time on this page restores its saved tabs through the existing reload path and takes over its running shells
- cwd needs no Rust change. Warp reads `default_cwd` from `#pty_url` for every new session (`/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:43`). The host page rewrites the fragment on each thread switch

Designs that lose:

| Design | Why not |
| --- | --- |
| Filter tabs by a group key | 15 to 20 edits in `view.rs`, which has 257 uses of `self.tabs`. One missed spot shows another thread's tabs, or "close other tabs" ends another thread's shells |
| Save, close and restore tabs on each switch | Visible reload on every switch. Shells of a thread you left end after 10 minutes |
| One Warp window per thread | Each window needs its own canvas and WebGL context. The web build is not made for it |

Scope the key to the thread, not the project. Threads in one project can have different worktrees.

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

Measured from panelwarp's VS Code logs unless marked:

| Thing | Cost |
| --- | --- |
| First open, wasm cached | Canvas shows at 194 ms median |
| First open after a new wasm build | About 720 ms |
| Thread switch (thread already opened on this page) | One frame (estimate from the design) |
| Hidden tab, idle | Almost no CPU. Nothing draws |
| Hidden tab with output | Output is still parsed, up to 60 wakeups a second per pane |
| Memory per tab | Not measured |

Load on first open. A hidden preload saves under a second and may start shells at a tiny size.

Daemon limits to turn into settings:

- Detached shell lifetime, 10 minutes (`/Users/abrodsky/GitHub/panelwarp/server.js:60`). It applies after a page reload or a closed browser tab
- Idle exit, 5 minutes (`/Users/abrodsky/GitHub/panelwarp/daemon.js:12`)
- The `stty` poll runs once a second for every attached shell that is running a command. Twenty threads with dev servers means twenty `stty` calls a second

## Limits that stay

- T3's agents and project scripts keep using T3's terminal backend. Warp is a second terminal for you
- Browsers reserve Cmd+T, Cmd+W, Cmd+N and Cmd+1 to 9. Warp's tab shortcuts need other keys in `keybindings.yaml`, or the tab buttons
- T3's shortcuts do not fire while focus is inside the iframe, unless they are added to Warp's routed keys
- `wasm-opt` is not installed here, so only the `wasm-fast` profile builds. The build scripts default `WARP_SRC` and `WARP_TARGET_DIR` to paths that do not exist on this machine
- T3 moves fast: 510 commits and one release between 0.1.7 and 0.1.8 in 5 days

## Security

Reasonable hardening for a tool that runs on localhost, a VPN or T3 Connect:

- Always start the PTY server with a token. Without one, any website can frame `http://127.0.0.1:8080/`, pass the PTY Origin check (`/Users/abrodsky/GitHub/panelwarp/server.js:245`) and send `warp-paste` and `warp-send-key` (`/Users/abrodsky/GitHub/panelwarp/media/host.html:460`). Read from the code, not exploited. The VS Code path always uses a token
- Send `Content-Security-Policy: frame-ancestors` for the T3 origin from the static server
- Check `e.origin` in host.html and the relay page, and post to exact origins. host.html posts to `'*'` today (`/Users/abrodsky/GitHub/panelwarp/media/host.html:213`)
- Over a VPN or T3 Connect the T3 origin is not `127.0.0.1`. The Warp servers bind `127.0.0.1` today, so remote use needs a route to them and the right origin in the checks above

## License

Warp's client and panelwarp are AGPL-3.0. T3 Code is MIT. Running both on your own machine has no extra duties. Sharing a T3 Code build that bundles the Warp wasm would bring AGPL duties for that bundle. Not legal advice.

## Rough effort

Estimates, not measured.

| Step | Size |
| --- | --- |
| Web host with relay page: terminal, clipboard, links, storage | 1 to 2 days |
| Daemon, cwd, history, tabs | 1 to 2 days |
| Settings files and AI without `vscode` | 2 to 3 days |
| Tab sets per thread, Warp patch and rebuild | 2 to 3 days |
| T3 surface patch and iframe host | 1 to 2 days |
| Script that re-applies the patch and rebuilds the client per release | 1 day |
| Security hardening | half a day |
| Upkeep per T3 release | Re-apply, fix conflicts in `RightPanelTabs.tsx` when they come, rebuild |

## Not verified yet

- Building `apps/web` alone at a tag and running it against the stock server
- T3 API response shapes for threads and projects (the research made no authenticated calls)
- The tab set swap in Warp. It is a design from reading the code, with no prototype
- Memory per tab and for the whole instance inside the T3 page
- How Warp behaves when its iframe is hidden or resized to zero while shells run
