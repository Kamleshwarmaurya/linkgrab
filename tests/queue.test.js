'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DownloadQueue } = require('../src/main/queue');
const { mkTmp, waitFor } = require('./_helpers');

/** Fake yt-dlp runner whose "processes" are driven by the test. */
function fakeRunner() {
  const runs = [];
  return {
    runs,
    download(params, onEvent) {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      const run = {
        params, onEvent, finished: false,
        emit: (ev) => onEvent(ev),
        finish: (res) => { run.finished = true; resolve(Object.assign({ code: 0, signal: null, killed: false, error: null, filePath: null, stderr: '' }, res)); },
        killed: false,
      };
      const handle = {
        done,
        kill() { run.killed = true; if (!run.finished) run.finish({ code: null, signal: 'SIGTERM', killed: true }); return done.then(() => undefined); },
      };
      runs.push(run);
      return handle;
    },
  };
}

function setup(over) {
  const dir = mkTmp('lg-queue-');
  const settings = Object.assign({ downloadDir: path.join(dir, 'dl'), maxConcurrent: 2, speedLimit: '', cookiesFrom: '' }, over || {});
  const runner = fakeRunner();
  const storePath = path.join(dir, 'downloads.json');
  const queue = new DownloadQueue({ ytdlp: runner, settings: { get: () => settings }, storePath });
  return { dir, settings, runner, queue, storePath };
}

const YT = (n) => `https://www.youtube.com/watch?v=vid${n}`;

test('add validates and rejects unsupported links', () => {
  const { queue } = setup();
  assert.throws(() => queue.add('https://vimeo.com/1', 'best'), /Unsupported link/);
  assert.throws(() => queue.add('nope', 'best'), /valid/);
  assert.throws(() => queue.add(YT(1), '1234'), /quality/i);
});

test('add starts immediately when a slot is free; concurrency limit is respected', async () => {
  const { queue, runner } = setup({ maxConcurrent: 2 });
  const a = queue.add(YT(1), 'best');
  const b = queue.add(YT(2), '720');
  const c = queue.add(YT(3), 'audio');
  assert.equal(runner.runs.length, 2);
  assert.equal(queue.get(a.id).status, 'fetching');
  assert.equal(queue.get(b.id).status, 'fetching');
  assert.equal(queue.get(c.id).status, 'queued');
  assert.equal(runner.runs[1].params.quality, '720');
  // finishing one frees a slot for the queued one
  runner.runs[0].finish({ code: 0, filePath: null });
  await waitFor(() => runner.runs.length === 3, 2000, 'third run');
  assert.equal(queue.get(c.id).status, 'fetching');
  assert.equal(queue.get(a.id).status, 'completed');
  assert.equal(runner.runs.filter((r) => !r.finished).length, 2);
});

test('raising maxConcurrent and pumping starts more', () => {
  const { queue, runner, settings } = setup({ maxConcurrent: 1 });
  queue.add(YT(1), 'best'); queue.add(YT(2), 'best'); queue.add(YT(3), 'best');
  assert.equal(runner.runs.length, 1);
  settings.maxConcurrent = 3;
  queue.pump();
  assert.equal(runner.runs.length, 3);
});

test('duplicate active link+quality is rejected, other quality is allowed', () => {
  const { queue } = setup();
  queue.add(YT(1), 'best');
  assert.throws(() => queue.add(YT(1), 'best'), /already/);
  assert.doesNotThrow(() => queue.add(YT(1), '720'));
});

