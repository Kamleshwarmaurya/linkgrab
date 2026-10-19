'use strict';
// Unit tests for src/main/gallerydl.js: parsing, layout planning, argument building, error mapping and the
// runner's event/result handling (driven by a tiny fake `gallery-dl` script, so no network and no Python needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const g = require('../src/main/gallerydl');
const { mkTmp } = require('./_helpers');

const WIN_BAD = /[<>:"|?*\\\x00-\x1f]|[. ]$/;

function dumpOf(files, dir) {
  const arr = [[2, dir || { tweet_id: 111 }]];
  for (const f of files) arr.push([3, f.url, f.meta]);
  return JSON.stringify(arr);
}
function tw(num, ext, extra) {
  return {
    url: `https://pbs.twimg.com/media/img${num}.${ext}`,
    meta: Object.assign({
      tweet_id: 1234567890123, num, count: 4, extension: ext, content: 'Look at these\nline two',
      author: { name: 'jack', nick: 'Jack D' },
    }, extra || {}),
  };
}

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

test('parseTarget: http(s) only, optional generic: prefix, no credentials', () => {
  assert.deepEqual(g.parseTarget('https://x.com/a/status/1').arg, 'https://x.com/a/status/1');
  const p = g.parseTarget('generic:http://127.0.0.1/gallery.html');
  assert.equal(p.ok, true);
  assert.equal(p.prefixed, true);
  assert.equal(p.arg, 'generic:http://127.0.0.1/gallery.html');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', '--exec=calc', 'ftp://x/y', 'https://u:p@x.com/a', '', null, 'generic:file:///x']) {
    assert.equal(g.parseTarget(bad).ok, false, String(bad));
  }
});

test('parseLine only trusts LGF|/LGS| lines', () => {
  assert.deepEqual(g.parseLine('LGF|/tmp/a b/01.jpg'), { type: 'done', path: '/tmp/a b/01.jpg', skipped: false });
  assert.deepEqual(g.parseLine('LGS|C:\\dl\\X 1\\01.jpg\r'), { type: 'done', path: 'C:\\dl\\X 1\\01.jpg', skipped: true });
  assert.equal(g.parseLine('/tmp/a/01.jpg'), null);
  assert.equal(g.parseLine('# /tmp/a/01.jpg'), null);
  assert.equal(g.parseLine('LGF|'), null);
  assert.equal(g.parseLine(null), null);
});

test('parseDump: files, directory, queue entries and errors', () => {
  const d = g.parseDump(JSON.stringify([
    [2, { a: 1 }],
    [3, 'https://x/1.jpg', { extension: 'JPG', num: 1 }],
    [3, 'https://x/2.mp4?x=1', { num: 2 }],
    [6, 'https://child', {}],
    [-1, { error: 'HttpError', message: "'404 Not Found'" }],
  ]));
  assert.equal(d.ok, true);
  assert.equal(d.files.length, 2);
  assert.equal(d.files[0].ext, 'jpg');
  assert.equal(d.files[1].ext, 'mp4'); // from the URL path when the metadata has no extension
  assert.equal(d.queued, 1);
  assert.deepEqual(d.errors, ["HttpError: '404 Not Found'"]);
  assert.equal(g.parseDump('not json').ok, false);
  assert.equal(g.parseDump('').files.length, 0);
});

test('infoFromDump: image, mixed and video posts', () => {
  const imgs = g.parseDump(dumpOf([tw(1, 'jpg'), tw(2, 'png'), tw(3, 'jpg')]));
  const a = g.infoFromDump(imgs, { site: 'x', url: 'https://x.com/jack/status/1' });
  assert.equal(a.kind, 'image');
  assert.equal(a.imageCount, 3);
  assert.equal(a.videoCount, 0);
  assert.equal(a.engine, 'gallery-dl');
  assert.deepEqual(a.qualities, [{ key: 'images', label: 'Images (3)' }]);
  assert.equal(a.title, 'Look at these');
  assert.equal(a.uploader, 'Jack D');
  assert.equal(a.thumbnails.length, 3);
  assert.equal(a.thumbnail, a.thumbnails[0]);

  const m = g.infoFromDump(g.parseDump(dumpOf([tw(1, 'jpg'), tw(2, 'mp4'), tw(3, 'jpg'), tw(4, 'htm')])), { site: 'x', url: 'https://x.com/a/status/1' });
  assert.equal(m.kind, 'mixed');
  assert.equal(m.imageCount, 2);
  assert.equal(m.videoCount, 1);
  assert.equal(m.fileCount, 3); // the .htm card page is not media
  assert.deepEqual(m.qualities.map((q) => q.key), ['media', 'images']);
  assert.equal(m.qualities[0].label, 'Everything (3 files)');
  assert.equal(m.qualities[1].label, 'Images only (2)');

  const v = g.infoFromDump(g.parseDump(dumpOf([tw(1, 'mp4')])), { site: 'x', url: 'https://x.com/a/status/1' });
  assert.equal(v.kind, 'video');
  assert.equal(v.imageCount, 0);

  const many = g.infoFromDump(g.parseDump(dumpOf(Array.from({ length: 9 }, (_, i) => tw(i + 1, 'jpg')))), { site: 'x', url: 'u' });
  assert.equal(many.thumbnails.length, 6);
});

