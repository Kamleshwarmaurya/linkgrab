'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createEngine, downloadFile, pickGallerydlAsset } = require('../src/main/engine');
const zip = require('../src/main/zip');
const { mkTmp } = require('./_helpers');

const posix = process.platform !== 'win32';
const FAKE_YTDLP = '#!/bin/sh\ncase "$1" in\n  --version) echo 2026.01.02;;\n  -U) echo "Updated yt-dlp to 2026.01.02"; exit 0;;\nesac\n';
const FAKE_FFMPEG = '#!/bin/sh\necho "ffmpeg version 7.0-test Copyright"\n';
const FAKE_GALLERYDL = '#!/bin/sh\ncase "$1" in\n  --version) echo 1.32.17;;\nesac\n';
const FAKE_GALLERYDL_NEW = '#!/bin/sh\ncase "$1" in\n  --version) echo 1.40.2;;\nesac\n';
const PIP_GALLERYDL = ['/usr/local/bin/gallery-dl', '/usr/bin/gallery-dl'].find((p) => fs.existsSync(p)) || null;

// The whole file runs with no LINKGRAB_GALLERYDL override unless a test sets one itself.
const savedGalleryEnv = process.env.LINKGRAB_GALLERYDL;
delete process.env.LINKGRAB_GALLERYDL;
test.after(() => {
  if (savedGalleryEnv === undefined) delete process.env.LINKGRAB_GALLERYDL; else process.env.LINKGRAB_GALLERYDL = savedGalleryEnv;
});

/** Run fn with env vars temporarily changed (undefined deletes). */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function writeExe(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, { mode: 0o755 });
}

/** Tiny file server with redirects. routes: path -> Buffer | {redirect} | {status} */
function serve(routes) {
  const server = http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end(); }
    if (r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
    res.writeHead(200, { 'Content-Length': r.length });
    res.end(r);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
  }));
}

