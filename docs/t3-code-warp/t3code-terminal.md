# T3 Code terminal: how it works and where to plug in Warp

Research notes for adding Warp to T3 Code web. The original sections target T3 Code 0.1.7 in web mode. The Nov 10 follow-up below verifies the runtime and session boundaries against a newer pinned source snapshot. No terminal throughput or browser memory benchmark was run.

## Nov 10: verified runtime and session boundaries

Follow-up source: [T3 commit `73fb49d`](https://github.com/pingdotgg/t3code/tree/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be), inspected in `/Users/alexbrodsky/.t3/scratch/2026-11-10-can-you-research-how-t3-4000ee20/t3code`. Related research: [Remote Per-Thread Terminal Performance fork](t3-thread://v2/d15cb9d9-075b-4ef1-89ab-cd02514e01c7/143a8fa3-a3a4-4354-ae07-36756a5dffee).

T3 already shares one main Ghostty WASM runtime per browser tab. Each terminal allocates its own Ghostty handles within that runtime, then frees them on disposal. This is the ownership model wanted for Warp, although Warp's WASM build contains its application UI rather than just an embeddable VT library. T3 also loads a tiny PTY callback trampoline WASM module, not a separate application runtime per terminal. Sources: [runtime singleton](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/runtime.ts), [terminal core](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/core.ts), [adapter overview](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/README.md).

| Responsibility | Owner in T3 |
| --- | --- |
| Shell processes, cwd, session lifetime, metadata | Environment server |
| Bounded raw output history and persistence | Environment server |
| ANSI parsing, screen/scrollback, cursor and terminal modes | Browser's per-terminal Ghostty state |
| Canvas drawing, input, selection, scrolling | Browser adapter |

The server's `TerminalSessionSnapshot.history` is retained raw terminal output. The browser resets its Ghostty terminal and replays that text. A snapshot here is not a serialized server-side emulator grid. Replaying a bounded tail can lose state created before the retained output, especially for full-screen programs and resize-sensitive output. Sources: [manager snapshot](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/server/src/terminal/Manager.ts), [browser reset/replay](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/core.ts).

The transferable performance choices are:

- **Independent lifetimes.** A shell remains on the host without requiring a mounted browser terminal. Disposing a viewer frees its local handles without making the process lifetime a UI concern
- **Metadata separate from output.** Terminal summaries exclude history, and ordinary output does not need to republish the metadata list. Clients can list sessions without subscribing to every stream
- **Bounded retention.** Server raw history is limited to 5,000 lines and 8 MiB of UTF-8 output. Client transport buffers have a separate 512 KiB limit. History appends are incremental, and disk writes are coalesced with a 250 ms delay
- **Pipelined flow control.** Output streams allow an acknowledgement window of eight chunks or about 64 KiB of encoded messages. A subscriber's queued-output budget is about 8 MiB, with explicit resynchronization from retained history when it falls behind. This avoids one network round trip for every small output event
- **Visibility-aware drawing.** Hiding a surface cancels rendering, but retained hidden surfaces still feed output to the browser parser. Hidden does not mean zero parsing or zero memory
- **Bounded drawer retention.** The chat drawer keeps at most ten hidden thread views plus its active view. That is a drawer cache policy, not a cap on all backend sessions or a measured optimum for Warp

Sources: [terminal runtime decisions](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/docs/internals/terminal-runtime.md), [output protocol](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/server/src/terminal/OutputProtocol.ts), [surface visibility](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/terminal/ghostty/surface.ts), [drawer limit](https://github.com/pingdotgg/t3code/blob/73fb49d0b3a61bff74aebc362fc6c17d6c0d39be/apps/web/src/components/ChatView.logic.ts).

For Warp, copying these lifetime and transport choices would reduce frontend retention without first moving the parser. Moving parsed terminal state and command blocks to a Rust service is a larger option. It needs Warp's shell hooks and block lifecycle, an exact snapshot/update boundary, and a single owner for terminal replies. The [server-state study](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/server-state.md) records that boundary and a proposed prototype.

The remaining sections preserve the versioned 0.1.7 integration observations. Their file counts, entry points, limits, and build recipes need checking against the version chosen for implementation.

## Sources and how to read this doc

| Tag | Source |
| --- | --- |
| **[client]** | Installed build at `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/` (minified, no source maps on disk) |
| **[server]** | Running server at `http://127.0.0.1:3773`, unauthenticated GET requests only |
| **[launcher]** | `/Users/abrodsky/.npm/_npx/89628044cae88a02/node_modules/t3/bin/t3.mjs` |
| **[binary]** | `/Users/abrodsky/.t3/runtime/versions/0.1.7/t3`, `--help` output and string scan |
| **[upstream]** | `pingdotgg/t3code` at tag `v0.1.7` (commit `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`), read through raw URLs. Most upstream facts came from a summarizing fetch tool, so treat exact constants from upstream as close to the source but not character checked |

Facts marked **unverified** are inferred and were not tested. Nothing here was tested with an authenticated session, because no state-changing calls were allowed.

The tag `v0.1.7` matches the installed version. `v0.1.8` shipped on 2026-11-09, the day of this research.

## 1. Terminal, client side

### Library and renderer

- The terminal is **not xterm.js**. It uses **libghostty-vt** (Ghostty's VT core) compiled to wasm, with T3's own **Canvas 2D** renderer. **[client]** **[upstream]**
  - Wasm files: `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/ghostty-vt-DdA0Zryv.wasm` and `ghostty-write-pty-hgyAvVbe.wasm` (a 112 byte callback trampoline for terminal replies to the PTY).
  - The JS calls the Ghostty C ABI directly (`ghostty_terminal_new`, `ghostty_terminal_vt_write`, `ghostty_render_state_*`, `ghostty_key_encoder_*`, `ghostty_mouse_encoder_*`, `ghostty_paste_encode`). No WebGL. **[client]**
  - The upstream README says it "is intentionally not an xterm compatibility layer". A symbols-only Nerd Font is vendored and loaded lazily. https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/terminal/ghostty/README.md
- The chunk `assets/terminal-CE8KAyjQ.js` is only the lucide "terminal" icon (198 bytes). The real terminal code is in `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/ThreadTerminalDrawer-9EIdX1Sz.js` (111 KB). **[client]**

### Components and files (upstream `v0.1.7`)

| File | Role |
| --- | --- |
| https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/ThreadTerminalDrawer.tsx | Drawer and panel UI: tabs, split groups, sidebar list, resize. Exports `ThreadTerminalDrawer` (default) and `TerminalViewport`, which mounts one `GhosttyTerminalSurface` per terminal. About 1,300 lines. `mode` is `"drawer"` or `"panel"` |
| https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/PersistentThreadTerminals.tsx | `PersistentThreadTerminalDrawer` and `PersistentThreadTerminalPanel`. Computes cwd, worktree path and env. Hides inactive drawers with CSS instead of unmounting, so terminals survive thread switches |
| https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/terminal/useThreadTerminalActions.ts | Terminal actions (launch, split, close) |
| `apps/web/src/terminal/ghostty/` (`core.ts`, `renderer.ts`, `runtime.ts`, `surface.ts`, `keyCodes.ts`, `vendor/`, `fonts/`) | Ghostty wasm runtime, render snapshots, Canvas 2D frames, input, IME, selection, links |
| `apps/web/src/terminalUiStateStore.ts` | Zustand-style store persisted to localStorage |
| `apps/web/src/terminal-links.ts`, `apps/web/src/rightPanelStore.ts`, `apps/web/src/rightPanelLayout.ts` | Link handling, right panel surfaces |
| `apps/web/src/components/ChatView.tsx` | Hosts the drawer under the chat column |
| `packages/contracts/src/terminal.ts` | Shared RPC schemas |
| `apps/web/scripts/build-libghostty-wasm.sh`, `native/libghostty-vt/` | Wasm build and upstream pin |

A second terminal user exists: `ProviderAuthTerminal` (provider login flow). **[client]**

### Layout

- **Drawer**: bottom of the chat column, per thread. Default height 280 px, clamped to at least 180 px and at most 75% of the viewport. **[client]** **[upstream]**
- **Right panel tab**: a terminal can also be a right panel surface (`kind: "terminal"`) next to `preview`, `diff`, `files`, `file`, `pull-request`, `device` and `side-chat`. Right panel surfaces are stored per thread. **[client]** (`rightPanelStore-ocfGPHT9.js`)
- Each thread has several terminals, arranged in groups. A group holds up to 4 terminals as horizontal or vertical splits ("max 4 per group"). **[client]**
- Terminal ids are per thread. The default id is `term-1`. **[upstream]** `packages/contracts/src/terminal.ts`

### How it opens

| Key (default) | Command | When |
| --- | --- | --- |
| `mod+j` | `terminal.toggle` | always |
| `mod+d` / `mod+shift+d` | `terminal.split` / `terminal.splitVertical` | terminal focused |
| `mod+n` | `terminal.new` | terminal focused |
| `mod+w` | `terminal.close` | terminal focused |

Source: default keybinding table in `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/utils-BL51zcsk.js`. **[client]** Users override these in `/Users/abrodsky/.t3/userdata/keybindings.json`. There is no terminal route. The drawer is UI state on the thread route.

### State store

- localStorage key `t3code:terminal-state:v1`, shape `{ terminalUiStateByThreadKey: { [threadKey]: { terminalOpen, terminalHeight, terminalIds, activeTerminalId, terminalGroups: [{ id, terminalIds, splitDirection? }], activeTerminalGroupId } } }`. **[client]** (`terminalUiStateStore-irLr7MUB.js`)
- Right panel surfaces per thread: `t3code:right-panel-state:v2`. **[client]**
- Neither key stores a cwd. **[client]**

## 2. Terminal, server side

| Item | Finding |
| --- | --- |
| Manager | https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/terminal/Manager.ts (`TerminalManager` Effect service: `open`, `attachStream`, `observeStream`, `write`, `resize`, `clear`, `close`, `closeIdle`, `subscribeMetadata`, ...) **[upstream]** |
| PTY backend | **node-pty** (`^1.2.0-beta.15`) through https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/terminal/NodePtyAdapter.ts. Loaded lazily with `createRequire`, kept outside the single executable. Installed copy: `/Users/abrodsky/.t3/runtime/versions/0.1.7/node_modules/node-pty`. No Bun **[upstream]** **[binary]** |
| Shell | `$SHELL`, else `bash`. POSIX fallbacks `/bin/zsh`, `/bin/bash`, `/bin/sh`. zsh gets `-o nopromptsp`. No `-l` login flag seen (unverified, from a partial read) **[upstream]** |
| TERM | node-pty `name: "xterm-256color"`. `COLORTERM=truecolor` if unset **[upstream]** |
| Env | Server env copied minus `T3CODE_*`, `VITE_*`, `TMUX`, `PORT` and other blocklisted keys. Then the client's env is applied. The client sends `T3CODE_PROJECT_ROOT=<project root>` and, for worktree threads, `T3CODE_WORKTREE_PATH=<worktree>` **[upstream]** **[client]** (`projectScripts-BJoQsSHI.js`) |
| cwd | The client chooses it: `worktreePath ?? project.workspaceRoot` (function `we` in `projectScripts-BJoQsSHI.js`). So a worktree thread starts in its worktree and a local thread starts at the project root. The server checks that the folder exists **[client]** **[upstream]** |
| Session key | `threadId + "\u0000" + terminalId`. No cap on running sessions. Up to 128 inactive sessions retained **[upstream]** |
| Scrollback | In memory: 5,000 lines or 8 MB. Persisted with a 250 ms debounce to `/Users/abrodsky/.t3/userdata/logs/terminals/terminal_<base64url threadId>[_<terminalId>].log` (8 files on this machine). Client buffer default 512 KB **[upstream]**. Log folder and file names checked on local disk |
| Browser reload | PTYs live in the server process, so they keep running. The client re-attaches with `terminal.attach` and `resume: true`, gets a `snapshot` with `history`, then live events **[client]** **[upstream]** |
| Server restart | The manager finalizer kills all PTYs. On the next open, the saved history tail is replayed after a mode reset (`neutralizeInheritedHistory`) **[upstream]** |
| Kill | SIGTERM, then SIGKILL after 1 s **[upstream]** |
| Shared size | Several viewers can attach. The PTY size is the smallest attached viewer **[upstream]** |
| Idle close | `closeIdle` runs on demand only and skips sessions with a running subprocess. No idle timer found **[upstream]** |

## 3. Wire protocol

### Transport

- One WebSocket at **`ws://127.0.0.1:3773/ws`**. A plain GET returns `426` with `{"code":"orchestration_protocol_incompatible",...,"orchestrationProtocolVersion":2}`. **[server]**
- Query parameters added by the client: `orchestrationProtocol=2`, `clientCapabilities=settingsSecretReferences`, plus `clientSurface`, `clientAppVersion`, `clientDeviceType`, `clientOs`, `clientWebDeployment`, `clientBrowser`. Remote clients add `wsTicket=<ticket>`. **[client]**
- Framework: **Effect RPC** (`effect/rpc`) with **JSON** serialization (`contentType: application/json`, no framing). Messages are Effect RPC envelopes: client `{"_tag":"Request","id":...,"tag":"terminal.open","payload":{...},"headers":[]}`, server `Chunk`, `Exit`, `Defect`, plus `Ack`, `Interrupt`, `Ping`, `Pong`. **[client]** (`utils-BL51zcsk.js`)
- HTTP JSON APIs (Effect HttpApi) sit beside it under `/api/...`. Orchestration routes need the header `x-t3-orchestration-protocol: 2`. **[client]**

### Terminal RPC methods

| Method | Payload | Notes |
| --- | --- | --- |
| `terminal.open` | `threadId`, `terminalId` (max 128), `cwd`, `worktreePath?`, `cols?` (1 to 1000), `rows?` (1 to 500), `env?` (max 128 keys, values up to 8192 chars), `providerInstanceId?` | Starts or reuses a PTY |
| `terminal.attach` | Same fields as open but `cwd` optional, plus `restartIfNotRunning?`, `resume?` | Stream: `snapshot` first, then `output`, `exited`, `closed`, `error`, `cleared`, `restarted`, `activity` |
| `terminal.observe` | `threadId`, `terminalId` | Read-only stream |
| `terminal.write` | `threadId`, `terminalId`, `data` (1 to 65,536 chars) | Keystrokes |
| `terminal.resize` | `threadId`, `terminalId`, `cols`, `rows` | |
| `terminal.clear` | `threadId`, `terminalId` | |
| `terminal.close` | `threadId`, `terminalId?`, `deleteHistory?` | |
| `subscribeTerminalMetadata` | `{}` | Stream of `snapshot` / `upsert` / `remove` with `TerminalSummary` items: `threadId`, `terminalId`, **`cwd`**, **`worktreePath`**, `status`, `pid`, `hasRunningSubprocess`, `label`, ... |

Sources: method map in `utils-BL51zcsk.js` **[client]**, schemas in https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/packages/contracts/src/terminal.ts **[upstream]**. `TerminalSessionSnapshot` carries `cwd`, `worktreePath`, `status`, `pid`, `history`, `exitCode`, `label`, `cols`, `rows`.

RPC permissions are scoped: `terminal:read`, `terminal:operate`, `preview:operate`, `orchestration:read`. **[client]**

### Auth

| Check | Finding |
| --- | --- |
| `GET /api/auth/session` (no cookie) | `200`, `{"authenticated":false,"auth":{"policy":"loopback-browser","bootstrapMethods":["one-time-token"],"sessionMethods":["browser-session-cookie","bearer-access-token","dpop-access-token"],"sessionCookieName":"t3_session_3773_<hash>",...}}` **[server]** |
| `GET /api/orchestration/shell`, `/api/projects`, `/api/orchestration/threads/<id>` (no cookie) | `401` `EnvironmentAuthInvalidError`, `missing_credential` **[server]** |
| `GET /.well-known/t3/environment` | `200` with no auth. Returns `environmentId`, label, platform, `serverVersion`, `orchestrationProtocolVersion`, capabilities **[server]** |
| First browser session | `t3 serve` prints a startup pairing link `/pair#token=<one-time token>`. The page trades it for a session cookie via `POST /api/auth/browser-session` **[upstream]** `EnvironmentAuth.ts` |
| Cookie | `HttpOnly`, `Path=/`, `SameSite=Lax`, no `Secure` **[upstream]** `auth/http.ts` |
| WebSocket upgrade | Accepts `?wsTicket=` (minted by `POST /api/auth/websocket-ticket` with a bearer token), otherwise cookie or bearer. Cookie auth requires an allowed Origin (see section 8) **[upstream]** |

A forked client can reuse the backend as is: same `/ws`, same `terminal.*` methods, same cookie. A third-party page on another port cannot use the cookie (see section 8).

## 4. Finding the active thread's working directory from outside

### SPA routes (installed client)

| Route | Meaning |
| --- | --- |
| `/$environmentId/$threadId` | A server thread. `environmentId` is the value from `/.well-known/t3/environment` |
| `/draft/$draftId` | Unsent draft. No server thread yet |
| `/projects/$projectKey`, `/threads/$environmentId/$threadId`, `/settings/...`, `/pull-requests`, `/usage`, `/pair` | Other pages |

Source: route table in `main-sk5g_Jie.js`. **[client]**

### Rule

`cwd = thread.worktreePath ?? project.workspaceRoot` (client function `we`). **[client]**

### Ways to get it

1. **Same-origin script (injected into `index.html`, see section 5)**. Read `threadId` from `location.pathname`. Then with the existing cookie (unverified response shapes, inferred from client schemas):
   - `GET /api/orchestration/threads/<threadId>` with `x-t3-orchestration-protocol: 2`. The thread object has `id`, `projectId`, `branch`, `worktreePath`.
   - `GET /api/projects` returns `{ projects: [{ id, title, workspaceRoot, scripts, ... }], updatedAt }`.
   - `GET /api/orchestration/shell` returns a shell snapshot of projects and threads (exact shape unverified).
2. **Effect RPC over `/ws`**: `subscribeTerminalMetadata` lists `cwd` and `worktreePath` for every thread that has a terminal. **[client]** **[upstream]**
3. **From inside a T3 terminal**: any command started in the T3 terminal already runs in the thread cwd and sees `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH`. A project script could start the Warp PTY server there (see section 5).
4. **CLI and MCP** (unverified): `t3 thread` and `t3 project` subcommands talk to the running server ("Start, message, and read threads on the running server"). The client also references an MCP endpoint with OAuth (`/.well-known/oauth-protected-resource/mcp`). Output shapes were not checked.

localStorage holds no cwd. The keys seen are UI state (`t3code:terminal-state:v1`, `t3code:right-panel-state:v2`, `t3code:ui-state:v1`, `t3code:renderer-state:v8`, `t3code:client-settings:v1`, theme keys, drafts). **[client]**

## 5. Extension points without a fork

### Summary

| Option | Works? | Notes |
| --- | --- | --- |
| Plugin / mod / custom panel API | No | None found in client or CLI **[client]** **[binary]** |
| Custom CSS or JS setting | No | No `customCss` or user script setting found. Themes are color palettes (`t3 theme`, `/Users/abrodsky/.t3/userdata/themes/`, localStorage `t3code:themes:v1`) **[client]** **[binary]** |
| CLI flag for a client dir, static routes or proxy | No | No static dir override. Only `--dev-url` (see below) **[binary]** **[upstream]** |
| Edit `client/index.html` on disk | **Yes** | Read from disk on every request. Lost when a new version installs |
| Reverse proxy in front of 3773 that injects a script | Likely | Unverified. See below |
| Project scripts | Yes, partly | Run a command in the thread terminal with the thread cwd. Has `previewUrl` and `autoOpenPreview` fields |
| Preview pane | Yes, slow | Server-side headless Chrome streamed as JPEG. See section 6 |
| HTML file preview | Unverified | Sandboxed real `<iframe>`. See below |

### `index.html` is read from disk per request

- Upstream `http.ts` at `v0.1.7` streams each static file from `config.staticDir` on every request. `index.html` is served unmodified (no nonce, no config injection). Unknown paths and extensionless paths fall back to `index.html`. Only a set of immutable hashed assets from `.vite/manifest.json` is loaded at startup, and the installed client has no `.vite/manifest.json`. https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/http.ts **[upstream]**
- `staticDir` is `<dir of the server module>/client`, else `../../web/dist` (monorepo). No env override. In the single executable that is `/Users/abrodsky/.t3/runtime/versions/0.1.7/client`. https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/config.ts **[upstream]**
- Running server check: `GET /` returns 21,702 bytes with the same SHA-256 as `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/index.html`. Headers: `cache-control: no-cache`, no ETag, no CSP, no `X-Frame-Options`. Assets get `cache-control: no-cache` plus an mtime-based ETag (`W/"c6-1a1a5441180"`), which fits a per-request `stat`. **[server]**
- Not tested by editing the file (not allowed). Conclusion: adding a `<script src="/assets/warp-bridge.js">` to `index.html` and dropping that file in `client/assets/` should take effect on the next page reload, with no server restart.
- The page is a React SPA. An injected script should overlay its own fixed-position element on top of `[data-thread-terminal-drawer]` (a stable attribute in the drawer, **[client]**) instead of editing React's DOM.

### Versions and updates

- The launcher installs each version into `/Users/abrodsky/.t3/runtime/versions/<version>/` and skips the install when `.install-complete` holds the same version string. It does not check file hashes. **[launcher]**
- `npx t3@latest` will pick up `0.1.8` (released 2026-11-09) and install a fresh `versions/0.1.8/`. A local edit in `versions/0.1.7/client/` will then not be used. Pinning `npx t3@0.1.7 serve ...` keeps the edit. Whether old version folders are pruned is unverified (`t3 update` and `t3 uninstall` exist).
- `T3CODE_RELEASE_BASE_URL` changes where the launcher downloads release tarballs and `SHA256SUMS`. A fork could publish its own `t3-<v>-darwin-arm64.tar.gz` and reuse the npm launcher. **[launcher]**
- `T3CODE_HOME` (or `--base-dir`) moves the whole data and runtime folder. **[launcher]** **[binary]**

### `--dev-url`

- `t3 serve --dev-url <url>` makes the server answer loopback page requests with a **302 redirect** to the dev URL. It does not proxy. **[upstream]** `http.ts`
- Side effects: data goes to a `dev/` folder instead of `userdata/` unless `--base-dir` is explicit (**[upstream]** `config.ts`). The dev origin is added to trusted origins and to credentialed CORS.
- A forked or patched web client could be served from the dev URL this way. It is more moving parts than editing `index.html` (unverified end to end).

### Reverse proxy (unverified)

A small proxy on `127.0.0.1:<p>` that forwards everything (including the `/ws` upgrade) to `127.0.0.1:3773` and rewrites `index.html` to add one script tag. Why it should pass auth:
- Cookies are scoped by host, not port, so the `127.0.0.1` session cookie is sent to the proxy port too.
- The Origin check accepts `Sec-Fetch-Site: same-origin`, or an Origin host equal to `Host`. Keep `Host` as sent, or rely on `Sec-Fetch-Site`.

This survives version updates, because nothing under `/Users/abrodsky/.t3/` is edited.

### Project scripts

- Projects carry `scripts: [{ id, name, command, icon, runOnWorktreeCreate, runOnSettle, keybinding, previewUrl, autoOpenPreview }]`. Running one writes ` <command>\r` into a T3 terminal for the thread. The terminal starts in the thread cwd with `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH`. **[client]** (`projectScripts-BJoQsSHI.js`)
- Scripts can come from a `t3.json` in the repo or from settings overrides (`projectScriptOverrides` in `/Users/abrodsky/.t3/userdata/settings.json`). **[client]**
- A script such as `warp-pty-server --cwd "$PWD" --port 0` could start a per-thread Warp backend in the right folder, and `previewUrl` plus `autoOpenPreview` could open it in the preview pane. How `previewUrl` is applied was not traced (unverified).

### HTML file preview iframe (unverified)

- `.html` files and agent HTML renders show in a real `<iframe sandbox="allow-scripts allow-forms allow-popups allow-downloads">`. **[client]** (`contextPresentationRegistry-5dkWq4HI.js`)
- Server responses under `/api/assets` set CSP `sandbox allow-scripts allow-forms allow-popups allow-downloads` for HTML, with no `frame-src`. **[upstream]** `http.ts`
- So an HTML file containing `<iframe src="http://127.0.0.1:<port>">` might show a live Warp page at native speed. The nested frame would inherit the sandbox: opaque origin, no cookies, no localStorage, no `allow-same-origin`. Whether Warp's wasm build runs there is for the Warp side to check.

## 6. The preview (browser) pane

- **In web mode it is not an iframe.** It is a server-side **headless Chrome** (`chrome-headless-shell`, installed at `/Users/abrodsky/.t3/tools/chrome-headless-shell`, profiles in `/Users/abrodsky/.t3/userdata/server-browser/profiles`). Frames stream over a WebSocket at `/api/preview-stream/ws?threadId=&tabId=&maxWidth=&maxHeight=` as **JPEG** (quality 70 by default) and are drawn on a `<canvas>` with `createImageBitmap`. **[client]** (`_chat-Cz6MbZKI.js`) **[upstream]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/preview/ServerBrowserStream.ts
- Flow control: the client sends `{"type":"ack"}` per frame, and only one frame is in flight. Newer frames replace waiting ones. Slow viewers are dropped above an 8 MB socket buffer. **[client]** **[upstream]**
- Input: the client sends JSON messages of type `key`, `text`, `mouse`, `wheel`, `navigate`, `resize`, `takeControl` over that socket. The server forwards them to the headless page. There is a control model (`you`, `agent`, `another-viewer`, `unclaimed`) because agents can drive the same tab. **[client]**
- The Electron desktop app uses a native bridge (`window.desktopBridge.preview`) instead. Not used in a normal browser. **[client]** (`previewBridge-CW8BYK6o.js`)
- URLs: any `http:` or `https:` URL. Schemeless `localhost`, `127.0.0.1`, `0.0.0.0` and `[::1]` become `http://`. `file:`, `data:`, `javascript:`, `ws:` and similar are rejected. **[client]** (`preview-BuD6bl61.js`) A port scanner suggests local servers (`subscribeDiscoveredLocalServers`). **[upstream]** `preview/PortScanner.ts`
- Can a user open `http://127.0.0.1:<port>` by hand and use it? Yes, the page loads on the server host, which is this machine. It will not be full speed: each key goes browser to server to headless Chrome to the page, and each screen update comes back as a JPEG. A canvas or WebGL heavy page like Warp also renders in a headless shell, possibly without GPU (unverified). Fine for occasional use. Poor as a main terminal.
- Layout: a right panel surface (`kind: "preview"`, id `browser:<tabId>`), shown as tabs next to diff, files and terminal. It can also float as a mini player. Toggle with `mod+shift+j`. Tabs are keyed by `threadId` and `tabId` on the server, and right panel state is stored per thread in `t3code:right-panel-state:v2`. **[client]**

## 7. Fork cost

### Repo and toolchain (upstream `v0.1.7`)

- Monorepo `@t3tools/monorepo`. Apps: `desktop`, `marketing`, `mobile`, `server`, `web`. About 30 packages, including `contracts`, `client-runtime`, `shared`, many `provider-*` and `source-control-*`. https://github.com/pingdotgg/t3code/tree/v0.1.7
- Node `26.12.1`, `pnpm@12.14.0`, driven by `vp` (Vite+). Effect v4 (`effect/rpc`, `@effect/platform-node`). React SPA built with Vite (rolldown chunks). **[upstream]** root `package.json`
- Root scripts: `dev` = `node scripts/dev-runner.ts dev`, `dev:server`, `dev:web`, `build` = `vp run --filter './apps/*' build`, `start` = `vp run --filter t3 start`. **[upstream]**
- Dev runbook: `vp i`, then `vp run dev` (server and web). `vp run dev:server` and `vp run dev:web` run halves. Ports come from `[dev-runner]` output. https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/docs/operations/development.md
- `apps/server` scripts: `start` = `node dist/bin.mjs`, `build:bundle` = `vp pack`, `build:exe` = `node scripts/cli.ts build-exe`. **[upstream]**
- The released `t3` is a **Node single executable (SEA)**, Node `v26.12.1` (`NODE_SEA_BLOB` and fuse present). node-pty and other native modules sit beside it in `node_modules/`. **[binary]**
- A fork does not need the executable. Running `node dist/bin.mjs` from `apps/server` serves `apps/web/dist` through the `../../web/dist` static dir candidate. **[upstream]** `config.ts` (not run)
- Cheapest fork (unverified): build only `apps/web` from tag `v0.1.7` and copy its `dist/` over `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/`. The official server keeps running. The web build must match the server version because of the orchestration protocol and RPC schemas.

### Files a "swap the terminal for an iframe" change touches

This was an early viewport-replacement option. Do not create a Warp iframe/runtime for every thread: the current requirement is one application runtime per browser tab. Prefer the separately hosted Warp surface described in the [surface study](/Users/alexbrodsky/GitHub/panelwarp/docs/t3-code-warp/t3code-surfaces.md), with logical per-thread state inside that runtime.

| File | Change |
| --- | --- |
| `apps/web/src/components/ThreadTerminalDrawer.tsx` | Replace `TerminalViewport` (Ghostty surface) with an `<iframe>` whose `src` carries `cwd`, `threadId`, `terminalId`. Keep tabs and splits or drop them |
| `apps/web/src/components/PersistentThreadTerminals.tsx` | Already computes `cwd`, `worktreePath`, `runtimeEnv`. Pass them to the iframe. Keep the hide-not-unmount behavior so Warp sessions survive thread switches |
| `apps/web/src/components/terminal/useThreadTerminalActions.ts` | Only if launching, splitting or closing changes |
| `apps/web/src/terminalUiStateStore.ts` | Only if the state shape changes |
| `apps/web/src/components/ChatView.tsx` | Probably untouched |
| `apps/web/src/keybindings.ts` | Only if shortcuts must work while focus is inside the iframe. Key events inside an iframe do not reach the parent window, so `mod+j` and friends stop working from inside Warp unless Warp forwards them with `postMessage` |

Server, contracts and `apps/web/src/terminal/ghostty/` can stay as they are. Project scripts still write into T3 terminals, so the Ghostty path stays in use for those unless also changed.

### Churn (commits on `main`, from GitHub history pages)

| Path | Recent commits | Rough rate |
| --- | --- | --- |
| `apps/web/src/components/ThreadTerminalDrawer.tsx` | 35 commits from 2026-09-04 to 2026-11-04. 25 in October | about 20 to 25 per month |
| `apps/web/src/terminal/` (Ghostty) | 28 in October, 3 in Nov 1 to 8 | about 25 per month |
| `apps/server/src/terminal/` | 26 from Oct 11 to 31, 9 in Nov 1 to 8 | about 35 per month |
| `apps/web/src/components/ChatView.tsx` | 35 commits from 2026-10-28 to 2026-11-09 | about 85 per month |

Sources: https://github.com/pingdotgg/t3code/commits/main/apps/web/src/components/ThreadTerminalDrawer.tsx, https://github.com/pingdotgg/t3code/commits/main/apps/web/src/terminal, https://github.com/pingdotgg/t3code/commits/main/apps/server/src/terminal, https://github.com/pingdotgg/t3code/commits/main/apps/web/src/components/ChatView.tsx

A patch confined to `ThreadTerminalDrawer.tsx` will hit rebase conflicts most weeks. Keeping the change in one new component plus a small hook point lowers that.

### Release cadence

- Stable tags: `v0.1.0` 2026-10-15, `v0.1.4` 2026-10-29, `v0.1.6` 2026-10-31, `v0.1.7` 2026-11-04, `v0.1.8` 2026-11-09. Nine stable releases in about 25 days. Several nightly and preview tags per day. https://api.github.com/repos/pingdotgg/t3code/git/refs/tags/v0.1
- CONTRIBUTING says outside contributions are not actively sought, and features need maintainer approval first. An upstream "pluggable terminal" PR is unlikely to land without prior discussion. https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/CONTRIBUTING.md

## 8. Security notes that affect embedding

- `access-control-allow-origin: *` is set on every response, including `401`s. **[server]** With `*`, browsers do not let cross-origin pages read credentialed responses. Credentialed CORS is enabled only for the dev origin when `--dev-url` is set. **[upstream]** `http.ts`
- Unauthenticated routes that answer: `/`, static assets, `/api/auth/session`, `/.well-known/t3/environment` (leaks environment id, machine label, OS, version). Data routes return `401` without a credential. **[server]**
- Cookie-authenticated HTTP and WebSocket requests must pass `isBrowserOriginAllowed`: no `Origin` header, or `Sec-Fetch-Site: same-origin`, or a trusted origin (dev URL origin, desktop renderer origins, `devAllowedOrigins`), or an Origin host (with port) equal to `Host` / `X-Forwarded-Host`. **[upstream]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/server/src/auth/EnvironmentAuth.ts
- Effect for a Warp page on `127.0.0.1:<other port>`: the browser sends the T3 cookie (same host, `SameSite=Lax`, same-site), but the Origin check rejects it because the port differs. So that page cannot open T3's `/ws` or read T3 data with the user's cookie. It needs a same-origin bridge (injected script or proxy), a bearer token, or `wsTicket`.
- `T3CODE_DEV_ALLOWED_ORIGINS` exists in the binary. If it feeds `devAllowedOrigins` in normal `serve` mode, it would let a named extra origin use the cookie on the WebSocket. Unverified.
- No `X-Frame-Options` or CSP on `index.html`, so T3 itself can be framed by a wrapper page. In a same-site wrapper (another `127.0.0.1` port) the `Lax` cookie is still sent and requests from the T3 frame keep their own origin, so it should keep working (unverified). The wrapper cannot read the T3 frame's URL across ports.
- Bearer and DPoP requests skip the Origin check by design. Tickets for `/ws` come from `POST /api/auth/websocket-ticket` with a bearer token.
- No CSRF token. `SameSite=Lax` and the Origin check are the protection. **[upstream]** `auth/http.ts`
- Nothing severe found. The Origin check blocks the obvious cross-port WebSocket hijack from other local pages.
