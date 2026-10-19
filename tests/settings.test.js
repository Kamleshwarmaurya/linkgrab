'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings } = require('../src/main/settings');
const { mkTmp } = require('./_helpers');

test('defaults', () => {
  const dir = mkTmp('lg-set-');
  const s = new Settings({ filePath: path.join(dir, 'settings.json'), defaultDownloadDir: path.join(dir, 'Downloads', 'LinkGrab') });
  assert.deepEqual(s.get(), { downloadDir: path.join(dir, 'Downloads', 'LinkGrab'), maxConcurrent: 3, speedLimit: '', cookiesFrom: '' });
});

test('set validates, merges, persists and emits change', () => {
  const dir = mkTmp('lg-set-');
  const file = path.join(dir, 'settings.json');
  const s = new Settings({ filePath: file, defaultDownloadDir: path.join(dir, 'dl') });
  let changes = 0;
  s.on('change', () => changes++);
  const out = s.set({ maxConcurrent: '5', cookiesFrom: 'Chrome', speedLimit: '2M', downloadDir: path.join(dir, 'mine'), junk: 1 });
  assert.equal(out.maxConcurrent, 5);
  assert.equal(out.cookiesFrom, 'chrome');
  assert.equal(out.speedLimit, '2M');
  assert.equal(out.downloadDir, path.join(dir, 'mine'));
  assert.equal('junk' in out, false);
  assert.equal(changes, 1);
  // invalid values are ignored, previous value kept
  const bad = s.set({ maxConcurrent: 'abc', cookiesFrom: 'x; rm', speedLimit: '--evil', downloadDir: 'relative/path' });
  assert.equal(bad.maxConcurrent, 5);
  assert.equal(bad.cookiesFrom, 'chrome');
  assert.equal(bad.speedLimit, '2M');
  assert.equal(bad.downloadDir, path.join(dir, 'mine'));
  // clamp
  assert.equal(s.set({ maxConcurrent: 0 }).maxConcurrent, 1);
  assert.equal(s.set({ maxConcurrent: 500 }).maxConcurrent, 10);
  // clearing
  assert.equal(s.set({ cookiesFrom: '', speedLimit: '' }).cookiesFrom, '');
  assert.equal(s.get().speedLimit, '');
  // persisted and reloaded
  s.set({ cookiesFrom: 'edge' });
  const again = new Settings({ filePath: file, defaultDownloadDir: path.join(dir, 'dl') });
  assert.equal(again.get().cookiesFrom, 'edge');
  assert.equal(again.get().maxConcurrent, 10);
  // get() returns a copy
  const g = again.get(); g.maxConcurrent = 1;
  assert.equal(again.get().maxConcurrent, 10);
});

test('corrupt settings file falls back to defaults', () => {
  const dir = mkTmp('lg-set-');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '<<<garbage');
  const s = new Settings({ filePath: file, defaultDownloadDir: path.join(dir, 'dl') });
  assert.equal(s.get().maxConcurrent, 3);
  assert.doesNotThrow(() => s.set({ maxConcurrent: 2 }));
});

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

test('v1.1: settings keys are unchanged and a settings change pumps the queue of the services', () => {
  const { createServices } = require('../src/main/api');
  const ud = mkTmp('lg-set11-');
  const svc = createServices({ userDataDir: ud, defaultDownloadDir: path.join(ud, 'dl') });
  assert.deepEqual(Object.keys(svc.settings.get()).sort(), ['cookiesFrom', 'downloadDir', 'maxConcurrent', 'speedLimit']);
  let pumped = 0;
  const orig = svc.queue.pump.bind(svc.queue);
  svc.queue.pump = () => { pumped++; return orig(); };
  svc.settings.set({ maxConcurrent: 2 });
  assert.ok(pumped >= 1);
  assert.equal(svc.settings.get().cookiesFrom, '');
  svc.settings.set({ cookiesFrom: 'firefox' });
  assert.equal(svc.settings.get().cookiesFrom, 'firefox');
});
