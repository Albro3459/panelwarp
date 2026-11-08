// Coding-agent conversations for Warp's Agents panel: recent Claude Code, Codex and Gemini CLI
// sessions from anywhere on this Mac, an AI summary of each (fast model, streamed) and opening
// one (Claude Code in its VS Code editor tab, the others resumed in a new Warp tab).
//
// Everything is read from the agents' own session files; nothing is written to them.

const vscode = require('vscode');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { providerPreferences } = require('./ai');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const GEMINI_TMP = path.join(HOME, '.gemini', 'tmp');

const MAX_CONVERSATIONS = 100;
// How much of a conversation's end the summary is based on (~4k tokens).
const SUMMARY_CHARS = 16000;
// Session files can be tens of MB; only their ends are read.
const HEAD_BYTES = 256 * 1024;
// The head is read on to the end of its last line, so a first prompt with pasted images (several
// MB on one line) isn't cut off, up to this much.
const HEAD_MAX_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
// A Claude conversation opened in another folder's new window is handed off through globalState.
const PENDING_OPEN_KEY = 'warp.pendingClaudeOpen';
const PENDING_OPEN_MAX_AGE = 2 * 60 * 1000;
// Windows of Claude Code tabs saved with "Save Window": closed, to be reopened later as a whole.
const SAVED_WINDOWS_KEY = 'warp.savedWindows';
const MAX_SAVED_WINDOWS = 50;
// When each conversation was last seen (agent:id -> ms), shared by all windows, and when this
// tracking started: turns that finished earlier count as seen.
const SEEN_KEY = 'warp.agentsSeen';
// A turn whose session file hasn't changed for this long isn't running anymore (the agent was
// closed or crashed mid-turn). Long tool calls and permission prompts stay under it.
const STALE_TURN_MS = 30 * 60 * 1000;
const SEEN_SINCE_KEY = 'warp.agentsSeenSince';
// Finished turns are checked this often and announced once they're this old, so Warp's own
// notification for the same turn (WARP_NOTICE_MS either side) can come in first and cover it.
const FINISHED_CHECK_MS = 10 * 1000;
const FINISHED_DELAY_MS = 15 * 1000;
const WARP_NOTICE_MS = 60 * 1000;
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
// Every window watches; the first to create a turn's file here announces it. The window with the
// conversation's folder goes first, one with a parent folder of it after CLAIM_PARENT_MS, others
// after CLAIM_OTHER_MS (more than a check interval each).
const CLAIM_DIR = path.join(os.tmpdir(), 'panelwarp-finished');
const CLAIM_PARENT_MS = 12 * 1000;
const CLAIM_OTHER_MS = 25 * 1000;
const EXTENSION_ID = 'felixkrueckel.panelwarp';
// The macOS notifier app (notifier/main.swift; packaged next to extension.js).
const NOTIFIER_APP = path.join(__dirname, 'notifier', 'Panelwarp.app');
const NOTIFIER = path.join(NOTIFIER_APP, 'Contents', 'MacOS', 'panelwarp-notifier');
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const fromClaudeExtension = (c) => c.agent === 'claude' && c.entrypoint === 'claude-vscode';

