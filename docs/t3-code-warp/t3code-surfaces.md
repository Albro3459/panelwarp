# T3 Code surfaces: adding a "Warp" surface

Research notes on adding a "Warp (W)" entry to T3 Code's "Open a surface" list. The Warp page is one shared `<iframe>` for the whole browser page. It must never be unmounted, re-parented or reloaded. Scope is T3 Code 0.1.7 in web mode (`t3 serve` on `http://127.0.0.1:3773`).

Earlier work: `/Users/abrodsky/.t3/worktrees/panelwarp/t3-code-warp/docs/t3-code-warp/t3code-terminal.md` and `/Users/abrodsky/.t3/worktrees/panelwarp/t3-code-warp/docs/t3-code-warp/README.md`. This doc does not repeat them.

## Sources

| Tag | Source |
| --- | --- |
| **[client]** | Installed build `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/` (minified, no source maps on disk or on the server). Only `0.1.7` exists under `/Users/abrodsky/.t3/runtime/versions/` |
| **[server]** | Running server `http://127.0.0.1:3773`, GET only. `/.well-known/t3/environment` reports `serverVersion` `0.1.7` |
| **[launcher]** | `/Users/abrodsky/.npm/_npx/89628044cae88a02/node_modules/t3/bin/t3.mjs` (launcher `0.1.7`). The running process is `npm exec t3@latest serve --host 127.0.0.1 --port 3773` |
| **[v0.1.7]** | Upstream tag `v0.1.7`, read through `https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/<path>` with a summarizing fetch tool. Names and shapes are close to the source but not character checked |
| **[v0.1.8]** | Upstream tag `v0.1.8`, spot checks only |
| **[history]** | GitHub commit history pages and the commits API |

"Unverified" marks anything inferred and not tested. Nothing was edited, built or run.

## 1. Surface model

### Where kinds are defined

- Surface kinds live only in the web app, in `apps/web/src/rightPanelStore.ts`. Not in `packages/contracts`, not on the server. The store imports only id brands (`ThreadId`, `EnvironmentId`, `RunId`, `ScopedThreadRef`) from `@t3tools/contracts`. **[v0.1.7]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/rightPanelStore.ts
- Names: `RIGHT_PANEL_KINDS` (list of kind strings), `RightPanelSurface` (union), `ThreadRightPanelState`, `singletonSurface()` (builds `diff`, `files`, `pull-requests`, `device`), `browserSurface()`. About 950 lines. **[v0.1.7]**
- `open(ref, kind)` and `toggle(ref, kind)` take `Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "side-chat">`. A new singleton kind added to `RIGHT_PANEL_KINDS` and `singletonSurface` becomes valid for both with no signature edit. **[v0.1.7]**
- The same 9 kinds, storage key and version are in `v0.1.8`. No new kind. **[v0.1.8]**

### Kinds and ids

| Kind | Id shape | Extra fields | Launcher row |
| --- | --- | --- | --- |
| `preview` | `browser:<tabId>` or `browser:new` | `resourceId` | Browser (B) |
| `terminal` | `terminal:<terminalId>` | `resourceId`, `terminalIds`, `activeTerminalId`, `splitDirection?` | Terminal (T) |
| `files` | `files` | `folderTrail?` | Files (F) |
| `file` | `file:<path>` or `attachment:<id>` | `relativePath`, `revealLine`, `revealRequestId`, `attachment?` | none (opened from links) |
| `diff` | `diff` | none | Diff (D) |
| `pull-request` | `pull-request:[<env>:]<projectId>:[<host>:]<repo>:<number>` (URI-encoded parts) | `projectId`, `repository`, `number`, `host?`, `url?`, `detailTab?` | Pull request (P) |
| `pull-requests` | `pull-requests` | none | Linked pull requests (L) |
| `device` | `device` or `device:<hostId>:<deviceId>` | `target?`, `title?` | Device (M) |
| `side-chat` | `side-chat:<threadId>` | `threadId` | Side chat (S), only when the thread has a first message |

Sources: id builders in `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/rightPanelStore-ocfGPHT9.js` **[client]**, union in `rightPanelStore.ts` **[v0.1.7]**.

### Where the list is built

Both lists are in `apps/web/src/components/RightPanelTabs.tsx` (about 57 KB). **[v0.1.7]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/RightPanelTabs.tsx

| List | Component | When it shows |
| --- | --- | --- |
| "Open a surface" launcher | `RightPanelEmptyState`, array `actions` | Right panel is open and `activeSurfaceId === null` **[client]** |
| "+" menu | `addSurfaceActions` inside `RightPanelTabs` | The "+" button (`aria-label="Add panel surface"`) in the tab bar, or `mod+t` (`rightPanel.new`) **[client]** |

