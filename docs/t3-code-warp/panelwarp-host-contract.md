# panelwarp host contract

What the Warp wasm app needs from its host, and which parts of panelwarp depend on VS Code. Sources:

- panelwarp at `/Users/abrodsky/GitHub/panelwarp` (branch `dev`, commit `21753e3`)
- The patched Warp clone at `/Users/abrodsky/GitHub/warp` (branch `vscode-panel`, upstream `c75f182` plus 67 commits)
- The installed extension at `/Users/abrodsky/.vscode/extensions/felixkrueckel.panelwarp-0.1.18/`

Everything below was read in the code unless it is marked "unverified".

## Nov 10 scope clarification

The process described here owns shells, replay bytes, persisted layouts, and finished blocks sent by the browser. It does not own Warp's live parsed terminal model. When a browser detaches, recording output does not by itself continue constructing Warp command blocks on the server. The original `/Users/abrodsky/...` paths below are historical source locations.

The current requirement is one Warp WASM runtime per T3 browser tab, with thread-owned state and a preferred shared physical renderer. A PTY host can run beside the T3 environment independently of its web UI. For remote access it must run on the machine containing the project and have an authenticated route reachable by the browser. A remote browser's `127.0.0.1` points to that browser's device, not the project host.

T3's Ghostty backend is a useful model for separating shell lifetime, output subscriptions, bounded replay, and lightweight metadata. Its emulator still runs in the browser. A native Warp service that parses output and owns grids, modes, and block lifecycle would be a new backend boundary, not just a new entry point for this Node daemon. See [server-owned state](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/server-state.md) and [performance evidence](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/performance.md).

## 1. Process layout

```
VS Code window (extension host, extension.js)
  |  spawns once, detached (ptyHost.js)
  v
PTY host = daemon.js -> server.js startServer()     <- one per extension build, shared by all windows
  |  node-pty spawn per tab/pane                       survives window reloads
  v
zsh / bash / fish

Webview (VS Code renderer)
  outer HTML from extension.js webviewHtml()   <- uses acquireVsCodeApi()
    <iframe src="http://127.0.0.1:<static>/?keys=..&wasm=<etag>#pty_url=ws://127.0.0.1:<pty>/create?token=..">
      media/host.html + warp.js + warp_bg.wasm   <- talks to its parent with window.parent.postMessage
        WebSocket -> PTY host /create
```

| Process | Started by | Runtime | Survives window reload | Evidence |
| --- | --- | --- | --- | --- |
| Extension host (`extension.js`) | VS Code | VS Code's Node | No | `/Users/abrodsky/GitHub/panelwarp/extension.js:624` |
| PTY host (`daemon.js` + `server.js`) | `ensurePtyHost`, `spawn(process.execPath, [daemon.js], {detached: true})` with `ELECTRON_RUN_AS_NODE=1` | VS Code's Electron as plain Node | Yes. Exits after 5 min with no shells and no page requests, or when the login session ends | `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:105`, `/Users/abrodsky/GitHub/panelwarp/daemon.js:12`, `/Users/abrodsky/GitHub/panelwarp/daemon.js:67`, `/Users/abrodsky/GitHub/panelwarp/daemon.js:87` |
| Shells | node-pty in the PTY host, loaded lazily | native | Yes. A shell whose page disconnects waits 10 min and buffers up to 2 MB | `/Users/abrodsky/GitHub/panelwarp/server.js:318`, `/Users/abrodsky/GitHub/panelwarp/server.js:60` |
| `stty` poll | PTY host, every 1 s while a command runs | `execFile` | n/a | `/Users/abrodsky/GitHub/panelwarp/server.js:86` |
| Notifier (`notifier/Panelwarp.app`, Swift) | `agents.js` via `execFile`, macOS only, only when the window is unfocused | native | n/a | `/Users/abrodsky/GitHub/panelwarp/agents.js:57`, `/Users/abrodsky/GitHub/panelwarp/agents.js:115` |
| `ps` poll | `memoryMonitor.js` every 15 s | `execFile` | n/a | `/Users/abrodsky/GitHub/panelwarp/memoryMonitor.js:24` |

How the pieces talk:

- Extension host to PTY host: no live channel. The PTY host writes `pty-host.json` (mode 0600) into the extension's global storage with `pid`, `key`, `nonce`, `pageUrl`, `staticOrigin`, `ptyBaseUrl` (which holds the token). The extension polls for it for up to 15 s after spawning, then health-checks it with a TCP connect. `/Users/abrodsky/GitHub/panelwarp/daemon.js:40`, `/Users/abrodsky/GitHub/panelwarp/daemon.js:55`, `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:54`, `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:126`
- Build key: a hash of the extension dir, the bundle dir, and the size and mtime of `daemon.js`, `server.js`, `shellRecorder.js`. A new key starts a new PTY host. The old one keeps its shells and the new one proxies a page's `pane` request to it (up to 5 previous hosts). `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:22`, `/Users/abrodsky/GitHub/panelwarp/ptyHost.js:95`, `/Users/abrodsky/GitHub/panelwarp/server.js:390`
- Webview outer page to extension: `acquireVsCodeApi().postMessage` and `webview.postMessage`. `/Users/abrodsky/GitHub/panelwarp/extension.js:571`, `/Users/abrodsky/GitHub/panelwarp/extension.js:451`
- host.html to outer page: `window.parent.postMessage(msg, '*')`. The outer page relays an allowlist of types to the extension after checking `e.origin === warpOrigin`, and relays everything from the extension into the iframe with `targetOrigin = warpOrigin`. `/Users/abrodsky/GitHub/panelwarp/extension.js:574`, `/Users/abrodsky/GitHub/panelwarp/extension.js:602`
- Page to PTY host: HTTP for static files, WebSocket for PTYs. Both on `127.0.0.1` only. `/Users/abrodsky/GitHub/panelwarp/server.js:42`

Ports:

- Under VS Code: the PTY port is random (`ptyPort = 0`). The static port is remembered in `globalState['warp.staticPort']` so the page origin, and with it the browser cache of the wasm, stays stable. If that port is taken it falls back to a random one. `/Users/abrodsky/GitHub/panelwarp/extension.js:226`, `/Users/abrodsky/GitHub/panelwarp/extension.js:249`, `/Users/abrodsky/GitHub/panelwarp/server.js:583`
- Standalone `node server.js`: `PTY_PORT` (default 3030, no fallback) and `STATIC_PORT` (default 8080, random fallback). `/Users/abrodsky/GitHub/panelwarp/server.js:636`

Token scheme:

