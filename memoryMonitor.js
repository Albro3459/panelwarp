// Status-bar memory monitor for this VS Code window: its extension host, its window renderer and
// its webviews (each webview, e.g. a Claude Code conversation, runs in its own renderer process).
// Hovering lists them; a warning pops up when one process (never the window's total) passes
// `host.memory_warning_gb`, since VS Code crashes a process whose JavaScript heap reaches about
// 4 GB. The extension host is measured by its JS heap, the others by their resident memory.
//
// VS Code doesn't say which webview process belongs to which tab, so webviews are listed by
// process, largest first. Reads `ps`, so macOS and Linux only.

const vscode = require('vscode');
const v8 = require('v8');
const { execFile } = require('child_process');

const POLL_MS = 15_000;
const GB = 1024 ** 3;
const gb = (bytes) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 2 : 1)} GB`;

/** `[[dd-]hh:]mm:ss` -> seconds. */
function parseElapsed(etime) {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime];
  return rest.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86400;
}

function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,etime=,args='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const processes = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (m) processes.push({ pid: +m[1], ppid: +m[2], bytes: +m[3] * 1024, age: parseElapsed(m[4]), args: m[5] });
      }
      resolve(processes);
    });
  });
}

const flag = (args, name) => args.match(new RegExp(`--${name}=(\\S+)`))?.[1];

/**
 * This window's processes, from `ps` output. The extension host is this process; its window is
 * the renderer group (renderers sharing `--vscode-window-config`) that started last before it,
 * and the group's oldest renderer is the window itself, the others its webviews.
 */
function windowProcesses(all) {
  const own = all.find((p) => p.pid === process.pid);
  if (!own) return null;
  const groups = new Map();
  for (const p of all) {
    if (p.ppid !== own.ppid || flag(p.args, 'type') !== 'renderer') continue;
    const config = flag(p.args, 'vscode-window-config');
    if (!config) continue;
    if (!groups.has(config)) groups.set(config, []);
    groups.get(config).push(p);
  }
  let best = null;
  for (const renderers of groups.values()) {
    renderers.sort((a, b) => b.age - a.age);
    const window = renderers[0];
    // Started no later than the extension host (1 s slack for ps' rounding), most recently.
    if (window.age + 1 >= own.age && (!best || window.age < best[0].age)) best = renderers;
  }
  const heap = v8.getHeapStatistics();
  // Its JavaScript heap, exactly: that is what runs out (other processes only have their RSS).
  const extensionHost = {
    ...own,
    bytes: heap.used_heap_size,
    heapLimit: heap.heap_size_limit,
    label: 'Extension host',
    detail: `JS heap, limit ${gb(heap.heap_size_limit)}; ${gb(own.bytes)} in all`,
  };
  return [
    extensionHost,
    ...(best ? [{ ...best[0], label: 'Window' }] : []),
    ...(best ?? []).slice(1).map((p) => ({ ...p, label: 'Webview' })),
  ].sort((a, b) => b.bytes - a.bytes);
}

class MemoryMonitor {
  /** @param {() => number} warningGb @param {vscode.OutputChannel} log */
  constructor(warningGb, log) {
    this.warningGb = warningGb;
    this.log = log;
    /** pids already warned about, until they drop back below the threshold */
    this.warned = new Set();
    this.item = vscode.window.createStatusBarItem('warp.memory', vscode.StatusBarAlignment.Right, 0);
    this.item.name = 'Memory (Warp)';
    this.item.command = 'workbench.action.openProcessExplorer';
    this.timer = setInterval(() => this.update(), POLL_MS);
    this.update();
  }

  async update() {
    let processes;
    try {
      processes = windowProcesses(await listProcesses());
    } catch (error) {
      this.log.appendLine(`memory monitor: ${error.message}`);
    }
    if (!processes) {
      this.item.hide();
      return;
    }
    const limit = this.warningGb() * GB;
    const largest = processes[0];
    // A heap's own limit can be below the setting (VS Code crashed one at ~3.2 GB).
    const isOver = (p) => limit > 0 && (p.bytes >= limit || (p.heapLimit && p.bytes >= 0.85 * p.heapLimit));
    const over = processes.filter(isOver);
    const webviews = processes.filter((p) => p.label === 'Webview').length;

    this.item.text = `$(pulse) ${gb(largest.bytes)}`;
    this.item.backgroundColor = over.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ['warp.splitClaudeTabs'] };
    tooltip.appendMarkdown('**Memory of this window**\n\n| Process | Memory |\n|:--|--:|\n');
    for (const p of processes) {
      const detail = p.detail ? ` (${p.detail})` : '';
      const mark = isOver(p) ? ' $(warning)' : '';
      tooltip.appendMarkdown(`| ${p.label}${detail}${mark} | ${gb(p.bytes)} |\n`);
    }
    tooltip.appendMarkdown(
      `\nEach webview (a Claude Code conversation, Warp, …) is its own process; VS Code doesn't say ` +
        `which tab is which, so close the largest conversation tabs to free one up. ` +
        (limit > 0 ? `Warns above ${this.warningGb()} GB (\`host.memory_warning_gb\` in Warp's settings). ` : '') +
        'Click for the Process Explorer.\n\n' +
        '[$(split-horizontal) Move half of the Claude Code tabs to a new window](command:warp.splitClaudeTabs)',
    );
    this.item.tooltip = tooltip;
    this.item.show();

    for (const pid of this.warned) {
      if (!over.some((p) => p.pid === pid)) this.warned.delete(pid);
    }
    for (const p of over) {
      if (this.warned.has(p.pid)) continue;
      this.warned.add(p.pid);
      this.warn(p, webviews);
    }
  }

  async warn(p, webviews) {
    const what = {
      'Extension host': `The extension host (where extensions like Claude Code run) uses ${gb(p.bytes)}`,
      Window: `This window uses ${gb(p.bytes)}`,
      Webview: `A webview (one of ${webviews} open, e.g. a Claude Code conversation) uses ${gb(p.bytes)}`,
    }[p.label];
    const fix = {
      'Extension host': 'Move some Claude Code tabs to another window or close long conversations before it crashes',
      Window: 'Close editors or reload the window before it crashes',
      Webview: 'Close the largest conversation tab before it crashes',
    }[p.label];
    const split = 'Split Claude Tabs';
    const explorer = 'Process Explorer';
    // Only the extension host's limit is known (its JS heap); the others are measured by RSS.
    const limit = p.heapLimit ? ` (its limit is ${gb(p.heapLimit)})` : '';
    const choice = await vscode.window.showWarningMessage(`${what}. ${fix}${limit}.`, split, explorer);
    if (choice === split) vscode.commands.executeCommand('warp.splitClaudeTabs');
    if (choice === explorer) vscode.commands.executeCommand('workbench.action.openProcessExplorer');
  }

  dispose() {
    clearInterval(this.timer);
    this.item.dispose();
  }
}

module.exports = { MemoryMonitor, windowProcesses, listProcesses };
