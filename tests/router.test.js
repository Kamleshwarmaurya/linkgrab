'use strict';
// Router tests with fake runners: every merge combination of yt-dlp and gallery-dl results, plus download routing.
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../src/main/ytdlp');
const gal = require('../src/main/gallerydl');
const { createRouter, galleryTargetFor, NEEDS_IMAGE_ENGINE, NO_IMAGES_FOR_SITE } = require('../src/main/router');

const X_URL = 'https://x.com/jack/status/1234567890123';
const IG_URL = 'https://www.instagram.com/p/CxYz123/';
const YT_URL = 'https://www.youtube.com/watch?v=abc';
const TEST_SITE = (url) => (/youtube/.test(url) ? 'youtube' : /x\.com|twitter/.test(url) ? 'x' : /instagram/.test(url) ? 'instagram' : /127\.0\.0\.1|localhost/.test(url) ? 'test' : null);

const VIDEO_QUALITIES = y.bucketQualities([1080, 720, 360]);

function ytInfo(over) {
  return { ok: true, info: Object.assign({ title: 'Video title', thumbnail: 'https://t/v.jpg', duration: 12, uploader: 'jack', site: 'x', qualities: VIDEO_QUALITIES }, over || {}) };
}
function gInfo(images, videos, over) {
  const thumbs = Array.from({ length: images }, (_, i) => `https://img/${i + 1}.jpg`).slice(0, 6);
  return {
    ok: true,
    info: Object.assign({
      title: 'Post text', thumbnail: thumbs[0] || '', thumbnails: thumbs, duration: 0, uploader: 'Jack D', site: 'x',
      kind: images && videos ? 'mixed' : images ? 'image' : 'video', imageCount: images, videoCount: videos,
      fileCount: images + videos, engine: 'gallery-dl', qualities: gal.qualitiesFor(images, videos),
    }, over || {}),
  };
}
const fail = (error, extra) => Object.assign({ ok: false, error }, extra || {});
const NO_VIDEO = y.friendlyError('ERROR: [twitter] 123: No video could be found in this tweet', { site: 'x' });
const IG_NO_VIDEO = y.friendlyError('ERROR: [Instagram] CxYz: There is no video in this post', { site: 'instagram' });
const X_LOGIN = y.friendlyError('ERROR: [twitter] 123: NSFW tweet requires authentication', { site: 'x' });
const G_LOGIN = gal.friendlyError('[twitter][error] AuthRequired: Login required', { site: 'x' });
const G_MISSING = fail(gal.MISSING_MESSAGE, { missing: true });
const Y_MISSING = fail('yt-dlp is not installed. Use the engine setup banner to install it.');

function fakes(yRes, gRes) {
  const calls = { y: [], g: [] };
  const mk = (res, list) => ({
    getInfo(url, opts) { list.push({ url, opts }); return typeof res === 'function' ? res(url, opts) : Promise.resolve(res); },
    download() { throw new Error('unused'); },
  });
  return { calls, ytdlp: mk(yRes, calls.y), gallery: mk(gRes, calls.g) };
}
function routerFor(yRes, gRes) {
  const f = fakes(yRes, gRes);
  return Object.assign(f, { router: createRouter({ ytdlp: f.ytdlp, gallery: f.gallery, getSiteOf: TEST_SITE }) });
}

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

test('ytdlp.js: images/media are valid keys but invalid for yt-dlp itself', () => {
  assert.equal(y.isValidQuality('images'), true);
  assert.equal(y.isValidQuality('media'), true);
  assert.equal(y.isValidQuality('best'), true);
  assert.equal(y.isValidQuality('4k'), false);
  for (const q of ['images', 'media']) {
    const a = y.buildDownloadArgs({ url: 'https://x.com/a/status/1', quality: q, outDir: '/tmp/dl' });
    assert.equal(a[a.indexOf('-f') + 1], 'bv*+ba/b', q);
    assert.ok(!a.includes('-x'));
    assert.equal(y.formatSelector(q), 'bv*+ba/b');
  }
});