/** This window's workspace folder that is `cwd` or contains it (the deepest), or ''. */
function folderFor(cwd) {
  if (!cwd) return '';
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const inside = folders.filter((f) => cwd === f || cwd.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
  return inside.sort((a, b) => b.length - a.length)[0] || '';
}

/** True for the one window that gets to announce this turn. */
function claimTurn(key, doneAt) {
  fs.mkdirSync(CLAIM_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(CLAIM_DIR, `${key.replace(/[^\w.-]/g, '_')}-${doneAt}`), '', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * What a click on the macOS notification opens: the window with the conversation's folder (a new
 * one if none has it), then, for the Claude Code extension, the conversation in its editor tab
 * (through this extension's URI handler, in that window). Terminal sessions only get their window.
 */
function clickUrls(conversation, folder) {
  const scheme = vscode.env.uriScheme;
  const target = folder || (fromClaudeExtension(conversation) ? conversation.cwd : '');
  const urls = [];
  if (target) urls.push(`${scheme}://file${target.split('/').map(encodeURIComponent).join('/')}/`);
  if (fromClaudeExtension(conversation)) {
    urls.push(`${scheme}://${EXTENSION_ID}/open?agent=claude&id=${encodeURIComponent(conversation.id)}`);
  }
  return urls;
}

/**
 * Tells you a conversation finished. While this window is focused that's a VS Code notification
 * (with Open for the Claude Code extension's conversations); otherwise, on macOS, a system
 * notification that brings you to it when clicked.
 */
function notifyFinished(conversation, folder, open, log) {
  // The chat's title as the headline (what its tab shows), the agent below it.
  const title = conversation.title || 'Conversation';
  const body = `${AGENT_NAMES[conversation.agent]} finished`;
  const toast = () => {
    const actions = fromClaudeExtension(conversation) ? ['Open'] : [];
    vscode.window.showInformationMessage(`${title} — ${body}`, ...actions).then((choice) => {
      if (choice === 'Open') return open();
    }).catch((error) => vscode.window.showErrorMessage(error.message));
  };
  if (process.platform !== 'darwin' || vscode.window.state.focused || !fs.existsSync(NOTIFIER)) return toast();
  // The first notification waits for you to allow them, hence the long timeout.
  execFile(NOTIFIER, [title, body, ...clickUrls(conversation, folder)], { timeout: 5 * 60 * 1000 }, (error, _out, stderr) => {
    if (!error) return;
    log.appendLine(`agents: macOS notification failed (${String(stderr).trim() || error.message}); ` +
      'allow Panelwarp in System Settings > Notifications');
    toast();
  });
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Bytes from the start of `file` through the end of the line that crosses HEAD_BYTES. */
function headLength(file, size) {
  if (size <= HEAD_BYTES) return size;
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    for (let pos = HEAD_BYTES; pos < Math.min(size, HEAD_MAX_BYTES); pos += chunk.length) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, pos);
      const newline = chunk.subarray(0, read).indexOf(10);
      if (newline >= 0) return pos + newline + 1;
      if (read < chunk.length) return size;
    }
    return Math.min(size, HEAD_MAX_BYTES);
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed JSON lines from the start (`head`) or end of a file; partial lines are dropped. */
function jsonLines(file, size, which) {
  let length = which === 'head' ? HEAD_BYTES : TAIL_BYTES;
  const start = which === 'head' ? 0 : Math.max(0, size - length);
  if (which === 'head') length = headLength(file, size);
  let lines = readRange(file, start, Math.min(length, size)).split('\n');
  if (which === 'head' && size > length) lines.pop();
  if (which === 'tail' && start > 0) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Visible text of a message's content (a string or content blocks), without tool traffic. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => ['text', 'input_text', 'output_text'].includes(block?.type))
    .map((block) => block.text)
    .join('\n');
}

// Harness-injected messages (command output, environment context, ...) start with a tag.
const isInjected = (text) => /^\s*</.test(text);

const oneLine = (text, max = 120) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Newest files under `dir` matching `test`, as {file, mtimeMs, size}. */
function recentFiles(dir, test, depth) {
  const out = [];
  const walk = (current, level) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) walk(full, level + 1);
      } else if (test(entry.name, full)) {
        try {
          const stat = fs.statSync(full);
          out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CONVERSATIONS);
}

// --- Claude Code: ~/.claude/projects/<cwd slug>/<session id>.jsonl ---------------------------

const claude = {
  files: () => recentFiles(CLAUDE_PROJECTS, (name) => name.endsWith('.jsonl'), 1),

  parse({ file, size }) {
    let cwd = '';
    let firstPrompt = '';
    for (const entry of jsonLines(file, size, 'head')) {
      cwd ||= entry.cwd || '';
      if (!firstPrompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
        const text = contentText(entry.message?.content);
        if (text && !isInjected(text)) firstPrompt = text;
      }
      if (cwd && firstPrompt) break;
    }
    // The chat's title as Claude Code shows it: your rename (`custom-title`, also set by forks)
    // over its AI title, the newest of each.
    let title = '';
    let customTitle = '';
    // When the latest turn ended, or 0 while one runs or after it was interrupted. A turn ends
    // with an assistant message that stopped on its own (`end_turn`); Claude writes
    // `turn_duration` after only some turns.
    let doneAt = 0;
    let state = 'idle';
    // Where the latest turn ran: "claude-vscode" (the Claude Code extension) or "cli".
    let entrypoint = '';
    for (const entry of jsonLines(file, size, 'tail')) {
      if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
      else if (entry.type === 'ai-title' && entry.aiTitle) title = entry.aiTitle;
      else if (entry.type === 'summary' && entry.summary && !title) title = entry.summary;
      if (entry.isSidechain) continue;
      const stopped = ['end_turn', 'stop_sequence'].includes(entry.message?.stop_reason);
      if ((entry.type === 'system' && entry.subtype === 'turn_duration') || (entry.type === 'assistant' && stopped)) {
        doneAt = Date.parse(entry.timestamp) || 0;
        state = 'done';
      } else if ((entry.type === 'user' && !entry.isMeta) || entry.type === 'assistant') {
        doneAt = 0;
        const interrupted =
          entry.type === 'user' && /^\[Request interrupted by user/.test(contentText(entry.message?.content));
        state = interrupted ? 'idle' : 'working';
      }
      if (entry.entrypoint && (entry.type === 'user' || entry.type === 'assistant')) entrypoint = entry.entrypoint;
    }
    // Long sessions: the title can be older than the tail.
    if (!customTitle && !title) {
      for (const entry of jsonLines(file, size, 'head')) {
        if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
        else if (entry.type === 'ai-title' && entry.aiTitle) title = entry.aiTitle;
      }
    }
    title = customTitle || title;
    if (!title && !firstPrompt) return null;
    return { id: path.basename(file, '.jsonl'), title: oneLine(title || firstPrompt), cwd, doneAt, state, entrypoint };
  },

  /** [{role, text}] of the conversation's end. */
  transcript({ file, size }) {
    const turns = [];
    for (const entry of jsonLines(file, size, 'tail')) {
      if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || entry.isSidechain) continue;
      const text = contentText(entry.message?.content);
      if (text && !isInjected(text)) turns.push({ role: entry.type, text });
    }
    return turns;
  },
};

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl ----------------------------

/** A Codex rollout line's message, for both the `response_item` wrapper and the older bare form. */
function codexMessage(entry) {
  const item = entry.type === 'response_item' ? entry.payload : entry;
  if (item?.type !== 'message') return null;
  const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
  const text = role && contentText(item.content);
  return text && !isInjected(text) ? { role, text } : null;
}

const codex = {
  files: () => recentFiles(CODEX_SESSIONS, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), 3),

  parse({ file, size }) {
    let id = '';
    let cwd = '';
    let firstPrompt = '';
    for (const entry of jsonLines(file, size, 'head')) {
      const meta = entry.type === 'session_meta' ? entry.payload : entry;
      id ||= (entry.type === 'session_meta' || !entry.type ? meta?.id : '') || '';
      cwd ||= meta?.cwd || '';
      const message = codexMessage(entry);
      if (!firstPrompt && message?.role === 'user') firstPrompt = message.text;
      if (id && cwd && firstPrompt) break;
    }
    id ||= path.basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1] || '';
    if (!id || !firstPrompt) return null;
    let doneAt = 0;
    let state = 'idle';
    for (const entry of jsonLines(file, size, 'tail')) {
      const event = entry.type === 'event_msg' ? entry.payload?.type : null;
      if (event === 'task_complete') {
        doneAt = Date.parse(entry.timestamp) || 0;
        state = 'done';
      } else if (event === 'turn_aborted') {
        doneAt = 0;
        state = 'idle';
      } else if (event === 'task_started' || event === 'user_message') {
        doneAt = 0;
        state = 'working';
      }
    }
    return { id, title: oneLine(firstPrompt), cwd, doneAt, state };
  },

  transcript: ({ file, size }) => jsonLines(file, size, 'tail').map(codexMessage).filter(Boolean),
};

