'use strict';
// Exercises src/main/main.js against a stand-in 'electron' module (real Electron cannot run in CI sandboxes).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmp } = require('./_helpers');

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const FAKE = path.join(__dirname, '_fake_electron.js');

test('--smoke-test prints LINKGRAB_SMOKE_OK and exits 0 without opening a window', () => {
  const r = spawnSync(process.execPath, ['-r', FAKE, MAIN, '--smoke-test'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LINKGRAB_SMOKE_OK/);
  assert.ok(!/SMOKE_FAIL/.test(r.stderr));
});

test('normal start registers every api:* channel, builds the window per contract, and handlers work', () => {
  const script = `
    require(${JSON.stringify(FAKE)});
    require(${JSON.stringify(MAIN)});
    const e = global.__FAKE_ELECTRON__;
    setTimeout(async () => {
      const out = { channels: [...e.__handlers.keys()].sort(), info: e.__info() };
      const call = (n, ...a) => e.__handlers.get('api:' + n)({}, ...a);
      out.settings = await call('getSettings');
      out.list = await call('list');
      out.badAdd = await call('add', 'https://vimeo.com/1', 'best');
      out.badInfo = await call('getInfo', 42);
      out.clip = await call('readClipboardUrl');
      out.folder = await call('chooseFolder');
      out.pause = await call('pause', undefined);
      out.setS = await call('setSettings', { maxConcurrent: 2 });
      out.status = await call('engineStatus');
      out.badImages = await call('add', 'https://www.youtube.com/watch?v=abc', 'images');
      out.badImagesInfo = await call('getInfo', 'https://www.facebook.com/watch/?v=1', 'media');
      out.menu = e.__menu;
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    }, 300);
  `;
  const env = Object.assign({}, process.env, { PATH: '/nonexistent', FAKE_USERDATA: mkTmp('lg-fake-ud-') });
  delete env.LINKGRAB_YTDLP; delete env.LINKGRAB_FFMPEG;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, r.stdout + r.stderr);
  const out = JSON.parse(line.slice(7));
  const expected = ['getInfo', 'add', 'list', 'pause', 'resume', 'cancel', 'remove', 'openFile', 'showInFolder', 'getSettings',
    'setSettings', 'chooseFolder', 'engineStatus', 'installEngine', 'updateEngine', 'readClipboardUrl'].map((n) => 'api:' + n).sort();
  assert.deepEqual(out.channels, expected);
  const w = out.info.windowOptions;
  assert.equal(w.width, 1100); assert.equal(w.height, 700);
  assert.equal(w.minWidth, 900); assert.equal(w.minHeight, 560);
  assert.equal(w.backgroundColor, '#14161a');
  assert.equal(w.webPreferences.contextIsolation, true);
  assert.equal(w.webPreferences.nodeIntegration, false);
  assert.ok(w.webPreferences.preload.endsWith(path.join('src', 'preload', 'preload.js')));
  assert.ok(out.info.loaded.endsWith(path.join('src', 'renderer', 'index.html')));
  assert.equal(out.menu, null);
  assert.equal(out.settings.maxConcurrent, 3);
  assert.deepEqual(out.list, []);
  assert.equal(out.badAdd.ok, false);
  assert.equal(out.badInfo.ok, false);
  assert.equal(out.clip, 'https://youtu.be/zzz111');
  assert.equal(out.folder, null);
  assert.equal(out.pause.ok, false);
  assert.equal(out.setS.maxConcurrent, 2);
  assert.equal(out.status.ytdlp.installed, false);
  // v1.1: the image engine is part of the status shape
  assert.deepEqual(Object.keys(out.status.gallerydl).sort(), ['installed', 'path', 'version']);
  assert.equal(out.status.gallerydl.installed, false);
  assert.equal(out.badImages.ok, false);
  assert.match(out.badImages.error, /X and Instagram/);
  assert.equal(out.badImagesInfo.ok, false);
});

test('--smoke-test also exercises the image engine status and the router', () => {
  const src = require('node:fs').readFileSync(MAIN, 'utf8');
  assert.match(src, /services\.router/);
  assert.match(src, /st\.gallerydl/);
  const r = spawnSync(process.execPath, ['-r', FAKE, MAIN, '--smoke-test'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').pop(), 'LINKGRAB_SMOKE_OK');
});