test('planDownload: exactly one file lands flat as "<Site> <postid>.<ext>"', () => {
  const dump = g.parseDump(dumpOf([tw(1, 'jpg')]));
  const out = path.join('/tmp', 'dl');
  const plan = g.planDownload({ files: dump.files, site: 'x', url: 'https://x.com/a/status/1234567890123', quality: 'images', outDir: out });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'single');
  assert.equal(plan.total, 1);
  assert.equal(plan.dir, out);
  assert.equal(plan.folder, out);
  assert.equal(plan.format, 'X 1234567890123.{extension}');
  assert.deepEqual(plan.expected, [path.join(out, 'X 1234567890123.jpg')]);
});

test('planDownload: more than one file go to a subfolder as 01.ext, 02.ext ...', () => {
  const dump = g.parseDump(dumpOf([tw(1, 'jpg'), tw(2, 'png'), tw(3, 'jpg')]));
  const out = path.join('/tmp', 'dl');
  const plan = g.planDownload({ files: dump.files, site: 'instagram', url: 'https://www.instagram.com/p/x/', quality: 'images', outDir: out });
  assert.equal(plan.mode, 'folder');
  assert.equal(plan.total, 3);
  assert.equal(plan.folder, path.join(out, 'Instagram 1234567890123'));
  assert.equal(plan.format, '{num:02}.{extension}');
  assert.deepEqual(plan.expected.map((p) => path.basename(p)), ['01.jpg', '02.png', '03.jpg']);
});

test('planDownload: images-only on a mixed post renumbers without gaps', () => {
  const dump = g.parseDump(dumpOf([tw(1, 'jpg'), tw(2, 'mp4'), tw(3, 'png')]));
  const imagesOnly = g.planDownload({ files: dump.files, site: 'x', url: 'u', quality: 'images', outDir: '/tmp/dl' });
  assert.equal(imagesOnly.total, 2);
  assert.deepEqual(imagesOnly.expected.map((p) => path.basename(p)), ['01.jpg', '02.png']);
  assert.match(imagesOnly.format, /^\\fE /);
  assert.ok(imagesOnly.format.includes('{1:1,3:2}'), imagesOnly.format);
  const media = g.planDownload({ files: dump.files, site: 'x', url: 'u', quality: 'media', outDir: '/tmp/dl' });
  assert.equal(media.total, 3);
  assert.deepEqual(media.expected.map((p) => path.basename(p)), ['01.jpg', '02.mp4', '03.png']);
  assert.equal(media.format, '{num:02}.{extension}');
});

test('planDownload: several posts (profile link) are keyed by post id and named after the user', () => {
  const files = [tw(1, 'jpg', { tweet_id: 11 }), tw(1, 'jpg', { tweet_id: 12 }), tw(2, 'jpg', { tweet_id: 12 })];
  const plan = g.planDownload({ files: g.parseDump(dumpOf(files)).files, site: 'x', url: 'u', quality: 'media', outDir: '/tmp/dl' });
  assert.equal(plan.mode, 'folder');
  assert.equal(path.basename(plan.folder), 'X jack');
  assert.ok(plan.format.includes("'11:1':1") && plan.format.includes("'12:2':3"), plan.format);
  assert.ok(plan.format.includes('(tweet_id, num)'));
});