test('ytdlp.friendlyError: X / Instagram login hints and the stable no-video sentence', () => {
  assert.match(X_LOGIN, /X post needs you to be signed in.*Use browser cookies/);
  assert.match(y.friendlyError('ERROR: [Instagram] a: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser', { site: 'instagram' }), /Instagram post.*Use browser cookies/);
  assert.match(y.friendlyError('ERROR: login required', { site: 'instagram', cookiesFrom: 'chrome' }), /logged in to Instagram in the browser/);
  assert.equal(NO_VIDEO, y.NO_VIDEO_MESSAGE);
  assert.equal(IG_NO_VIDEO, y.NO_VIDEO_MESSAGE);
  assert.equal(y.isNoVideoMessage(NO_VIDEO), true);
  assert.equal(y.isNoVideoMessage(X_LOGIN), false);
  // other sites keep the old wording
  assert.match(y.friendlyError('ERROR: Sign in to confirm', { site: 'youtube' }), /This video needs you to be signed in/);
});

test('non X/Instagram sites go straight to yt-dlp and the result is returned unchanged', async () => {
  const yRes = ytInfo({ site: 'youtube' });
  const t = routerFor(yRes, gInfo(3, 0));
  const r = await t.router.getInfo(YT_URL, { cookiesFrom: 'chrome' });
  assert.equal(r, yRes);
  assert.equal(t.calls.g.length, 0);
  assert.deepEqual(t.calls.y[0].opts, { cookiesFrom: 'chrome' });
  const t2 = routerFor(fail('Video unavailable'), gInfo(3, 0));
  assert.deepEqual(await t2.router.getInfo(YT_URL), fail('Video unavailable'));
  assert.equal(t2.calls.g.length, 0);
});

test('both ok with video and images -> mixed (engine both, merged qualities, thumbnails)', async () => {
  const t = routerFor(ytInfo(), gInfo(3, 1));
  const r = await t.router.getInfo(X_URL, { cookiesFrom: 'firefox' });
  assert.equal(r.ok, true);
  const i = r.info;
  assert.equal(i.kind, 'mixed');
  assert.equal(i.engine, 'both');
  assert.equal(i.imageCount, 3);
  assert.equal(i.videoCount, 1);
  assert.equal(i.fileCount, 4);
  assert.equal(i.title, 'Video title');
  assert.equal(i.duration, 12);
  assert.equal(i.thumbnail, 'https://t/v.jpg');
  assert.deepEqual(i.thumbnails, ['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg', 'https://t/v.jpg']);
  assert.deepEqual(i.qualities.slice(0, 2), [{ key: 'media', label: 'Everything (4 files)' }, { key: 'images', label: 'Images only (3)' }]);
  assert.deepEqual(i.qualities.slice(2), VIDEO_QUALITIES);
  assert.equal(i.qualities[i.qualities.length - 1].key, 'audio');
  // both engines asked, both with the cookie setting, gallery told the site
  assert.equal(t.calls.y.length, 1);
  assert.equal(t.calls.g.length, 1);
  assert.equal(t.calls.y[0].opts.cookiesFrom, 'firefox');
  assert.equal(t.calls.g[0].opts.cookiesFrom, 'firefox');
  assert.equal(t.calls.g[0].opts.site, 'x');
  assert.equal(t.calls.g[0].url, X_URL);
});

test('thumbnails are capped at 6', async () => {
  const t = routerFor(ytInfo(), gInfo(9, 1));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.info.thumbnails.length, 6);
  assert.equal(r.info.imageCount, 9);
});

test('both ok, no images -> plain video (yt-dlp qualities, engine yt-dlp)', async () => {
  const t = routerFor(ytInfo(), gInfo(0, 1));
  const r = await t.router.getInfo(IG_URL);
  assert.equal(r.info.kind, 'video');
  assert.equal(r.info.engine, 'yt-dlp');
  assert.equal(r.info.videoCount, 1);
  assert.equal(r.info.imageCount, 0);
  assert.deepEqual(r.info.qualities, VIDEO_QUALITIES);
  assert.equal(r.info.needsGallerydl, undefined);
});

test('only yt-dlp ok (gallery-dl failed) -> video post, nothing flagged', async () => {
  const t = routerFor(ytInfo(), fail('Network problem while talking to the site.'));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'video');
  assert.equal(r.info.engine, 'yt-dlp');
  assert.equal(r.info.needsGallerydl, undefined);
  assert.deepEqual(r.info.qualities, VIDEO_QUALITIES);
});

test('gallery-dl missing + video post -> still the yt-dlp result, flagged needsGallerydl', async () => {
  const t = routerFor(ytInfo(), G_MISSING);
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'video');
  assert.equal(r.info.needsGallerydl, true);
  assert.deepEqual(r.info.qualities, VIDEO_QUALITIES);
});