// --- Gemini CLI: ~/.gemini/tmp/<sha256 of project root>/chats/session-*.json -----------------

const gemini = {
  files: () =>
    recentFiles(GEMINI_TMP, (name, full) => name.endsWith('.json') && path.basename(path.dirname(full)) === 'chats', 2),

  read({ file }) {
    const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
    const turns = (chat.messages || [])
      .map((m) => ({
        role: m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : null,
        text: contentText(m.content) || (Array.isArray(m.content) ? '' : String(m.content ?? '')),
      }))
      .filter((m) => m.role && m.text && !isInjected(m.text));
    return { chat, turns };
  },

  parse(entry, projectRoots) {
    const { chat, turns } = gemini.read(entry);
    const firstPrompt = turns.find((t) => t.role === 'user')?.text;
    if (!chat.sessionId || !firstPrompt) return null;
    // Gemini only stores a hash of the project root; match it against folders we know.
    const hash = chat.projectHash || path.basename(path.dirname(path.dirname(entry.file)));
    // Gemini writes the file once a reply is complete, so an answered last prompt is a done turn.
    const last = (chat.messages || []).filter((m) => m.type === 'user' || m.type === 'gemini').at(-1);
    const doneAt = last?.type === 'gemini' ? Date.parse(last.timestamp || chat.lastUpdated) || entry.mtimeMs : 0;
    const state = doneAt ? 'done' : 'working';
    return { id: chat.sessionId, title: oneLine(firstPrompt), cwd: projectRoots.get(hash) || '', doneAt, state };
  },

  transcript: (entry) => gemini.read(entry).turns,
};