test('planDownload: ids are sanitised (no braces, slashes, dots or reserved characters) and are Windows-safe', () => {
  const evil = tw(1, 'jpg', { tweet_id: '..\\..\\{num}%(x)s:*?"<>|' });
  const evil2 = tw(2, 'jpg', { tweet_id: '..\\..\\{num}%(x)s:*?"<>|' });
  const plan = g.planDownload({ files: g.parseDump(dumpOf([evil, evil2])).files, site: 'x', url: 'u', quality: 'media', outDir: '/tmp/dl' });
  const folderName = path.basename(plan.folder);
  assert.ok(!WIN_BAD.test(folderName), folderName);
  assert.ok(!/[{}%]/.test(folderName), folderName);
  const single = g.planDownload({ files: g.parseDump(dumpOf([evil])).files, site: 'x', url: 'u', quality: 'media', outDir: '/tmp/dl' });
  assert.ok(!/[{}%\\/]/.test(single.format.replace('{extension}', '')), single.format);
  assert.ok(!WIN_BAD.test(path.basename(single.expected[0])), single.expected[0]);
});

test('planDownload: no id/user falls back to a stable hash; empty selection is an error', () => {
  const noMeta = [{ url: 'http://a/x.jpg', ext: 'jpg', meta: { num: 1 } }];
  const p1 = g.planDownload({ files: noMeta, site: 'test', url: 'http://h/gallery.html', quality: 'images', outDir: '/tmp/dl' });
  const p2 = g.planDownload({ files: noMeta, site: 'test', url: 'http://h/gallery.html', quality: 'images', outDir: '/tmp/dl' });
  assert.match(path.basename(p1.expected[0]), /^Test [0-9a-f]{8}\.jpg$/);
  assert.equal(p1.expected[0], p2.expected[0]);
  const none = g.planDownload({ files: g.parseDump(dumpOf([tw(1, 'mp4')])).files, site: 'x', url: 'u', quality: 'images', outDir: '/tmp/dl' });
  assert.equal(none.ok, false);
  assert.match(none.error, /No images/);
});

