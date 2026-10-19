'use strict';
// End-to-end: real yt-dlp (generic extractor) against a local HTTP server.
// The site allowlist is relaxed ONLY here (inside this suite) through the test hook env var.

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DownloadQueue } = require('../src/main/queue');
const ytdlp = require('../src/main/ytdlp');
const { Settings } = require('../src/main/settings');
const { createServices, createApi } = require('../src/main/api');
const { mkTmp, findFfmpeg, findYtdlp, sampleVideo, startServer, waitFor } = require('./_helpers');

const YTDLP = findYtdlp();
const FFMPEG = findFfmpeg();
const skip = !YTDLP || !FFMPEG ? 'yt-dlp or ffmpeg not available' : false;

function mkQueue(over) {
  const dir = mkTmp('lg-int-');
  const cfg = Object.assign({ downloadDir: path.join(dir, 'dl'), maxConcurrent: 3, speedLimit: '', cookiesFrom: '' }, over || {});
  const runner = ytdlp.createRunner({ getBinary: () => YTDLP, getFfmpeg: () => FFMPEG });
  const storePath = path.join(dir, 'downloads.json');
  const queue = new DownloadQueue({ ytdlp: runner, settings: { get: () => cfg }, storePath });
  const updates = [];
  queue.on('update', (i) => updates.push(Object.assign({ _t: Date.now() }, i)));
  return { dir, cfg, runner, queue, storePath, updates };
}

const statusOf = (queue, id) => (queue.get(id) || {}).status;
const filesIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