test('progress events update the item; updates are throttled but status changes are not', async () => {
  const { queue, runner } = setup();
  const updates = [];
  queue.on('update', (i) => updates.push(i));
  const it = queue.add(YT(1), 'best');
  const run = runner.runs[0];
  updates.length = 0;
  run.emit({ type: 'title', id: 'vid1', title: 'Hello World' });
  assert.equal(queue.get(it.id).title, 'Hello World');
  run.emit({ type: 'progress', downloaded: 1000, total: 10000, speed: 500, eta: 18 });
  let cur = queue.get(it.id);
  assert.equal(cur.status, 'downloading');
  assert.equal(cur.percent, 10);
  assert.equal(cur.speed, 500);
  assert.equal(cur.eta, 18);
  assert.equal(cur.size, 10000);
  assert.equal(cur.downloaded, 1000);
  // flood of progress events in a short burst
  updates.length = 0;
  const t0 = Date.now();
  for (let i = 1; i <= 500; i++) run.emit({ type: 'progress', downloaded: 1000 + i, total: 10000, speed: 500, eta: 10 });
  const burstMs = Date.now() - t0;
  const progressEmits = updates.filter((u) => u.status === 'downloading').length;
  assert.ok(progressEmits <= Math.ceil(burstMs / 250) + 1, `emitted ${progressEmits} in ${burstMs}ms`);
  assert.equal(queue.get(it.id).downloaded, 1500); // state itself is always current
  // status change is always emitted immediately
  updates.length = 0;
  run.emit({ type: 'merging' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'merging');
  // progress is ignored once merging
  run.emit({ type: 'progress', downloaded: 1, total: 10000, speed: 1, eta: 1 });
  assert.equal(queue.get(it.id).status, 'merging');
});

test('two streams (video then audio) accumulate size and downloaded', () => {
  const { queue, runner } = setup();
  const it = queue.add(YT(1), 'best');
  const run = runner.runs[0];
  run.emit({ type: 'progress', downloaded: 9000, total: 9000, speed: 1, eta: 0 });
  run.emit({ type: 'progress', downloaded: 100, total: 1000, speed: 1, eta: 1 });
  const cur = queue.get(it.id);
  assert.equal(cur.size, 10000);
  assert.equal(cur.downloaded, 9100);
  assert.equal(cur.percent, 91);
});

test('completion uses the LGF file path and records size', async () => {
  const { queue, runner, dir } = setup();
  const file = path.join(dir, 'out.mp4');
  fs.writeFileSync(file, Buffer.alloc(1234));
  const done = [];
  queue.on('completed', (i) => done.push(i));
  const it = queue.add(YT(1), 'best');
  runner.runs[0].emit({ type: 'file', path: file });
  runner.runs[0].finish({ code: 0, filePath: file });
  await waitFor(() => queue.get(it.id).status === 'completed', 2000, 'completed');
  const cur = queue.get(it.id);
  assert.equal(cur.filePath, file);
  assert.equal(cur.percent, 100);
  assert.equal(cur.size, 1234);
  assert.equal(cur.error, null);
  assert.equal(done.length, 1);
});

test('failure sets a friendly error and frees the slot; resume retries', async () => {
  const { queue, runner } = setup({ maxConcurrent: 1 });
  const a = queue.add(YT(1), 'best');
  const b = queue.add(YT(2), 'best');
  runner.runs[0].finish({ code: 1, error: 'This video needs you to be signed in. Use browser cookies' });
  await waitFor(() => queue.get(a.id).status === 'error', 2000, 'error');
  assert.match(queue.get(a.id).error, /browser cookies/);
  await waitFor(() => runner.runs.length === 2, 2000, 'next run');
  assert.equal(queue.get(b.id).status, 'fetching');
  runner.runs[1].finish({ code: 0 });
  await waitFor(() => queue.get(b.id).status === 'completed', 2000);
  queue.resume(a.id); // retry
  assert.equal(runner.runs.length, 3);
  assert.equal(queue.get(a.id).error, null);
  assert.equal(queue.get(a.id).status, 'fetching');
});

test('pause kills the process, keeps the item, resume respawns', async () => {
  const { queue, runner } = setup();
  const it = queue.add(YT(1), 'best');
  runner.runs[0].emit({ type: 'progress', downloaded: 500, total: 1000, speed: 5, eta: 1 });
  const r = await queue.pause(it.id);
  assert.equal(r.ok, true);
  assert.equal(runner.runs[0].killed, true);
  const cur = queue.get(it.id);
  assert.equal(cur.status, 'paused');
  assert.equal(cur.speed, 0);
  assert.equal(cur.percent, 50);
  assert.equal(runner.runs.length, 1);
  queue.resume(it.id);
  assert.equal(runner.runs.length, 2);
  assert.equal(queue.get(it.id).status, 'fetching');
  assert.equal(runner.runs[1].params.url, runner.runs[0].params.url);
});

test('pausing a queued item prevents it from starting; resume queues it', async () => {
  const { queue, runner } = setup({ maxConcurrent: 1 });
  queue.add(YT(1), 'best');
  const b = queue.add(YT(2), 'best');
  queue.pause(b.id);
  assert.equal(queue.get(b.id).status, 'paused');
  runner.runs[0].finish({});
  await waitFor(() => queue.get(queue.list()[0].id).status === 'completed', 2000);
  assert.equal(runner.runs.length, 1);
  queue.resume(b.id);
  assert.equal(runner.runs.length, 2);
});

test('cancel kills, deletes partial files for that video id, keeps unrelated and final files', async () => {
  const { queue, runner, dir, settings } = setup();
  const it = queue.add(YT(1), 'best');
  runner.runs[0].emit({ type: 'title', id: 'vid1', title: 'My Clip' });
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  const mk = (n) => { const p = path.join(settings.downloadDir, n); fs.writeFileSync(p, 'x'); return p; };
  const partials = [
    mk('My Clip [vid1].f137.mp4.part'),
    mk('My Clip [vid1].f251.webm'),
    mk('My Clip [vid1].mp4.part'),
    mk('My Clip [vid1].mp4.ytdl'),
    mk('My Clip [vid1].f140.m4a.part-Frag12'),
  ];
  const keep = [mk('Other [vid2].mp4.part'), mk('My Clip [vid1].mp4'), mk('notes.txt')];
  const r = await queue.cancel(it.id);
  assert.equal(r.ok, true);
  assert.equal(runner.runs[0].killed, true);
  assert.equal(queue.get(it.id).status, 'canceled');
  for (const p of partials) assert.ok(!fs.existsSync(p), 'should be deleted: ' + p);
  for (const p of keep) assert.ok(fs.existsSync(p), 'should be kept: ' + p);
  // a canceled item can be started again from scratch
  queue.start(it.id);
  assert.equal(runner.runs.length, 2);
  void dir;
});

test('remove emits "removed", optionally deletes the finished file', async () => {
  const { queue, runner, settings } = setup();
  const removed = [];
  queue.on('removed', (id) => removed.push(id));
  const file = path.join(settings.downloadDir, 'done.mp4');
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  fs.writeFileSync(file, 'data');
  const a = queue.add(YT(1), 'best');
  runner.runs[0].finish({ code: 0, filePath: file });
  await waitFor(() => queue.get(a.id).status === 'completed', 2000);
  assert.deepEqual(await queue.remove(a.id, false), { ok: true });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(removed, [a.id]);
  assert.equal(queue.get(a.id), null);

  const b = queue.add(YT(2), 'best');
  runner.runs[1].finish({ code: 0, filePath: file });
  await waitFor(() => queue.get(b.id).status === 'completed', 2000);
  await queue.remove(b.id, true);
  assert.ok(!fs.existsSync(file));
  assert.equal(removed.length, 2);
  assert.equal((await queue.remove('nope', false)).ok, false);
});

test('removing a running download stops it', async () => {
  const { queue, runner } = setup();
  const a = queue.add(YT(1), 'best');
  await queue.remove(a.id, false);
  assert.equal(runner.runs[0].killed, true);
  assert.equal(queue.list().length, 0);
});

test('persistence: reload turns active items into paused, keeps the rest', async () => {
  const { queue, runner, storePath, settings, dir } = setup({ maxConcurrent: 1 });
  const file = path.join(dir, 'f.mp4');
  fs.writeFileSync(file, 'x');
  const a = queue.add(YT(1), 'best');
  runner.runs[0].emit({ type: 'title', id: 'vid1', title: 'First' });
  runner.runs[0].emit({ type: 'progress', downloaded: 200, total: 1000, speed: 10, eta: 80 });
  const b = queue.add(YT(2), '720'); // stays queued
  queue.save();
  // simulate a crash: no shutdown, just load a new queue from the same file
  const runner2 = fakeRunner();
  const q2 = new DownloadQueue({ ytdlp: runner2, settings: { get: () => settings }, storePath });
  const items = q2.list();
  assert.equal(items.length, 2);
  const ra = items.find((i) => i.id === a.id);
  const rb = items.find((i) => i.id === b.id);
  assert.equal(ra.status, 'paused');
  assert.equal(ra.title, 'First');
  assert.equal(ra.percent, 20);
  assert.equal(ra.speed, 0);
  assert.equal(rb.status, 'queued');
  assert.equal(rb.quality, '720');
  assert.equal(runner2.runs.length, 0, 'loading must not start anything by itself');
  q2.pump();
  assert.equal(runner2.runs.length, 1, 'pump starts the queued item');
  q2.resume(a.id);
  assert.equal(q2.get(a.id).status, 'queued'); // slot is taken, waits its turn
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(onDisk.items.length, 2);
  void file;
});

test('persistence: corrupt or missing store file is tolerated', () => {
  const { dir, settings } = setup();
  const p = path.join(dir, 'broken.json');
  fs.writeFileSync(p, '{not json');
  const q = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath: p });
  assert.deepEqual(q.list(), []);
  const q2 = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath: path.join(dir, 'none.json') });
  assert.deepEqual(q2.list(), []);
});