test('buildDownloadArgs: array only, deterministic flags, URL last after --', () => {
  const plan = { dir: '/tmp/dl/X 1', format: '{num:02}.{extension}' };
  const a = g.buildDownloadArgs({ arg: 'https://x.com/a/status/1', plan, quality: 'images', limitRate: '2M', cookiesFrom: 'firefox' });
  assert.ok(a.includes('--config-ignore'));
  assert.ok(a.includes('--no-input'));
  assert.ok(a.includes('--windows-filenames'));
  assert.ok(!a.includes('--no-skip'));
  assert.equal(a[a.indexOf('-D') + 1], '/tmp/dl/X 1');
  assert.equal(a[a.indexOf('-f') + 1], '{num:02}.{extension}');
  assert.equal(a[a.indexOf('--limit-rate') + 1], '2M');
  assert.equal(a[a.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.ok(a.includes('after:LGF|{_path}') && a.includes('skip:LGS|{_path}'));
  assert.equal(a[a.length - 2], '--');
  assert.equal(a[a.length - 1], 'https://x.com/a/status/1');
  const filter = a[a.indexOf('--filter') + 1];
  assert.ok(filter.includes("'jpg'") && !filter.includes("'mp4'"), filter);
  const media = g.buildDownloadArgs({ arg: 'u', plan, quality: 'media' });
  assert.ok(media[media.indexOf('--filter') + 1].includes("'mp4'"));
});

test('buildDownloadArgs: cookies and rate limit from outside are sanitised, nothing else comes from the caller', () => {
  const a = g.buildDownloadArgs({ arg: 'https://x.com/a', plan: { dir: '/d', format: 'f' }, quality: 'images', limitRate: '1M --exec calc', cookiesFrom: 'chrome --exec calc' });
  assert.ok(!a.includes('--limit-rate'));
  assert.ok(!a.includes('--cookies-from-browser'));
  assert.ok(!a.some((x) => /calc/.test(x)));
  const info = g.buildInfoArgs({ arg: 'https://x.com/a', cookiesFrom: 'edge' });
  assert.ok(info.includes('-j'));
  assert.ok(!info.includes('-J'));
  assert.equal(info[info.indexOf('--cookies-from-browser') + 1], 'edge');
  assert.equal(info[info.length - 2], '--');
  assert.ok(g.buildInfoArgs({ arg: 'u', resolve: true }).includes('-J'));
});

test('friendlyError: login, auth, rate limit, private, deleted, unsupported, network, NSFW', () => {
  const x = { site: 'x' };
  assert.match(g.friendlyError('[twitter][error] AuthRequired: Login required', x), /Use browser cookies/);
  assert.match(g.friendlyError("[instagram][error] HttpError: '401 Unauthorized' for 'https://i.instagram.com/api'", { site: 'instagram' }), /Instagram post needs you to be signed in.*Use browser cookies/);
  assert.match(g.friendlyError("HttpError: '403 Forbidden' for 'https://x'", x), /signed in/);
  assert.match(g.friendlyError('[twitter][error] AuthorizationError: NSFW Tweet', x), /age-restricted|sensitive/);
  assert.match(g.friendlyError("[twitter][error] HttpError: '429 Too Many Requests'", x), /rate-limiting/);
  assert.match(g.friendlyError('[instagram][error] Please wait a few minutes before you try again', { site: 'instagram' }), /rate-limiting/);
  assert.match(g.friendlyError("[twitter][error] AuthorizationError: User '@x' protected", x), /private or protected/);
  assert.match(g.friendlyError("[twitter][error] NotFoundError: Requested tweet does not exist", { site: 'x', cookiesFrom: 'chrome' }), /not available/);
  assert.match(g.friendlyError("HttpError: '404 Not Found' for 'http://h/x'"), /not available/);
  assert.match(g.friendlyError("[gallery-dl][error] Unsupported URL 'https://x.com/home'", x), /does not point to a post/);
  assert.match(g.friendlyError('[generic][error] HttpError: NewConnectionError: Failed to establish a new connection'), /Network/);
  assert.match(g.friendlyError('OSError: [Errno 28] No space left on device'), /disk is full/);
  assert.match(g.friendlyError('PermissionError: [Errno 13] Permission denied'), /not allowed to write/);
  assert.match(g.friendlyError('could not find chrome cookies database', x), /could not read cookies/);
  assert.equal(g.friendlyError('[x][error] something odd'), 'Download failed: something odd');
  assert.equal(g.friendlyError(''), 'Download failed for an unknown reason.');
  // with cookies already on, the advice changes instead of repeating "turn them on"
  assert.doesNotMatch(g.friendlyError('Login required', { site: 'x', cookiesFrom: 'chrome' }), /turn on/);
});

// ------------------------------------------------------------------ runner with a fake gallery-dl

/**
 * A fake gallery-dl: `-j` prints FAKE_DUMP (a file path), anything else "downloads" the files listed by the dump
 * into -D (names from the plan are ignored: it just uses 01.ext...), printing the LGF lines. Behaviour switches:
 * FAKE_EXIT (exit code at the end), FAKE_FAIL_AT (1-based file that is not produced), FAKE_SLEEP_MS (per file).
 */
function writeFakeBinary(dir) {
  const file = path.join(dir, 'fake-gallery-dl');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_LOG) fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + '\\n');
if (args.includes('-j') || args.includes('-J')) {
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n');
  process.stdout.write(fs.readFileSync(process.env.FAKE_DUMP, 'utf8'));
  process.exit(0);
}
const dir = args[args.indexOf('-D') + 1];
const dump = JSON.parse(fs.readFileSync(process.env.FAKE_DUMP, 'utf8'));
const files = dump.filter((e) => e[0] === 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const f of files) {
    i++;
    if (process.env.FAKE_FAIL_AT && Number(process.env.FAKE_FAIL_AT) === i) continue;
    await sleep(Number(process.env.FAKE_SLEEP_MS || 0));
    const name = (files.length === 1 ? 'one.' : String(i).padStart(2, '0') + '.') + f[2].extension;
    const p = path.join(dir, name);
    const existed = fs.existsSync(p);
    if (!existed) fs.writeFileSync(p, Buffer.alloc(1000 * i, 1));
    process.stdout.write((existed ? 'LGS|' : 'LGF|') + p + '\\n');
    process.stdout.write((existed ? '# ' : '') + p + '\\n');
  }
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n');
  process.exit(Number(process.env.FAKE_EXIT || 0));
})();
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function setupFake(files, extraEnv) {
  const dir = mkTmp('lg-fakegal-');
  const bin = writeFakeBinary(dir);
  const dump = path.join(dir, 'dump.json');
  fs.writeFileSync(dump, dumpOf(files));
  const runner = g.createGalleryRunner({
    getBinary: () => bin,
    getFfmpeg: () => null,
    env: Object.assign({ FAKE_DUMP: dump, FAKE_ARGS_LOG: path.join(dir, 'args.log') }, extraEnv || {}),
  });
  return { dir, runner, argsLog: path.join(dir, 'args.log'), out: path.join(dir, 'dl') };
}