Both hold the same 8 rows with the same letters. The launcher adds a `description` for Device and Side chat. Disabled reasons come from `SURFACE_DISABLED_REASONS` (menu tooltips) and `SURFACE_UNAVAILABLE_HINTS` (launcher). **[v0.1.7]** **[client]**

Props on `RightPanelTabsProps`: `onAddBrowser`, `onAddBrowserInProfile`, `onAddTerminal`, `onAddDiff`, `onAddFiles`, `onAddPullRequest`, `onAddPullRequests`, `onAddDevice`, `onAddSideChat?`, plus `browserAvailable`, `terminalAvailable`, `diffAvailable`, `filesAvailable`, `pullRequestAvailable`, `pullRequestsAvailable`, `deviceAvailable`, `sideChatAvailable?`, `sideChatDisabledReason?`. **[v0.1.7]**

The handlers are created in `ChatView.tsx` and passed through `apps/web/src/components/chat/ChatRightPanel.tsx` (a 51 line wrapper that picks inline or sheet mode and spreads the rest of the props into `RightPanelTabs`). **[client]** **[history]** commit `8da8f61`

### How the letters work

- `surfaceShortcutActionForKey(actions, event)` returns the available action whose `shortcut` matches. It ignores events with `defaultPrevented`, `isComposing`, Meta, Ctrl or Alt. **[v0.1.7]** **[client]**
- The key comes from `surfaceShortcutKey` (`/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/surfaceShortcutKey-D2LA5CyI.js`). It lowercases `event.key`, and for non-Latin layouts falls back to `event.code` (`KeyW` gives `w`). **[client]**
- Launcher: registers a `keydown` listener on `window` in the capture phase while it is mounted. It skips the key when any popup is open (`[data-slot="dialog-popup" | "menu-popup" | "popover-popup" | ...]` with `[data-open]`) or when the target is inside `input, textarea, select, [contenteditable]`. Arrow keys and Enter move a highlight that lives in React state. **[client]**
- "+" menu: `onKeyDownCapture` on the menu popup runs the same matcher. **[client]**
- The launcher root carries `data-surface-launcher-keys="BTFDPLMS"`. A separate "type to focus the composer" handler skips letters listed in that attribute. Any other letter typed with no focus goes to the composer. **[client]** (`useTimelineFollow-DtZEBtsA.js`)

**Is W free?** Yes. No launcher or menu row uses W in `v0.1.7` or `v0.1.8`. No default keybinding uses a bare `w` (only `mod+w` for `terminal.close` and `rightPanel.close`). `/Users/abrodsky/.t3/userdata/keybindings.json` has no bare `w` either. **[client]** **[v0.1.8]**

### Device and Side chat

- **Device** (`kind: "device"`): watch an iOS Simulator or Android Emulator. Added in `dca7b59` "feat(devices): add simulator and emulator support (#10677)", 2026-09-10, about 9,000 added lines. **[history]**
- **Side chat** (`kind: "side-chat"`): a second chat beside the thread, "Ask a side question while this thread keeps working." Added in `50c1c5d` "feat: side chats beside the main thread (#26901)", 2026-10-31. This is the newest kind. **[history]**

Both are full features with server and contracts work. The surface plumbing is a small part of each.

### Files touched by the newest kind (`50c1c5d`, side chat)

The commit has 4,710 added and 987 removed lines. The API listing was read in 100 KB pages, so a few file names at page edges may be missing. **[history]** https://api.github.com/repos/pingdotgg/t3code/commits/50c1c5d

| Area | Files |
| --- | --- |
| Surface plumbing (web) | `apps/web/src/rightPanelStore.ts` (+42 -5), `apps/web/src/rightPanelStore.test.ts`, `apps/web/src/components/RightPanelTabs.tsx` (+99 -3), `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` (+14), `apps/web/src/components/chat/useRightPanelActions.ts` (+9 -4), `apps/web/src/hooks/useRightPanelSurfaceClose.ts` (+26 -1) and its test, `apps/web/src/closedViewStore.ts` (+2) and its test, `apps/web/src/reopenClosedView.ts` (+6 -1) and its test, `apps/web/src/components/ReopenClosedViewShortcut.tsx` (+5), `apps/web/src/components/CommandPalette.logic.ts` (+2 -2), `apps/web/src/components/ChatView.tsx` (+291 -171) |
| Side chat feature (web) | New `apps/web/src/components/chat/SideChatPane.tsx`, `apps/web/src/components/chat/useSideChat.ts`, `apps/web/src/lib/sideChatPane.ts`. Edits to `ChatComposer.tsx`, `MessagesTimeline.tsx`, `ThreadRelationshipsControl.tsx`, `useChatShortcuts.ts`, `useComposerMenuItems.ts`, `useComposerSend.ts`, `useComposerStash.ts`, `usePasteToFocusComposer.ts`, `useThreadLifecycle.tsx`, `ThreadActivityBanners.tsx`, `ThreadDetailsCard.tsx`, `ThreadDetailsPanel.tsx`, `backgroundThread.ts`, `composerSlashCommandSearch.ts`, `threadDetailsItems.ts`, `timelineViewport.ts`, `AssistantSelectionToolbar.tsx`, `ComposerPendingUserInputPanel.tsx`, `BackgroundThreadAnnouncer.tsx`, `Sidebar.logic.ts`, `browser/openFileInPreview.ts`, `composer-logic.ts`, `lib/desktopPasteAsText.ts` |
| Server | About 25 files under `apps/server/src/orchestration-v2/` (Orchestrator, ProjectionStore, ProviderTurnStartService, ThreadForkService, ContextHandoffService, checkpoints, search and more), plus `environment/ServerEnvironment.ts`, `pullRequest/linkedThreads.ts`, `relay/AgentAwarenessRelay.ts`, `serverRuntimeStartup.ts`, `storageCleanup.ts` |
| Shared packages | `packages/contracts/src/orchestrationV2.ts` (+27 -1), `packages/contracts/src/environment.ts` (+2), seven files in `packages/client-runtime/src/` (`state/threadShell.ts`, `state/models.ts`, `operations/commands.ts`, `promptLinks.ts`, ...), `packages/shared/src/agentAwareness.ts` |
| Other | 4 mobile files, 2 docs, 1 eval case |