describe('integration (real yt-dlp, local server)', () => {
  let prevHook;
  before(() => { prevHook = process.env.LINKGRAB_ALLOW_ANY_HOST; process.env.LINKGRAB_ALLOW_ANY_HOST = '1'; });
  after(() => { if (prevHook === undefined) delete process.env.LINKGRAB_ALLOW_ANY_HOST; else process.env.LINKGRAB_ALLOW_ANY_HOST = prevHook; });

  test('getInfo through the real yt-dlp (-J) returns title, site and only existing heights', { skip }, async () => {
    const dashDir = mkTmp('lg-dash-info-');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', sampleVideo(), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash',
      '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      path.join(dashDir, 'manifest.mpd')]);
    const srv = await startServer(sampleVideo(), { staticDir: dashDir });
    try {
      const runner = ytdlp.createRunner({ getBinary: () => YTDLP });
      // plain file: yt-dlp reports no height, so only best + audio are offered
      const plain = await runner.getInfo(srv.url('clip.mp4'));
      assert.equal(plain.ok, true, plain.error);
      assert.equal(plain.info.title, 'clip');
      assert.equal(plain.info.site, 'test');
      assert.deepEqual(plain.info.qualities.map((q) => q.key), ['best', 'audio']);
      // DASH manifest: one 640x360 video stream
      const res = await runner.getInfo(srv.url('static/manifest.mpd'));
      assert.equal(res.ok, true, res.error);
      const keys = res.info.qualities.map((q) => q.key);
      assert.deepEqual(keys, ['best', '360', 'audio']);
      assert.match(res.info.qualities[0].label, /360p/);
      assert.equal(typeof res.info.duration, 'number');
    } finally { await srv.close(); }
  });

  test('getInfo reports a clear error for a dead link', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    try {
      const runner = ytdlp.createRunner({ getBinary: () => YTDLP });
      const res = await runner.getInfo(srv.url('missing.mp4'));
      assert.equal(res.ok, false);
      assert.ok(res.error && res.error.length > 10);
    } finally { await srv.close(); }
  });

  test('download completes: progress parsed, LGF path used, file identical to source', { skip }, async () => {
    const srv = await startServer(sampleVideo(), { bytesPerSec: 600000 });
    const { queue, updates, cfg } = mkQueue();
    try {
      const it = queue.add(srv.url('first.mp4'), 'best');
      await waitFor(() => statusOf(queue, it.id) === 'completed', 30000, 'completion');
      const done = queue.get(it.id);
      assert.equal(done.title, 'first');
      assert.equal(done.percent, 100);
      assert.equal(done.error, null);
      assert.equal(done.filePath, path.join(cfg.downloadDir, 'first [first].mp4'));
      assert.ok(fs.existsSync(done.filePath));
      assert.equal(fs.statSync(done.filePath).size, srv.size);
      assert.equal(done.size, srv.size);
      const seen = new Set(updates.map((u) => u.status));
      assert.ok(seen.has('fetching') && seen.has('downloading') && seen.has('completed'), [...seen].join());
      const mid = updates.filter((u) => u.status === 'downloading' && u.percent > 0 && u.percent < 100);
      assert.ok(mid.length >= 2, 'expected intermediate progress updates, got ' + mid.length);
      assert.ok(updates.some((u) => u.speed > 0), 'speed should be reported');
      assert.deepEqual(filesIn(cfg.downloadDir).filter((f) => /\.(part|ytdl)$/.test(f)), []);
      // throttle: <= ~4 progress emits per second
      for (const u of updates) {
        const inWindow = updates.filter((v) => v._t >= u._t && v._t < u._t + 1000).length;
        assert.ok(inWindow <= 8, `${inWindow} updates within one second`);
      }
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('audio quality produces an mp3 via ffmpeg', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    const { queue, cfg } = mkQueue();
    try {
      const it = queue.add(srv.url('tune.mp4'), 'audio');
      await waitFor(() => ['completed', 'error'].includes(statusOf(queue, it.id)), 30000, 'audio');
      const done = queue.get(it.id);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(done.filePath.endsWith('.mp3'), done.filePath);
      assert.ok(fs.statSync(done.filePath).size > 1000);
      void cfg;
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('separate video+audio streams are merged and status goes through "merging"', { skip }, async () => {
    const dashDir = mkTmp('lg-dash-');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', sampleVideo(), '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash',
      '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      path.join(dashDir, 'manifest.mpd')]);
    const srv = await startServer(sampleVideo(), { staticDir: dashDir });
    const { queue, updates, cfg } = mkQueue();
    try {
      const it = queue.add(srv.url('static/manifest.mpd'), 'best');
      await waitFor(() => ['completed', 'error'].includes(statusOf(queue, it.id)), 40000, 'merge');
      const done = queue.get(it.id);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(done.filePath.endsWith('.mp4'));
      assert.ok(updates.some((u) => u.status === 'merging'), 'merging status expected');
      const leftovers = filesIn(cfg.downloadDir).filter((f) => /\.f\d+\./.test(f) || /\.part$/.test(f));
      assert.deepEqual(leftovers, []);
      // the merged file has both streams
      const probe = require('node:child_process').spawnSync(FFMPEG, ['-i', done.filePath], { encoding: 'utf8' });
      assert.match(probe.stderr, /Video:/);
      assert.match(probe.stderr, /Audio:/);
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('pause keeps the .part file, resume continues with a Range request and finishes', { skip }, async () => {
    const srv = await startServer(sampleVideo(), { bytesPerSec: 150000 });
    const { queue, cfg } = mkQueue();
    try {
      const it = queue.add(srv.url('slow.mp4'), 'best');
      await waitFor(() => (queue.get(it.id).downloaded || 0) > 250000, 30000, 'some progress');
      const r = await queue.pause(it.id);
      assert.equal(r.ok, true);
      assert.equal(statusOf(queue, it.id), 'paused');
      const part = filesIn(cfg.downloadDir).filter((f) => f.endsWith('.part'));
      assert.equal(part.length, 1, filesIn(cfg.downloadDir).join());
      const partSize = fs.statSync(path.join(cfg.downloadDir, part[0])).size;
      assert.ok(partSize > 100000 && partSize < srv.size, `part size ${partSize}`);
      const before = srv.requests.length;
      queue.resume(it.id);
      await waitFor(() => statusOf(queue, it.id) === 'completed', 40000, 'resume completion');
      const ranged = srv.requests.slice(before).filter((q) => q.range && /bytes=[1-9]\d*-/.test(q.range));
      assert.ok(ranged.length >= 1, 'resume must request a non-zero byte offset; got ' + JSON.stringify(srv.requests.slice(before)));
      const done = queue.get(it.id);
      assert.equal(fs.statSync(done.filePath).size, srv.size);
      assert.equal(
        fs.readFileSync(done.filePath).equals(fs.readFileSync(sampleVideo())), true, 'resumed file must be byte-identical');
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('cancel kills yt-dlp and deletes partial files', { skip }, async () => {
    const srv = await startServer(sampleVideo(), { bytesPerSec: 100000 });
    const { queue, cfg } = mkQueue();
    try {
      const it = queue.add(srv.url('gone.mp4'), 'best');
      await waitFor(() => (queue.get(it.id).downloaded || 0) > 150000, 30000, 'progress');
      assert.ok(filesIn(cfg.downloadDir).some((f) => f.endsWith('.part')));
      const r = await queue.cancel(it.id);
      assert.equal(r.ok, true);
      assert.equal(statusOf(queue, it.id), 'canceled');
      assert.deepEqual(filesIn(cfg.downloadDir), []);
      // process really gone: no growth after a moment
      await new Promise((r2) => setTimeout(r2, 400));
      assert.deepEqual(filesIn(cfg.downloadDir), []);
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('concurrency limit holds with real processes', { skip }, async () => {
    const srv = await startServer(sampleVideo(), { bytesPerSec: 500000 });
    const { queue, updates } = mkQueue({ maxConcurrent: 2 });
    try {
      const ids = [1, 2, 3, 4].map((n) => queue.add(srv.url(`c${n}.mp4`), 'best').id);
      let maxActive = 0;
      const sample = setInterval(() => {
        const n = queue.list().filter((i) => ['fetching', 'downloading', 'merging'].includes(i.status)).length;
        if (n > maxActive) maxActive = n;
      }, 20);
      await waitFor(() => ids.every((id) => statusOf(queue, id) === 'completed'), 60000, 'all complete');
      clearInterval(sample);
      assert.equal(maxActive, 2);
      assert.ok(updates.length > 0);
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('reload mid-download: becomes paused, resume completes', { skip }, async () => {
    const srv = await startServer(sampleVideo(), { bytesPerSec: 150000 });
    const a = mkQueue();
    try {
      const it = a.queue.add(srv.url('reload.mp4'), 'best');
      await waitFor(() => (a.queue.get(it.id).downloaded || 0) > 200000, 30000, 'progress');
      a.queue.save();
      // "crash": a second queue loads the persisted file while the first process is still alive
      await a.queue.pause(it.id); // stop the first process so only one writer touches the .part file
      const raw = JSON.parse(fs.readFileSync(a.storePath, 'utf8'));
      raw.items[0].item.status = 'downloading'; // what the file looked like at the time of the crash
      fs.writeFileSync(a.storePath, JSON.stringify(raw));
      const b = new DownloadQueue({ ytdlp: a.runner, settings: { get: () => a.cfg }, storePath: a.storePath });
      assert.equal(b.get(it.id).status, 'paused');
      assert.equal(b.get(it.id).title, 'reload');
      b.resume(it.id);
      await waitFor(() => b.get(it.id).status === 'completed', 40000, 'completion after reload');
      assert.equal(fs.statSync(b.get(it.id).filePath).size, srv.size);
      await b.shutdown();
    } finally { await a.queue.shutdown(); await srv.close(); }
  });

  test('HTTP 404 becomes a friendly error and does not block the queue', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    const { queue } = mkQueue({ maxConcurrent: 1 });
    try {
      const bad = queue.add(srv.url('missing.mp4'), 'best');
      const good = queue.add(srv.url('fine.mp4'), 'best');
      await waitFor(() => statusOf(queue, bad.id) === 'error', 30000, 'error');
      assert.match(queue.get(bad.id).error, /not available|Download failed|Network/);
      assert.ok(!/Traceback|\bERROR:/.test(queue.get(bad.id).error));
      await waitFor(() => statusOf(queue, good.id) === 'completed', 30000, 'next item');
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('unreachable server becomes a network error message', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    const url = srv.url('x.mp4');
    await srv.close();
    const { queue } = mkQueue();
    try {
      const it = queue.add(url, 'best');
      await waitFor(() => statusOf(queue, it.id) === 'error', 30000, 'error');
      assert.match(queue.get(it.id).error, /Network|Download failed/);
    } finally { await queue.shutdown(); }
  });

  test('speed limit and quality options reach yt-dlp without breaking the run', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    const { queue } = mkQueue({ speedLimit: '5M' });
    try {
      const it = queue.add(srv.url('lim.mp4'), '360');
      await waitFor(() => ['completed', 'error'].includes(statusOf(queue, it.id)), 30000);
      assert.equal(queue.get(it.id).status, 'completed', queue.get(it.id).error);
    } finally { await queue.shutdown(); await srv.close(); }
  });

  test('missing yt-dlp gives an install hint instead of crashing', async () => {
    const runner = ytdlp.createRunner({ getBinary: () => null });
    const dir = mkTmp('lg-nobin-');
    const queue = new DownloadQueue({ ytdlp: runner, settings: { get: () => ({ downloadDir: dir, maxConcurrent: 1 }) } });
    const it = queue.add('https://youtu.be/abc', 'best');
    await waitFor(() => queue.get(it.id).status === 'error', 3000);
    assert.match(queue.get(it.id).error, /not installed/);
  });

  test('api layer end to end (services wiring, getInfo cache, add/list/remove, settings)', { skip }, async () => {
    const srv = await startServer(sampleVideo());
    const userData = mkTmp('lg-api-');
    process.env.LINKGRAB_YTDLP = YTDLP;
    process.env.LINKGRAB_FFMPEG = FFMPEG;
    const services = createServices({ userDataDir: userData, defaultDownloadDir: path.join(userData, 'Downloads', 'LinkGrab') });
    const opened = [];
    const api = createApi(services, {
      openPath: async (p) => { opened.push(p); return ''; },
      showItemInFolder: (p) => opened.push('show:' + p),
      readClipboardText: () => 'copy this: https://youtu.be/abc123 thanks',
      chooseFolder: async () => path.join(userData, 'picked'),
    });
    try {
      const st = await api.engineStatus();
      assert.equal(st.ytdlp.installed, true);
      assert.match(st.ytdlp.version, /^\d{4}\.\d{2}\.\d{2}/);
      assert.equal(st.ffmpeg.installed, true);
      assert.equal(await api.readClipboardUrl(), 'https://youtu.be/abc123');
      assert.equal(await api.chooseFolder(), path.join(userData, 'picked'));

      assert.equal((await api.add('https://vimeo.com/1', 'best')).ok, false);
      assert.equal((await api.getInfo('javascript:alert(1)')).ok, false);
      const info = await api.getInfo(srv.url('api.mp4'));
      assert.equal(info.ok, true, info.error);
      const s = await api.setSettings({ maxConcurrent: 99, cookiesFrom: 'bogus', speedLimit: '1M', evil: 1 });
      assert.equal(s.maxConcurrent, 10);
      assert.equal(s.cookiesFrom, '');
      assert.equal(s.speedLimit, '1M');
      assert.equal('evil' in s, false);
      await api.setSettings({ speedLimit: '' });
      const added = await api.add(srv.url('api.mp4'), 'best');
      assert.equal(added.ok, true, added.error);
      assert.equal(added.item.title, 'api', 'title comes from the info cache');
      await waitFor(async () => (await api.list()).every((i) => i.status === 'completed'), 30000, 'api download');
      const [item] = await api.list();
      assert.equal((await api.openFile(item.id)).ok, true);
      assert.equal(opened[opened.length - 1], item.filePath);
      assert.equal((await api.showInFolder(item.id)).ok, true);
      assert.equal(opened[opened.length - 1], 'show:' + item.filePath);
      assert.equal((await api.showInFolder()).ok, true); // no id: opens download folder
      assert.equal((await api.openFile('nope')).ok, false);
      assert.equal((await api.pause(123)).ok, false);
      assert.equal((await api.remove(item.id, true)).ok, true);
      assert.equal(fs.existsSync(item.filePath), false);
      assert.deepEqual(await api.list(), []);
    } finally {
      delete process.env.LINKGRAB_YTDLP;
      delete process.env.LINKGRAB_FFMPEG;
      await services.queue.shutdown();
      await srv.close();
    }
  });

  test('openFile refuses executable file types', async () => {
    const userData = mkTmp('lg-api2-');
    const services = createServices({ userDataDir: userData, defaultDownloadDir: path.join(userData, 'dl') });
    const exe = path.join(userData, 'evil.exe');
    fs.writeFileSync(exe, 'MZ');
    fs.writeFileSync(path.join(userData, 'downloads.json'), JSON.stringify({ version: 1, items: [{ item: {
      id: 'x1', url: 'https://youtu.be/abc', status: 'completed', filePath: exe, quality: 'best', addedAt: 1 }, outDir: userData }] }));
    const services2 = createServices({ userDataDir: userData, defaultDownloadDir: path.join(userData, 'dl') });
    const opened = [];
    const api = createApi(services2, { openPath: async (p) => { opened.push(p); return ''; }, showItemInFolder() {}, readClipboardText: () => '', chooseFolder: async () => null });
    const r = await api.openFile('x1');
    assert.equal(r.ok, false);
    assert.deepEqual(opened, []);
    void services; void Settings;
  });
});

// ---------------------------------------------------------------- v1.1 api layer (fakes, no external binaries)

describe('api layer v1.1 (fake engine / router)', () => {
  const { DownloadQueue: DQ } = require('../src/main/queue');

  function fakeEnv(over) {
    const o = over || {};
    const dir = mkTmp('lg-api11-');
    const cfg = { downloadDir: path.join(dir, 'dl'), maxConcurrent: 3, speedLimit: '', cookiesFrom: '' };
    const calls = { info: [], download: [] };
    const router = {
      getInfo: async (url, opts) => { calls.info.push([url, opts]); return o.info || { ok: true, info: { title: 'T', thumbnail: 'th', site: 'instagram', kind: 'mixed', videoCount: 1, imageCount: 3, engine: 'both', thumbnails: ['a'], qualities: [{ key: 'media', label: 'Everything (4 files)' }] } }; },
      download: (p) => { calls.download.push(p); return { done: new Promise(() => {}), kill: async () => {} }; },
    };
    const engine = {
      getYtdlpPath: () => (o.noYtdlp ? null : '/bin/yt-dlp'),
      getFfmpegPath: () => null,
      getGallerydlPath: () => (o.noGallery ? null : '/bin/gallery-dl'),
      status: async () => o.status || { ytdlp: { installed: true, version: '1', path: '/bin/yt-dlp' }, ffmpeg: { installed: false, path: null }, gallerydl: { installed: true, version: '1.2', path: '/bin/gallery-dl' } },
    };
    const settings = { get: () => cfg, set: (x) => Object.assign(cfg, x), on() {} };
    const queue = new DQ({ ytdlp: router, settings, storePath: path.join(dir, 'downloads.json') });
    const opened = [];
    const api = createApi({ settings, engine, runner: router, router, queue }, {
      openPath: async (p) => { opened.push(['open', p]); return ''; },
      showItemInFolder: (p) => opened.push(['show', p]),
      readClipboardText: () => '', chooseFolder: async () => null,
    });
    return { dir, cfg, calls, router, engine, queue, api, opened };
  }

  const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c || 'x'); return p; };

  async function finishedItem(env, url, quality, result) {
    const r = await env.api.add(url, quality);
    assert.equal(r.ok, true, r.error);
    // complete via the queue's own exit handling by driving the fake handle
    const rec = env.queue.recs.get(r.item.id);
    rec.handle = null;
    await env.queue._onExit(rec, Object.assign({ code: 0 }, result));
    return env.queue.get(r.item.id);
  }

  test('services expose gallery and router and stay backwards compatible', () => {
    const ud = mkTmp('lg-svc-');
    const s = createServices({ userDataDir: ud, defaultDownloadDir: path.join(ud, 'dl') });
    for (const k of ['settings', 'engine', 'runner', 'queue', 'gallery', 'router']) assert.ok(k in s, k);
    assert.equal(typeof s.router.download, 'function');
    assert.equal(typeof s.router.getInfo, 'function');
    assert.equal(s.queue.ytdlp, s.router, 'the queue gets the router');
    if (s.gallery) {
      assert.equal(typeof s.gallery.download, 'function');
      assert.equal(typeof s.gallery.getInfo, 'function');
    }
  });

  test('quality validation per site: images/media only for x, instagram (and the test hook site)', async () => {
    const env = fakeEnv();
    for (const q of ['images', 'media']) {
      for (const url of ['https://www.youtube.com/watch?v=abc', 'https://www.facebook.com/watch/?v=1', 'https://www.linkedin.com/posts/x-1']) {
        const a = await env.api.add(url, q);
        assert.equal(a.ok, false, url + q);
        assert.match(a.error, /X and Instagram/);
        const g = await env.api.getInfo(url, q);
        assert.equal(g.ok, false);
        assert.match(g.error, /X and Instagram/);
      }
    }
    assert.equal(env.queue.list().length, 0);
    assert.equal(env.calls.info.length, 0, 'rejected before any engine is spawned');
    const ok1 = await env.api.add('https://x.com/u/status/123', 'images');
    assert.equal(ok1.ok, true, ok1.error);
    assert.equal(ok1.item.kind, 'image');
    const ok2 = await env.api.add('https://www.instagram.com/p/AbC/', 'media');
    assert.equal(ok2.ok, true, ok2.error);
    assert.equal(ok2.item.kind, 'mixed');
    assert.equal((await env.api.add('https://youtu.be/abc', '720')).ok, true);
    assert.equal((await env.api.add('https://youtu.be/abc2', 'bogus')).ok, false);
  });

  test('image qualities need the image engine; video qualities still only need yt-dlp', async () => {
    const env = fakeEnv({ noGallery: true });
    const a = await env.api.add('https://x.com/u/status/1', 'images');
    assert.equal(a.ok, false);
    assert.match(a.error, /image engine/);
    assert.equal((await env.api.add('https://x.com/u/status/1', 'best')).ok, true);
    const env2 = fakeEnv({ noYtdlp: true });
    assert.equal((await env2.api.add('https://x.com/u/status/2', 'best')).ok, false);
    assert.equal((await env2.api.add('https://x.com/u/status/2', 'images')).ok, true);
  });

  test('getInfo goes through the router, passes cookies, caches the new fields; add uses the cached info', async () => {
    const env = fakeEnv();
    env.cfg.cookiesFrom = 'firefox';
    const url = 'https://www.instagram.com/p/AbC/';
    const r1 = await env.api.getInfo(url);
    assert.equal(r1.ok, true);
    assert.equal(r1.info.kind, 'mixed');
    assert.equal(r1.info.imageCount, 3);
    assert.deepEqual(r1.info.thumbnails, ['a']);
    assert.equal(env.calls.info[0][1].cookiesFrom, 'firefox');
    await env.api.getInfo(url);
    assert.equal(env.calls.info.length, 1, 'second call is served from the cache');
    const a = await env.api.add(url, 'media');
    assert.equal(a.item.title, 'T');
    assert.equal(a.item.kind, 'mixed');
    assert.equal(a.item.fileCount, 4, 'media = images + videos from the info');
    const b = await env.api.add(url, 'images');
    assert.equal(b.item.fileCount, 3);
  });

  test('failed getInfo (e.g. image engine missing) is passed through and not cached', async () => {
    const bad = { ok: false, error: 'Image downloads need the image engine. Click Install engine in the banner.' };
    const env = fakeEnv({ info: bad });
    const r = await env.api.getInfo('https://x.com/u/status/5');
    assert.deepEqual(r, bad);
    await env.api.getInfo('https://x.com/u/status/5');
    assert.equal(env.calls.info.length, 2);
  });

  test('engineStatus returns engine.status() including gallerydl; falls back to a safe shape', async () => {
    const env = fakeEnv();
    const st = await env.api.engineStatus();
    assert.deepEqual(Object.keys(st).sort(), ['ffmpeg', 'gallerydl', 'ytdlp']);
    assert.deepEqual(st.gallerydl, { installed: true, version: '1.2', path: '/bin/gallery-dl' });
    // an engine that does not report gallerydl yet gets a derived field
    const old = fakeEnv({ status: { ytdlp: { installed: false, version: null, path: null }, ffmpeg: { installed: false, path: null } } });
    assert.deepEqual((await old.api.engineStatus()).gallerydl, { installed: true, version: null, path: '/bin/gallery-dl' });
    // engine throws
    env.engine.status = async () => { throw new Error('boom'); };
    const bad = await env.api.engineStatus();
    assert.equal(bad.gallerydl.installed, false);
    assert.equal(bad.ytdlp.installed, false);
  });

  test('openFile opens the first file of a multi-file item; refuses executables; showInFolder reveals it', async () => {
    const env = fakeEnv();
    const folder = path.join(env.cfg.downloadDir, 'Instagram abc');
    const files = ['01.jpg', '02.jpg', '03.mp4'].map((n) => write(path.join(folder, n)));
    const item = await finishedItem(env, 'https://www.instagram.com/p/abc/', 'media', { files, folder, filePath: files[0] });
    assert.equal(item.status, 'completed');
    assert.equal((await env.api.openFile(item.id)).ok, true);
    assert.deepEqual(env.opened.pop(), ['open', files[0]]);
    assert.equal((await env.api.showInFolder(item.id)).ok, true);
    assert.deepEqual(env.opened.pop(), ['show', files[0]]);
    // first file disappears
    fs.unlinkSync(files[0]);
    const gone = await env.api.openFile(item.id);
    assert.equal(gone.ok, false);
    assert.match(gone.error, /no longer exists/);
    // executables are still refused (files[0] is what counts)
    const exe = write(path.join(env.dir, 'x', 'evil.exe'));
    const it2 = await finishedItem(env, 'https://x.com/u/status/9', 'media', { files: [exe, files[1]], folder: path.dirname(exe) });
    assert.equal((await env.api.openFile(it2.id)).ok, false);
    assert.equal(env.opened.length, 0);
  });

  test('showInFolder opens the item folder when there is no file yet, else the download dir', async () => {
    const env = fakeEnv();
    const folder = path.join(env.cfg.downloadDir, 'Instagram new');
    fs.mkdirSync(folder, { recursive: true });
    const a = await env.api.add('https://www.instagram.com/p/new/', 'images');
    // running item, folder reported but no finished file yet
    env.queue.recs.get(a.item.id).item.folder = folder;
    assert.equal((await env.api.showInFolder(a.item.id)).ok, true);
    assert.deepEqual(env.opened.pop(), ['open', folder]);
    // a finished file exists while the item is still running: that file is selected
    const f = write(path.join(folder, '01.jpg'));
    env.queue.recs.get(a.item.id).item.files = [f];
    assert.equal((await env.api.showInFolder(a.item.id)).ok, true);
    assert.deepEqual(env.opened.pop(), ['show', f]);
    // nothing known: download dir
    const b = await env.api.add('https://x.com/u/status/77', 'images');
    assert.equal((await env.api.showInFolder(b.item.id)).ok, true);
    assert.deepEqual(env.opened.pop(), ['open', env.cfg.downloadDir]);
    // openFile of an unfinished item stays "not ready"
    assert.equal((await env.api.openFile(b.item.id)).ok, false);
  });

  test('remove through the api deletes all files and the empty folder', async () => {
    const env = fakeEnv();
    const folder = path.join(env.cfg.downloadDir, 'Instagram rm');
    const files = ['01.jpg', '02.jpg'].map((n) => write(path.join(folder, n)));
    const item = await finishedItem(env, 'https://www.instagram.com/p/rm/', 'images', { files, folder });
    assert.equal((await env.api.remove(item.id, true)).ok, true);
    assert.ok(!fs.existsSync(folder));
    assert.deepEqual(await env.api.list(), []);
  });
});