test('runner (fake binary): 3 images -> subfolder, progress + files events, result shape', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'png'), tw(3, 'jpg')]);
  const events = [];
  const h = f.runner.download({ url: 'https://x.com/jack/status/1234567890123', quality: 'images', outDir: f.out, site: 'x', cookiesFrom: 'firefox', limitRate: '1M' }, (e) => events.push(e));
  const res = await h.done;
  assert.equal(res.code, 0, res.error);
  assert.equal(res.error, null);
  assert.equal(res.killed, false);
  assert.equal(res.fileCount, 3);
  assert.equal(res.folder, path.join(f.out, 'X 1234567890123'));
  assert.deepEqual(res.files.map((p) => path.basename(p)), ['01.jpg', '02.png', '03.jpg']);
  assert.equal(res.filePath, res.files[0]);
  const filesEvs = events.filter((e) => e.type === 'files');
  assert.equal(filesEvs.length, 3);
  assert.deepEqual(filesEvs.map((e) => e.files.length), [1, 2, 3]);
  assert.ok(filesEvs.every((e) => e.folder === res.folder && e.fileCount === 3));
  const prog = events.filter((e) => e.type === 'progress');
  assert.ok(prog.length >= 3);
  for (const p of prog) {
    assert.ok(p.percent >= 0 && p.percent <= 100);
    assert.ok(Number.isFinite(p.downloaded));
    for (const k of ['size', 'speed', 'eta']) assert.ok(k in p, k);
  }
  const pct = prog.map((p) => p.percent);
  assert.deepEqual(pct, pct.slice().sort((a, b) => a - b), 'percent never goes down');
  assert.equal(pct[pct.length - 1], 100);
  const dl = prog.map((p) => p.downloaded);
  assert.deepEqual(dl, dl.slice().sort((a, b) => a - b), 'downloaded never goes down');
  // arguments that reached the process
  const argv = fs.readFileSync(f.argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(argv.length >= 2); // listing + download
  const dlArgs = argv[argv.length - 1];
  assert.equal(dlArgs[dlArgs.length - 1], 'https://x.com/jack/status/1234567890123');
  assert.equal(dlArgs[dlArgs.length - 2], '--');
  assert.equal(dlArgs[dlArgs.indexOf('--cookies-from-browser') + 1], 'firefox');
  assert.equal(dlArgs[dlArgs.indexOf('-D') + 1], res.folder);
});

test('runner (fake binary): exactly one file goes directly into the download dir', async () => {
  const f = setupFake([tw(1, 'jpg')]);
  const events = [];
  const res = await f.runner.download({ url: 'https://x.com/jack/status/1234567890123', quality: 'images', outDir: f.out, site: 'x' }, (e) => events.push(e)).done;
  assert.equal(res.code, 0, res.error);
  assert.equal(res.folder, f.out);
  assert.equal(res.files.length, 1);
  assert.equal(path.dirname(res.files[0]), f.out);
  const argv = fs.readFileSync(f.argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const dlArgs = argv[argv.length - 1];
  assert.equal(dlArgs[dlArgs.indexOf('-f') + 1], 'X 1234567890123.{extension}');
});

test('runner (fake binary): re-running reports already present files (resume skips them)', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'jpg')]);
  const first = await f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' }).done;
  assert.equal(first.code, 0);
  const events = [];
  const second = await f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' }, (e) => events.push(e)).done;
  assert.equal(second.code, 0);
  assert.deepEqual(second.files, first.files);
  assert.equal(events.filter((e) => e.type === 'files').length, 2);
});

test('runner (fake binary): partial failure keeps the finished files and says how many', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'jpg'), tw(3, 'jpg')], { FAKE_FAIL_AT: '2', FAKE_EXIT: '4', FAKE_STDERR: "[downloader.http][warning] '429 Too Many Requests' for 'https://pbs.twimg.com/x'" });
  const res = await f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' }).done;
  assert.equal(res.code, 4);
  assert.equal(res.files.length, 2);
  assert.match(res.error, /^Only 2 of 3 files could be downloaded\./);
  assert.match(res.error, /rate-limiting/);
  assert.equal(res.fileCount, 3);
});