The Device commit `dca7b59` touched these surface files: `RightPanelTabs.tsx` (+31), `ChatView.tsx` (+75, the surface switch still lived in ChatView then), `rightPanelStore.ts` (+11 -1), and added `apps/web/src/components/device/DevicePanel.tsx`. Its `packages/contracts/src/device.ts` is the device RPC, not the surface kind. **[history]**

Takeaway: a surface kind needs only web files. The minimum set is the store, the tab bar, the content switch and the place that wires the "add" handler.

## 2. Where surfaces render

| Place | What shows there | Notes |
| --- | --- | --- |
| Right panel, inline | One active surface, tabs on top | Beside the chat column. Width per thread in localStorage `t3code:preview-panel-width:<threadKey>`. Can be maximized (`maximized: true` in state) **[client]** |
| Right panel, sheet | Same panel in a sheet | Narrow windows. `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)"` **[v0.1.7]**. Mapping of that query to sheet mode is unverified |
| Bottom drawer | T3 terminals only | Not a surface host. See the earlier doc |
| Floating mini player | Browser or device only | `previewMiniPlayerStore` sources are `browser` or `device`, one per thread, not persisted **[client]** |
| Split | None for surfaces | Only the terminal surface splits terminals inside itself (max 4) |

- At most one right panel surface is visible per window at a time. The mini player and the terminal drawer can show beside it. **[client]**
- Panel state is per thread. `byThreadKey` is keyed by `"<environmentId>:<threadId>"`. **[client]** (`utils-BL51zcsk.js`)
- `ChatView` renders `RightPanelSurfaceContent` once, with the active surface only. **[client]** (`_chat-Cz6MbZKI.js`, function `Fk`) **[v0.1.7]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/chat/RightPanelSurfaceContent.tsx

### DOM hooks around a surface

From `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/PanelLayoutControls-BcQBbDGC.js` **[client]**:

```
div[data-workspace-area][data-workspace-focus-key="panel:<environmentId>:<activeSurfaceId or empty>"]
   [data-preview-panel-mode="inline" | "sheet"][data-preview-panel-maximized="true" | "false"]
  div[data-right-panel-tabbar]
    div[data-right-panel-tab-list]          (scroll area)
      div[data-active-tab]                  (one per tab, dnd-kit sortable attributes)
    button[aria-label="Add panel surface"]  (opens the "+" menu)
  div[data-right-panel-surface-content]     (holds the active surface or the launcher)
    div[aria-label="Open a surface"][data-surface-launcher-keys="BTFDPLMS"][data-workspace-focus-default]
      h3 "Open a surface"
      div.flex.flex-col.gap-0.5
        div.group.relative > button[type=button] > span(icon) + span(label) + kbd[data-slot=kbd]
        div[aria-disabled=true][tabindex=0]  (unavailable rows, with a tooltip)
```

- `data-workspace-focus-key` exposes the active surface id in the DOM. For example `panel:<env>:files` or `panel:<env>:empty`.
- While the panel closes with animations on, the panel root gets `inert` and its width animates to 0. **[client]**
- Other stable hooks: `[data-right-panel-toggle]` (header button), `[data-chat-column]`, `[data-thread-terminal-drawer]`, `[data-slot="sidebar-inset"]`, `[data-preview-mini-player]`, `#root`. **[client]**

## 3. Mount lifetime

