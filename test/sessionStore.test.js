const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { SessionStore } = require('../sessionStore');

const DAY_MS = 24 * 60 * 60 * 1000;

function storageDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(t, dir) {
  const store = new SessionStore(dir);
  t.after(() => store.close());
  return store;
}

function layout(uuid, cwd) {
  return JSON.stringify({ windows: [{ tabs: [{ root: { terminal: { uuid, cwd } } }] }] });
}

test('a workspace restores only its own tabs and blocks', (t) => {
  const store = openStore(t, storageDir(t));
  store.saveSession('file:///a', layout('aa', '/a'));
  store.saveBlock('aa', '{"command":"ls"}');
  store.saveSession('file:///b', layout('bb', '/b'));
  store.saveBlock('bb', '{"command":"pwd"}');

  assert.deepEqual(JSON.parse(store.load('file:///a')), {
    session: { windows: [{ tabs: [{ root: { terminal: { uuid: 'aa', cwd: '/a' } } }] }] },
    blocks: { aa: [{ command: 'ls' }] },
  });
  assert.deepEqual(JSON.parse(store.load('file:///b')), {
    session: { windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/b' } } }] }] },
    blocks: { bb: [{ command: 'pwd' }] },
  });
  assert.equal(store.load('file:///c'), null);
});

test("saving a workspace's tabs leaves other workspaces alone", (t) => {
  const dir = storageDir(t);
  const windowA = openStore(t, dir);
  const windowB = openStore(t, dir);
  windowA.saveSession('file:///a', layout('aa', '/a'));
  windowB.saveSession('file:///b', layout('bb', '/b'));
  windowB.saveSession('file:///a', layout('a2', '/a/src'));

  assert.deepEqual(JSON.parse(windowA.load('file:///a')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'a2', cwd: '/a/src' } } }] }],
  });
  assert.deepEqual(JSON.parse(windowA.load('file:///b')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/b' } } }] }],
  });
});

test('the old layout shared by every window is dropped', (t) => {
  const dir = storageDir(t);
  const old = new DatabaseSync(path.join(dir, 'warp.sqlite'));
  old.exec(`
    CREATE TABLE panel_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  old.prepare('INSERT INTO panel_session (id, json, updated_at) VALUES (1, ?, ?)').run(layout('aa', '/a'), Date.now());
  old.close();

  const store = openStore(t, dir);

  assert.equal(store.load('file:///a'), null);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'panel_session'").get(), undefined);
});

test("a workspace's tabs are dropped after 30 days without a save", (t) => {
  const store = openStore(t, storageDir(t));
  store.saveSession('file:///old', layout('aa', '/old'));
  store.saveBlock('aa', '{"command":"ls"}');
  store.saveSession('file:///recent', layout('bb', '/recent'));
  const monthAgo = Date.now() - 31 * DAY_MS;
  store.db.prepare("UPDATE panel_workspace_session SET updated_at = ? WHERE workspace = 'file:///old'").run(monthAgo);
  store.db.prepare("UPDATE panel_blocks SET saved_at = ? WHERE pane_uuid = 'aa'").run(monthAgo);

  assert.equal(store.load('file:///old'), null);
  assert.deepEqual(JSON.parse(store.load('file:///recent')).session, {
    windows: [{ tabs: [{ root: { terminal: { uuid: 'bb', cwd: '/recent' } } }] }],
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM panel_blocks WHERE pane_uuid = 'aa'").get().count, 0);
});