test('shutdown pauses running items and persists them', async () => {
  const { queue, runner, storePath, settings } = setup();
  const a = queue.add(YT(1), 'best');
  runner.runs[0].emit({ type: 'progress', downloaded: 1, total: 2, speed: 1, eta: 1 });
  await queue.shutdown();
  assert.equal(runner.runs[0].killed, true);
  assert.equal(queue.get(a.id).status, 'paused');
  const q2 = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath });
  assert.equal(q2.get(a.id).status, 'paused');
});

test('settings are read when a download starts (limit, cookies, folder)', () => {
  const { queue, runner, settings } = setup({ speedLimit: '1M', cookiesFrom: 'firefox' });
  queue.add(YT(1), 'best');
  assert.equal(runner.runs[0].params.limitRate, '1M');
  assert.equal(runner.runs[0].params.cookiesFrom, 'firefox');
  assert.equal(runner.runs[0].params.outDir, settings.downloadDir);
  assert.ok(fs.existsSync(settings.downloadDir));
});

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

// ---------------------------------------------------------------- v1.1: images / multi-file items

const IG = (n) => `https://www.instagram.com/p/post${n}/`;
const XU = (n) => `https://x.com/someone/status/${n}`;
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c === undefined ? 'x' : c); return p; };

test('v1.1 items carry kind/fileCount/files/folder defaults; images and media set kind', () => {
  const { queue, runner } = setup({ maxConcurrent: 5 });
  const v = queue.add(YT(1), 'best');
  assert.deepEqual([v.kind, v.fileCount, v.files, v.folder], ['video', 0, [], null]);
  const i = queue.add(IG(1), 'images');
  assert.equal(i.kind, 'image');
  const m = queue.add(XU(1), 'media');
  assert.equal(m.kind, 'mixed');
  assert.equal(runner.runs[1].params.quality, 'images');
  assert.equal(runner.runs[2].params.quality, 'media');
  // real info (meta) refines the numbers
  const m2 = queue.add(XU(2), 'media', { kind: 'image', fileCount: 4 });
  assert.equal(m2.kind, 'image');
  assert.equal(m2.fileCount, 4);
  const v2 = queue.add(IG(3), '720', { kind: 'mixed', fileCount: 9 });
  assert.equal(v2.kind, 'video'); // a video-quality download of a mixed post stays a video item
});

