'use strict';
// Regression tests for the issues found by the independent QA + security review of v1.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DownloadQueue } = require('../src/main/queue');
const { createApi, isBlockedToOpen } = require('../src/main/api');
const y = require('../src/main/ytdlp');
const g = require('../src/main/gallerydl');
const router = require('../src/main/router');
const zip = require('../src/main/zip');
const { mkTmp, waitFor } = require('./_helpers');

const posix = process.platform !== 'win32';
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c === undefined ? 'x' : c); return p; };

function fakeRunner() {
  const runs = [];
  return {
    runs,
    download(params, onEvent) {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      runs.push({ params, onEvent });
      return { done, kill() { resolve({ code: null, killed: true }); return done.then(() => undefined); } };
    },
  };
}

function storeWith(dir, items) {
  const storePath = path.join(dir, 'downloads.json');
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, items }));
  return storePath;
}

const baseItem = (over) => Object.assign({
  id: 'abc123', url: 'https://www.instagram.com/p/AbC/', site: 'instagram', title: 't', thumbnail: '', status: 'completed',
  percent: 100, speed: 0, eta: null, size: 1, downloaded: 1, filePath: null, error: null, quality: 'images', addedAt: 1,
  kind: 'image', fileCount: 0, files: [], folder: null,
}, over);

// ------------------------------------------------------------------ 3. remove(true) cannot leave the download dirs

test('remove(true): a tampered downloads.json cannot delete files outside the download dirs', async () => {
  const dir = mkTmp('lg-rf-');
  const dl = path.join(dir, 'dl');
  const inside = write(path.join(dl, 'Instagram AbC', '01.jpg'));
  const insideFlat = write(path.join(dl, 'Instagram flat.jpg'));
  const victim = write(path.join(dir, 'victim', 'precious.txt'));
  const victim2 = write(path.join(dir, 'victim2.txt'));
  const link = path.join(dl, 'linkdir');
  let canLink = true;
  try { fs.symlinkSync(path.join(dir, 'victim'), link, 'dir'); } catch (_) { canLink = false; }
  const viaLink = path.join(link, 'precious.txt');
  const storePath = storeWith(dir, [
    {
      item: baseItem({
        files: [inside, victim, victim2, viaLink, 'relative/evil.txt', path.join(dl, '..', 'victim2.txt'), '/'],
        filePath: victim2, fileCount: 7, folder: path.join(dir, 'victim'),
      }),
      outDir: dl, vid: '',
    },
    { item: baseItem({ id: 'def456', url: 'https://www.instagram.com/p/Def/', files: [victim, victim2], filePath: victim, folder: path.parse(dir).root }), outDir: path.parse(dir).root, vid: '' },
    { item: baseItem({ id: 'ghi789', url: 'https://www.instagram.com/p/Ghi/', files: [insideFlat], filePath: insideFlat, folder: dl }), outDir: dl, vid: '' },
  ]);
  const queue = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => ({ downloadDir: dl, maxConcurrent: 2 }) }, storePath });
  assert.equal((await queue.remove('abc123', true)).ok, true);
  assert.ok(!fs.existsSync(inside), 'the file inside the download dir is deleted');
  assert.ok(fs.existsSync(victim), 'a file outside the download dir survives');
  assert.ok(fs.existsSync(victim2), 'also when it is listed as filePath or through "..".');
  if (canLink) assert.ok(fs.existsSync(victim), 'a symlinked folder inside the download dir is not followed');
  // an outDir that is a filesystem root grants nothing
  assert.equal((await queue.remove('def456', true)).ok, true);
  assert.ok(fs.existsSync(victim) && fs.existsSync(victim2), 'a root-directory outDir does not make every file deletable');
  // normal case still works
  assert.equal((await queue.remove('ghi789', true)).ok, true);
  assert.ok(!fs.existsSync(insideFlat));
  assert.ok(fs.existsSync(dl), 'download dir stays');
});