test('gallery runner missing altogether (null) behaves like a missing binary', async () => {
  const router = createRouter({ ytdlp: fakes(ytInfo(), null).ytdlp, gallery: null, getSiteOf: TEST_SITE });
  const r = await router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.needsGallerydl, true);
  const r2 = await createRouter({ ytdlp: fakes(fail(NO_VIDEO), null).ytdlp, gallery: null, getSiteOf: TEST_SITE }).getInfo(X_URL);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, NEEDS_IMAGE_ENGINE);
});

test('yt-dlp "no video" + gallery-dl images -> image post', async () => {
  for (const [url, msg] of [[X_URL, NO_VIDEO], [IG_URL, IG_NO_VIDEO]]) {
    const t = routerFor(fail(msg), gInfo(3, 0, { site: url === X_URL ? 'x' : 'instagram' }));
    const r = await t.router.getInfo(url);
    assert.equal(r.ok, true);
    assert.equal(r.info.kind, 'image');
    assert.equal(r.info.engine, 'gallery-dl');
    assert.equal(r.info.imageCount, 3);
    assert.equal(r.info.videoCount, 0);
    assert.deepEqual(r.info.qualities, [{ key: 'images', label: 'Images (3)' }]);
    assert.equal(r.info.thumbnails.length, 3);
    assert.equal(r.info.thumbnail, 'https://img/1.jpg');
    assert.equal(r.info.title, 'Post text');
  }
});

test('yt-dlp login error + gallery-dl ok -> gallery result wins (single image too)', async () => {
  const t = routerFor(fail(X_LOGIN), gInfo(1, 0));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.info.kind, 'image');
  assert.deepEqual(r.info.qualities, [{ key: 'images', label: 'Images (1)' }]);
});

test('yt-dlp failed but gallery-dl sees images AND videos -> mixed with media/images only', async () => {
  const t = routerFor(fail(X_LOGIN), gInfo(2, 1));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.info.kind, 'mixed');
  assert.equal(r.info.engine, 'gallery-dl');
  assert.deepEqual(r.info.qualities.map((q) => q.key), ['media', 'images']);
  assert.equal(r.info.fileCount, 3);
});

test('yt-dlp failed but gallery-dl sees only videos -> video via gallery-dl', async () => {
  const t = routerFor(fail('Download failed: odd'), gInfo(0, 2));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.info.kind, 'video');
  assert.equal(r.info.engine, 'gallery-dl');
  assert.deepEqual(r.info.qualities.map((q) => q.key), ['media']);
});

test('yt-dlp not installed + gallery-dl ok -> gallery result', async () => {
  const t = routerFor(Y_MISSING, gInfo(2, 0));
  const r = await t.router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'image');
});

test('both fail: sign-in advice beats everything else', async () => {
  let r = await routerFor(fail(X_LOGIN), fail('Download failed: weird')).router.getInfo(X_URL);
  assert.equal(r.ok, false);
  assert.match(r.error, /Use browser cookies/);
  r = await routerFor(fail('Download failed: weird'), fail(G_LOGIN)).router.getInfo(X_URL);
  assert.match(r.error, /Use browser cookies/);
  r = await routerFor(fail(NO_VIDEO), fail(G_LOGIN)).router.getInfo(X_URL);
  assert.equal(r.error, G_LOGIN);
});

test('both fail: no-video + gallery-dl "nothing found" -> the gallery message', async () => {
  const msg = 'No images or videos were found in this post.';
  const r = await routerFor(fail(NO_VIDEO), fail(msg, { noMedia: true })).router.getInfo(X_URL);
  assert.equal(r.ok, false);
  assert.equal(r.error, msg);
});

test('both fail: deleted post / network use the more specific message, not a generic one', async () => {
  const gone = gal.friendlyError("HttpError: '404 Not Found'", { site: 'x', cookiesFrom: 'chrome' });
  let r = await routerFor(fail('Download failed: weird'), fail(gone)).router.getInfo(X_URL);
  assert.equal(r.error, gone);
  r = await routerFor(fail('This video is not available (removed, region-blocked or deleted).'), fail('Download failed: x')).router.getInfo(X_URL);
  assert.match(r.error, /not available/);
});