function makeZip(zipPath, files, method) {
  const script = `
import sys, zipfile, json
out, method = sys.argv[1], sys.argv[2]
spec = json.loads(sys.stdin.read())
comp = zipfile.ZIP_DEFLATED if method == 'deflate' else zipfile.ZIP_STORED
with zipfile.ZipFile(out, 'w', comp) as z:
    for name, content in spec.items():
        z.writestr(name, content)
`;
  const r = spawnSync('python3', ['-I', '-c', script, zipPath, method || 'deflate'], { encoding: 'utf8', input: JSON.stringify(files), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('makeZip failed: ' + (r.stderr || r.error));
}

test('zip reader extracts stored and deflated entries by basename (nested dirs, other files ignored)', async () => {
  for (const method of ['deflate', 'store']) {
    const dir = mkTmp('lg-zip-');
    const big = 'frame-data-'.repeat(200000); // ~2.2MB, compressible
    const zp = path.join(dir, 'a.zip');
    makeZip(zp, { 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe': big, 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe': 'probeé', 'ffmpeg-master-latest-win64-gpl/LICENSE.txt': 'x' }, method);
    const out = path.join(dir, 'out');
    const got = await zip.extractByBasename(zp, { 'ffmpeg.exe': path.join(out, 'ffmpeg.exe'), 'FFPROBE.EXE': path.join(out, 'ffprobe.exe') });
    assert.deepEqual(got.sort(), ['ffmpeg.exe', 'ffprobe.exe']);
    assert.equal(fs.readFileSync(path.join(out, 'ffmpeg.exe'), 'utf8'), big);
    assert.equal(fs.readFileSync(path.join(out, 'ffprobe.exe'), 'utf8'), 'probeé');
    assert.deepEqual(fs.readdirSync(out).sort(), ['ffmpeg.exe', 'ffprobe.exe']);
  }
});

test('zip reader rejects non-zip files', async () => {
  const dir = mkTmp('lg-zip-');
  const p = path.join(dir, 'bad.zip');
  fs.writeFileSync(p, Buffer.alloc(500, 7));
  await assert.rejects(zip.listEntries(p), /Not a zip/);
});

test('downloadFile follows redirects (up to 5) with progress, and fails clearly otherwise', async () => {
  const payload = Buffer.alloc(300000, 9);
  const srv = await serve({
    '/file': payload,
    '/r1': { redirect: '/r2' }, '/r2': { redirect: '/r3' }, '/r3': { redirect: '/file' },
    '/loop': { redirect: '/loop' },
    '/five': { redirect: '/f2' }, '/f2': { redirect: '/f3' }, '/f3': { redirect: '/f4' }, '/f4': { redirect: '/f5' }, '/f5': { redirect: '/file' },
  });
  try {
    const dir = mkTmp('lg-dl-');
    const dest = path.join(dir, 'x.bin');
    const seen = [];
    await downloadFile(srv.base + '/r1', dest, { allowHttp: true, onProgress: (g, t) => seen.push([g, t]) });
    assert.equal(fs.statSync(dest).size, payload.length);
    assert.deepEqual(seen[seen.length - 1], [payload.length, payload.length]);
    await downloadFile(srv.base + '/five', path.join(dir, 'five.bin'), { allowHttp: true }); // exactly 5 redirects
    await assert.rejects(downloadFile(srv.base + '/loop', path.join(dir, 'l.bin'), { allowHttp: true }), /Too many redirects/);
    await assert.rejects(downloadFile(srv.base + '/nope', path.join(dir, 'n.bin'), { allowHttp: true }), /HTTP 404/);
    assert.ok(!fs.existsSync(path.join(dir, 'n.bin')));
    await assert.rejects(downloadFile(srv.base + '/file', path.join(dir, 'h.bin')), /non-https/); // http refused by default
  } finally { await srv.close(); }
});

test('locate order: env override, then userData/bin, then PATH', { skip: !posix }, async () => {
  const dir = mkTmp('lg-eng-');
  const binDir = path.join(dir, 'bin');
  const pathDir = path.join(dir, 'pathdir');
  const envFile = path.join(dir, 'env', 'my-ytdlp');
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP, F: process.env.LINKGRAB_FFMPEG };
  try {
    process.env.PATH = pathDir + path.delimiter + '/nonexistent';
    delete process.env.LINKGRAB_YTDLP; delete process.env.LINKGRAB_FFMPEG;
    const eng = createEngine({ binDir });
    assert.equal(eng.findYtdlp(), null);
    assert.equal((await eng.status()).ytdlp.installed, false);
    writeExe(path.join(pathDir, 'yt-dlp'), FAKE_YTDLP);
    assert.deepEqual(eng.findYtdlp(), { path: path.join(pathDir, 'yt-dlp'), source: 'path' });
    writeExe(path.join(binDir, 'yt-dlp'), FAKE_YTDLP);
    assert.equal(eng.findYtdlp().source, 'userData');
    writeExe(envFile, FAKE_YTDLP);
    process.env.LINKGRAB_YTDLP = envFile;
    assert.deepEqual(eng.findYtdlp(), { path: envFile, source: 'env' });
    process.env.LINKGRAB_YTDLP = '/does/not/exist';
    assert.equal(eng.findYtdlp().source, 'userData'); // bad override falls through
    process.env.LINKGRAB_YTDLP = 'relative/yt-dlp';
    assert.equal(eng.findYtdlp().source, 'userData'); // must be absolute
    const st = await eng.status();
    assert.deepEqual(st.ytdlp, { installed: true, version: '2026.01.02', path: path.join(binDir, 'yt-dlp') });
    assert.deepEqual(st.ffmpeg, { installed: false, path: null });
    writeExe(path.join(pathDir, 'ffmpeg'), FAKE_FFMPEG);
    process.env.LINKGRAB_FFMPEG = path.join(pathDir, 'ffmpeg');
    assert.equal(eng.findFfmpeg().source, 'env');
    assert.equal((await eng.status()).ffmpeg.installed, true);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y === undefined) delete process.env.LINKGRAB_YTDLP; else process.env.LINKGRAB_YTDLP = saved.Y;
    if (saved.F === undefined) delete process.env.LINKGRAB_FFMPEG; else process.env.LINKGRAB_FFMPEG = saved.F;
  }
});