test('remove(true): files below the folder the item was started in are still deleted after the setting changed', async () => {
  const dir = mkTmp('lg-rf-');
  const oldDl = path.join(dir, 'old');
  const newDl = path.join(dir, 'new');
  fs.mkdirSync(newDl, { recursive: true });
  const f = write(path.join(oldDl, 'Instagram a.jpg'));
  const storePath = storeWith(dir, [{ item: baseItem({ files: [f], filePath: f, folder: oldDl }), outDir: oldDl, vid: '' }]);
  const queue = new DownloadQueue({ ytdlp: fakeRunner(), settings: { get: () => ({ downloadDir: newDl, maxConcurrent: 2 }) }, storePath });
  await queue.remove('abc123', true);
  assert.ok(!fs.existsSync(f));
});

// ------------------------------------------------------------------ 2. the store is not trusted when a download starts

test('a queued item with a tampered link (generic: prefix, file:) never reaches a downloader', () => {
  const dir = mkTmp('lg-rf-');
  const storePath = storeWith(dir, [
    { item: baseItem({ id: 'one111', url: 'generic:http://169.254.169.254/gallery.html', site: 'x', status: 'queued' }), outDir: path.join(dir, 'dl'), vid: '' },
    { item: baseItem({ id: 'two222', url: 'file:///etc/passwd', site: 'instagram', status: 'queued', quality: 'media' }), outDir: path.join(dir, 'dl'), vid: '' },
    { item: baseItem({ id: 'ok3333', url: 'https://x.com/a/status/1', site: 'instagram', status: 'queued', quality: 'media' }), outDir: path.join(dir, 'dl'), vid: '' },
  ]);
  const runner = fakeRunner();
  const queue = new DownloadQueue({ ytdlp: runner, settings: { get: () => ({ downloadDir: path.join(dir, 'dl'), maxConcurrent: 5 }) }, storePath });
  queue.pump();
  assert.equal(runner.runs.length, 1);
  assert.equal(runner.runs[0].params.url, 'https://x.com/a/status/1');
  assert.equal(runner.runs[0].params.site, 'x', 'the site is recomputed from the link, not taken from the store');
  assert.equal(queue.get('one111').status, 'error');
  assert.equal(queue.get('two222').status, 'error');
});

