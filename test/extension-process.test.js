import test from 'node:test';
import assert from 'node:assert/strict';
import { shellFor } from '../resources/extensions/pi-sync/process.js';

test('extension shellFor uses a shell only for bare Windows command names', () => {
  assert.equal(shellFor('pi-sync', 'win32'), true);
  assert.equal(shellFor('git', 'win32'), true);
  assert.equal(shellFor('C:/Program Files/pi-sync.cmd', 'win32'), false);
  assert.equal(shellFor('C:\\Users\\me\\pi-sync.exe', 'win32'), false);
  assert.equal(shellFor('pi-sync.cmd', 'win32'), false);
  assert.equal(shellFor('pi-sync', 'linux'), false);
  assert.equal(shellFor('/usr/bin/pi-sync', 'linux'), false);
});