test('install (linux layout): downloads yt-dlp via redirect, verifies it runs, reports progress', { skip: !posix }, async () => {
  const srv = await serve({ '/go': { redirect: '/yt' }, '/yt': Buffer.from(FAKE_YTDLP), '/gdl': Buffer.from(FAKE_GALLERYDL) });
  const dir = mkTmp('lg-inst-');
  const events = [];
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP, F: process.env.LINKGRAB_FFMPEG };
  try {
    process.env.PATH = '/nonexistent'; delete process.env.LINKGRAB_YTDLP; delete process.env.LINKGRAB_FFMPEG;
    const eng = createEngine({ binDir: path.join(dir, 'bin'), onProgress: (p) => events.push(p) });
    const r = await eng.install({ ytdlpUrl: srv.base + '/go', gallerydlUrl: srv.base + '/gdl', allowHttp: true });
    assert.equal(r.ok, true, r.error);
    assert.match(r.note || '', /ffmpeg/); // linux: ffmpeg must come from the package manager
    assert.doesNotMatch(r.note || '', /gallery-dl/);
    const st = await eng.status();
    assert.equal(st.ytdlp.installed, true);
    assert.equal(st.ytdlp.version, '2026.01.02');
    assert.equal(st.ytdlp.path, path.join(dir, 'bin', 'yt-dlp'));
    assert.ok(events.some((e) => e.stage === 'ytdlp' && e.percent === 100));
    assert.ok(events.every((e) => e.percent >= 0 && e.percent <= 100 && typeof e.message === 'string'));
    assert.deepEqual(st.gallerydl, { installed: true, version: '1.32.17', path: path.join(dir, 'bin', 'gallery-dl') });
    assert.equal(eng.getGallerydlPath(), path.join(dir, 'bin', 'gallery-dl'));
    assert.ok(events.some((e) => e.stage === 'gallerydl' && e.percent === 100));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')).sort(), ['gallery-dl', 'yt-dlp']); // no temp files left
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y !== undefined) process.env.LINKGRAB_YTDLP = saved.Y;
    if (saved.F !== undefined) process.env.LINKGRAB_FFMPEG = saved.F;
    await srv.close();
  }
});

test('install rejects a download that does not run as yt-dlp and leaves nothing behind', { skip: !posix }, async () => {
  const srv = await serve({ '/bad': Buffer.from('#!/bin/sh\necho hello world\n'), '/html': Buffer.from('<html>rate limited</html>') });
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP };
  try {
    process.env.PATH = '/nonexistent'; delete process.env.LINKGRAB_YTDLP;
    for (const route of ['/bad', '/html', '/missing']) {
      const dir = mkTmp('lg-inst-');
      const eng = createEngine({ binDir: path.join(dir, 'bin') });
      const r = await eng.install({ ytdlpUrl: srv.base + route, allowHttp: true });
      assert.equal(r.ok, false, route);
      assert.match(r.error, /Engine setup failed/);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), [], route);
      assert.equal(eng.findYtdlp(), null);
    }
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y !== undefined) process.env.LINKGRAB_YTDLP = saved.Y;
    await srv.close();
  }
});

test('install (windows layout): extracts ffmpeg.exe + ffprobe.exe from the zip and verifies them', { skip: !posix }, async () => {
  // Simulated on Linux: the "exe" files are shell scripts, but the whole download/zip/verify path is real.
  const dir = mkTmp('lg-winst-');
  const zp = path.join(dir, 'ff.zip');
  makeZip(zp, {
    'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe': FAKE_FFMPEG + '#'.repeat(500000),
    'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe': '#!/bin/sh\necho ffprobe\n',
    'ffmpeg-master-latest-win64-gpl/doc/readme.txt': 'hi',
  });
  const srv = await serve({ '/ff.zip': fs.readFileSync(zp), '/yt.exe': Buffer.from(FAKE_YTDLP), '/gdl.exe': Buffer.from(FAKE_GALLERYDL) });
  const events = [];
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP, F: process.env.LINKGRAB_FFMPEG };
  try {
    process.env.PATH = '/nonexistent'; delete process.env.LINKGRAB_YTDLP; delete process.env.LINKGRAB_FFMPEG;
    const binDir = path.join(dir, 'bin');
    const eng = createEngine({ binDir, platform: 'win32', onProgress: (p) => events.push(p) });
    const r = await eng.install({ ytdlpUrl: srv.base + '/yt.exe', ffmpegUrl: srv.base + '/ff.zip', gallerydlUrl: srv.base + '/gdl.exe', allowHttp: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.note, undefined);
    assert.deepEqual(fs.readdirSync(binDir).sort(), ['ffmpeg.exe', 'ffprobe.exe', 'gallery-dl.exe', 'yt-dlp.exe']);
    const st = await eng.status();
    assert.equal(st.ffmpeg.installed, true);
    assert.equal(st.ffmpeg.path, path.join(binDir, 'ffmpeg.exe'));
    assert.equal(st.ytdlp.installed, true);
    assert.deepEqual(st.gallerydl, { installed: true, version: '1.32.17', path: path.join(binDir, 'gallery-dl.exe') });
    assert.ok(events.some((e) => e.stage === 'ffmpeg' && e.percent === 100));
    assert.ok(events.some((e) => e.stage === 'gallerydl' && e.percent === 100));
    assert.equal(eng.ytdlpAssetName(), 'yt-dlp.exe');
    // a second install is a no-op
    const again = await eng.install({ allowHttp: true });
    assert.equal(again.ok, true);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y !== undefined) process.env.LINKGRAB_YTDLP = saved.Y;
    if (saved.F !== undefined) process.env.LINKGRAB_FFMPEG = saved.F;
    await srv.close();
  }
});