test('images/media are rejected by the queue for sites gallery-dl does not support', () => {
  const { queue } = setup();
  assert.throws(() => queue.add(YT(1), 'images'), /X and Instagram/);
  assert.throws(() => queue.add('https://www.facebook.com/watch/?v=1', 'media'), /X and Instagram/);
  assert.doesNotThrow(() => queue.add(IG(1), 'images'));
});

test('files events update files/folder/fileCount/filePath; progress accepts size+percent', () => {
  const { queue, runner, settings } = setup();
  const it = queue.add(IG(1), 'media');
  const run = runner.runs[0];
  const folder = path.join(settings.downloadDir, 'Instagram post1');
  const f1 = path.join(folder, '01.jpg');
  const f2 = path.join(folder, '02.jpg');
  run.emit({ type: 'progress', percent: 33.3, downloaded: 100, size: 300, speed: 10, eta: 2 });
  let cur = queue.get(it.id);
  assert.equal(cur.status, 'downloading');
  assert.equal(cur.percent, 33.3);
  assert.equal(cur.size, 300);
  run.emit({ type: 'files', files: [f1], folder, fileCount: 3 });
  cur = queue.get(it.id);
  assert.deepEqual(cur.files, [f1]);
  assert.equal(cur.filePath, f1);
  assert.equal(cur.folder, folder);
  assert.equal(cur.fileCount, 3);
  run.emit({ type: 'files', files: [f1, f2], folder, fileCount: 3 });
  assert.deepEqual(queue.get(it.id).files, [f1, f2]);
  assert.equal(queue.get(it.id).filePath, f1);
  // junk is ignored: relative paths, non-strings, traversal, duplicates
  run.emit({ type: 'files', files: ['rel.jpg', 5, '/a/../b.jpg', f1, f1], folder: folder, fileCount: 'x' });
  assert.deepEqual(queue.get(it.id).files, [f1]);
});