const AGENTS = { claude, codex, gemini };

/** This window's Claude Code editor tabs whose title matches a conversation's (tabs only show it). */
function claudeTabsTitled(conversationTitle) {
  const title = normalizeTitle(conversationTitle);
  if (!title) return [];
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType))
    .filter((tab) => {
      const label = normalizeTitle(tab.label);
      return label && (title.startsWith(label) || label.startsWith(title));
    });
}

class AgentConversations {
  /**
   * @param {import('./ai').WarpAi} ai for the OpenRouter key
   * @param {() => object} settings panelSettings.ai()
   */
  constructor(globalState, log, ai, settings) {
    this.globalState = globalState;
    this.log = log;
    this.ai = ai;
    this.settings = settings;
    // Parsed conversations by file + mtime, and summaries by agent:id:mtime.
    this.parsed = new Map();
    this.summaries = new Map();
    // Where each listed conversation's file is, so later requests can't name arbitrary files.
    this.known = new Map();
    this.summaryInFlight = null;
    // When Warp's own notification last came in (see noteWarpNotice).
    this.warpNoticeAt = 0;
  }

  /** JSON array of {agent, id, title, cwd, updatedAt}, newest first. */
  list() {
    const listed = this.scan();
    const seen = this.globalState.get(SEEN_KEY) || {};
    const since = this.seenSince();
    return JSON.stringify(
      listed.map(({ doneAt, state, ...conversation }) => ({
        ...conversation,
        // `working` while a turn runs; one that stopped writing long ago crashed or was closed.
        status: state === 'working' && Date.now() - conversation.updatedAt > STALE_TURN_MS ? 'idle' : state,
        // Its latest turn finished after you last looked at it (here or in its Claude tab).
        unread: doneAt > Math.max(since, seen[`${conversation.agent}:${conversation.id}`] || 0),
      })),
    );
  }

  /** The newest conversations with doneAt (when their latest turn finished, 0 if none) and state. */
  scan() {
    const projectRoots = new Map();
    const addRoot = (dir) => dir && projectRoots.set(crypto.createHash('sha256').update(dir).digest('hex'), dir);
    for (const folder of vscode.workspace.workspaceFolders || []) addRoot(folder.uri.fsPath);

    const conversations = [];
    // Gemini last, so the Claude and Codex folders can resolve its project hashes.
    for (const agent of ['claude', 'codex', 'gemini']) {
      for (const entry of AGENTS[agent].files()) {
        const cacheKey = `${entry.file}\0${entry.mtimeMs}`;
        let parsed = this.parsed.get(cacheKey);
        if (parsed === undefined || (agent === 'gemini' && parsed && !parsed.cwd)) {
          try {
            parsed = AGENTS[agent].parse(entry, projectRoots);
          } catch (error) {
            this.log.appendLine(`agents: skipped ${entry.file}: ${error.message}`);
            parsed = null;
          }
          this.parsed.set(cacheKey, parsed);
        }
        if (!parsed) continue;
        addRoot(parsed.cwd);
        this.known.set(`${agent}:${parsed.id}`, entry);
        conversations.push({ agent, ...parsed, updatedAt: Math.round(entry.mtimeMs) });
      }
    }
    if (this.parsed.size > 2000) this.parsed.clear();
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    const listed = conversations.slice(0, MAX_CONVERSATIONS);
    this.markVisibleClaudeTabsSeen(listed);
    return listed;
  }

  /**
   * Notifies once when a conversation's turn has finished and nobody has looked at it yet (Claude
   * Code in the VS Code extension or a terminal, Codex, Gemini). Turns already finished when this
   * starts aren't announced. Returns a disposable.
   */
  watchFinished() {
    const announced = new Map();
    for (const conversation of this.scan()) {
      if (conversation.doneAt) announced.set(`${conversation.agent}:${conversation.id}`, conversation.doneAt);
    }
    try {
      for (const name of fs.existsSync(CLAIM_DIR) ? fs.readdirSync(CLAIM_DIR) : []) {
        const file = path.join(CLAIM_DIR, name);
        if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.rmSync(file);
      }
    } catch {}
    // So macOS can relaunch the notifier for a click on one of its notifications.
    if (process.platform === 'darwin' && fs.existsSync(NOTIFIER_APP)) execFile(LSREGISTER, ['-f', NOTIFIER_APP], () => {});
    const timer = setInterval(() => this.announceFinished(announced), FINISHED_CHECK_MS);
    return { dispose: () => clearInterval(timer) };
  }