test('concurrent install() calls share one run', { skip: !posix }, async () => {
  let hits = 0;
  const srv = await serve({ '/yt': Buffer.from(FAKE_YTDLP), '/gdl': Buffer.from(FAKE_GALLERYDL) });
  const dir = mkTmp('lg-inst-');
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP };
  try {
    process.env.PATH = '/nonexistent'; delete process.env.LINKGRAB_YTDLP;
    const eng = createEngine({ binDir: path.join(dir, 'bin'), onProgress: (p) => { if (p.stage === 'ytdlp' && p.percent === 0) hits++; } });
    const ov = { ytdlpUrl: srv.base + '/yt', gallerydlUrl: srv.base + '/gdl', allowHttp: true };
    const [a, b] = await Promise.all([eng.install(ov), eng.install(ov)]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(hits, 1);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y !== undefined) process.env.LINKGRAB_YTDLP = saved.Y;
    await srv.close();
  }
});

test('update: runs -U and reports the new version; failures are reported, not thrown', { skip: !posix }, async () => {
  const dir = mkTmp('lg-upd-');
  const saved = { PATH: process.env.PATH, Y: process.env.LINKGRAB_YTDLP };
  try {
    process.env.PATH = '/nonexistent'; delete process.env.LINKGRAB_YTDLP;
    const eng = createEngine({ binDir: path.join(dir, 'bin') });
    assert.equal((await eng.update()).ok, false); // nothing installed
    writeExe(path.join(dir, 'bin', 'yt-dlp'), FAKE_YTDLP);
    const gsrv = await serve({ '/gdl': Buffer.from(FAKE_GALLERYDL) });
    try {
      // gallery-dl is missing: update installs it, and reports both versions
      assert.deepEqual(await eng.update({ gallerydlUrl: gsrv.base + '/gdl', allowHttp: true }), { ok: true, version: '2026.01.02', gallerydlVersion: '1.32.17' });
    } finally { await gsrv.close(); }
    // package-manager install that refuses to self-update
    const pm = path.join(dir, 'pm', 'yt-dlp');
    writeExe(pm, '#!/bin/sh\ncase "$1" in --version) echo 2026.01.02;; -U) echo "ERROR: You installed yt-dlp with a package manager" >&2; exit 100;; esac\n');
    fs.rmSync(path.join(dir, 'bin'), { recursive: true });
    process.env.LINKGRAB_YTDLP = pm;
    const r = await eng.update({ gallerydlUrl: 'http://127.0.0.1:1/never' });
    assert.equal(r.ok, false);
    assert.match(r.error, /package manager/);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Y === undefined) delete process.env.LINKGRAB_YTDLP; else process.env.LINKGRAB_YTDLP = saved.Y;
  }
});

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