test('router: gallery-dl only ever gets a plain http(s) link for x / instagram (no generic: prefix without the test hook)', async () => {
  assert.equal(router.galleryTargetFor('generic:http://127.0.0.1/gallery.html', 'x'), null);
  assert.equal(router.galleryTargetFor('file:///etc/passwd', 'instagram'), null);
  assert.equal(router.galleryTargetFor('https://x.com/a/status/1', 'x'), 'https://x.com/a/status/1');
  const calls = [];
  const gallery = { download: (p) => { calls.push(p); return null; }, getInfo: async (u) => { calls.push(u); return { ok: false, error: 'no' }; } };
  const yt = { download: () => { throw new Error('not expected'); }, getInfo: async () => ({ ok: false, error: 'yt' }) };
  const r = router.createRouter({ ytdlp: yt, gallery, getSiteOf: () => 'x' });
  const h = r.download({ url: 'generic:http://127.0.0.1/gallery.html', quality: 'images', outDir: '/tmp' }, () => {});
  const res = await h.done;
  assert.equal(res.code, 1);
  assert.deepEqual(calls, []);
  const info = await r.getInfo('generic:http://127.0.0.1/gallery.html', {});
  assert.equal(info.ok, false);
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------------ yt-dlp must not read config files

test('yt-dlp is always started with --ignore-config (cwd / profile yt-dlp.conf could carry --exec)', () => {
  const dl = y.buildDownloadArgs({ url: 'https://youtu.be/abc', quality: 'best', outDir: '/tmp/dl' });
  const info = y.buildInfoArgs({ url: 'https://youtu.be/abc' });
  assert.equal(dl[0], '--ignore-config');
  assert.equal(info[0], '--ignore-config');
  assert.equal(g.buildInfoArgs({ arg: 'https://x.com/a/status/1' }).includes('--config-ignore'), true);
});

// ------------------------------------------------------------------ 4. openFile refuses executables, also with Windows tricks

test('isBlockedToOpen: case, trailing dots/spaces, NTFS streams and the extra script/installer types', () => {
  const blocked = [
    'C:\\x\\setup.exe', 'a.EXE', 'a.exe.', 'a.exe ', 'a.exe. .', 'a.exe:Zone.Identifier', 'a.exe::$DATA', 'a.txt:b.exe',
    'a.bat', 'a.cmd', 'a.com', 'a.scr', 'a.msi', 'a.ps1', 'a.vbs', 'a.js', 'a.jse', 'a.wsf', 'a.lnk', 'a.hta', 'a.jar', 'a.reg',
    'a.cpl', 'a.pif', 'a.msc', 'a.inf', 'a.PS1 ', '/tmp/y.sh', 'photo.jpg.lnk',
  ];
  for (const f of blocked) assert.equal(isBlockedToOpen(f), true, f);
  for (const f of ['a.mp4', 'b.jpg', 'c.webp', 'my video.exe.mp4', 'note.txt', 'x: y.mp4', 'noext']) assert.equal(isBlockedToOpen(f), false, f);
});

test('api.openFile does not hand "setup.exe." (trailing dot) to the OS', { skip: !posix }, async () => {
  const dir = mkTmp('lg-rf-');
  const evil = path.join(dir, 'setup.exe.');
  fs.writeFileSync(evil, 'MZ');
  const good = write(path.join(dir, 'clip.mp4'));
  const items = { e: { id: 'e', status: 'completed', files: [evil], filePath: evil }, g: { id: 'g', status: 'completed', files: [good], filePath: good } };
  const opened = [];
  const api = createApi(
    { settings: { get: () => ({ downloadDir: dir }) }, engine: {}, queue: { get: (id) => items[id] || null } },
    { openPath: async (p) => { opened.push(p); return ''; }, showItemInFolder() {}, readClipboardText: () => '', chooseFolder: async () => null },
  );
  const r1 = await api.openFile('e');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /will not open/);
  assert.deepEqual(opened, []);
  assert.deepEqual(await api.openFile('g'), { ok: true });
  assert.deepEqual(opened, [good]);
});

// ------------------------------------------------------------------ 5. zip extraction limits

function makeZip(zipPath, files) {
  const script = `
import sys, zipfile, json
out = sys.argv[1]
spec = json.loads(sys.stdin.read())
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, content in spec.items():
        z.writestr(name, content)
`;
  const r = spawnSync('python3', ['-I', '-c', script, zipPath], { encoding: 'utf8', input: JSON.stringify(files) });
  if (r.status !== 0) throw new Error('makeZip failed: ' + (r.stderr || r.error));
}

/** Overwrite the uncompressed-size field of the (only) central directory record. */
function patchDeclaredSize(zipPath, size) {
  const buf = fs.readFileSync(zipPath);
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(size, at + 24);
  fs.writeFileSync(zipPath, buf);
}

test('zip: an entry that inflates beyond its declared size is rejected and leaves nothing behind', async () => {
  const dir = mkTmp('lg-rf-zip-');
  const zp = path.join(dir, 'bomb.zip');
  makeZip(zp, { 'bin/ffmpeg.exe': 'A'.repeat(3 * 1024 * 1024) });
  patchDeclaredSize(zp, 1000); // lies: says 1000 bytes
  const dest = path.join(dir, 'out', 'ffmpeg.exe');
  await assert.rejects(zip.extractByBasename(zp, { 'ffmpeg.exe': dest }), /declared size/);
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(dest + '.tmp'));
});