- The daemon makes a 32-byte random hex token per PTY host. `/Users/abrodsky/GitHub/panelwarp/daemon.js:50`
- `ptyBaseUrl = ws://127.0.0.1:<pty>/create?token=<T>`. The extension appends `shell`, `shell_path`, `default_cwd` and puts the whole URL in the iframe URL fragment `#pty_url=...`. Browsers never send fragments to the server. `/Users/abrodsky/GitHub/panelwarp/server.js:589`, `/Users/abrodsky/GitHub/panelwarp/extension.js:234`, `/Users/abrodsky/GitHub/panelwarp/extension.js:557`
- The server compares `?token=` with `crypto.timingSafeEqual` in `verifyClient` and returns 401 otherwise. `/Users/abrodsky/GitHub/panelwarp/server.js:244`
- Without a token the server only accepts WebSocket upgrades whose `Origin` is `http://127.0.0.1:<static>` or `http://localhost:<static>`. `/Users/abrodsky/GitHub/panelwarp/server.js:245`, `/Users/abrodsky/GitHub/panelwarp/server.js:586`
- The static server has no auth. It holds no secrets.

## 2. What server.js serves

### Static server (`/Users/abrodsky/GitHub/panelwarp/server.js:520`)

| Request path | File |
| --- | --- |
| `/` | `/Users/abrodsky/GitHub/panelwarp/media/host.html` |
| `/assets/client/static/fallback-fonts/<family>/<file>` | `/Users/abrodsky/GitHub/panelwarp/media/fallback-fonts/...` (a missing `-Bold.ttf` falls back to `-Regular.ttf`) |
| `/assets/client/wasm/<file>` | `<bundle>/wasm/<file>` (`warp.js`, `warp_bg.wasm`) |
| `/assets/client/static/<file>` | `<bundle>/assets/<file>` (hashed PNG/JPG assets) |
| anything else | `<bundle>/<path>`, 403 if it escapes the bundle dir |

These routes mirror Warp's own dev server `/Users/abrodsky/GitHub/warp/crates/serve-wasm/src/main.rs:78`. There is no SPA fallback and no `/session/...` route.

Response headers, all of them:

- `Content-Type` from a small MIME table (`.wasm` is `application/wasm`). `/Users/abrodsky/GitHub/panelwarp/server.js:151`
- `Cache-Control: no-cache` and `ETag: "<size>-<mtimeMs>"`. `If-None-Match` gets a 304. `/Users/abrodsky/GitHub/panelwarp/server.js:555`
- `Content-Length`
- For precompressed files: `X-Decoded-Length`, and `Content-Encoding: br` when the request's `Accept-Encoding` has `br`. Otherwise the server decompresses on the fly. `/Users/abrodsky/GitHub/panelwarp/server.js:571`

Not sent: CORS headers, CSP, `X-Frame-Options`, `frame-ancestors`, COOP, COEP, CORP. Any origin can frame the page.

Precompressed handling: `servedFile(file)` serves `file` if it exists, else `file.br`. The packaged extension ships `bundle/wasm/warp_bg.wasm.br` and every fallback font as `.br`, with decoded sizes in `precompressed.json`. `/Users/abrodsky/GitHub/panelwarp/server.js:131`, `/Users/abrodsky/GitHub/panelwarp/server.js:145`, `/Users/abrodsky/GitHub/panelwarp/scripts/package.sh:84`

### PTY WebSocket (`/Users/abrodsky/GitHub/panelwarp/server.js:3`, `/Users/abrodsky/GitHub/panelwarp/server.js:251`)

One endpoint: `ws://127.0.0.1:<pty>/create`. One socket per terminal pane.

Query parameters:

| Param | Who sets it | Meaning |
| --- | --- | --- |
| `token` | host (in `#pty_url`) | Auth |
| `shell` | host | `zsh`, `bash` or `fish`. Warp reads it to pick its bootstrap. Unknown or missing means zsh. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:59` |
| `shell_path` | host | Shell binary for the server. Unsupported shells fall back to `/bin/zsh` or `/bin/bash`. `/Users/abrodsky/GitHub/panelwarp/server.js:198` |
| `default_cwd` | host | Start dir when the pane has no `cwd` |
| `num_rows`, `num_cols` | Warp | Initial size |
| `cwd` | Warp | A restored tab's directory. Used if it exists. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:319` |
| `pane` | Warp | Pane uuid in hex. Lets a reloaded page adopt that pane's detached shell. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:324` |
| `session` | Warp | Reattach to a session id after a dropped socket. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:573` |

Frames:

| Direction | Frame | Content |
| --- | --- | --- |
| both | binary | Raw PTY bytes |
| page to server | text | `{"width": cols, "height": rows, "width_px", "height_px"}` resize. Warp coalesces resizes for 50 ms. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:80` |
| page to server | text | `{"close": true}`: pane closed for good, server kills the shell. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:492` |
| server to page | text | `{"session": "<id>"}` right after a new shell starts |
| server to page | text | `{"exited": code}`, then close 1000 |
| server to page | text | `"password_prompt"` (echo off and icanon on in the foreground command) |
| server to page | text | `{"adopt": {"session", "session_ids": [..], "running": bool}}`, then the recorded output as binary frames, then `"adopted"` |

Close codes: 4404 unknown session on reattach, 4000 when another socket takes over the session. `/Users/abrodsky/GitHub/panelwarp/server.js:270`, `/Users/abrodsky/GitHub/panelwarp/server.js:482`

Warp decodes these as `HostControl` in `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:124`. Warp types its own shell bootstrap over the socket. The server only spawns the shell with Warp-compatible flags and env (`TERM=xterm-256color`, `COLORTERM=truecolor`, `HISTCONTROL=ignorespace`). `/Users/abrodsky/GitHub/panelwarp/server.js:319`

Adoption needs `shellRecorder.js`, which keeps the shell's output up to the end of its bootstrap plus everything since the latest prompt. `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js:1`

## 3. host.html

File: `/Users/abrodsky/GitHub/panelwarp/media/host.html`. It does not call `acquireVsCodeApi`. It decides it is "embedded" when `window.parent !== window` (`/Users/abrodsky/GitHub/panelwarp/media/host.html:174`) and then talks to `window.parent` with `postMessage(msg, '*')`. Incoming messages are accepted only when `e.source === window.parent`. There is no origin check on incoming messages.

### Boot sequence

1. Starts fetching `/assets/client/wasm/warp_bg.wasm` at once. It keeps a copy in Cache Storage (`warp-wasm`) keyed by ETag. The ETag comes from `?wasm=` in the page URL, or from a `HEAD` request. `/Users/abrodsky/GitHub/panelwarp/media/host.html:88`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:98`
2. Shows a progress bar from `X-Decoded-Length` or `Content-Length`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:130`
3. `WebAssembly.compileStreaming`, with a fallback to `compile(arrayBuffer)`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:148`
4. Embedded: posts `warp-storage-request` and waits up to 5 s for `warp-storage-snapshot`. Not embedded: starts at once. `/Users/abrodsky/GitHub/panelwarp/media/host.html:592`
5. `startWarp` defines the data hooks, replaces `localStorage` with the snapshot, wraps `Storage.prototype` to report writes, then `import init from '/assets/client/wasm/warp.js'` and `init({module_or_path})`. The "Using exceptions for control flow" error from winit is expected and swallowed. `/Users/abrodsky/GitHub/panelwarp/media/host.html:48`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:554`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:160`
6. Polls for a `<canvas>` every 100 ms, hides the loader, posts `warp-loaded`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:61`

No `window.warpUserHandoff` is defined on purpose, which makes the patched build skip Warp sign-in. `/Users/abrodsky/GitHub/panelwarp/media/host.html:584`, patch `/Users/abrodsky/GitHub/panelwarp/warp-patches/0002-embedded-skip-Warp-sign-in-and-the-desktop-download-.patch:23`

### `window.*` hooks the page installs for Warp

Every Warp FFI import uses `catch`, so a missing hook makes Warp fall back (no feature) instead of crashing. `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:22`

| Hook | Set when | Called by Warp for | Evidence |
| --- | --- | --- | --- |
| `warpPanelCommandHistory()` -> JSON string or null | always | History rows at startup (shape `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:431`) | `/Users/abrodsky/GitHub/panelwarp/media/host.html:560` |
| `warpPanelWorkflows()` -> JSON `[{name, text}]` or null | always | Local workflow YAML files | `/Users/abrodsky/GitHub/panelwarp/media/host.html:562` |
| `warpPanelSession()` -> JSON `{session, blocks}` or null | always | Tabs to restore (shape `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:553`) | `/Users/abrodsky/GitHub/panelwarp/media/host.html:565` |
| `warpPanelSaveSession(json)` | embedded | Layout changes, checked every 2 s | `/Users/abrodsky/GitHub/panelwarp/media/host.html:567` |
| `warpPanelSaveBlock(paneUuid, json)` | embedded | Each finished block | `/Users/abrodsky/GitHub/panelwarp/media/host.html:569` |
| `warpPanelRecordCommand(kind, json)` | embedded | `started` / `finished` commands | `/Users/abrodsky/GitHub/panelwarp/media/host.html:576` |
| `warpPanelOpenSettingsFile()` | embedded | "Open settings file" | `/Users/abrodsky/GitHub/panelwarp/media/host.html:245` |
| `warpPanelResolvePaths(cwd, candidatesJson)` -> Promise<JSON> | embedded | Clickable paths: which candidates exist | `/Users/abrodsky/GitHub/panelwarp/media/host.html:250` |
| `warpPanelOpenFile(path, line, column)` | embedded | Click on a file link | `/Users/abrodsky/GitHub/panelwarp/media/host.html:268` |
| `warpPanelRevealFile(path)` | embedded | Reveal a path | `/Users/abrodsky/GitHub/panelwarp/media/host.html:270` |
| `Notification` (replaced class) | embedded | Long-running command and password prompt notifications | `/Users/abrodsky/GitHub/panelwarp/media/host.html:275` |
| `warpPanelBell()` | embedded | Audible bell (WebAudio beep) | `/Users/abrodsky/GitHub/panelwarp/media/host.html:290` |
| `warpPanelStoreApiKey(provider, key)` | embedded | OpenRouter key from Warp's settings row | `/Users/abrodsky/GitHub/panelwarp/media/host.html:304` |
| `warpPanelGenerateCommands(prompt, context, stage)` -> Promise<JSON> | embedded | AI Command Search `#` | `/Users/abrodsky/GitHub/panelwarp/media/host.html:311` |
| `warpPanelNextCommand(request)` -> Promise | embedded | Next Command | `/Users/abrodsky/GitHub/panelwarp/media/host.html:328` |
| `warpPanelPromptSuggestion(request)` -> Promise | embedded | Prompt suggestions for a CLI agent | `/Users/abrodsky/GitHub/panelwarp/media/host.html:339` |
| `warpPanelAgentConversations()`, `...Summary(agent, id, onText)`, `...Seen(agent, id)`, `warpPanelOpenAgentConversation(agent, id, mode)`, `warpPanelTrashAgentConversation(agent, id)` | embedded | Agents panel | `/Users/abrodsky/GitHub/panelwarp/media/host.html:374` |
| `warpPanelConfirm(message, detail, label)` -> Promise<bool> | embedded | Modal confirms (private routing off etc.) | `/Users/abrodsky/GitHub/panelwarp/media/host.html:410` |
| `window.open` (replaced) | embedded | External links | `/Users/abrodsky/GitHub/panelwarp/media/host.html:214` |
| `navigator.clipboard.writeText` / `.write` (replaced) | embedded | Copy | `/Users/abrodsky/GitHub/panelwarp/media/host.html:218` |

Hooks Warp installs for the host to call:

| Hook | Purpose | Evidence |
| --- | --- | --- |
| `window.warpOpenUrl(url)` | Hand Warp a `warp://` or `warposs://` URL, e.g. `warposs://settings?widget=host_api_key` | `/Users/abrodsky/GitHub/warp/crates/warpui/src/platform/wasm/mod.rs:173` (patch 0006) |
| `window.warpPanelReloadSettings()` | Re-read every setting and keybinding from localStorage | `/Users/abrodsky/GitHub/warp/app/src/platform/wasm.rs:884` (patch 0066) |

Warp also calls an optional upstream hook `window.warpEmitEvent(event)` with `{kind: "THEME_BACKGROUND_CHANGED", color}` and a few others. host.html does not define it. A host could use it to match its chrome to Warp's theme. `/Users/abrodsky/GitHub/warp/crates/warp_web_event_bus/src/lib.rs:12`, `/Users/abrodsky/GitHub/warp/app/src/appearance.rs:442`

### localStorage, fonts, focus, keyboard, clipboard, theme

