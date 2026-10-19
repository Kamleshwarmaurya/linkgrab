'use strict';
// Real end-to-end tests: the real gallery-dl (and yt-dlp for the router test) against a local HTTP server.
//
// gallery-dl's `generic:` extractor only understands host names without a port, so the local server doubles as an
// HTTP proxy: gallery-dl is pointed at it with http_proxy (the runner's `env` option) and fetches
// http://gallery.test/<page>. The server ignores the host and answers by path. X and Instagram themselves cannot
// be reached from the sandbox, so everything site specific is covered with fakes in router/gallerydl tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const g = require('../src/main/gallerydl');
const ytdlp = require('../src/main/ytdlp');
const { createRouter } = require('../src/main/router');
const { mkTmp, sampleVideo, findYtdlp, findFfmpeg, waitFor } = require('./_helpers');

function findGallery() {
  if (process.env.LINKGRAB_GALLERYDL) return process.env.LINKGRAB_GALLERYDL;
  const w = spawnSync('which', ['gallery-dl'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}
const GALLERY = findGallery();
const skip = GALLERY ? false : 'gallery-dl is not installed (pip install gallery-dl)';

const HOST = 'http://gallery.test';
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const sha1File = (f) => sha(fs.readFileSync(f));

let assets; // name -> Buffer
function makeAssets() {
  const dir = mkTmp('lg-img-assets-');
  const script = `
import sys
from PIL import Image
d = sys.argv[1]
specs = [('a.jpg', (200, 50, 50), (320, 240)), ('b.png', (50, 200, 50), (300, 200)), ('c.jpg', (50, 50, 200), (280, 280)),
         ('s1.jpg', (10, 10, 10), (200, 200)), ('s2.jpg', (60, 60, 60), (210, 200)), ('s3.jpg', (120, 120, 120), (220, 200)), ('s4.jpg', (180, 180, 180), (230, 200))]
for name, color, size in specs:
    Image.new('RGB', size, color).save(d + '/' + name)
`;
  execFileSync('python3', ['-I', '-c', script, dir]);
  const out = {};
  for (const n of fs.readdirSync(dir)) out[n] = fs.readFileSync(path.join(dir, n));
  out['v.mp4'] = fs.readFileSync(sampleVideo());
  return out;
}

const PAGES = {
  '/three/gallery.html': ['a.jpg', 'b.png', 'c.jpg'],
  '/one/gallery.html': ['a.jpg'],
  '/mixed/gallery.html': ['a.jpg', 'v.mp4', 'c.jpg'],
  '/slow/gallery.html': ['s1.jpg', 's2.jpg', 's3.jpg', 's4.jpg'],
  '/half/gallery.html': ['a.jpg', 'missing.png', 'c.jpg'],
  '/empty/gallery.html': [],
};

function startSite() {
  const requests = [];
  const gate = { open: true, waiting: [] };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    requests.push(p);
    if (PAGES[p]) {
      const body = '<!doctype html><html><head><title>Test gallery</title></head><body>' +
        PAGES[p].map((n) => (n.endsWith('.mp4')
          ? `<video controls><source src="/img/${n}" type="video/mp4"></video>`
          : `<img src="/img/${n}">`)).join('\n') + '</body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    const m = /^\/img\/([\w.]+)$/.exec(p);
    if (m && assets[m[1]]) {
      const send = () => {
        const buf = assets[m[1]];
        res.writeHead(200, { 'Content-Type': m[1].endsWith('.png') ? 'image/png' : m[1].endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
      };
      if (m[1] === 's3.jpg' && !gate.open) {
        const w = () => { if (!res.destroyed) send(); };
        gate.waiting.push(w);
        res.on('close', () => { gate.waiting = gate.waiting.filter((x) => x !== w); });
        return undefined;
      }
      return send();
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        proxy: `http://127.0.0.1:${port}`,
        requests,
        count: (p) => requests.filter((x) => x === p).length,
        holdS3() { gate.open = false; },
        releaseS3() { gate.open = true; const w = gate.waiting; gate.waiting = []; w.forEach((f) => f()); },
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

function proxyEnv(site) {
  return { http_proxy: site.proxy, HTTP_PROXY: site.proxy, no_proxy: '', NO_PROXY: '', all_proxy: '', ALL_PROXY: '' };
}
const pageUrl = (p) => `${HOST}${p}`;
// a host the app itself accepts as the test site (port-less: gallery-dl's generic extractor cannot do ports)
const lhUrl = (p) => `http://localhost${p}`;
const listDir = (d) => fs.readdirSync(d).sort();

let site;
let runner;

test.before(async () => {
  if (skip) return;
  assets = makeAssets();
  site = await startSite();
  runner = g.createGalleryRunner({ getBinary: () => GALLERY, getFfmpeg: () => findFfmpeg(), env: proxyEnv(site) });
});
test.after(async () => { if (site) await site.close(); });

test('real gallery-dl: getInfo lists 3 images (kind image, qualities, thumbnails)', { skip }, async () => {
  const r = await runner.getInfo('generic:' + pageUrl('/three/gallery.html'), { site: 'test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.kind, 'image');
  assert.equal(r.info.imageCount, 3);
  assert.equal(r.info.videoCount, 0);
  assert.equal(r.info.engine, 'gallery-dl');
  assert.deepEqual(r.info.qualities, [{ key: 'images', label: 'Images (3)' }]);
  assert.deepEqual(r.info.thumbnails, ['a.jpg', 'b.png', 'c.jpg'].map((n) => `${HOST}/img/${n}`));
  assert.equal(r.info.thumbnail, r.info.thumbnails[0]);
  assert.equal(r.info.title, 'Test gallery');
});

test('real gallery-dl: 3 images -> subfolder "Test <id>/01.jpg 02.png 03.jpg", with progress and files events', { skip }, async () => {
  const out = mkTmp('lg-img-out-');
  const url = 'generic:' + pageUrl('/three/gallery.html');
  const events = [];
  const h = runner.download({ url, quality: 'images', outDir: out, site: 'test' }, (e) => events.push(e));
  const res = await h.done;
  assert.equal(res.code, 0, res.error);
  assert.equal(res.error, null);
  assert.equal(res.killed, false);
  assert.equal(res.fileCount, 3);
  assert.equal(res.files.length, 3);
  // layout on disk
  const entries = listDir(out);
  assert.equal(entries.length, 1, entries.join(','));
  assert.match(entries[0], /^Test [0-9a-f]{8}$/);
  assert.equal(res.folder, path.join(out, entries[0]));
  assert.deepEqual(listDir(res.folder), ['01.jpg', '02.png', '03.jpg']);
  assert.deepEqual(res.files, ['01.jpg', '02.png', '03.jpg'].map((n) => path.join(res.folder, n)));
  assert.equal(res.filePath, res.files[0]);
  // content is exactly what the server sent
  assert.equal(sha1File(res.files[0]), sha(assets['a.jpg']));
  assert.equal(sha1File(res.files[1]), sha(assets['b.png']));
  assert.equal(sha1File(res.files[2]), sha(assets['c.jpg']));
  // no stray .part files, nothing outside the folder
  assert.ok(!listDir(res.folder).some((n) => n.endsWith('.part')));
  // events
  const fe = events.filter((e) => e.type === 'files');
  assert.deepEqual(fe.map((e) => e.files.length), [1, 2, 3]);
  assert.ok(fe.every((e) => e.folder === res.folder && e.fileCount === 3));
  assert.deepEqual(fe[2].files, res.files);
  const prog = events.filter((e) => e.type === 'progress');
  assert.ok(prog.length >= 3);
  const pct = prog.map((e) => e.percent);
  assert.deepEqual(pct, pct.slice().sort((a, b) => a - b));
  assert.equal(pct[pct.length - 1], 100);
  assert.ok(prog.every((e) => Number.isFinite(e.downloaded) && e.downloaded >= 0));
  assert.equal(prog[prog.length - 1].downloaded, assets['a.jpg'].length + assets['b.png'].length + assets['c.jpg'].length);
  assert.ok(prog.some((e) => e.percent > 0 && e.percent < 100), 'saw an intermediate percent');
});

test('real gallery-dl: exactly 1 image -> flat "Test <id>.jpg" directly in the download dir', { skip }, async () => {
  const out = mkTmp('lg-img-out-');
  const res = await runner.download({ url: 'generic:' + pageUrl('/one/gallery.html'), quality: 'images', outDir: out, site: 'test' }).done;
  assert.equal(res.code, 0, res.error);
  const entries = listDir(out);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^Test [0-9a-f]{8}\.jpg$/);
  assert.equal(res.folder, out);
  assert.deepEqual(res.files, [path.join(out, entries[0])]);
  assert.equal(res.fileCount, 1);
  assert.equal(sha1File(res.files[0]), sha(assets['a.jpg']));
});

test('real gallery-dl: MIXED post (images + mp4) -> media takes everything, images only the pictures', { skip }, async () => {
  const url = 'generic:' + pageUrl('/mixed/gallery.html');
  const info = await runner.getInfo(url, { site: 'test' });
  assert.equal(info.ok, true, info.error);
  assert.equal(info.info.kind, 'mixed');
  assert.equal(info.info.imageCount, 2);
  assert.equal(info.info.videoCount, 1);
  assert.deepEqual(info.info.qualities.map((q) => q.label), ['Everything (3 files)', 'Images only (2)']);

  const outAll = mkTmp('lg-img-out-');
  const all = await runner.download({ url, quality: 'media', outDir: outAll, site: 'test' }).done;
  assert.equal(all.code, 0, all.error);
  assert.deepEqual(all.files.map((f) => path.basename(f)), ['01.jpg', '02.mp4', '03.jpg']);
  assert.equal(sha1File(all.files[1]), sha(assets['v.mp4']));

  const outImg = mkTmp('lg-img-out-');
  const imgs = await runner.download({ url, quality: 'images', outDir: outImg, site: 'test' }).done;
  assert.equal(imgs.code, 0, imgs.error);
  assert.deepEqual(imgs.files.map((f) => path.basename(f)), ['01.jpg', '02.jpg']); // renumbered without a gap
  assert.equal(sha1File(imgs.files[1]), sha(assets['c.jpg']));
  assert.ok(!listDir(imgs.folder).some((n) => n.endsWith('.mp4')));
});

test('real gallery-dl: kill mid-way keeps finished files; re-running resumes without re-downloading them', { skip }, async () => {
  const out = mkTmp('lg-img-out-');
  const url = 'generic:' + pageUrl('/slow/gallery.html');
  site.holdS3();
  let latest = [];
  const h = runner.download({ url, quality: 'images', outDir: out, site: 'test' }, (e) => { if (e.type === 'files') latest = e.files; });
  await waitFor(() => latest.length >= 2 && site.count('/img/s3.jpg') >= 1, 20000, 'two files done and the third requested');
  const t0 = Date.now();
  await h.kill();
  const killed = await h.done;
  assert.ok(Date.now() - t0 < 8000, 'kill returned promptly');
  assert.equal(killed.killed, true);
  assert.equal(killed.error, null);
  assert.equal(killed.files.length, 2);
  assert.deepEqual(killed.files.map((f) => path.basename(f)), ['01.jpg', '02.jpg']);
  assert.equal(h.child === null || h.child.exitCode !== null || h.child.signalCode !== null, true, 'process is gone');
  const s1 = site.count('/img/s1.jpg');
  const s2 = site.count('/img/s2.jpg');
  assert.equal(s1, 1);
  assert.equal(s2, 1);
  assert.ok(!fs.existsSync(path.join(killed.folder, '03.jpg')), 'the unfinished file is not left as a finished one');

  // resume
  site.releaseS3();
  const events = [];
  const res = await runner.download({ url, quality: 'images', outDir: out, site: 'test' }, (e) => events.push(e)).done;
  assert.equal(res.code, 0, res.error);
  assert.deepEqual(res.files.map((f) => path.basename(f)), ['01.jpg', '02.jpg', '03.jpg', '04.jpg']);
  assert.equal(site.count('/img/s1.jpg'), s1, 's1 was skipped, not fetched again');
  assert.equal(site.count('/img/s2.jpg'), s2, 's2 was skipped, not fetched again');
  assert.ok(site.count('/img/s3.jpg') >= 2 && site.count('/img/s4.jpg') === 1);
  assert.equal(sha1File(res.files[3]), sha(assets['s4.jpg']));
  assert.ok(!listDir(res.folder).some((n) => n.endsWith('.part')));
  assert.equal(events.filter((e) => e.type === 'files').length, 4); // skipped files are reported too
});

test('real gallery-dl: a page that does not exist (404) gives a friendly error, in getInfo and download', { skip }, async () => {
  const url = 'generic:' + pageUrl('/nothing/gallery.html');
  const info = await runner.getInfo(url, { site: 'test' });
  assert.equal(info.ok, false);
  assert.match(info.error, /not available/);
  assert.doesNotMatch(info.error, /Traceback|HttpError/);
  const out = mkTmp('lg-img-out-');
  const res = await runner.download({ url, quality: 'images', outDir: out, site: 'test' }).done;
  assert.notEqual(res.code, 0);
  assert.match(res.error, /not available/);
  assert.deepEqual(res.files, []);
  assert.deepEqual(listDir(out), []);
});

test('real gallery-dl: a page without images -> clear error; one broken image -> partial result with the others kept', { skip }, async () => {
  const none = await runner.getInfo('generic:' + pageUrl('/empty/gallery.html'), { site: 'test' });
  assert.equal(none.ok, false);
  assert.match(none.error, /No images or videos/);

  const out = mkTmp('lg-img-out-');
  const res = await runner.download({ url: 'generic:' + pageUrl('/half/gallery.html'), quality: 'images', outDir: out, site: 'test' }).done;
  assert.notEqual(res.code, 0);
  assert.match(res.error, /^Only 2 of 3 files could be downloaded/);
  assert.deepEqual(res.files.map((f) => path.basename(f)), ['01.jpg', '03.jpg']);
  assert.equal(res.fileCount, 3);
  assert.ok(fs.existsSync(res.files[0]));
});

test('real gallery-dl: unsupported link and unreachable server map to friendly text', { skip }, async () => {
  const r = await runner.getInfo(pageUrl('/three/gallery.html'), { site: 'test' }); // no generic: prefix -> no extractor
  assert.equal(r.ok, false);
  assert.match(r.error, /does not point to a post/);
  const dead = g.createGalleryRunner({ getBinary: () => GALLERY, env: { http_proxy: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', no_proxy: '', NO_PROXY: '' } });
  const d = await dead.getInfo('generic:' + pageUrl('/three/gallery.html'), { site: 'test', timeoutMs: 60000 });
  assert.equal(d.ok, false);
  assert.match(d.error, /Network problem/);
});

test('gallery-dl binary missing: friendly engine message (no spawn error escapes)', async () => {
  const gone = g.createGalleryRunner({ getBinary: () => path.join(mkTmp('lg-nobin-'), 'gallery-dl') });
  const res = await gone.download({ url: 'generic:' + pageUrl('/three/gallery.html'), quality: 'images', outDir: mkTmp('lg-img-out-') }).done;
  assert.equal(res.error, 'The image engine (gallery-dl) is not installed. Use the engine setup banner to install it.');
  const none = g.createGalleryRunner({ getBinary: () => null });
  assert.equal((await none.getInfo('https://x.com/a/status/1')).error, g.MISSING_MESSAGE);
  assert.equal((await none.download({ url: 'https://x.com/a/status/1', quality: 'images', outDir: mkTmp('lg-img-out-') }).done).error, g.MISSING_MESSAGE);
});

test('router with the real engines (test hook): mixed page -> kind mixed, both engines; image page -> kind image; downloads', { skip: skip || (findYtdlp() ? false : 'yt-dlp is not installed') }, async () => {
  const prev = { hook: process.env.LINKGRAB_ALLOW_ANY_HOST, p1: process.env.http_proxy, p2: process.env.HTTP_PROXY, n1: process.env.no_proxy, n2: process.env.NO_PROXY };
  Object.assign(process.env, { LINKGRAB_ALLOW_ANY_HOST: '1' }, proxyEnv(site)); // yt-dlp child inherits the proxy
  try {
    const yt = ytdlp.createRunner({ getBinary: findYtdlp, getFfmpeg: findFfmpeg });
    const router = createRouter({ ytdlp: yt, gallery: runner }); // real sites.detectSite: localhost is the 'test' site with the hook

    const mixed = await router.getInfo(lhUrl('/mixed/gallery.html'));
    assert.equal(mixed.ok, true, mixed.error);
    assert.equal(mixed.info.kind, 'mixed');
    assert.equal(mixed.info.engine, 'both');
    assert.equal(mixed.info.imageCount, 2);
    assert.equal(mixed.info.videoCount, 1);
    assert.deepEqual(mixed.info.qualities.slice(0, 2).map((q) => q.key), ['media', 'images']);
    assert.ok(mixed.info.qualities.some((q) => q.key === 'best') && mixed.info.qualities.some((q) => q.key === 'audio'));

    const imgPage = await router.getInfo(lhUrl('/three/gallery.html'));
    assert.equal(imgPage.ok, true, imgPage.error);
    assert.equal(imgPage.info.kind, 'image');
    assert.equal(imgPage.info.engine, 'gallery-dl');
    assert.deepEqual(imgPage.info.qualities, [{ key: 'images', label: 'Images (3)' }]);

    const missing = await router.getInfo(lhUrl('/nothing/gallery.html'));
    assert.equal(missing.ok, false);
    assert.ok(missing.error && missing.error.length > 5);

    const out = mkTmp('lg-img-out-');
    const res = await router.download({ url: lhUrl('/three/gallery.html'), quality: 'images', outDir: out, site: 'test' }).done;
    assert.equal(res.code, 0, res.error);
    assert.equal(res.files.length, 3);
    assert.deepEqual(listDir(res.folder), ['01.jpg', '02.png', '03.jpg']);

    // the video of the mixed post still goes through yt-dlp when a video quality is chosen
    const out2 = mkTmp('lg-img-out-');
    const vid = await router.download({ url: lhUrl('/mixed/gallery.html'), quality: 'best', outDir: out2, site: 'test' }).done;
    assert.equal(vid.code, 0, vid.error);
    assert.ok(vid.filePath && vid.filePath.endsWith('.mp4'));
  } finally {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('LINKGRAB_ALLOW_ANY_HOST', prev.hook);
    restore('http_proxy', prev.p1);
    restore('HTTP_PROXY', prev.p2);
    restore('no_proxy', prev.n1);
    restore('NO_PROXY', prev.n2);
  }
});