test('zip: absurd declared sizes and central directories are refused before anything is written', async () => {
  const dir = mkTmp('lg-rf-zip-');
  const zp = path.join(dir, 'big.zip');
  makeZip(zp, { 'bin/ffmpeg.exe': 'B'.repeat(5000) });
  patchDeclaredSize(zp, 0x7fffffff); // ~2 GiB
  const dest = path.join(dir, 'out', 'ffmpeg.exe');
  await assert.rejects(zip.extractByBasename(zp, { 'ffmpeg.exe': dest }), /too large/);
  assert.ok(!fs.existsSync(dest));

  const zp2 = path.join(dir, 'cd.zip');
  makeZip(zp2, { 'bin/ffmpeg.exe': 'C'.repeat(100) });
  const buf = fs.readFileSync(zp2);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  buf.writeUInt32LE(0x7ffffff0, eocd + 12); // central directory "size"
  fs.writeFileSync(zp2, buf);
  await assert.rejects(zip.listEntries(zp2), /Corrupt zip central directory/);
});

test('zip: entry names never decide where files are written (traversal names are ignored)', async () => {
  const dir = mkTmp('lg-rf-zip-');
  const zp = path.join(dir, 'trav.zip');
  makeZip(zp, { '../../evil.txt': 'x', '/abs/evil2.txt': 'y', 'C:\\win\\evil3.txt': 'z', 'ok/ffmpeg.exe': 'real' });
  const out = path.join(dir, 'out');
  const got = await zip.extractByBasename(zp, { 'ffmpeg.exe': path.join(out, 'ffmpeg.exe') });
  assert.deepEqual(got, ['ffmpeg.exe']);
  assert.deepEqual(fs.readdirSync(out), ['ffmpeg.exe']);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')));
});

// ------------------------------------------------------------------ 7. cancel / remove find a gallery item's partial files

test('gallery runner announces the name stem (title event with the plan id) before spawning gallery-dl', async () => {
  const dir = mkTmp('lg-rf-gal-');
  const bin = path.join(dir, 'fake-gdl');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a.includes('-j') || a.includes('-J')) { process.stdout.write(fs.readFileSync(process.env.FAKE_DUMP, 'utf8')); process.exit(0); }
const d = a[a.indexOf('-D') + 1];
const f = a[a.indexOf('-f') + 1];
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, f.replace('{extension}', 'jpg').replace('{num:02}', '01') + '.part'), 'partial');
setTimeout(() => process.exit(0), 20000);
`);
  fs.chmodSync(bin, 0o755);
  const meta = (n) => ({ post_shortcode: 'AbC123', num: n, extension: 'jpg', username: 'someone' });
  const dumpFor = (n) => JSON.stringify([[2, {}]].concat(Array.from({ length: n }, (_, i) => [3, `https://scontent.cdninstagram.com/p${i + 1}.jpg`, meta(i + 1)])));
  const outDir = path.join(dir, 'dl');
  for (const n of [1, 2]) {
    const dump = path.join(dir, `dump${n}.json`);
    fs.writeFileSync(dump, dumpFor(n));
    const runner = g.createGalleryRunner({ getBinary: () => bin, getFfmpeg: () => null, env: { FAKE_DUMP: dump } });
    const queue = new DownloadQueue({ ytdlp: runner, settings: { get: () => ({ downloadDir: outDir, maxConcurrent: 2 }) }, storePath: path.join(dir, `s${n}.json`) });
    const it = queue.add('https://www.instagram.com/p/AbC123/', 'images');
    const partDir = n === 1 ? outDir : path.join(outDir, 'Instagram AbC123');
    const find = () => (fs.existsSync(partDir) ? fs.readdirSync(partDir).filter((x) => x.endsWith('.part')) : []);
    await waitFor(() => find().length === 1, 8000);
    assert.equal(queue.recs.get(it.id).vid, 'AbC123', 'the queue knows the name stem');
    await queue.cancel(it.id);
    assert.equal(queue.get(it.id).status, 'canceled');
    assert.equal(find().length, 0, `partial file removed on cancel (${n} file${n > 1 ? 's' : ''})`);
    if (n === 2) assert.ok(!fs.existsSync(partDir), 'the now-empty post folder is removed too');
    await queue.shutdown();
  }
});
