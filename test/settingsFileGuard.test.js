const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { readMarker, writeMarker } = require('../settingsFileGuard');

test("windows record the open settings file and dead windows' entries are dropped", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelwarp-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, '.settings-file-open.json');
  const live = new Set([1, 2]);
  const isAlive = (pid) => live.has(pid);

  assert.deepEqual(readMarker(marker, isAlive), {});
  assert.deepEqual(writeMarker(marker, 'a', 1, true, isAlive), { a: 1 });
  assert.deepEqual(writeMarker(marker, 'b', 2, true, isAlive), { a: 1, b: 2 });
  assert.deepEqual(writeMarker(marker, 'a', 1, false, isAlive), { b: 2 });
  // Window b quit without removing its entry
  live.delete(2);
  assert.deepEqual(readMarker(marker, isAlive), {});
  assert.deepEqual(writeMarker(marker, 'a', 1, false, isAlive), {});
  assert.equal(fs.existsSync(marker), false);
  // A broken marker counts as no window
  fs.writeFileSync(marker, '[1, 2');
  assert.deepEqual(readMarker(marker, isAlive), {});
  // The real liveness check knows this process
  assert.deepEqual(writeMarker(marker, 'me', process.pid, true), { me: process.pid });
});