test('files list is capped at 200 but fileCount keeps the real number', async () => {
  const { queue, runner, settings } = setup();
  const it = queue.add(IG(1), 'images');
  const folder = path.join(settings.downloadDir, 'Instagram big');
  const many = Array.from({ length: 250 }, (_, i) => path.join(folder, String(i + 1).padStart(3, '0') + '.jpg'));
  runner.runs[0].emit({ type: 'files', files: many, folder, fileCount: 250 });
  assert.equal(queue.get(it.id).files.length, 200);
  assert.equal(queue.get(it.id).fileCount, 250);
  runner.runs[0].finish({ code: 0, files: many, folder, fileCount: 250 });
  await waitFor(() => queue.get(it.id).status === 'completed', 2000);
  assert.equal(queue.get(it.id).files.length, 200);
  assert.equal(queue.get(it.id).fileCount, 250);
});

test('completion with gallery result fields: files, folder, count, summed size', async () => {
  const { queue, runner, settings } = setup();
  const folder = path.join(settings.downloadDir, 'Instagram post1');
  const f1 = write(path.join(folder, '01.jpg'), Buffer.alloc(100));
  const f2 = write(path.join(folder, '02.jpg'), Buffer.alloc(250));
  const it = queue.add(IG(1), 'images');
  runner.runs[0].emit({ type: 'progress', percent: 50, downloaded: 10, size: 20, speed: 1, eta: 1 });
  runner.runs[0].finish({ code: 0, files: [f1, f2], folder, filePath: f1 });
  await waitFor(() => queue.get(it.id).status === 'completed', 2000);
  const cur = queue.get(it.id);
  assert.deepEqual(cur.files, [f1, f2]);
  assert.equal(cur.filePath, f1);
  assert.equal(cur.folder, folder);
  assert.equal(cur.fileCount, 2);
  assert.equal(cur.size, 350);
  assert.equal(cur.percent, 100);
});