test('gallery-dl locate order: env override, then userData/bin, then PATH', { skip: !posix }, async () => {
  const dir = mkTmp('lg-gdl-');
  const binDir = path.join(dir, 'bin');
  const pathDir = path.join(dir, 'pathdir');
  const envFile = path.join(dir, 'env', 'my-gdl');
  await withEnv({ PATH: pathDir + path.delimiter + '/nonexistent', LINKGRAB_GALLERYDL: undefined }, async () => {
    const eng = createEngine({ binDir });
    assert.equal(eng.getGallerydlPath(), null);
    assert.equal(eng.findGallerydl(), null);
    assert.deepEqual((await eng.status()).gallerydl, { installed: false, version: null, path: null });
    writeExe(path.join(pathDir, 'gallery-dl'), FAKE_GALLERYDL);
    assert.equal(eng.getGallerydlPath(), path.join(pathDir, 'gallery-dl'));
    assert.equal(eng.findGallerydl().source, 'path');
    writeExe(path.join(binDir, 'gallery-dl'), FAKE_GALLERYDL);
    assert.equal(eng.findGallerydl().source, 'userData');
    writeExe(envFile, FAKE_GALLERYDL);
    process.env.LINKGRAB_GALLERYDL = envFile;
    assert.equal(eng.getGallerydlPath(), envFile);
    assert.equal(eng.findGallerydl().source, 'env');
    process.env.LINKGRAB_GALLERYDL = '/does/not/exist';
    assert.equal(eng.findGallerydl().source, 'userData'); // bad override falls through
    process.env.LINKGRAB_GALLERYDL = 'relative/gallery-dl';
    assert.equal(eng.findGallerydl().source, 'userData'); // must be absolute
    process.env.LINKGRAB_GALLERYDL = envFile;
    assert.deepEqual((await eng.status()).gallerydl, { installed: true, version: '1.32.17', path: envFile });
    // a file that does not behave like gallery-dl is reported as not installed
    writeExe(envFile, '#!/bin/sh\necho hello\n');
    assert.deepEqual((await eng.status()).gallerydl, { installed: false, version: null, path: envFile });
  });
});

test('status().gallerydl works with the real pip gallery-dl via LINKGRAB_GALLERYDL', { skip: !posix || !PIP_GALLERYDL }, async () => {
  const dir = mkTmp('lg-gdl-');
  await withEnv({ PATH: '/nonexistent', LINKGRAB_GALLERYDL: PIP_GALLERYDL }, async () => {
    const eng = createEngine({ binDir: path.join(dir, 'bin') });
    const st = await eng.status();
    assert.equal(st.gallerydl.installed, true);
    assert.equal(st.gallerydl.path, PIP_GALLERYDL);
    assert.match(st.gallerydl.version, /^\d+\.\d+\.\d+/);
    // already available: install does not try to download anything (no overrides, no network needed)
    const events = [];
    const eng2 = createEngine({ binDir: path.join(dir, 'bin2'), onProgress: (p) => events.push(p) });
    writeExe(path.join(dir, 'bin2', 'yt-dlp'), FAKE_YTDLP);
    const r = await eng2.install();
    assert.equal(r.ok, true, r.error);
    assert.doesNotMatch(r.note || '', /gallery-dl/);
    assert.ok(events.some((e) => e.stage === 'gallerydl' && /already installed/.test(e.message)));
    assert.ok(!fs.existsSync(path.join(dir, 'bin2', 'gallery-dl')));
  });
});

test('install: a gallery-dl failure does not fail the install (ok:true + note), yt-dlp stays installed', { skip: !posix }, async () => {
  const srv = await serve({
    '/yt': Buffer.from(FAKE_YTDLP),
    '/bad': Buffer.from('#!/bin/sh\necho not-a-version\n'),
    '/html': Buffer.from('<html>rate limited</html>'),
    '/api': Buffer.from(JSON.stringify({ tag_name: 'v9', assets: [{ name: 'gallery-dl-9.zip', browser_download_url: 'https://github.com/x/y/gallery-dl-9.zip' }] })),
  });
  try {
    for (const route of ['/bad', '/html', '/missing']) {
      const dir = mkTmp('lg-inst-');
      const binDir = path.join(dir, 'bin');
      const events = [];
      await withEnv({ PATH: '/nonexistent', LINKGRAB_YTDLP: undefined, LINKGRAB_FFMPEG: undefined }, async () => {
        const eng = createEngine({ binDir, onProgress: (p) => events.push(p) });
        const r = await eng.install({ ytdlpUrl: srv.base + '/yt', gallerydlUrl: srv.base + route, gallerydlApi: srv.base + '/api', allowHttp: true });
        assert.equal(r.ok, true, route + ' ' + r.error);
        assert.match(r.note, /image engine \(gallery-dl\)/, route);
        assert.match(r.note, /ffmpeg/, route); // earlier notes are kept
        assert.deepEqual(fs.readdirSync(binDir), ['yt-dlp'], route); // nothing half-installed
        const st = await eng.status();
        assert.equal(st.ytdlp.installed, true);
        assert.equal(st.gallerydl.installed, false);
        assert.ok(events.some((e) => e.stage === 'gallerydl'));
      });
    }
  } finally { await srv.close(); }
});