| Event | What happens to the surface component | Source |
| --- | --- | --- |
| Switch surface tab | The old surface unmounts. Only the active surface is rendered | **[client]** `Fk` gets one `surface` |
| Close the panel | Stays mounted during the close animation (a presence hook keeps the last value), then unmounts | **[client]** `ZD` in `main-sk5g_Jie.js` |
| Switch thread | `ChatView` is reused, not remounted ("Unkeyed so navigating between server threads reuses one ChatView"). If the new thread's active surface has the same kind, React keeps the same component instance with new props, unless the case sets a `key` (side chat keys by surface id, pull request by `<threadKey>:<id>`, diff by thread key). Otherwise it unmounts | **[v0.1.7]** `ThreadRouteView.tsx`, **[client]** |
| Open Settings or Usage | The current thread view stays mounted, inert, "in place" under the page (`BackgroundThreadContext`) | **[v0.1.7]** `ThreadRouteView.tsx` |

- T3's own terminal **surface** is not kept alive. `PersistentThreadTerminalPanel` has no wrapper, no portal and no cache. Its PTY lives on the server and the view re-attaches. **[v0.1.7]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/apps/web/src/components/PersistentThreadTerminals.tsx
- The terminal **drawer** stays mounted for threads whose drawer is open and hides inactive ones with the `hidden` class. No portal, no LRU, no reparenting. **[v0.1.7]**

### A keep-alive pattern to copy

T3 already has the exact "slot plus root-level host" pattern, for the desktop (Electron) browser:

| Piece | File | Role |
| --- | --- | --- |
| Slot | `apps/web/src/browser/BrowserSurfaceSlot.tsx` | Renders `<div data-browser-surface-slot={tabId}>`. Measures it with `getBoundingClientRect`, an `observeResize` helper, `resize` and capture-phase `scroll` listeners, and also observes `[data-preview-panel-mode="inline"]` and `[data-slot="sidebar-gap"]`. Calls `present(rect, visible, cornerRadius, zIndex)` and `release()` on unmount **[client]** `fT` in `_chat-Cz6MbZKI.js` |
| Store | `apps/web/src/browser/browserSurfaceStore.ts` | Zustand store `byTabId[tabId] = { rect, visible, zIndex (default 30), cornerRadius, owner }`. `claim` gives each slot a unique `Symbol` owner so a stale slot cannot hide a newer one **[client]** `Ib`/`Rb` in `main-sk5g_Jie.js` |
| Host | `apps/web/src/browser/ElectronBrowserHost.tsx` and `HostedBrowserWebview.tsx` | One `<webview>` per tab inside `<div class="contents" data-electron-browser-host>` at app level. Each is a `position: fixed` wrapper placed at the slot rect. Hidden tabs stay mounted. Sorted by a stable id because "Electron destroys a moved webview's guest" **[v0.1.7]** |

The upstream directory listing is at https://api.github.com/repos/pingdotgg/t3code/contents/apps/web/src/browser?ref=v0.1.7. In web mode this host returns `null` (Electron only). The browser surface in web mode is the server-side JPEG stream from the earlier doc.

A persistent Warp iframe can copy this design one to one: slot component in the surface, small store or module with claim, present and release, and one fixed-position iframe owned outside React's surface tree.

## 4. State

| Key | Where | Version | Content |
| --- | --- | --- | --- |
| `t3code:right-panel-state:v2` | localStorage (zustand `persist`) | 14 | `{ byThreadKey: { [threadKey]: { isOpen, activeSurfaceId, surfaces[], dismissedDeviceSurfaceIds?, maximized?, proactiveDiffTurnId? } }, threadPanelVisibilityByThreadKey }` |
| `t3code:closed-views:v2` | localStorage | 2 | Last 20 closed tabs for `mod+shift+t` (`{ kind: "panel-tab", threadRef, surface }`). Terminal and live browser tabs are not remembered |
| `t3code:preview-panel-width:<threadKey>` | localStorage | none | Panel width |

Sources: `/Users/abrodsky/.t3/runtime/versions/0.1.7/client/assets/rightPanelStore-ocfGPHT9.js` **[client]**, `rightPanelStore.ts` **[v0.1.7]**.

- Nothing about surfaces is sent to or validated by the server. `packages/contracts` has no surface schema. **[v0.1.7]** **[client]**
- `migratePersistedRightPanelState` runs only when the stored version differs from 14 (zustand `persist` behaviour, unverified in this build). It drops `plan` and `agents`, checks `file`, `pull-request` and `terminal`, and **keeps any other kind unchanged**. So a `warp` surface survives a reload and a version bump. **[client]** **[v0.1.8]**
- What a stock client does with a stored `warp` surface (read from minified code, unverified at runtime):
  - The tab renders with an empty title and no icon (`surfaceTitle` and `SurfaceIcon` have no default case).
  - The content area renders nothing (`RightPanelSurfaceContent` has no default case and returns `undefined`). No crash expected.
  - Closing it adds it to closed views. Reopening it with `mod+shift+t` falls into `default: open(ref, kind)`. `singletonSurface("warp")` returns `undefined` and the add step reads `.id` of it. That likely throws. Only matters after going back from a fork to stock.
  - The closed-views validator (`default: return false`) drops unknown kinds, but only when that store migrates.