test('runner (fake binary): exit 0 without any file is an error, not a silent success', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'jpg')], { FAKE_FAIL_AT: '1' });
  fs.writeFileSync(path.join(f.dir, 'dump.json'), dumpOf([tw(1, 'jpg')]));
  const res = await f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' }).done;
  assert.notEqual(res.code, 0);
  assert.match(res.error, /No downloadable/);
});

test('runner (fake binary): kill() stops the process, result is killed with the files done so far', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'jpg'), tw(3, 'jpg'), tw(4, 'jpg')], { FAKE_SLEEP_MS: '700' });
  let seen = 0;
  let h;
  h = f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' }, (e) => {
    if (e.type === 'files') seen = e.files.length;
  });
  const t0 = Date.now();
  while (seen < 1 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 30));
  assert.ok(seen >= 1);
  await h.kill();
  const res = await h.done;
  assert.equal(res.killed, true);
  assert.equal(res.error, null);
  assert.ok(res.files.length >= 1 && res.files.length < 4, String(res.files.length));
});

test('runner (fake binary): kill() while the file listing is still running resolves killed', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'jpg')]);
  const h = f.runner.download({ url: 'https://x.com/jack/status/1', quality: 'images', outDir: f.out, site: 'x' });
  await h.kill();
  const res = await h.done;
  assert.equal(res.killed, true);
  assert.equal(res.error, null);
});

test('runner (fake binary): getInfo parses -j, and an error dump maps to a friendly message', async () => {
  const f = setupFake([tw(1, 'jpg'), tw(2, 'mp4')]);
  const r = await f.runner.getInfo('https://x.com/jack/status/1', { site: 'x', cookiesFrom: 'edge' });
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'mixed');
  assert.equal(r.info.site, 'x');
  const argv = fs.readFileSync(f.argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(argv[0].includes('-j'));
  assert.equal(argv[0][argv[0].indexOf('--cookies-from-browser') + 1], 'edge');

  fs.writeFileSync(path.join(f.dir, 'dump.json'), JSON.stringify([[-1, { error: 'AuthRequired', message: 'Login required' }]]));
  const bad = await f.runner.getInfo('https://x.com/jack/status/1', { site: 'x' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Use browser cookies/);

  fs.writeFileSync(path.join(f.dir, 'dump.json'), JSON.stringify([[2, {}]]));
  const none = await f.runner.getInfo('https://x.com/jack/status/1', { site: 'x' });
  assert.equal(none.ok, false);
  assert.match(none.error, /No images or videos/);
  assert.equal(none.noMedia, true);
});

test('runner: missing binary gives the contract message (download and getInfo)', async () => {
  const r = g.createGalleryRunner({ getBinary: () => null });
  const h = r.download({ url: 'https://x.com/a/status/1', quality: 'images', outDir: '/tmp/x' }, () => {});
  const res = await h.done;
  assert.equal(res.error, 'The image engine (gallery-dl) is not installed. Use the engine setup banner to install it.');
  assert.equal(res.code, -1);
  assert.deepEqual(res.files, []);
  await h.kill();
  const info = await r.getInfo('https://x.com/a/status/1');
  assert.equal(info.ok, false);
  assert.equal(info.error, g.MISSING_MESSAGE);
  assert.equal(info.missing, true);
  // binary configured but gone from disk
  const r2 = g.createGalleryRunner({ getBinary: () => path.join(mkTmp('lg-none-'), 'nope') });
  assert.equal((await r2.download({ url: 'https://x.com/a/status/1', quality: 'images', outDir: mkTmp('lg-o-') }).done).error, g.MISSING_MESSAGE);
});

test('runner: invalid URLs are rejected without spawning anything', async () => {
  const r = g.createGalleryRunner({ getBinary: () => '/definitely/not/run' });
  const res = await r.download({ url: 'file:///etc/passwd', quality: 'images', outDir: '/tmp/x' }).done;
  assert.match(res.error, /not a valid http/);
  assert.equal((await r.getInfo('ftp://x/y')).ok, false);
});