test('install: tries the next gallery-dl source when the first one fails', { skip: !posix }, async () => {
  const srv = await serve({ '/yt': Buffer.from(FAKE_YTDLP), '/gdl': Buffer.from(FAKE_GALLERYDL) });
  try {
    const dir = mkTmp('lg-inst-');
    await withEnv({ PATH: '/nonexistent', LINKGRAB_YTDLP: undefined }, async () => {
      const eng = createEngine({ binDir: path.join(dir, 'bin') });
      const r = await eng.install({ ytdlpUrl: srv.base + '/yt', gallerydlUrl: [srv.base + '/404', srv.base + '/gdl'], allowHttp: true });
      assert.equal(r.ok, true, r.error);
      assert.doesNotMatch(r.note || '', /gallery-dl/);
      assert.equal((await eng.status()).gallerydl.version, '1.32.17');
    });
  } finally { await srv.close(); }
});

test('install: gallery-dl is added to an existing v1.0 setup (yt-dlp already present)', { skip: !posix }, async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Length': FAKE_GALLERYDL.length }); res.end(FAKE_GALLERYDL); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = mkTmp('lg-inst-');
    const binDir = path.join(dir, 'bin');
    writeExe(path.join(binDir, 'yt-dlp'), FAKE_YTDLP);
    writeExe(path.join(binDir, 'ffmpeg'), FAKE_FFMPEG);
    await withEnv({ PATH: '/nonexistent', LINKGRAB_YTDLP: undefined, LINKGRAB_FFMPEG: undefined }, async () => {
      const eng = createEngine({ binDir });
      const r = await eng.install({ gallerydlUrl: `http://127.0.0.1:${srv.address().port}/g`, allowHttp: true });
      assert.deepEqual(r, { ok: true });
      assert.equal(hits, 1);
      assert.equal((await eng.status()).gallerydl.installed, true);
      assert.deepEqual(await eng.install({ gallerydlUrl: `http://127.0.0.1:${srv.address().port}/g`, allowHttp: true }), { ok: true });
      assert.equal(hits, 1); // second install is a no-op
    });
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test('install (windows layout) names the binary gallery-dl.exe; darwin skips gallery-dl with a note', { skip: !posix }, async () => {
  const srv = await serve({ '/yt': Buffer.from(FAKE_YTDLP), '/gdl': Buffer.from(FAKE_GALLERYDL) });
  try {
    await withEnv({ PATH: '/nonexistent', LINKGRAB_YTDLP: undefined, LINKGRAB_FFMPEG: undefined }, async () => {
      const dir = mkTmp('lg-inst-');
      const mac = createEngine({ binDir: path.join(dir, 'mac'), platform: 'darwin' });
      const r = await mac.install({ ytdlpUrl: srv.base + '/yt', gallerydlUrl: srv.base + '/gdl', allowHttp: true });
      assert.equal(r.ok, true, r.error);
      assert.match(r.note, /brew install gallery-dl/);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'mac')), ['yt-dlp']); // never downloaded on darwin
      const arm = createEngine({ binDir: path.join(dir, 'arm'), platform: 'linux', arch: 'arm64' });
      const r2 = await arm.install({ ytdlpUrl: srv.base + '/yt', gallerydlUrl: srv.base + '/gdl', allowHttp: true });
      assert.equal(r2.ok, true, r2.error);
      assert.match(r2.note, /pip install gallery-dl/);
    });
  } finally { await srv.close(); }
});