- localStorage: Warp-on-web keeps every setting there as a JSON-encoded string, plus `CustomKeybindings` (YAML as a JSON string, patch 0065). Embedded, host.html clears it and loads the host snapshot before `init`, then batches every `setItem`/`removeItem`/`clear` into `warp-storage-changes` after 200 ms. `warp-storage-update` from the host writes entries without echoing them, then calls `warpPanelReloadSettings()`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:512`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:579`
- Fonts: main fonts are inside the wasm (unverified, no font files exist in the bundle's `assets/`). Fallback fonts (symbols, CJK, emoji, Nerd Font) load from `<origin>/assets/client/static/fallback-fonts/...` (patch 0003). `/Users/abrodsky/GitHub/warp/app/src/font_fallback.rs` via `/Users/abrodsky/GitHub/panelwarp/warp-patches/0003-embedded-load-fallback-fonts-from-the-host-page-s-or.patch:25`
- Focus: `window` `focus` focuses the canvas in all modes. Embedded, a `pointerdown` while the document lacks focus posts `warp-request-focus`, and `warp-focus` from the host focuses the canvas. `/Users/abrodsky/GitHub/panelwarp/media/host.html:235`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:473`, `/Users/abrodsky/GitHub/panelwarp/media/host.html:507`
- Keyboard: embedded, a capture-phase `keydown` listener intercepts trusted keys listed in `?keys=` (VS Code-style specs like `cmd+shift+p`) and posts `warp-routed-key`. Cmd+V is intercepted and turned into `warp-clipboard-read`. The matching `keyup` is swallowed. `/Users/abrodsky/GitHub/panelwarp/media/host.html:422`
- Synthetic keys: `warp-send-key` from the host dispatches modifier and key `KeyboardEvent`s on the canvas. Warp accepts untrusted events. `/Users/abrodsky/GitHub/panelwarp/media/host.html:477`
- Paste: Warp reads paste only from `paste` events on `document` (`/Users/abrodsky/GitHub/warp/crates/warpui/src/platform/wasm/mod.rs:186`). Embedded, the host answers `warp-clipboard-read` with `warp-paste`, which host.html replays as a `ClipboardEvent`. `/Users/abrodsky/GitHub/panelwarp/media/host.html:467`
- Copy: Warp writes with `navigator.clipboard.write([ClipboardItem])`, falling back to `writeText`. `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/wasm.rs:30`
- Theme: host.html sets only a black background and a fixed loader. Warp's theme lives in its own settings. Warp listens to `prefers-color-scheme` changes. `/Users/abrodsky/GitHub/warp/crates/warpui/src/platform/wasm/mod.rs:228`

### Message table

Direction "page -> host" means host.html posts to its parent. In VS Code the outer webview page relays it to the extension (`FROM_WARP` allowlist, `/Users/abrodsky/GitHub/panelwarp/extension.js:574`). Handlers are in `WarpViewProvider.onMessage`, `/Users/abrodsky/GitHub/panelwarp/extension.js:281`.

| Type | Direction | Payload | Handler | Needs `vscode.*`? |
| --- | --- | --- | --- | --- |
| `warp-storage-request` | page -> host | none | Replies `warp-storage-snapshot`. `settingsFile.load()`, `history.load()`, `sessions.load(workspace)`, `readWorkflowFiles(workspaceFolders)` `/Users/abrodsky/GitHub/panelwarp/extension.js:296` | Partly. Files and SQLite are plain Node. Workspace folders, globalState mirror and error toasts are VS Code |
| `warp-storage-snapshot` | host -> page | `{entries, history, session, workflows}` (last three are JSON strings or null) | `startWarp` `/Users/abrodsky/GitHub/panelwarp/media/host.html:594` | n/a |
| `warp-storage-changes` | page -> host | `{changes: {key: string or null}}` | `settingsFile.save` writes `settings.toml`, `keybindings.yaml`, globalState mirror `/Users/abrodsky/GitHub/panelwarp/extension.js:307` | Partly. TOML/YAML writes are plain Node (`smol-toml`). Mirror is `globalState` |
| `warp-storage-update` | host -> page | `{changes}` | Writes localStorage silently, calls `warpPanelReloadSettings` `/Users/abrodsky/GitHub/panelwarp/media/host.html:543` | Sent when `fs.watch` sees file edits (plain Node) or a VS Code save |
| `warp-loaded` | page -> host | `{timing, liveSettings}` | Logs, flushes a pending `warp-navigate`, asks a deferred routing confirm `/Users/abrodsky/GitHub/panelwarp/extension.js:283` | No (log only) |
| `warp-navigate` | host -> page | `{url}` | `window.warpOpenUrl(url)` `/Users/abrodsky/GitHub/panelwarp/media/host.html:464` | n/a |
| `warp-record-command` | page -> host | `{kind: "started" or "finished", json}` | `history.record` (SQLite) and history sync timer `/Users/abrodsky/GitHub/panelwarp/extension.js:418` | Record is plain Node. Sync uses `globalState` + Settings Sync |
| `warp-save-session` | page -> host | `{json}` | `sessions.saveSession(workspaceKey, json)` `/Users/abrodsky/GitHub/panelwarp/extension.js:396` | Store is plain Node. The key needs workspace identity |
| `warp-save-block` | page -> host | `{paneUuid, json}` | `sessions.saveBlock` `/Users/abrodsky/GitHub/panelwarp/extension.js:403` | No |
| `warp-open-settings` | page -> host | none | `settingsFile.open()` opens TOML in an editor `/Users/abrodsky/GitHub/panelwarp/extension.js:377` | Yes (`openTextDocument`, `showTextDocument`) |
| `warp-resolve-paths` | page -> host | `{id, cwd, candidates}` | `filePaths.resolvePaths` (stat only) `/Users/abrodsky/GitHub/panelwarp/extension.js:380` | No |
| `warp-resolve-paths-result` | host -> page | `{id, json}` | Resolves the pending promise (5 s timeout) | n/a |
| `warp-open-file` | page -> host | `{path, line, column}` | `vscode.open` with a selection `/Users/abrodsky/GitHub/panelwarp/filePaths.js:41` | Yes |
| `warp-reveal-file` | page -> host | `{path}` | `revealInExplorer` or `revealFileInOS` `/Users/abrodsky/GitHub/panelwarp/filePaths.js:63` | Yes |
| `warp-notify` | page -> host | `{title, body}` | `showInformationMessage` with "Show Warp" `/Users/abrodsky/GitHub/panelwarp/extension.js:485` | Yes |
| `warp-request-focus` | page -> host | none | `warp.view.focus`, then posts `warp-focus` `/Users/abrodsky/GitHub/panelwarp/extension.js:414` | Yes |
| `warp-focus` | host -> page | none | Focuses the canvas | n/a |
| `warp-clipboard-read` | page -> host | none | Replies `warp-paste` with `vscode.env.clipboard.readText()` `/Users/abrodsky/GitHub/panelwarp/extension.js:426` | Yes |
| `warp-paste` | host -> page | `{text}` | Dispatches a `paste` event | n/a |
| `warp-clipboard-write` | page -> host | `{text}` | `vscode.env.clipboard.writeText` `/Users/abrodsky/GitHub/panelwarp/extension.js:444` | Yes |
| `warp-open-url` | page -> host | `{url}` | `vscode.env.openExternal`, http and https only `/Users/abrodsky/GitHub/panelwarp/extension.js:434` | Yes |
| `warp-routed-key` | page -> host | `{spec}` | Runs the mapped VS Code command `/Users/abrodsky/GitHub/panelwarp/extension.js:429` | Yes |
| `warp-routed-keys` | host -> page | `{keys: [spec]}` | Replaces the routed key list | n/a |
| `warp-send-key` | host -> page | `{key, code, cmd, ctrl, alt, shift}` | Synthetic key press on the canvas. Used by "Warp: New Tab" etc. `/Users/abrodsky/GitHub/panelwarp/extension.js:500` | n/a |
| `warp-store-api-key` | page -> host | `{provider, key}` | `context.secrets.store` `/Users/abrodsky/GitHub/panelwarp/ai.js:358` | Yes (SecretStorage) |
| `warp-confirm` | page -> host | `{id, message, detail, confirmLabel}` | Modal `showWarningMessage` `/Users/abrodsky/GitHub/panelwarp/panelSettings.js:141` | Yes |
| `warp-confirm-result` | host -> page | `{id, confirmed}` | Resolves the promise (no timeout) | n/a |
| `warp-ai-generate-commands` | page -> host | `{id, prompt, context, stage}` | `WarpAi.generateCommands` (OpenRouter or local model `fetch`) | Logic is plain Node. Key from SecretStorage, warnings via `vscode.window` |
| `warp-ai-next-command` | page -> host | `{id, request}` | `WarpAi.nextCommand` | Same |
| `warp-ai-prompt-suggestion` | page -> host | `{id, request}` | `WarpAi.promptSuggestion` | Same |
| `warp-ai-result` | host -> page | `{id, json}` or `{id, error}` | Resolves or rejects (60 s or 20 s timeout) | n/a |
| `warp-agents-list` | page -> host | `{id}` | `agents.list()` reads `~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp` | Mostly plain Node. Folder matching uses `workspaceFolders` |
| `warp-agents-summary` | page -> host | `{id, agent, sessionId}` | Streams `warp-agents-text`, then `warp-agents-result` | Plain Node `fetch` to OpenRouter, key via SecretStorage |
| `warp-agents-open` | page -> host | `{id, agent, sessionId, mode}` | Codex and Gemini return a resume command. Claude opens a Claude Code editor tab or a new window `/Users/abrodsky/GitHub/panelwarp/agents.js:661` | Yes for Claude |
| `warp-agents-trash` | page -> host | `{id, agent, sessionId}` | Closes Claude tabs, `workspace.fs.delete(useTrash)` `/Users/abrodsky/GitHub/panelwarp/agents.js:700` | Yes |
| `warp-agents-seen` | page -> host | `{agent, sessionId}` | `markSeen` in `globalState` | Yes (`globalState`) |
| `warp-agents-text` | host -> page | `{id, text}` | `onText` callback | n/a |
| `warp-agents-result` | host -> page | `{id, value}` or `{id, error}` | Resolves or rejects | n/a |

## 4. VS Code coupling inventory

| Feature | `vscode.*` APIs | Where | Non-VS Code replacement |
| --- | --- | --- | --- |
| Webview view and hosting | `registerWebviewViewProvider`, `webview.html`, `webview.postMessage`, `onDidReceiveMessage`, `onDidChangeVisibility`, `retainContextWhenHidden`, `acquireVsCodeApi` (outer page) | `/Users/abrodsky/GitHub/panelwarp/extension.js:253`, `/Users/abrodsky/GitHub/panelwarp/extension.js:700`, `/Users/abrodsky/GitHub/panelwarp/extension.js:571` | The host's own page with an `<iframe>` and a `message` listener. Keep the iframe mounted when hidden, or the wasm reloads (~100 MB) |
| Remote windows | `env.asExternalUri` | `/Users/abrodsky/GitHub/panelwarp/extension.js:88` | Drop for local use |
| Activity bar/panel moves | `vscode.moveViews`, `setContext`, launcher views | `/Users/abrodsky/GitHub/panelwarp/extension.js:171` | Drop |
| Commands and keybindings | `registerCommand` for 9 Warp keystroke commands, restart, settings, keybindings, API key, moves, Claude windows. `package.json` keybindings. `terminal.integrated.commandsToSkipShell` and `keybindings.json` edits | `/Users/abrodsky/GitHub/panelwarp/extension.js:707`, `/Users/abrodsky/GitHub/panelwarp/extension.js:104`, `/Users/abrodsky/GitHub/panelwarp/package.json:228` | Drop, or post `warp-send-key` from host UI. Replace `?keys=` routing with the host's own shortcuts |
| Routed keys defaults | VS Code command ids | `/Users/abrodsky/GitHub/panelwarp/panelSettings.js:28` | Host-defined map, or none |
| Secret storage | `context.secrets` | `/Users/abrodsky/GitHub/panelwarp/ai.js:360`, `/Users/abrodsky/GitHub/panelwarp/ai.js:367` | macOS Keychain, an env var, or a 0600 file. Only needed for AI |
| globalState | settings mirror `warp.localStorage`, `warp.staticPort`, `warp.historySync`, `warp.agentsSeen`, saved windows, pending opens, move state | `/Users/abrodsky/GitHub/panelwarp/settingsFile.js:204`, `/Users/abrodsky/GitHub/panelwarp/extension.js:81`, `/Users/abrodsky/GitHub/panelwarp/agents.js:31` | A JSON file. The settings files alone are enough for settings |
| workspaceState | empty-window id for tab restore | `/Users/abrodsky/GitHub/panelwarp/sessionStore.js:133` | Any stable key, e.g. the T3 project path |
| Settings Sync | `globalState.setKeysForSync(['warp.historySync'])` | `/Users/abrodsky/GitHub/panelwarp/extension.js:628` | Drop (opt-in feature) |
| Old VS Code settings migration | `workspace.getConfiguration('warp')` | `/Users/abrodsky/GitHub/panelwarp/panelSettings.js:112` | Drop |
| Shell choice | `getConfiguration('terminal.integrated')` | `/Users/abrodsky/GitHub/panelwarp/extension.js:66` | `$SHELL` |
| Workspace folder for cwd | `workspace.workspaceFolders[0]` as `default_cwd` | `/Users/abrodsky/GitHub/panelwarp/extension.js:237` | The T3 project or worktree path |
| Settings files | `onDidSaveTextDocument`, `openTextDocument`, `showTextDocument` (plus plain `fs.watch`) | `/Users/abrodsky/GitHub/panelwarp/settingsFile.js:215`, `/Users/abrodsky/GitHub/panelwarp/settingsFile.js:411` | `fs.watch` already covers edits. "Open settings file" can open the file in the OS editor or be dropped |
| File opening | `vscode.open`, `revealInExplorer`, `revealFileInOS`, `getWorkspaceFolder`, `Uri`, `Position`, `Range` | `/Users/abrodsky/GitHub/panelwarp/filePaths.js:41` | `open -R`, `code -g file:line:col`, or a T3 file viewer. `resolvePaths` is plain Node |
| Notifications and confirms | `showInformationMessage`, `showWarningMessage` (modal), `showErrorMessage` | `/Users/abrodsky/GitHub/panelwarp/extension.js:488`, `/Users/abrodsky/GitHub/panelwarp/panelSettings.js:142`, `/Users/abrodsky/GitHub/panelwarp/settingsFile.js:350` | Host toasts and a modal, or the browser `Notification` API |
| Clipboard and links | `env.clipboard`, `env.openExternal` | `/Users/abrodsky/GitHub/panelwarp/extension.js:427`, `/Users/abrodsky/GitHub/panelwarp/extension.js:441` | Native browser APIs. Only needed because host.html overrides them in embedded mode |
| Focus | `commands.executeCommand('warp.view.focus')` | `/Users/abrodsky/GitHub/panelwarp/extension.js:415` | `iframe.focus()` |
| URI handler | `registerUriHandler` (`vscode://felixkrueckel.panelwarp/open`) | `/Users/abrodsky/GitHub/panelwarp/extension.js:645` | Drop |
| Status bar | memory monitor item, Save window, N saved | `/Users/abrodsky/GitHub/panelwarp/memoryMonitor.js:86`, `/Users/abrodsky/GitHub/panelwarp/extension.js:753` | Drop |
| Memory monitor | VS Code process tree via `ps`, `workbench.action.openProcessExplorer` | `/Users/abrodsky/GitHub/panelwarp/memoryMonitor.js:1` | Drop |
| Claude Code tab features | `window.tabGroups`, `TabInputWebview`, `claudeVSCodePanel`, `claude-vscode.editor.open`, `extensions.getExtension('anthropic.claude-code')`, `vscode.openFolder`, `workbench.action.closeWindow`, `env.uriScheme`, `window.state.focused` | `/Users/abrodsky/GitHub/panelwarp/agents.js:369`, `/Users/abrodsky/GitHub/panelwarp/agents.js:661`, `/Users/abrodsky/GitHub/panelwarp/agents.js:756`, `/Users/abrodsky/GitHub/panelwarp/agents.js:893` | Drop. The listing and summaries can stay. "Open" can return `claude --resume <id>` for Warp to run, which `mode: "terminal"` already does |
| Output channel | `createOutputChannel` | `/Users/abrodsky/GitHub/panelwarp/extension.js:625` | `console` |

Plain Node today (no `vscode` import): `/Users/abrodsky/GitHub/panelwarp/server.js`, `/Users/abrodsky/GitHub/panelwarp/daemon.js`, `/Users/abrodsky/GitHub/panelwarp/ptyHost.js`, `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js`, `/Users/abrodsky/GitHub/panelwarp/history.js`, `/Users/abrodsky/GitHub/panelwarp/sessionStore.js` (except the `workspaceKey` helper's arguments), `/Users/abrodsky/GitHub/panelwarp/workflows.js`, `/Users/abrodsky/GitHub/panelwarp/pathHints.js`, and `resolvePaths` in `/Users/abrodsky/GitHub/panelwarp/filePaths.js`.

Imports `vscode` at module top, so it cannot be `require`d outside VS Code without a stub: `extension.js`, `settingsFile.js`, `panelSettings.js`, `ai.js`, `agents.js`, `memoryMonitor.js`. The TODO says `settingsFile.js` was "tested with a stubbed VS Code". `/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:17`

Runtime needs outside VS Code: `node-pty` 1.1.0 (native, prebuilds for darwin-arm64/x64 and win32 in `/Users/abrodsky/GitHub/panelwarp/node_modules/node-pty/prebuilds`), `ws`, `smol-toml`, `zod`, and `node:sqlite` for history and tabs. The local Node is v22.23.3. Whether a non-Node runtime (for example Bun) can load `node-pty` and `node:sqlite` is unverified.

## 5. Standalone viability

### `node server.js` today

```
node /Users/abrodsky/GitHub/panelwarp/server.js <bundle dir>
# env: PTY_PORT (3030), STATIC_PORT (8080), WARP_PANEL_TOKEN (optional), WARP_PANEL_DEBUG (optional)
# prints: open http://127.0.0.1:8080/#pty_url=ws://127.0.0.1:3030/create?shell=zsh
```

`/Users/abrodsky/GitHub/panelwarp/server.js:627`. The bundle dir must contain `wasm/warp.js`. A browser test with the wasm-fast bundle served this way passed on Nov 6 (`/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:25`). It runs in-process (no daemon), so shells end when the process ends. Without a token, it relies on the WebSocket `Origin` check. With `WARP_PANEL_TOKEN` set, the printed URL carries `?token=`.

Compared to the extension, standalone mode lacks: the daemon and its reload survival across server restarts, `shell_path` and `default_cwd` (the printed URL only has `shell`, so new tabs start in the server's `$HOME`), every bridge feature listed in section 3, and settings files.

Opened as a top-level tab (not embedded), host.html starts at once with no bridge:

| Feature | Top-level tab | Inside an iframe whose parent does nothing |
| --- | --- | --- |
| Terminal, blocks, completions, splits | Works | Works after a 5 s wait |
| Settings persistence | Browser localStorage for `127.0.0.1:8080`. Survives while the port stays the same | Same, but every change is posted to the parent too |
| Command history across reloads | None (`warpPanelCommandHistory` returns null, `warpPanelRecordCommand` is undefined) | None |
| Tabs restore | None. A reloaded page within 10 min still adopts running shells only if Warp recreates panes with the same uuids, which needs the session restore (unverified) | None |
| AI (`#`, Next Command, suggestions) | Off (hooks missing) | Requests time out (60 s / 20 s) |
| Clickable paths | Off (no `warpPanelResolvePaths`) | Promise times out after 5 s, no links |
| Notifications | Real browser `Notification` (asks permission) | Posted to parent, lost |
| Copy | Native clipboard | Posted to parent, lost |
| Paste (Cmd+V) | Native paste event | Intercepted, posted to parent, lost. Paste breaks |
| Links | `window.open` | Posted to parent, lost |
| Bell | Off (no `warpPanelBell`) | WebAudio beep |

The key point for T3: host.html switches into embedded mode whenever it is in any iframe. In that mode the parent must implement at least `warp-storage-request` (reply `warp-storage-snapshot`), `warp-clipboard-read` (reply `warp-paste`), `warp-clipboard-write`, `warp-open-url`, `warp-request-focus`, and `warp-notify`. Otherwise copy, paste and links break.

### `acquireVsCodeApi` and the shim

host.html never uses `acquireVsCodeApi`. Only the outer webview page in `/Users/abrodsky/GitHub/panelwarp/extension.js:571` does. A non-VS Code host replaces that outer page and the extension with:

1. A parent page (T3's React app) that renders `<iframe src=".../?keys=[]&wasm=<etag>#pty_url=<ws url with token, shell, shell_path, default_cwd>" allow="clipboard-read; clipboard-write">`.
2. A `message` listener that checks `e.source === iframe.contentWindow` and `e.origin === <static origin>`, and posts replies with `iframe.contentWindow.postMessage(msg, <static origin>)`.
3. A backend (T3's server, or a sidecar) that implements whichever handlers T3 wants, from the table in section 3. The plain-Node modules can be reused as is.

Effort: the minimum (storage snapshot, clipboard, links, focus, notify) is small, about the size of `webviewHtml` plus a dozen handler cases. Settings files, history and tabs reuse `settingsFile.js` (after removing its `vscode` calls), `history.js` and `sessionStore.js` (inferred).

### Smallest file set

- Bundle: `<bundle>/wasm/warp.js`, `<bundle>/wasm/warp_bg.wasm` (or `.br` plus `precompressed.json`), `<bundle>/assets/**`
- `/Users/abrodsky/GitHub/panelwarp/media/host.html`
- `/Users/abrodsky/GitHub/panelwarp/media/fallback-fonts/**` (optional, symbols and CJK render as boxes without them)
- `/Users/abrodsky/GitHub/panelwarp/server.js`, `/Users/abrodsky/GitHub/panelwarp/shellRecorder.js`
- `node_modules`: `node-pty`, `node-addon-api`, `ws`
- Optional for reload survival: `/Users/abrodsky/GitHub/panelwarp/daemon.js`, `/Users/abrodsky/GitHub/panelwarp/ptyHost.js` (both plain Node)

### Security note for embedding

In no-token mode, any website can frame `http://127.0.0.1:8080/`. The framed page's own origin passes the PTY `Origin` check (`/Users/abrodsky/GitHub/panelwarp/server.js:245`), and host.html accepts `warp-paste` and `warp-send-key` from any parent without an origin check (`/Users/abrodsky/GitHub/panelwarp/media/host.html:460`). Warp accepts synthetic paste and key events. Together that looks like a path for a web page to type and run a command in a local shell while the dev server runs. The end-to-end exploit is unverified, and Chrome's local network access rules may block the public-to-localhost frame (unverified). The VS Code path is not affected because it always uses a token. For T3: always run with a token, send `Content-Security-Policy: frame-ancestors http://127.0.0.1:3773` (or the T3 origin) from the static server, and check `e.origin` in host.html's message handlers. host.html also posts API keys and settings to `'*'` (`/Users/abrodsky/GitHub/panelwarp/media/host.html:213`), which a framing page would receive.

## 6. Wasm embed constraints

- Rendering: wgpu 30 with the `webgl` feature. WebGPU is disabled on purpose. `/Users/abrodsky/GitHub/warp/Cargo.toml:375`, `/Users/abrodsky/GitHub/warp/crates/warpui/Cargo.toml:178`. So WebGL2 is required (inferred from wgpu's `webgl` backend).
- Threads and cross-origin isolation: none needed. wgpu uses `fragile-send-sync-non-atomic-wasm`, the wasm flags only add `--cfg=web_sys_unstable_apis` (no `+atomics`), and `warp.js` has no `SharedArrayBuffer`. `/Users/abrodsky/GitHub/warp/.cargo/config.toml:24`. The server sends no COOP/COEP/CORP. If the T3 page itself were cross-origin isolated with COEP `require-corp`, the iframe would be blocked until the static server sends CORP or COEP headers (unverified for T3).
- Canvas: winit creates one canvas and appends it to `<body>`, or into `#wasm-container` if that element exists. It focuses the canvas and calls `preventDefault` on wheel, pointer and context menu events and most key events. `/Users/abrodsky/GitHub/warp/crates/warpui/src/windowing/winit/window.rs:1264`, `/Users/abrodsky/GitHub/warp/crates/warpui/src/platform/wasm/mod.rs:68`. host.html sizes it with CSS `100vw x 100vh`, so inside an iframe it fills the iframe. `/Users/abrodsky/GitHub/panelwarp/media/host.html:9`
- One app per document: Warp's hooks are window globals and it cannot be torn down without a page unload (`/Users/abrodsky/GitHub/warp/crates/warp_web_event_bus/src/lib.rs:26` says as much). An iframe per terminal surface is the practical unit. Running it directly in T3's document would mix Warp's localStorage with T3's and needs the bundle at T3's origin root (inferred).
- Keys the browser keeps: Warp lets these through to the browser: F5, Alt+Left/Right, and Cmd (macOS) with `0-9 - = + [ ] l n r t tab w pageup pagedown`, plus shifted variants. `/Users/abrodsky/GitHub/warp/crates/warpui/src/platform/wasm/mod.rs:123`. In a browser tab, Cmd+T, Cmd+W, Cmd+N go to the browser, so Warp's New Tab, Close Tab and similar shortcuts do not work. VS Code got around this with commands that send `warp-send-key`. T3 needs its own buttons or alternative bindings for those.
- Focus in an iframe: clicking into a cross-origin iframe focuses it in a normal browser (VS Code's nested webview was the odd case). The parent can call `iframe.focus()` and post `warp-focus`.
- Clipboard: copy uses `navigator.clipboard.write`. A cross-origin iframe needs `allow="clipboard-write"` (and `clipboard-read` if reading). Paste uses the native `paste` event, which works in a focused iframe without permissions (standard browser behavior, not tested here). host.html's embedded mode overrides both, so either implement the parent side or edit host.html.
- Asset and wasm URLs: patch 0006 does not set asset URLs. It adds `window.warpOpenUrl`. `/Users/abrodsky/GitHub/panelwarp/warp-patches/0006-wasm-let-the-host-page-hand-the-app-URLs-via-window..patch:25`. Asset URLs are `location.origin + "/assets/client/static/<hashed path>"` (`/Users/abrodsky/GitHub/warp/crates/warp_util/src/assets.rs:36`, `/Users/abrodsky/GitHub/warp/crates/warp_util/src/assets.rs:49`), fallback fonts use the same origin (patch 0003), and host.html imports `/assets/client/wasm/warp.js` and fetches `/assets/client/wasm/warp_bg.wasm` by absolute path. So the bundle must sit at the origin root. It cannot live under a sub-path such as `/warp/` without patching.
- PTY endpoint and token (patch 0001): Warp reads `location.hash`, strips `#pty_url=`, and uses the rest verbatim as the WebSocket base. It appends `&num_rows=..&num_cols=..` plus `cwd` and `pane`, or `session=` on reconnect. Without a fragment it falls back to `ws://127.0.0.1:3030/create`. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:35`, `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:307`. Anything inside the fragment URL must already be URL-encoded.
- `remote_tty` basics: a cargo feature (`/Users/abrodsky/GitHub/warp/app/Cargo.toml:813`) used in 51 files in `app/src`. It swaps the local PTY for a WebSocket PTY, and the patches use it as the "embedded" switch: skip sign-in, hide account and cloud UI, enable `file_links` on the web (`/Users/abrodsky/GitHub/warp/app/build.rs:242`), host session, history, workflows and settings reload. Reconnects retry up to 200 times. `/Users/abrodsky/GitHub/warp/app/src/terminal/remote_tty/event_loop.rs:90`
- New tab cwd (patch 0061): under `remote_tty`, a new tab does not inherit the active tab's directory (`/Users/abrodsky/GitHub/warp/app/src/workspace/view/startup_directory.rs:97`). Restored tabs send `cwd`. A new tab sends no `cwd` (inferred from the patch comment), so the server uses `default_cwd` from the fragment URL, then its own `cwd` option (`$HOME`). `/Users/abrodsky/GitHub/panelwarp/server.js:314`. For T3, put the thread's worktree path in `default_cwd`.
- Settings live reload: the host writes localStorage and calls `window.warpPanelReloadSettings()`. Both built bundles contain that hook (checked by string search in the wasm).

## 7. Bundle facts

Measured on disk:

| Bundle | `warp_bg.wasm` | `warp.js` | `assets/` | Total |
| --- | --- | --- | --- | --- |
| release-wasm (`/Users/abrodsky/GitHub/warp/target/wasm32-unknown-unknown/release-wasm/bundle`, built Nov 6 16:57) | 111,133,258 B | 146,946 B | 57 MB (PNG 49 MB, JPG 7.9 MB) | 163 MB, 85 files |
| wasm-fast (`/Users/abrodsky/GitHub/warp/target/wasm32-unknown-unknown/wasm-fast/bundle`, built Nov 6 13:00) | 200,467,620 B | 149,656 B | 57 MB | 248 MB |
| Packaged 0.1.18 (`/Users/abrodsky/.vscode/extensions/felixkrueckel.panelwarp-0.1.18/bundle`) | 14,358,939 B as `.br` (decoded 111,133,258 B, same size as the release build above) | 146,946 B | 17 MB (onboarding slides removed) | 31 MB |

Fallback fonts are 97 MB raw in `/Users/abrodsky/GitHub/panelwarp/media/fallback-fonts` and 40 MB brotli in the installed extension. The whole installed extension is 75 MB. The VSIX in the repo is 75,349,330 B.

Build:

- Command: `./script/wasm/bundle --no-split --channel oss --profile <profile> --features remote_tty`, then `wasm-opt -O2` for thin and release. `/Users/abrodsky/GitHub/panelwarp/scripts/build-warp.sh:51`
- Profiles: `release-wasm` is `opt-level = "s"`, fat LTO, 1 codegen unit. `wasm-fast` turns LTO off, 256 units, incremental. `wasm-thin` uses thin LTO, 16 units. `/Users/abrodsky/GitHub/warp/Cargo.toml:542` (patch 0025)
- Times from the script comments: wasm-fast ~20-30 s per edit, wasm-thin ~1.5 min, release ~9 min. `/Users/abrodsky/GitHub/panelwarp/scripts/build-warp.sh:4`. The TODO measured ~2.5 min for a wasm-fast rebuild on this machine. `/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:184`
- Prerequisites on this machine (per the TODO, `/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:181`): Homebrew `rustup` and `llvm` (the bundle script requires `/opt/homebrew/opt/llvm/bin/clang` on macOS, `/Users/abrodsky/GitHub/warp/script/wasm/bundle:8`), Rust 1.92.0 with `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.117. `wasm-opt` (binaryen) is missing, so only wasm-fast builds work right now. `brotli` is needed for packaging. Build output is about 60 GB. `/Users/abrodsky/GitHub/panelwarp/scripts/build-warp.sh:15`
- Output location: `$WARP_TARGET_DIR/wasm32-unknown-unknown/<profile>/bundle` (patch 0062). The scripts default to `~/Library/Caches/warp-target`, which does not exist here. The local bundles are in `/Users/abrodsky/GitHub/warp/target`. The scripts also default `WARP_SRC` to `~/Documents/programming/warp`, so set `WARP_SRC=/Users/abrodsky/GitHub/warp`.

Patch sync:

- `warp-patches/UPSTREAM_COMMIT` is `c75f182d193a8707bbbbc0cf545c6864c3c4fb3a` (Oct 5 2026). The clone's `vscode-panel` branch has 67 commits on top of it.
- `/Users/abrodsky/GitHub/panelwarp/scripts/export-warp-patches.sh` deletes `warp-patches/0*.patch` and regenerates them with `git format-patch <base>..vscode-panel`, plus `uncommitted.patch` for a dirty tree. Both `build-warp.sh` and `package.sh` run it, so any build rewrites every patch header. The TODO warns about this. `/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:207`
- Rebuild from patches: `git checkout $(cat warp-patches/UPSTREAM_COMMIT) && git am warp-patches/0*.patch`. `/Users/abrodsky/GitHub/panelwarp/scripts/export-warp-patches.sh:4`
- Rebasing onto newer upstream is manual: no rebase script exists. Patch 0067 is an upstream fix cherry-picked with `-x`, which shows the fork already trails upstream.
- The published extension is ahead of git in places. The TODO says the repo JS is 0.1.5 plus a few commits while bundles are 0.1.16+. `/Users/abrodsky/GitHub/panelwarp/TODO/settings-and-keybindings-files.md:176`

## 8. License

Not legal advice.

- panelwarp is `AGPL-3.0-only` (`/Users/abrodsky/GitHub/panelwarp/package.json:26`). Warp's client is AGPL-3.0, with some parts MIT. `/Users/abrodsky/GitHub/panelwarp/NOTICE.md:3`
- Personal local use: AGPL obligations start when you convey (distribute) the program, or when you let other users interact with a modified version over a network (section 13). Running it on your own machine for yourself triggers neither.
- Distribution: anyone who distributes T3 Code with the Warp bundle must offer the Corresponding Source for the AGPL parts (the patched Warp source or the patches plus upstream commit, and the panelwarp host code). MIT code can be included in an AGPL work, but not the reverse. If T3 and Warp were merged into one program, the combined work would have to be distributed under AGPL terms.
- Keeping Warp in its own process and iframe, talking over HTTP, WebSocket and `postMessage`, is the common way to argue the two are separate programs in an aggregate. Whether that holds for a given integration is a legal question.
- Serving T3 to other people over a network with a modified Warp inside would trigger section 13. Users would need a way to get the source.