test('both fail with gallery-dl missing: image-only post -> install hint; login -> yt-dlp message; both missing -> yt-dlp', async () => {
  let r = await routerFor(fail(NO_VIDEO), G_MISSING).router.getInfo(X_URL);
  assert.deepEqual(r, { ok: false, error: NEEDS_IMAGE_ENGINE, needsGallerydl: true });
  r = await routerFor(fail(X_LOGIN), G_MISSING).router.getInfo(X_URL);
  assert.equal(r.ok, false);
  assert.equal(r.error, X_LOGIN);
  assert.equal(r.needsGallerydl, undefined);
  r = await routerFor(Y_MISSING, G_MISSING).router.getInfo(X_URL);
  assert.equal(r.error, Y_MISSING.error);
  r = await routerFor(Y_MISSING, fail('This post is not available.')).router.getInfo(X_URL);
  assert.equal(r.error, 'This post is not available.');
});

test('a runner that throws or rejects is treated as a failure, not a crash', async () => {
  const t = routerFor(() => { throw new Error('boom'); }, gInfo(2, 0));
  let r = await t.router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'image');
  const t2 = routerFor(ytInfo(), () => Promise.reject(new Error('kaboom')));
  r = await t2.router.getInfo(X_URL);
  assert.equal(r.ok, true);
  assert.equal(r.info.kind, 'video');
  const t3 = routerFor(() => Promise.reject(new Error('a')), () => { throw new Error('b'); });
  r = await t3.router.getInfo(X_URL);
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not read this link/);
});

test('both lookups run concurrently', async () => {
  const order = [];
  let releaseY;
  let releaseG;
  const yP = new Promise((r) => { releaseY = () => r(ytInfo()); });
  const gP = new Promise((r) => { releaseG = () => r(gInfo(2, 0)); });
  const router = createRouter({
    ytdlp: { getInfo: () => { order.push('y-start'); return yP; } },
    gallery: { getInfo: () => { order.push('g-start'); return gP; } },
    getSiteOf: TEST_SITE,
  });
  const pending = router.getInfo(X_URL);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['y-start', 'g-start']); // gallery started before yt-dlp finished
  releaseG();
  releaseY();
  const r = await pending;
  assert.equal(r.info.kind, 'mixed');
});

// ------------------------------------------------------------------ test hook

test('hook: /gallery.html on a test host uses generic: only when LINKGRAB_ALLOW_ANY_HOST=1', async () => {
  const prev = process.env.LINKGRAB_ALLOW_ANY_HOST;
  try {
    process.env.LINKGRAB_ALLOW_ANY_HOST = '1';
    const u = 'http://127.0.0.1:4567/gallery.html';
    assert.equal(galleryTargetFor(u, 'test'), 'generic:' + u);
    assert.equal(galleryTargetFor('http://127.0.0.1:4567/sub/gallery.html', 'test'), 'generic:http://127.0.0.1:4567/sub/gallery.html');
    assert.equal(galleryTargetFor('http://127.0.0.1:4567/video.mp4', 'test'), null);
    assert.equal(galleryTargetFor('http://127.0.0.1:4567/gallery.html.txt', 'test'), null);
    assert.equal(galleryTargetFor(u, 'youtube'), null);
    assert.equal(galleryTargetFor(X_URL, 'x'), X_URL);

    const t = routerFor(fail('This link does not point to a downloadable video.'), gInfo(3, 0, { site: 'test' }));
    const r = await t.router.getInfo(u);
    assert.equal(r.info.kind, 'image');
    assert.equal(t.calls.g[0].url, 'generic:' + u);
    assert.equal(t.calls.y[0].url, u);
    assert.equal(t.calls.g[0].opts.site, 'test');

    // ordinary test URLs keep using yt-dlp only
    const t2 = routerFor(ytInfo({ site: 'test' }), gInfo(3, 0));
    const r2 = await t2.router.getInfo('http://127.0.0.1:4567/clip.mp4');
    assert.equal(t2.calls.g.length, 0);
    assert.equal(r2.info.kind, undefined);

    delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    assert.equal(galleryTargetFor(u, 'test'), null);
    const t3 = routerFor(fail('x'), gInfo(3, 0));
    await t3.router.getInfo(u);
    assert.equal(t3.calls.g.length, 0);
  } finally {
    if (prev === undefined) delete process.env.LINKGRAB_ALLOW_ANY_HOST; else process.env.LINKGRAB_ALLOW_ANY_HOST = prev;
  }
});

// ------------------------------------------------------------------ download routing