test('completion of a single gallery file lives in the download dir (folder = download dir)', async () => {
  const { queue, runner, settings } = setup();
  const f = write(path.join(settings.downloadDir, 'Instagram post1.jpg'), Buffer.alloc(77));
  const it = queue.add(IG(1), 'images');
  runner.runs[0].emit({ type: 'files', files: [f], folder: settings.downloadDir, fileCount: 1 });
  runner.runs[0].finish({ code: 0, files: [f], folder: settings.downloadDir });
  await waitFor(() => queue.get(it.id).status === 'completed', 2000);
  const cur = queue.get(it.id);
  assert.equal(cur.fileCount, 1);
  assert.equal(cur.size, 77);
  assert.equal(cur.folder, settings.downloadDir);
});

test('old store without the new fields migrates: defaults for video items, filePath becomes files[0]', () => {
  const { dir, settings } = setup();
  const file = write(path.join(dir, 'old.mp4'));
  const p = path.join(dir, 'old-store.json');
  const old = (id, extra) => ({ item: Object.assign({
    id, url: 'https://youtu.be/' + id, site: 'youtube', title: 't', thumbnail: '', status: 'completed', percent: 100, speed: 0, eta: null,
    size: 1, downloaded: 1, filePath: file, error: null, quality: 'best', addedAt: 5 }, extra), outDir: settings.downloadDir, vid: id });
  fs.writeFileSync(p, JSON.stringify({ version: 1, items: [old('aaa111'), old('bbb222', { status: 'paused', filePath: null }), old('ccc333', { status: 'error', filePath: null })] }));
  const q = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath: p });
  const a = q.get('aaa111');
  assert.equal(a.kind, 'video');
  assert.equal(a.fileCount, 1);
  assert.deepEqual(a.files, [file]);
  assert.equal(a.folder, path.dirname(file));
  const b = q.get('bbb222');
  assert.deepEqual([b.kind, b.fileCount, b.files, b.folder], ['video', 0, [], null]);
  // the migrated shape is what gets written back, and it round-trips
  q.save();
  const q2 = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath: p });
  assert.deepEqual(q2.get('aaa111'), a);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).items[0].item.fileCount, 1);
});

test('persistence round-trips image items; garbage in new fields is repaired', () => {
  const { dir, settings, queue, runner, storePath } = setup();
  const folder = path.join(settings.downloadDir, 'X 99');
  const f1 = path.join(folder, '01.jpg');
  const it = queue.add(XU(99), 'images');
  runner.runs[0].emit({ type: 'files', files: [f1], folder, fileCount: 4 });
  queue.save();
  const q2 = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath });
  const cur = q2.get(it.id);
  assert.equal(cur.status, 'paused');
  assert.equal(cur.kind, 'image');
  assert.deepEqual(cur.files, [f1]);
  assert.equal(cur.fileCount, 4);
  assert.equal(cur.folder, folder);
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  Object.assign(raw.items[0].item, { kind: 'weird', files: 'nope', fileCount: -5, folder: 7, filePath: null });
  const p2 = path.join(dir, 'garbage.json');
  fs.writeFileSync(p2, JSON.stringify(raw));
  const q3 = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => settings }, storePath: p2 });
  const g = q3.get(it.id);
  assert.equal(g.kind, 'image'); // falls back to the quality
  assert.deepEqual(g.files, []);
  assert.equal(g.fileCount, 0);
  assert.equal(g.folder, null);
});

test('resume of a gallery item re-runs the same quality (gallery-dl skips existing files)', async () => {
  const { queue, runner, settings } = setup();
  const folder = path.join(settings.downloadDir, 'Instagram post1');
  const it = queue.add(IG(1), 'images');
  runner.runs[0].emit({ type: 'files', files: [path.join(folder, '01.jpg')], folder, fileCount: 3 });
  await queue.pause(it.id);
  assert.equal(queue.get(it.id).status, 'paused');
  assert.equal(queue.get(it.id).files.length, 1, 'finished files are kept while paused');
  queue.resume(it.id);
  assert.equal(runner.runs.length, 2);
  assert.equal(runner.runs[1].params.quality, 'images');
  assert.equal(queue.get(it.id).files.length, 1);
});