  announceFinished(announced) {
    try {
      const since = this.seenSince();
      const seen = this.globalState.get(SEEN_KEY) || {};
      for (const conversation of this.scan()) {
        const { agent, id, doneAt, cwd } = conversation;
        const key = `${agent}:${id}`;
        if (!doneAt || (announced.get(key) || 0) >= doneAt) continue;
        // Wait a little: Warp's own notification for the same turn can arrive a moment later, and
        // the window with the conversation's folder gets to announce it first.
        const folder = folderFor(cwd);
        const wait = FINISHED_DELAY_MS + (!folder ? CLAIM_OTHER_MS : folder === cwd ? 0 : CLAIM_PARENT_MS);
        if (Date.now() - doneAt < wait) continue;
        announced.set(key, doneAt);
        if (doneAt <= Math.max(since, seen[key] || 0)) continue;
        if (this.warpNoticeAt && Math.abs(this.warpNoticeAt - doneAt) < WARP_NOTICE_MS) continue;
        if (!claimTurn(key, doneAt)) continue;
        this.log.appendLine(`agents: ${key} finished; notifying`);
        notifyFinished(conversation, folder, () => this.open(agent, id), this.log);
      }
    } catch (error) {
      this.log.appendLine(`agents: finished check: ${error.message}`);
    }
  }

  /** Warp's own notification (its agent plugin) just came in; it covers the turn it's about. */
  noteWarpNotice() {
    this.warpNoticeAt = Date.now();
  }

  seenSince() {
    let since = this.globalState.get(SEEN_SINCE_KEY);
    if (!since) {
      since = Date.now();
      this.globalState.update(SEEN_SINCE_KEY, since);
    }
    return since;
  }

