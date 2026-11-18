'use strict';

// Keeps Warp's settings closed while settings.toml or keybindings.yaml is open in an editor, so
// settings always open showing what the files say. Opening a file closes the settings tab; opening
// settings while a file is open asks to close the file first, then opens them.
//
// The windows of one machine share the files, so each window records whether it has one open in a
// marker next to them: {"<window session id>": <extension host pid>}. Entries of windows that quit
// without removing theirs are dropped when their process is gone.

const fs = require('fs');
const path = require('path');

const MARKER = '.settings-file-open.json';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readEntries(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch {
    return {};
  }
}

/** The marker's entries of live windows. */
function readMarker(file, isAlive = alive) {
  const live = {};
  for (const [id, pid] of Object.entries(readEntries(file))) {
    if (Number.isInteger(pid) && isAlive(pid)) live[id] = pid;
  }
  return live;
}

/** Adds or removes this window's entry and drops dead windows' ones. Returns the live entries. */
function writeMarker(file, id, pid, open, isAlive = alive) {
  const before = readEntries(file);
  const entries = readMarker(file, isAlive);
  if (open) entries[id] = pid;
  else delete entries[id];
  if (JSON.stringify(entries) !== JSON.stringify(before)) {
    if (Object.keys(entries).length) fs.writeFileSync(file, JSON.stringify(entries));
    else fs.rmSync(file, { force: true });
  }
  return entries;
}

class SettingsFileGuard {
  /**
   * @param {{dir: string, files: string[], onState: (open: boolean) => void,
   *   log: {appendLine: (line: string) => void}}} options `onState` gets whether a file is open in
   *   any window of this machine, whenever that changes
   */
  constructor(vscode, context, { dir, files, onState, log }) {
    this.vscode = vscode;
    this.files = files;
    this.onState = onState;
    this.log = log;
    this.marker = path.join(dir, MARKER);
    this.id = vscode.env.sessionId;
    this.openHere = false;
    this.open = false;
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      { dispose: () => this.record(false) },
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, (_event, name) => {
        if (!name || name === MARKER) this.refresh();
      });
      watcher.on('error', (error) => log.appendLine(`settings file guard: ${error.message}`));
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (error) {
      log.appendLine(`settings file guard can't watch: ${error.message}`);
    }
    this.refresh();
  }

  /** This window's editor tabs showing one of the files. */
  tabs() {
    const { TabInputText, TabInputTextDiff } = this.vscode;
    const shows = (uri) => uri?.scheme === 'file' && this.files.includes(uri.fsPath);
    return this.vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          (tab.input instanceof TabInputText && shows(tab.input.uri)) ||
          (tab.input instanceof TabInputTextDiff && (shows(tab.input.original) || shows(tab.input.modified))),
      );
  }

  record(open) {
    try {
      return writeMarker(this.marker, this.id, process.pid, open);
    } catch (error) {
      this.log.appendLine(`settings file guard: ${error.message}`);
      return open ? { [this.id]: process.pid } : {};
    }
  }

  refresh() {
    this.openHere = this.tabs().length > 0;
    const open = Object.keys(this.record(this.openHere)).length > 0;
    if (open === this.open) return;
    this.open = open;
    this.onState(open);
  }

  /**
   * Warp asked for settings while a file is open: asks to close it. Returns true if no file is
   * open any more.
   */
  async requestClose() {
    this.refresh();
    if (!this.open) return true;
    const tabs = this.tabs();
    if (!tabs.length) {
      this.vscode.window.showInformationMessage(
        "Warp's settings file is open in another VS Code window. Close it there to open Warp settings.",
      );
      return false;
    }
    const docs = this.vscode.workspace.textDocuments.filter(
      (doc) => doc.uri.scheme === 'file' && this.files.includes(doc.uri.fsPath),
    );
    const dirty = docs.filter((doc) => doc.isDirty);
    const names = [...new Set(docs.map((doc) => path.basename(doc.uri.fsPath)))].join(' and ') || 'the settings file';
    const action = dirty.length ? 'Save and Close' : 'Close';
    const choice = await this.vscode.window.showWarningMessage(
      `Close ${names} to open Warp settings?`,
      {
        modal: true,
        detail: 'Warp settings open from the file, so they show what it says.',
      },
      action,
    );
    if (choice !== action) return false;
    for (const doc of dirty) {
      if (!(await doc.save())) return false;
    }
    await this.vscode.window.tabGroups.close(this.tabs());
    this.refresh();
    return !this.open;
  }
}

module.exports = { SettingsFileGuard, readMarker, writeMarker };