async function completedGallery(env, opts) {
  const o = opts || {};
  const { queue, runner, settings } = env;
  const folder = o.folder || path.join(settings.downloadDir, 'Instagram post1');
  const files = [1, 2, 3].map((n) => write(path.join(folder, '0' + n + '.jpg')));
  const it = queue.add(IG(o.n || 1), 'images');
  runner.runs[runner.runs.length - 1].finish({ code: 0, files, folder, filePath: files[0] });
  await waitFor(() => queue.get(it.id).status === 'completed', 2000);
  return { it, folder, files };
}

test('remove(id,true) deletes every file and the now-empty folder', async () => {
  const env = setup();
  const { it, folder, files } = await completedGallery(env);
  const r = await env.queue.remove(it.id, true);
  assert.equal(r.ok, true);
  for (const f of files) assert.ok(!fs.existsSync(f));
  assert.ok(!fs.existsSync(folder), 'empty folder removed');
  assert.ok(fs.existsSync(env.settings.downloadDir), 'download dir itself stays');
});

test('remove(id,true) keeps the folder when foreign files remain, and remove(id,false) deletes nothing', async () => {
  const env = setup({ maxConcurrent: 5 });
  const a = await completedGallery(env);
  const foreign = write(path.join(a.folder, 'my-notes.txt'));
  await env.queue.remove(a.it.id, true);
  for (const f of a.files) assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(foreign));
  assert.ok(fs.existsSync(a.folder));
  const b = await completedGallery(env, { folder: path.join(env.settings.downloadDir, 'Instagram other'), n: 2 });
  await env.queue.remove(b.it.id, false);
  for (const f of b.files) assert.ok(fs.existsSync(f));
  assert.ok(fs.existsSync(b.folder));
});

test('remove never deletes the download dir itself (single file item) and removes only that file', async () => {
  const env = setup({ maxConcurrent: 5 });
  const other = write(path.join(env.settings.downloadDir, 'unrelated.mp4'));
  const f = write(path.join(env.settings.downloadDir, 'Instagram post9.jpg'));
  const it = env.queue.add(IG(9), 'images');
  env.runner.runs[0].finish({ code: 0, files: [f], folder: env.settings.downloadDir });
  await waitFor(() => env.queue.get(it.id).status === 'completed', 2000);
  await env.queue.remove(it.id, true);
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(env.settings.downloadDir));
});

test('folder outside the download dir is never removed, even if it becomes empty', async () => {
  const env = setup();
  const outside = path.join(env.dir, 'elsewhere', 'album');
  const { it, files } = await completedGallery(env, { folder: outside });
  await env.queue.remove(it.id, true);
  for (const f of files) assert.ok(fs.existsSync(f), 'files outside every download root are skipped (review fix)');
  assert.ok(fs.existsSync(outside), 'and a folder outside the download dir is left alone');
});