function recordingRunners() {
  const log = [];
  const mk = (name) => ({
    download(p, onEvent) {
      log.push({ name, p, onEvent });
      return { child: null, done: Promise.resolve({ code: 0, files: [], name }), kill: () => Promise.resolve() };
    },
    getInfo() { return Promise.resolve(fail('x')); },
  });
  return { log, ytdlp: mk('yt-dlp'), gallery: mk('gallery-dl') };
}

test('download: video qualities go to yt-dlp untouched, images/media to gallery-dl', async () => {
  const r = recordingRunners();
  const router = createRouter({ ytdlp: r.ytdlp, gallery: r.gallery, getSiteOf: TEST_SITE });
  const ev = () => {};
  for (const q of ['best', '1080', '720', '480', '360', 'audio']) {
    const p = { url: X_URL, quality: q, outDir: '/tmp/dl', site: 'x' };
    const res = await router.download(p, ev).done;
    assert.equal(res.name, 'yt-dlp', q);
    assert.equal(r.log[r.log.length - 1].p, p); // same object, not rewritten
    assert.equal(r.log[r.log.length - 1].onEvent, ev);
  }
  for (const [url, site] of [[X_URL, 'x'], [IG_URL, 'instagram']]) {
    for (const q of ['images', 'media']) {
      const res = await router.download({ url, quality: q, outDir: '/tmp/dl', limitRate: '1M', cookiesFrom: 'edge', site }, ev).done;
      assert.equal(res.name, 'gallery-dl');
      const call = r.log[r.log.length - 1];
      assert.equal(call.p.url, url);
      assert.equal(call.p.site, site);
      assert.equal(call.p.quality, q);
      assert.equal(call.p.limitRate, '1M');
      assert.equal(call.p.cookiesFrom, 'edge');
      assert.equal(call.onEvent, ev);
    }
  }
  // site is derived from the URL when the queue did not pass it
  await router.download({ url: X_URL, quality: 'images', outDir: '/tmp/dl' }, ev).done;
  assert.equal(r.log[r.log.length - 1].p.site, 'x');
});

test('download: images/media for unsupported sites or without the gallery runner fail cleanly', async () => {
  const r = recordingRunners();
  const router = createRouter({ ytdlp: r.ytdlp, gallery: r.gallery, getSiteOf: TEST_SITE });
  const res = await router.download({ url: YT_URL, quality: 'images', outDir: '/tmp/dl' }).done;
  assert.equal(res.error, NO_IMAGES_FOR_SITE);
  assert.notEqual(res.code, 0);
  assert.equal(r.log.length, 0);
  await router.download({ url: YT_URL, quality: 'media', outDir: '/tmp/dl' }).kill();
  const noGallery = createRouter({ ytdlp: r.ytdlp, gallery: null, getSiteOf: TEST_SITE });
  const res2 = await noGallery.download({ url: X_URL, quality: 'images', outDir: '/tmp/dl' }).done;
  assert.equal(res2.error, gal.MISSING_MESSAGE);
});

test('download: test hook rewrites /gallery.html to generic: and only then', async () => {
  const prev = process.env.LINKGRAB_ALLOW_ANY_HOST;
  try {
    const r = recordingRunners();
    const router = createRouter({ ytdlp: r.ytdlp, gallery: r.gallery, getSiteOf: TEST_SITE });
    const u = 'http://127.0.0.1:4567/gallery.html';
    process.env.LINKGRAB_ALLOW_ANY_HOST = '1';
    await router.download({ url: u, quality: 'images', outDir: '/tmp/dl', site: 'test' }).done;
    assert.equal(r.log[r.log.length - 1].name, 'gallery-dl');
    assert.equal(r.log[r.log.length - 1].p.url, 'generic:' + u);
    const res = await router.download({ url: 'http://127.0.0.1:4567/clip.mp4', quality: 'images', outDir: '/tmp/dl', site: 'test' }).done;
    assert.equal(res.error, NO_IMAGES_FOR_SITE);
    await router.download({ url: u, quality: 'best', outDir: '/tmp/dl', site: 'test' }).done;
    assert.equal(r.log[r.log.length - 1].name, 'yt-dlp');
    delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    const res2 = await router.download({ url: u, quality: 'images', outDir: '/tmp/dl', site: 'test' }).done;
    assert.equal(res2.error, NO_IMAGES_FOR_SITE);
  } finally {
    if (prev === undefined) delete process.env.LINKGRAB_ALLOW_ANY_HOST; else process.env.LINKGRAB_ALLOW_ANY_HOST = prev;
  }
});