  /** Records that a conversation was seen now (clicked in the Agents panel, its tab in front). */
  markSeen(agent, id) {
    const seen = { ...(this.globalState.get(SEEN_KEY) || {}) };
    seen[`${agent}:${id}`] = Date.now();
    // Only conversations that can still be listed.
    const keys = Object.keys(seen);
    if (keys.length > MAX_CONVERSATIONS * 3) {
      for (const key of keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - MAX_CONVERSATIONS * 2)) {
        delete seen[key];
      }
    }
    this.globalState.update(SEEN_KEY, seen);
  }

  /**
   * A Claude Code conversation shown in front in a Claude editor tab of this focused window is
   * seen. The tab is matched by its title, the only thing VS Code tells us about another
   * extension's webview.
   */
  markVisibleClaudeTabsSeen(conversations) {
    if (!vscode.window.state.focused) return;
    const labels = vscode.window.tabGroups.all
      .map((group) => group.activeTab)
      .filter((tab) => tab?.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType))
      .map((tab) => normalizeTitle(tab.label))
      .filter(Boolean);
    if (!labels.length) return;
    for (const conversation of conversations) {
      if (conversation.agent !== 'claude' || !conversation.doneAt) continue;
      const title = normalizeTitle(conversation.title);
      if (labels.some((label) => title.startsWith(label) || label.startsWith(title))) {
        const seen = this.globalState.get(SEEN_KEY) || {};
        if ((seen[`claude:${conversation.id}`] || 0) < conversation.doneAt) this.markSeen('claude', conversation.id);
      }
    }
  }

  entry(agent, id) {
    if (!this.known.has(`${agent}:${id}`)) this.list();
    const entry = this.known.get(`${agent}:${id}`);
    if (!entry) throw new Error('unknown conversation');
    try {
      const stat = fs.statSync(entry.file);
      return { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      throw new Error('conversation no longer exists');
    }
  }

  /**
   * Streams a summary of the conversation's last ~4k tokens from the fast model, calling
   * `onText` with the summary so far. Only one runs at a time: a new one cancels the last.
   */
  async summarize(agent, id, onText) {
    const entry = this.entry(agent, id);
    const cacheKey = `${agent}:${id}:${entry.mtimeMs}`;
    const cached = this.summaries.get(cacheKey);
    if (cached) return onText(cached);

    const config = this.settings();
    // Transcripts can contain secrets, like recent commands: never sent to hosts that keep them.
    if (!config.privateRouting) throw new Error('Summaries need private routing (Settings › AI provider)');
    let transcript = '';
    for (const turn of AGENTS[agent].transcript(entry).reverse()) {
      const line = `${turn.role === 'user' ? 'User' : 'Agent'}: ${turn.text.trim()}\n\n`;
      if (transcript.length + line.length > SUMMARY_CHARS) {
        if (!transcript) transcript = `…${line.slice(-SUMMARY_CHARS)}`;
        break;
      }
      transcript = line + transcript;
    }
    if (!transcript) throw new Error('No messages to summarize');

    const apiKey = await this.ai.apiKey().catch(() => {
      throw new Error('Needs an OpenRouter API key');
    });
    this.summaryInFlight?.abort();
    const controller = new AbortController();
    this.summaryInFlight = controller;
    const started = Date.now();
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.fastModel,
          max_tokens: 300,
          stream: true,
          reasoning: { enabled: false },
          provider: providerPreferences(config.privateRouting, config.fastPriority),
          messages: [
            {
              role: 'system',
              content:
                'You summarize the end of a conversation between a developer and a coding agent ' +
                '(the transcript may start mid-conversation). Write at most 2 short sentences on ' +
                'what they are working on, then 2-4 bullet points, each on its own line starting ' +
                'with "- ", on where it stands and what is left or blocked. Keep each bullet under ' +
                '12 words. No preamble, no headings, no other markdown.',
            },
            { role: 'user', content: transcript },
          ],
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${response.status}`);
      }
      let text = '';
      let buffered = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (event.error) throw new Error(event.error.message || 'provider error');
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) onText((text += delta));
        }
      }
      text = text.trim();
      if (!text) throw new Error('Empty summary');
      this.summaries.set(cacheKey, text);
      if (this.summaries.size > 200) this.summaries.delete(this.summaries.keys().next().value);
      this.log.appendLine(`agents: summary via ${config.fastModel} in ${Date.now() - started} ms`);
      onText(text);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('cancelled');
      throw error;
    } finally {
      if (this.summaryInFlight === controller) this.summaryInFlight = null;
    }
  }

  /**
   * Opens a conversation. Claude Code ones open in its VS Code editor tab (in a new window for
   * another folder) and this returns undefined; Codex and Gemini ones return the shell command
   * that resumes them, for Warp to run in a new tab. `mode` "terminal" returns the resume
   * command for Claude too; "editor" insists on the Claude Code extension.
   */
  async open(agent, id, mode = 'default') {
    const entry = this.entry(agent, id);
    this.markSeen(agent, id);
    const parsed = this.parsed.get(`${entry.file}\0${entry.mtimeMs}`) || AGENTS[agent].parse(entry, new Map());
    const cwd = parsed?.cwd || '';
    const cd = cwd && fs.existsSync(cwd) ? `cd ${shellQuote(cwd)} && ` : '';
    if (agent === 'codex') return `${cd}codex resume ${shellQuote(id)}`;
    if (agent === 'gemini') return `${cd}gemini --resume ${shellQuote(id)}`;

    if (mode === 'terminal') {
      // A move: its Claude Code tab here closes, so two never write to it at once.
      const tabs = claudeTabsTitled(parsed?.title);
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      return `${cd}claude --resume ${shellQuote(id)}`;
    }
    if (!vscode.extensions.getExtension('anthropic.claude-code')) {
      if (mode === 'editor') throw new Error('The Claude Code extension is not installed');
      return `${cd}claude --resume ${shellQuote(id)}`;
    }
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!cwd || folders.includes(cwd)) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', id);
      return undefined;
    }
    if (!fs.existsSync(cwd)) throw new Error(`folder no longer exists: ${cwd}`);
    // Claude Code resumes conversations of the window's folder, so open that folder; the new
    // window's instance of this extension finishes the job (openPendingClaudeConversation).
    await this.globalState.update(PENDING_OPEN_KEY, { folder: cwd, id, at: Date.now() });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), {
      forceNewWindow: folders.length > 0,
    });
    return undefined;
  }

  /**
   * Moves a conversation's session file to the Trash (so it can be put back), with Claude Code's
   * folder of its subagent transcripts and tool results next to it. Its Claude Code tab here
   * closes first, or the extension would write the file again.
   */
  async trash(agent, id) {
    const entry = this.entry(agent, id);
    const parsed = this.parsed.get(`${entry.file}\0${entry.mtimeMs}`) || AGENTS[agent].parse(entry, new Map());
    const paths = [entry.file];
    if (agent === 'claude') {
      const tabs = claudeTabsTitled(parsed?.title);
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      const sideFolder = path.join(path.dirname(entry.file), id);
      if (fs.existsSync(sideFolder)) paths.push(sideFolder);
    }
    for (const file of paths) {
      await vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: true });
    }
    this.known.delete(`${agent}:${id}`);
    this.log.appendLine(`agents: moved ${agent} conversation ${id} to the Trash`);
  }

  /**
   * This window's Claude Code editor tabs, each matched to a conversation of the window's
   * folders. Tabs only tell us their title; each is matched to the newest unclaimed conversation
   * with that title. `tabs` are all Claude Code tabs, `matched` the ones with a conversation.
   */
  matchClaudeTabs() {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType));
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!folders.length) throw new Error('Open a folder first: Claude Code resumes conversations per folder.');

    const conversations = JSON.parse(this.list()).filter((c) => c.agent === 'claude' && folders.includes(c.cwd));
    const matched = [];
    const claimed = new Set();
    for (const tab of tabs) {
      const label = normalizeTitle(tab.label);
      const conversation =
        label &&
        conversations.find(
          (c) => !claimed.has(c.id) && (normalizeTitle(c.title).startsWith(label) || label.startsWith(normalizeTitle(c.title) || '\0')),
        );
      if (!conversation) continue;
      claimed.add(conversation.id);
      let size = 0;
      try {
        size = this.entry('claude', conversation.id).size;
      } catch {}
      matched.push({ tab, id: conversation.id, cwd: conversation.cwd, title: conversation.title, size });
    }
    return { tabs, matched, folders };
  }

  /**
   * Moves about half of this window's Claude Code tabs, by conversation size, into a new window
   * of the same folder. Each window has its own extension host and renderer, so this splits the
   * memory of big conversations (VS Code crashes a process near 4 GB). The half with the tab in
   * front stays here.
   */
  async splitClaudeTabs(storageDir) {
    const { tabs, matched, folders } = this.matchClaudeTabs();
    if (matched.length < 2) {
      throw new Error(
        `Found ${tabs.length} Claude Code tab${tabs.length === 1 ? '' : 's'} here` +
          (tabs.length > matched.length ? ` (${matched.length} matched to a conversation)` : '') +
          '; splitting needs at least 2.',
      );
    }

    // Biggest first into the lighter half; the half holding the active tab stays.
    const halves = [
      { tabs: [], size: 0 },
      { tabs: [], size: 0 },
    ];
    for (const m of matched.sort((a, b) => b.size - a.size)) {
      const half = halves[0].size <= halves[1].size ? halves[0] : halves[1];
      half.tabs.push(m);
      half.size += m.size;
    }
    const moving = halves.find((half) => !half.tabs.some((m) => m.tab.isActive && m.tab.group.isActive)) || halves[1];

    // The same folder can't be open in two windows, but a workspace file listing it can.
    const workspaceFile = writeWorkspaceFile(storageDir, folders);

    const ids = moving.tabs.map((m) => m.id);
    await this.globalState.update(PENDING_OPEN_KEY, { folder: folders[0], ids, at: Date.now() });
    // Closed here first, so one conversation is never open in two windows at once.
    await vscode.window.tabGroups.close(moving.tabs.map((m) => m.tab));
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFile), { forceNewWindow: true });
    this.log.appendLine(`agents: moved ${ids.length} of ${matched.length} Claude tabs to a new window`);
    return { moved: ids.length, total: matched.length };
  }

  /** The saved windows, newest first. */
  savedWindows() {
    const saved = this.globalState.get(SAVED_WINDOWS_KEY);
    return Array.isArray(saved) ? saved : [];
  }

  /**
   * Saves this window's Claude Code tabs (conversation ids, their editor groups, which is in
   * front) to the saved windows list, closes the tabs and then the window. `reopenWindow` brings
   * them all back. The tabs are closed first so VS Code doesn't restore them itself the next
   * time the folder opens (it would, through Claude Code's webview serializer), which would
   * double them up when the saved window is reopened.
   */
  async saveWindow(storageDir) {
    const { tabs, matched, folders } = this.matchClaudeTabs();
    if (!matched.length) {
      throw new Error(
        tabs.length
          ? `None of the ${tabs.length} Claude Code tab${tabs.length === 1 ? '' : 's'} here matched a conversation of this folder.`
          : 'No Claude Code tabs in this window.',
      );
    }
    const groups = vscode.window.tabGroups.all;
    // A multi-root window keeps its workspace file (or gets one) so it reopens with all folders.
    let workspaceFile;
    const current = vscode.workspace.workspaceFile;
    if (folders.length > 1) {
      workspaceFile = current?.scheme === 'file' && fs.existsSync(current.fsPath) ? current.fsPath : writeWorkspaceFile(storageDir, folders);
    }
    const saved = {
      id: crypto.randomUUID(),
      savedAt: Date.now(),
      folders,
      workspaceFile,
      tabs: matched.map((m) => ({
        id: m.id,
        title: m.title,
        group: Math.max(0, groups.indexOf(m.tab.group)),
        active: m.tab.isActive,
        focused: m.tab.isActive && m.tab.group.isActive,
      })),
    };
    const list = [saved, ...this.savedWindows()].slice(0, MAX_SAVED_WINDOWS);
    await this.globalState.update(SAVED_WINDOWS_KEY, list);
    this.onDidChangeSavedWindows?.();
    await vscode.window.tabGroups.close(matched.map((m) => m.tab));
    this.log.appendLine(`agents: saved window with ${matched.length} Claude tabs (${folders.join(', ')})`);
    await vscode.commands.executeCommand('workbench.action.closeWindow');
    return { saved: matched.length, total: tabs.length, unmatched: tabs.length - matched.length };
  }

  /**
   * Reopens a saved window: its folder (or workspace file) opens in a new window, whose instance
   * of this extension opens the conversations (openPendingClaudeConversation) in their groups.
   * The entry leaves the list; a window that failed to open stays. If the folder is already open
   * in a window, VS Code brings that window forward and the tabs open there.
   */
  async reopenWindow(id) {
    const saved = this.savedWindows().find((w) => w.id === id);
    if (!saved) throw new Error('That saved window is gone.');
    const target = saved.workspaceFile && fs.existsSync(saved.workspaceFile) ? saved.workspaceFile : saved.folders[0];
    if (!target || !fs.existsSync(target)) throw new Error(`folder no longer exists: ${saved.folders[0]}`);
    await this.globalState.update(PENDING_OPEN_KEY, {
      folder: saved.folders[0],
      ids: saved.tabs.map((t) => t.id),
      tabs: saved.tabs,
      at: Date.now(),
    });
    await this.forgetWindow(id);
    const here = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    this.log.appendLine(`agents: reopening saved window with ${saved.tabs.length} Claude tabs (${target})`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: here.length > 0 });
  }

  async forgetWindow(id) {
    await this.globalState.update(
      SAVED_WINDOWS_KEY,
      this.savedWindows().filter((w) => w.id !== id),
    );
    this.onDidChangeSavedWindows?.();
  }
}

/**
 * A workspace file listing the folders, in the extension's storage (old ones are cleaned up),
 * so a folder that is already open in one window can open in another.
 */
function writeWorkspaceFile(storageDir, folders) {
  const dir = path.join(storageDir, 'split-windows');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 30 * 24 * 3600 * 1000) fs.rmSync(file);
    } catch {}
  }
  const name = `${path.basename(folders[0])} ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}`;
  const workspaceFile = path.join(dir, `${name.replace(/[^\w .-]/g, '_')}.code-workspace`);
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: folders.map((folder) => ({ path: folder })) }, null, 2));
  return workspaceFile;
}

/** On activation: opens Claude conversations another window handed to this window's folder. */
async function openPendingClaudeConversation(globalState, log) {
  const pending = globalState.get(PENDING_OPEN_KEY);
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_OPEN_MAX_AGE) {
    await globalState.update(PENDING_OPEN_KEY, undefined);
    return;
  }
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  if (!folders.includes(pending.folder)) return;
  await globalState.update(PENDING_OPEN_KEY, undefined);
  try {
    await vscode.extensions.getExtension('anthropic.claude-code')?.activate();
    if (pending.tabs) {
      await openClaudeTabsInGroups(pending.tabs);
      return;
    }
    for (const id of pending.ids || [pending.id]) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', id);
    }
  } catch (error) {
    log.appendLine(`agents: could not open Claude conversation: ${error.message}`);
  }
}

/**
 * Opens saved Claude Code tabs back into their editor groups (side by side; groups are created
 * as needed). Each opens in the first group and is moved right `group` times; the tab that was in
 * front in each group opens last, so it is in front again, and the focused group gets focus.
 */
async function openClaudeTabsInGroups(tabs) {
  const run = (command) => vscode.commands.executeCommand(command);
  const ordered = [...tabs].sort((a, b) => (a.group || 0) - (b.group || 0) || Number(!!a.active) - Number(!!b.active));
  for (const tab of ordered) {
    await run('workbench.action.focusFirstEditorGroup');
    await vscode.commands.executeCommand('claude-vscode.editor.open', tab.id);
    for (let i = 0; i < (tab.group || 0); i++) await run('workbench.action.moveEditorToNextGroup');
  }
  const focused = tabs.find((t) => t.focused) || tabs.find((t) => t.active) || tabs[0];
  await run('workbench.action.focusFirstEditorGroup');
  for (let i = 0; i < (focused?.group || 0); i++) await run('workbench.action.focusNextGroup');
}

/** A title for matching tab labels: one line, no ellipsis, at least a few characters. */
function normalizeTitle(text) {
  const title = String(text || '').replace(/\s+/g, ' ').replace(/(…|\.\.\.)$/, '').trim().toLowerCase();
  return title.length >= 4 ? title : '';
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

module.exports = { AgentConversations, openPendingClaudeConversation, openClaudeTabsInGroups };