test('a tampered folder (parent traversal, the dl dir parent, a symlink out) is never deleted', async () => {
  const env = setup({ maxConcurrent: 5 });
  fs.mkdirSync(env.settings.downloadDir, { recursive: true });
  const victim = path.join(env.dir, 'victim');
  fs.mkdirSync(victim);
  // 1. ".." traversal written into the store by hand
  const t1 = await completedGallery(env, { n: 1 });
  env.queue.recs.get(t1.it.id).item.folder = path.join(env.settings.downloadDir, '..', 'victim');
  await env.queue.remove(t1.it.id, true);
  assert.ok(fs.existsSync(victim), 'traversal must not remove a sibling of the download dir');
  // 2. the parent of the download dir
  const t2 = await completedGallery(env, { n: 2, folder: path.join(env.settings.downloadDir, 'Instagram two') });
  env.queue.recs.get(t2.it.id).item.folder = env.dir;
  await env.queue.remove(t2.it.id, true);
  assert.ok(fs.existsSync(env.dir));
  // 3. a symlink inside the download dir that points outside
  const link = path.join(env.settings.downloadDir, 'Instagram link');
  let canLink = true;
  try { fs.symlinkSync(victim, link, 'dir'); } catch (_) { canLink = false; }
  if (canLink) {
    const t3 = await completedGallery(env, { n: 3, folder: path.join(env.settings.downloadDir, 'Instagram three') });
    env.queue.recs.get(t3.it.id).item.folder = link;
    await env.queue.remove(t3.it.id, true);
    assert.ok(fs.existsSync(victim), 'symlinked folder must not be followed');
    assert.ok(fs.existsSync(link));
  }
});

test('remove(true) of a completed video deletes just its file (inside the download dir)', async () => {
  const env = setup();
  const f = write(path.join(env.settings.downloadDir, 'plain.mp4'));
  const it = env.queue.add(YT(5), 'best');
  env.runner.runs[0].finish({ code: 0, filePath: f });
  await waitFor(() => env.queue.get(it.id).status === 'completed', 2000);
  assert.deepEqual(env.queue.get(it.id).files, [f]);
  await env.queue.remove(it.id, true);
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(env.settings.downloadDir));
});

test('cancel of a gallery item deletes .part files in its folder (and the folder if empty), keeps finished/foreign files', async () => {
  const env = setup();
  const folder = path.join(env.settings.downloadDir, 'Instagram post1');
  const it = env.queue.add(IG(1), 'images');
  env.runner.runs[0].emit({ type: 'title', id: 'post1', title: 'A post' });
  const done = write(path.join(folder, '01.jpg'));
  const part = write(path.join(folder, '02.jpg.part'));
  env.runner.runs[0].emit({ type: 'files', files: [done], folder, fileCount: 2 });
  const topPart = write(path.join(env.settings.downloadDir, 'Instagram post1.mp4.part'));
  const otherPart = write(path.join(env.settings.downloadDir, 'Instagram post2.jpg.part'));
  await env.queue.cancel(it.id);
  const cur = env.queue.get(it.id);
  assert.equal(cur.status, 'canceled');
  assert.deepEqual([cur.files, cur.fileCount, cur.folder, cur.filePath], [[], 0, null, null]);
  assert.ok(!fs.existsSync(part));
  assert.ok(!fs.existsSync(topPart));
  assert.ok(fs.existsSync(otherPart), 'another post\'s partial is untouched');
  assert.ok(fs.existsSync(done), 'finished files are not deleted by cancel');
});

test('cancel of a gallery item that only has partials removes its empty folder', async () => {
  const env = setup();
  const folder = path.join(env.settings.downloadDir, 'Instagram post1');
  const it = env.queue.add(IG(1), 'media');
  env.runner.runs[0].emit({ type: 'title', id: 'post1', title: 'A post' });
  write(path.join(folder, '01.jpg.part'));
  await env.queue.cancel(it.id);
  assert.ok(!fs.existsSync(folder));
  assert.ok(fs.existsSync(env.settings.downloadDir));
});

test('status "merging" and throttling behave as before for a mixed item', () => {
  const { queue, runner } = setup();
  const it = queue.add(XU(7), 'media');
  runner.runs[0].emit({ type: 'progress', percent: 10, downloaded: 1, size: 10, speed: 1, eta: 1 });
  runner.runs[0].emit({ type: 'merging' });
  assert.equal(queue.get(it.id).status, 'merging');
  runner.runs[0].emit({ type: 'progress', percent: 90, downloaded: 9, size: 10, speed: 1, eta: 1 });
  assert.equal(queue.get(it.id).percent, 10);
});