- So no migration is needed for the fork. A cleanup step when going back to stock is optional.

## 5. Fork patch for a real "Warp" surface

### Design

- Kind `warp`, singleton per thread, id `warp`, no extra fields. Per-thread open state comes for free from `byThreadKey`.
- `WarpSurface` renders `<div data-warp-slot class="min-h-0 flex-1" />` and reports `{ threadKey, cwd, visible, rect }` to a module-level host.
- `warpFrameHost` creates the iframe once with `document.body.appendChild`, never moves it, and positions it with `position: fixed` over the slot rect. This avoids an edit to `routes/__root.tsx`.
- Hide with `visibility: hidden` and `pointer-events: none`, keeping the last size. Do not use `display: none` or a 0x0 size, since the wasm canvas would resize to 0 (unverified for Warp).
- `cwd` is already computed in ChatView as `thread.worktreePath ?? project.workspaceRoot` and passed to `RightPanelSurfaceContent` as `files.workspaceRoot` (variable `td` in the minified ChatView). No new ChatView prop is needed for it. **[client]**
- Hide the iframe when the slot is released, when the panel root has `inert`, and when `BackgroundThreadContext` says the thread is in the background (Settings or Usage). Otherwise the iframe would draw over the Settings page.
- Keep the iframe `z-index` below Base UI popups (menus, dialogs, tooltips are portaled to `body`). T3 uses 30 for its native browser views. **[client]**

### Files

| # | File | Edit | Size | Commits per month on `main` |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/components/warp/WarpSurface.tsx` | **New**. Slot `div`, `useLayoutEffect` claim and release, reads `BackgroundThreadContext` | about 40 lines | new |
| 2 | `apps/web/src/components/warp/warpFrameHost.ts` | **New**. Creates the iframe, owner tokens like `browserSurfaceStore`, rect tracking (`ResizeObserver`, `resize`, capture `scroll`), `postMessage({ type: "warp-thread", threadKey, cwd })` with an exact target origin | about 120 lines | new |
| 3 | `apps/web/src/rightPanelStore.ts` | **Add to lists**: `"warp"` in `RIGHT_PANEL_KINDS`, `{ id: "warp"; kind: "warp" }` in `RightPanelSurface`, one `case "warp"` in `singletonSurface` | about 4 lines | Sep 12, Oct 16, Nov 1 (to Nov 9) |
| 4 | `apps/web/src/components/RightPanelTabs.tsx` | **Add to lists**: `onAddWarp?` and `warpAvailable?` props, one row in `addSurfaceActions`, one row in `RightPanelEmptyState` `actions` (label "Warp", shortcut "W", a lucide icon), one entry in each reason map, one `case` in `surfaceTitle` and in `SurfaceIcon` | about 25 lines | Sep 9 or more, Oct 26, Nov 0 |
| 5 | `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` | **Add a case**: `case "warp": return <WarpSurface threadRef={threadRef} cwd={props.files.workspaceRoot ?? null} visible={visible} />` plus an import | about 4 lines | created Oct 17. Oct 7, Nov 2 |
| 6 | `apps/web/src/components/ChatView.tsx` | **Add 2 props** next to `onAddDevice` on `<ChatRightPanel>`: `onAddWarp={() => threadRef && useRightPanelStore.getState().open(threadRef, "warp")}` and `warpAvailable={project !== null}` | 2 lines | about 85 (35 commits from Oct 28 to Nov 9) |
| 7 | `apps/web/src/closedViewStore.ts` (optional) | Add `case "warp":` to the `diff`/`files`/`pull-requests` validator group | 1 line | 2 commits ever (Oct) |

Sources for churn: https://github.com/pingdotgg/t3code/commits/main/apps/web/src/rightPanelStore.ts, https://github.com/pingdotgg/t3code/commits/main/apps/web/src/components/RightPanelTabs.tsx, https://github.com/pingdotgg/t3code/commits/main/apps/web/src/components/chat/RightPanelSurfaceContent.tsx, https://github.com/pingdotgg/t3code/commits/main/apps/web/src/closedViewStore.ts, ChatView figure from the earlier doc. **[history]**

Notes:

- Every edit to an existing file is additive (new list items, new `case` lines, new optional props). No existing line changes meaning.
- With item 3, `open`, `toggle`, reopen-closed (`default: open(ref, kind)`) and the close flow all work for `warp` without more edits. **[client]** (inferred, unverified)
- Not needed: `packages/contracts`, the server, `ChatRightPanel.tsx` (it spreads props), `routes/__root.tsx` (the host attaches itself to `body`).
- Run the web typecheck after each rebase. `vp build` does not typecheck (Vite default, unverified for `vp`). A missing `case` in a `switch` that must return a value shows up there.
- `RightPanelTabs.tsx` is the main conflict risk. Put the new rows after the Side chat rows, which rarely change. `ChatView.tsx` changes daily but two prop lines conflict only when the neighbouring props change.
- `main` moved 510 commits from `v0.1.7` to `v0.1.8` in 5 days. **[history]** https://api.github.com/repos/pingdotgg/t3code/compare/v0.1.7...v0.1.8

### Compared with the earlier "replace the terminal viewport" patch

| | New `warp` surface | Replace terminal viewport |
| --- | --- | --- |
| Files | 2 new, 4 or 5 existing | 2 or 3 existing |
| Kind of edit | Additive list items and cases | Logic change inside `ThreadTerminalDrawer.tsx` (about 1,300 lines) and `PersistentThreadTerminals.tsx` |
| Churn of touched files | 1 to 26 per month, plus 2 lines in ChatView | 20 to 25 per month on the drawer |
| T3's own terminal | Untouched. Agents and project scripts keep using it | Replaced or split in two |
| Iframe lifetime | Owned by one module, never moved | Tied to drawer mount, per thread, needs extra work to share one instance |

## 6. Fork-lite pipeline

Build only `apps/web` at the release tag and copy `dist/` over the installed `client/`. The official `t3` binary keeps running.

### Why it works

- The server streams static files from `<binary dir>/client` per request. `index.html` is re-read every time (earlier doc). **[v0.1.7]** `apps/server/src/http.ts`
- Workspace packages export TypeScript source (`"import": "./src/index.ts"` in `packages/contracts/package.json`), so the web app builds with no other package built first. **[v0.1.7]**
- The Ghostty wasm files are committed in `apps/web/src/terminal/ghostty/vendor/`. No Zig build is needed. **[v0.1.7]**
- The server reads `clientAppVersion` from the WebSocket URL for analytics only. It does not compare it to its own version. The only hard check is `orchestrationProtocol`. **[v0.1.7]** `apps/server/src/ws.ts` (partial read)
- The client compares its own `APP_VERSION` to each server's version to offer "update" prompts. **[client]** (`SR` in `main-sk5g_Jie.js`). Build with the exact server version to avoid them.
- The launcher only checks that `.install-complete` holds the version string. It never re-checks file hashes, so a patched `client/` is not overwritten. **[launcher]**

### Gotchas

- `apps/web/package.json` says `"version": "0.1.6"` at tag `v0.1.7`. The release job runs `node scripts/update-release-package-versions.ts "<version>"` first. `vite.config.ts` uses `process.env.APP_VERSION || pkg.version`. So set `APP_VERSION=0.1.7`. **[v0.1.7]** `.github/workflows/release.yml`, `apps/web/vite.config.ts`
- `vite.config.ts` sets `manifest: true` and `emptyOutDir: true`. So `dist/.vite/manifest.json` exists. The installed `client/` has no `.vite/` folder. The server loads that manifest only at startup to mark hashed assets as immutable. Copying it is harmless. Leaving it out is also fine. **[v0.1.7]** **[client]**
- Hashed asset names: copy the new files over the old ones and do not delete old chunks. A page loaded before the copy may still lazy-load old chunk names until it reloads. Replace `index.html` last (`cp -R` order is not guaranteed, so copy `assets/` first, then `index.html`).
- The official bundle was built with `VITE_T3CODE_RELAY_URL=https://relay.t3.codes`, Clerk ids and an OTLP trace endpoint baked in. **[client]** (`dist-DNKh8NnQ.js`). A local build without them should still work against the local server, with relay and sign-in features off (unverified). Set `VITE_T3CODE_RELAY_URL` if those features matter.

### Commands (not run, unverified)

Toolchain from the root `package.json`: Node `26.12.1` (`engines`), `pnpm@12.14.0` (`packageManager`, through Corepack), `vp` from the `vite-plus` dev dependency. **[v0.1.7]** https://raw.githubusercontent.com/pingdotgg/t3code/v0.1.7/package.json

```bash
# one time: a local clone of pingdotgg/t3code, Node 26.12.1, corepack enable
cd <t3code clone>
git fetch --tags
git worktree add ../t3code-v0.1.7 v0.1.7
cd ../t3code-v0.1.7
git apply --3way <path to>/warp-surface.patch
pnpm install --frozen-lockfile --filter "@t3tools/web..."   # web and its workspace deps only
cd apps/web
pnpm exec tsc --noEmit                                       # catches missing switch cases
APP_VERSION=0.1.7 pnpm exec vp build                         # writes apps/web/dist

CLIENT=/Users/abrodsky/.t3/runtime/versions/0.1.7/client
[ -d "$CLIENT.orig" ] || cp -R "$CLIENT" "$CLIENT.orig"      # one-time backup
cp -R dist/assets/. "$CLIENT/assets/"
cp dist/*.png dist/*.ico dist/*.webmanifest "$CLIENT/" 2>/dev/null
cp dist/index.html "$CLIENT/index.html"
echo "0.1.7 $(git rev-parse HEAD) $(shasum -a 256 <path to>/warp-surface.patch)" > "$CLIENT/.warp-patched"
```