test('update refreshes a LinkGrab-installed gallery-dl and leaves a user-managed one alone', { skip: !posix }, async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Length': FAKE_GALLERYDL_NEW.length }); res.end(FAKE_GALLERYDL_NEW); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ov = { gallerydlUrl: `http://127.0.0.1:${srv.address().port}/g`, allowHttp: true };
  try {
    const dir = mkTmp('lg-upd-');
    const binDir = path.join(dir, 'bin');
    writeExe(path.join(binDir, 'yt-dlp'), FAKE_YTDLP);
    writeExe(path.join(binDir, 'gallery-dl'), FAKE_GALLERYDL);
    const events = [];
    await withEnv({ PATH: '/nonexistent', LINKGRAB_YTDLP: undefined, LINKGRAB_GALLERYDL: undefined }, async () => {
      const eng = createEngine({ binDir, onProgress: (p) => events.push(p) });
      assert.equal((await eng.status()).gallerydl.version, '1.32.17');
      const r = await eng.update(ov);
      assert.deepEqual(r, { ok: true, version: '2026.01.02', gallerydlVersion: '1.40.2' });
      assert.equal(hits, 1);
      assert.ok(events.some((e) => e.stage === 'gallerydl' && e.percent === 100));
      assert.deepEqual(fs.readdirSync(binDir).sort(), ['gallery-dl', 'yt-dlp']);
      // user-managed copy (env override): not touched, no download
      const mine = path.join(dir, 'mine', 'gallery-dl');
      writeExe(mine, FAKE_GALLERYDL);
      process.env.LINKGRAB_GALLERYDL = mine;
      const r2 = await eng.update(ov);
      assert.equal(r2.ok, true);
      assert.equal(r2.gallerydlVersion, '1.32.17');
      assert.equal(hits, 1);
      assert.equal(fs.readFileSync(mine, 'utf8'), FAKE_GALLERYDL);
      // a failing refresh keeps the old binary and does not fail the yt-dlp update
      delete process.env.LINKGRAB_GALLERYDL;
      const r3 = await eng.update({ gallerydlUrl: 'http://127.0.0.1:1/never', gallerydlApi: null, allowHttp: true });
      assert.equal(r3.ok, true);
      assert.match(r3.note, /gallery-dl/);
      assert.equal(r3.version, '2026.01.02');
      assert.equal(r3.gallerydlVersion, '1.40.2');
    });
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test('pickGallerydlAsset chooses the right standalone asset per platform', () => {
  const dl = (n) => ({ name: n, browser_download_url: 'https://github.com/mikf/gallery-dl/releases/download/v9/' + n });
  const assets = [dl('gallery-dl-9.0.0.tar.gz'), dl('gallery-dl.bin'), dl('gallery-dl.exe'), dl('gallery-dl_x86.exe')];
  assert.equal(pickGallerydlAsset(assets, { platform: 'win32', arch: 'x64' }), assets[2].browser_download_url);
  assert.equal(pickGallerydlAsset(assets, { platform: 'linux', arch: 'x64' }), assets[1].browser_download_url);
  assert.equal(pickGallerydlAsset([dl('gallery-dl_x86.exe'), dl('gallery-dl_windows.exe')], { platform: 'win32', arch: 'ia32' }), dl('gallery-dl_x86.exe').browser_download_url);
  assert.equal(pickGallerydlAsset([dl('gallery-dl_windows.exe')], { platform: 'win32', arch: 'x64' }), dl('gallery-dl_windows.exe').browser_download_url);
  assert.equal(pickGallerydlAsset([dl('gallery-dl_linux')], { platform: 'linux', arch: 'x64' }), dl('gallery-dl_linux').browser_download_url);
  // nothing usable, darwin, bad input, and non-github hosts are never returned
  assert.equal(pickGallerydlAsset([dl('gallery-dl-9.zip')], { platform: 'win32' }), null);
  assert.equal(pickGallerydlAsset(assets, { platform: 'darwin' }), null);
  assert.equal(pickGallerydlAsset(null, { platform: 'win32' }), null);
  assert.equal(pickGallerydlAsset([], { platform: 'linux' }), null);
  assert.equal(pickGallerydlAsset([{ name: 'gallery-dl.exe', browser_download_url: 'https://evil.example/gallery-dl.exe' }], { platform: 'win32' }), null);
  assert.equal(pickGallerydlAsset([{ name: 'gallery-dl.exe', browser_download_url: 'http://github.com/x/gallery-dl.exe' }], { platform: 'win32' }), null);
});