Then reload the browser tab. No server restart. Rollback is `cp -R "$CLIENT.orig/." "$CLIENT/"`.

- The root `prepare` script runs `vp config --no-agent` on install. **[v0.1.7]**
- Build time is not stated anywhere upstream. The CI job that builds the bundle has a 30 minute timeout. The web output has 1,165 asset files. A few minutes on an M-series Mac is likely (unverified).
- A plain `pnpm install` without `--filter` would also pull desktop, mobile and server native modules. The filter should avoid that (unverified).

### On each new T3 release, a script would

1. Notice a new folder under `/Users/abrodsky/.t3/runtime/versions/` (or a new `serverVersion` at `http://127.0.0.1:3773/.well-known/t3/environment`) without a `client/.warp-patched` marker.
2. Add a worktree at tag `v<version>` and `git apply --3way` the patch. Stop and report on conflict.
3. Install with the filter, typecheck, build with `APP_VERSION=<version>`.
4. Back up and copy into `versions/<version>/client/`, write the marker.
5. Ask for a browser reload.

The new version must be installed first (the launcher creates the folder on first run). Until step 4 runs, the page is stock T3.

### Stopping silent upgrades

- The running command is `npx t3@latest serve`. `@latest` re-resolves on every start and installs a new `versions/<v>/`. **[server]** (`ps`), **[launcher]**
- Pin it: `npx t3@0.1.7 serve --host 127.0.0.1 --port 3773`, or `npm install -g t3@0.1.7` and run `t3 serve`. The launcher installs exactly its own `package.json` version. **[launcher]**
- Do not use T3's in-app server "Update" action. It is user-triggered. No automatic server update setting was found. **[client]** (unverified for `t3 update` defaults)
- `T3CODE_RELEASE_BASE_URL` redirects where the launcher downloads `v<version>/SHA256SUMS` and `t3-<version>-darwin-arm64.tar.gz`. It verifies only that the archive matches that `SHA256SUMS` and that `t3 --version` runs. **[launcher]** So a local mirror could serve the official tarball repacked with the patched `client/`. Then even `t3@latest` installs the patched build, as long as the mirror publishes every version first (unverified).
- `T3CODE_HOME` moves the whole runtime and data folder, if a separate patched install is wanted. **[launcher]**

## 7. No-fork version of the same UX

A same-origin script (userscript, extension or proxy, see the earlier doc) cannot add a kind to React state. It must be loaded before the app bundle so its `window` capture listeners run first.

### Inserting "Warp (W)" into the launcher and the "+" menu

| | Launcher "Open a surface" | "+" menu |
| --- | --- | --- |
| Component library | Plain `div` and `button`, Tailwind classes | Base UI Menu (`[data-slot="menu-popup"]`, `[data-slot="menu-item"]`, `role="menuitem"`, `aria-keyshortcuts="B"`), portaled to `body` |
| Find it | `[aria-label="Open a surface"][data-surface-launcher-keys]` | `[data-slot="menu-popup"][data-open]` that contains `[aria-keyshortcuts="T"]` |
| Insert | Clone a `div.group.relative` row, change label and `kbd`, append to `div.flex.flex-col.gap-0.5` | Append a clone of a `menu-item` |
| Letter W | Own `window` capture `keydown` with the same guards (no modifiers, not composing, not in a text field, no open popup). Also add `W` to `data-surface-launcher-keys`, or the "type to focus composer" handler sends `w` to the composer | `keydown` capture on the popup |
| Keyboard nav | Arrow keys and Enter skip the injected row (React state index) | Base UI's arrow navigation and highlight skip it |
| Fragility | Medium. React tolerates a foreign child at the end. A re-render can reorder it. The attribute edit is overwritten when the row list changes | High. Base UI owns item registration, focus and close-on-select |

All facts **[client]**. Selectors depend on Tailwind class names and two `aria-label` strings. `RightPanelTabs.tsx` gets about 26 commits a month.

### Where the Warp panel then shows

| Option | How | Depends on | Verdict |
| --- | --- | --- | --- |
| A. Script-owned dock | Fixed panel at the right (or bottom). Shrink `#root` with CSS (`width: calc(100vw - var(--warp-w))`). Toggle from the injected row, a hotkey or a button in `[data-right-panel-tabbar]` | `#root`, URL shape | Least fragile. T3 popovers that size to the viewport can open under the dock |
| B. Overlay T3's right panel content | When "Warp mode" is on for the thread, cover `[data-right-panel-surface-content]`. Turn it off on any tab click in `[data-right-panel-tab-list]` or when `data-workspace-focus-key` changes | 4 selectors | Feels most like a surface. A T3 tab still looks active under Warp. Works best when the panel shows the empty launcher |
| C. Reuse a real surface as the slot | Open Files or Terminal and cover it | Same as B | Poor. Terminal starts a PTY and a Ghostty view. Files loads a tree. The user loses that surface |
| D. Phantom `warp` surface | Write `{ id: "warp", kind: "warp" }` into `t3code:right-panel-state:v2` and reload. Stock T3 shows a blank tab, cover its content | localStorage schema, blank render of unknown kinds | Needs a page reload to add a tab, which reloads Warp. Blank title. Reopen may throw (section 4). Not recommended |

### Handles on `window`

- `window.__TSR_ROUTER__`: the TanStack Router instance. `router.state.location.pathname`, `router.state.matches[].params` (`environmentId`, `threadId`), `router.subscribe("onResolved", fn)`. **[client]** (`Match-CtCj-_Kc.js`, set in the router constructor)
- No zustand store, query cache or debug object is exposed. `window.__INSTANCE` and `window.__TOGGLE` belong to a virtual list library. **[client]**
- Active surface per thread: readable from localStorage `t3code:right-panel-state:v2` (zustand writes on each change) or from `data-workspace-focus-key`. Neither holds a cwd. **[client]**
- Thread `worktreePath` and project `workspaceRoot`: only through the HTTP API with the page's cookie, as in the earlier doc. Walking React fibers would also work but breaks on any refactor.

### Detecting thread switches

- URL shapes: `/<environmentId>/<threadId>` (server thread), `/draft/<draftId>` (draft, no server thread yet), `/settings/...` and `/usage` (thread kept in background). **[client]**
- Thread key format: `"<environmentId>:<threadId>"`. **[client]**
- Events: `window.navigation` `currententrychange` (T3 itself uses it, Chromium), or `__TSR_ROUTER__.subscribe("onResolved")`, or wrap `history.pushState` and `replaceState` plus `popstate`.

### Recommended no-fork design

Option A, with optional sugar:

1. One persistent iframe on `document.documentElement`, owned by the script. Same host code as the fork (section 5), so both routes share it.
2. A docked panel the script draws, shown and hidden with a hotkey and remembered per thread key in the script's own localStorage key.
3. Thread and cwd from `__TSR_ROUTER__` (fallback: URL) plus the HTTP API.
4. Optional: a "Warp (W)" row in the launcher only (not the "+" menu). If the selector misses, nothing breaks.

## 8. Verdict

| | Fork (full) | Fork-lite | Injection |
| --- | --- | --- | --- |
| What runs | Own server and client build | Official server, patched client files | Official server and client, plus a script |
| UX | Real tab, W in both lists, icon, title, reopen, per-thread state, maximize, sheet | Same as full fork | Own dock or overlay. No real tab. Launcher row only |
| First build effort | High. Node 26, pnpm 12, `vp`, native modules (node-pty), own update path | Medium. About 200 new lines, about 35 changed lines, one web build | Low to medium. One script, no build |
| Upkeep per release | Rebase plus full build and own server lifecycle | Re-apply the patch, one web build, copy. A script can do it. Conflicts mostly in `RightPanelTabs.tsx` | Check a few selectors. Often nothing |
| Release pace | 9 stable releases in 25 days, 510 commits from 0.1.7 to 0.1.8 | same | same |
| What breaks when T3 changes | Anything | Patch hunks in `RightPanelTabs.tsx` or ChatView props. Typecheck flags new exhaustive switches | Selectors, launcher markup, URL shape, API routes. Breaks quietly at runtime |

Recommendation: fork-lite with the additive `warp` surface patch, pinned to the installed version, upgraded by a script. Build the iframe host as standalone code so the injection route (option A) can serve as a fallback on a release where the patch does not apply. A full fork adds server upkeep without UX gain.

## Surprises

- "Open a surface" is not a menu. It is the empty state of the right panel. The "+" Base UI menu holds the same 8 rows. Both live in one file.
- Only the active surface is mounted. T3's own terminal surface unmounts on every tab switch.
- T3 already ships the slot and root-host pattern for the desktop browser (`BrowserSurfaceSlot`, `browserSurfaceStore`, `ElectronBrowserHost`), with a code comment that Electron destroys a moved webview.
- Surface kinds are web-only. Unknown kinds survive state migration and render as a blank tab in stock T3.
- The thread view stays mounted under Settings and Usage. An overlay must hide there.
- `apps/web/package.json` at tag `v0.1.7` says `0.1.6`. Builds need `APP_VERSION`.
- The router is exposed as `window.__TSR_ROUTER__`.
- Letters not listed in `data-surface-launcher-keys` go to the composer.
