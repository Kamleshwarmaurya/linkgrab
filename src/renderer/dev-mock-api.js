/* Dev-only mock of window.api so the UI can run in a plain browser.
   Loaded by app.js only when the page URL contains ?mock=1.
   Optional extra params: engine=missing (all engines), gd=missing (only gallery-dl), gdnote=1 (install
   succeeds but leaves the image engine missing, with a note), empty=1, clip=1, fast=1 (faster ticks).
   URL conventions for X / Instagram links: contains "photo" or "image" -> 4 images ("single" -> 1),
   contains "carousel" or "mixed" -> 2 images + 1 video, anything else -> 1 video. Add "private" or
   "fail" anywhere to exercise errors. */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const fast = q.get('fast') === '1';
  const TICK = fast ? 120 : 500;

  const listeners = { update: new Set(), removed: new Set(), engine: new Set() };
  const emit = (set, v) => listeners[set].forEach((cb) => { try { cb(JSON.parse(JSON.stringify(v))); } catch (e) { console.error(e); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let seq = 1;
  const items = new Map();
  const timers = new Map();
  let settings = { downloadDir: 'C:\\Users\\demo\\Downloads\\LinkGrab', maxConcurrent: 3, speedLimit: '', cookiesFrom: '' };
  let engine = {
    ytdlp: { installed: q.get('engine') !== 'missing', version: '2025.09.26', path: '/mock/yt-dlp' },
    ffmpeg: { installed: q.get('engine') !== 'missing', path: '/mock/ffmpeg' },
    gallerydl: { installed: q.get('engine') !== 'missing' && q.get('gd') !== 'missing', version: q.get('engine') !== 'missing' && q.get('gd') !== 'missing' ? '1.30.8' : '', path: '/mock/gallery-dl' }
  };

  function thumb(c1, c2) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><polygon points="136,64 136,116 186,90" fill="rgba(255,255,255,.85)"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function photo(c1, c2, n) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/><circle cx="170" cy="70" r="22" fill="rgba(255,255,255,.7)"/><polygon points="0,240 0,170 70,110 130,170 170,140 240,200 240,240" fill="rgba(0,0,0,.28)"/><text x="14" y="30" font-family="sans-serif" font-size="20" fill="rgba(255,255,255,.85)">' + n + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const PHOTOS = [photo('#f7971e', '#ffd200', 1), photo('#11998e', '#38ef7d', 2), photo('#ee0979', '#ff6a00', 3), photo('#396afc', '#2948ff', 4), photo('#8e2de2', '#4a00e0', 5), photo('#fc4a1a', '#f7b733', 6)];
  const THUMBS = [thumb('#ff5f6d', '#7b2ff7'), thumb('#2193b0', '#6dd5ed'), thumb('#f7971e', '#c0392b'), thumb('#56ab2f', '#134e5e')];

  function siteOf(u) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, '');
      if (/youtube\.com$|^youtu\.be$/.test(h)) return 'youtube';
      if (/facebook\.com$|^fb\.watch$/.test(h)) return 'facebook';
      if (/linkedin\.com$/.test(h)) return 'linkedin';
      if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return 'x';
      if (/(^|\.)instagram\.com$/.test(h) || h === 'instagr.am') return 'instagram';
    } catch (e) { /* ignore */ }
    return null;
  }
  const UNSUPPORTED = 'Unsupported site. LinkGrab supports YouTube, Facebook, LinkedIn, X and Instagram links.';
  const GD_MISSING = 'Image downloads need the image engine. Click Install engine in the banner.';
  const gdInstalled = () => !!(engine.gallerydl && engine.gallerydl.installed);
  // What a post contains, derived from the URL (mock convention, see header).
  function postOf(u, site) {
    if (site !== 'x' && site !== 'instagram') return { kind: 'video', videoCount: 1, imageCount: 0 };
    if (/carousel|mixed/i.test(u)) return { kind: 'mixed', videoCount: 1, imageCount: 2 };
    if (/photo|image/i.test(u)) { const n = /single/i.test(u) ? 1 : 4; return { kind: 'image', videoCount: 0, imageCount: n }; }
    return { kind: 'video', videoCount: 1, imageCount: 0 };
  }
  const VIDEO_QUALITIES = [{ key: 'best', label: 'Best available' }, { key: '1080', label: '1080p' }, { key: '720', label: '720p' }, { key: '480', label: '480p' }, { key: '360', label: '360p' }, { key: 'audio', label: 'Audio only' }];
  const titleFor = (u) => {
    const site = siteOf(u);
    if (site === 'x' || site === 'instagram') {
      const p = postOf(u, site);
      const who = site === 'x' ? '@demo_user' : 'demo.studio';
      return (p.kind === 'image' ? 'Photos from the weekend trip' : p.kind === 'mixed' ? 'Launch day: behind the scenes carousel' : 'Clip of the day') + ' - ' + who + ' on ' + (site === 'x' ? 'X' : 'Instagram');
    }
    if (/dQw4w9WgXcQ/.test(u)) return 'Never Gonna Give You Up (Official Video) [Remastered 4K]';
    const id = (u.match(/[?&]v=([^&]+)/) || u.match(/\/([^/?]+)\/?(\?|$)/) || [])[1] || 'clip';
    return 'Sample video ' + id + ' - a deliberately long title to test truncation in narrow table columns';
  };
  const emitItem = (it) => emit('update', it);

  function mk(partial) {
    const id = 'dl' + (seq++);
    const it = Object.assign({
      id, url: '', site: null, title: '', thumbnail: null, status: 'queued', percent: 0, speed: 0, eta: 0,
      size: 0, downloaded: 0, filePath: '', error: '', quality: 'best', addedAt: Date.now(),
      kind: 'video', fileCount: 0, files: [], folder: null
    }, partial);
    items.set(id, it);
    return it;
  }

  // seed
  if (q.get('empty') !== '1') {
    const now = Date.now();
    mk({ url: 'https://www.youtube.com/watch?v=aaa111', site: 'youtube', title: 'Lofi beats to code to - 3 hour mix', thumbnail: THUMBS[1], status: 'completed', percent: 100, size: 412 * 1048576, downloaded: 412 * 1048576, filePath: '/mock/lofi.mp4', quality: '1080', addedAt: now - 900000 });
    mk({ url: 'https://www.facebook.com/watch/?v=222', site: 'facebook', title: 'Behind the scenes: building our new studio', thumbnail: THUMBS[2], status: 'error', error: 'This video is private or requires login. Enable Settings > "Use browser cookies" and try again.', quality: '720', addedAt: now - 800000 });
    mk({ url: 'https://www.instagram.com/p/carousel-seed/', site: 'instagram', kind: 'mixed', title: 'Launch day: behind the scenes carousel - demo.studio on Instagram', thumbnail: PHOTOS[2], status: 'completed', percent: 100, size: 18 * 1048576, downloaded: 18 * 1048576, filePath: 'C:\\Users\\demo\\Downloads\\LinkGrab\\Instagram demo.studio\\01.jpg', files: ['C:\\x\\01.jpg', 'C:\\x\\02.jpg', 'C:\\x\\03.mp4'], fileCount: 3, folder: 'C:\\Users\\demo\\Downloads\\LinkGrab\\Instagram demo.studio', quality: 'media', addedAt: now - 600000 });
    mk({ url: 'https://x.com/demo_user/status/1900000000000000001', site: 'x', kind: 'image', title: 'Photos from the weekend trip - @demo_user on X', thumbnail: PHOTOS[0], status: 'completed', percent: 100, size: 2.4 * 1048576, downloaded: 2.4 * 1048576, filePath: 'C:\\Users\\demo\\Downloads\\LinkGrab\\X 1900000000000000001.jpg', files: ['C:\\x\\X 1900000000000000001.jpg'], fileCount: 1, folder: 'C:\\Users\\demo\\Downloads\\LinkGrab', quality: 'images', addedAt: now - 500000 });
    mk({ url: 'https://www.linkedin.com/posts/demo_333', site: 'linkedin', title: 'How we scaled our platform team (LinkedIn Live)', thumbnail: THUMBS[3], status: 'paused', percent: 38.4, size: 96 * 1048576, downloaded: 36.8 * 1048576, quality: 'best', addedAt: now - 700000 });
  }

  function running() { return Array.from(items.values()).filter((i) => ['fetching', 'downloading', 'merging'].indexOf(i.status) !== -1).length; }

  function pump() {
    const queued = Array.from(items.values()).filter((i) => i.status === 'queued').sort((a, b) => a.addedAt - b.addedAt);
    while (queued.length && running() < settings.maxConcurrent) start(queued.shift());
  }

  function start(it) {
    it.status = 'fetching'; it.error = ''; emitItem(it);
    timers.set(it.id, setTimeout(() => {
      if (!items.has(it.id) || it.status !== 'fetching') return;
      it.title = it.title || titleFor(it.url);
      const isImg = it.quality === 'images' || it.quality === 'media';
      if (isImg && !it.fileCount) {
        const p = postOf(it.url, it.site);
        it.fileCount = it.quality === 'images' ? p.imageCount : p.imageCount + p.videoCount;
      }
      it.thumbnail = it.thumbnail || (isImg ? PHOTOS[it.id.length % PHOTOS.length] : THUMBS[it.id.length % THUMBS.length]);
      it.size = it.size || (isImg ? (1.5 + Math.random() * 6) * Math.max(1, it.fileCount) : 40 + Math.floor(Math.random() * 400)) * 1048576;
      it.status = 'downloading'; emitItem(it);
      tick(it);
    }, 700));
  }

  function tick(it) {
    clearInterval(timers.get(it.id));
    const h = setInterval(() => {
      if (!items.has(it.id) || it.status !== 'downloading') { clearInterval(h); return; }
      const speed = (1.5 + Math.random() * 4) * 1048576 * (fast ? 4 : 1);
      it.speed = speed;
      it.downloaded = Math.min(it.size, it.downloaded + speed * (TICK / 1000) * (fast ? 1 : 1));
      it.percent = (it.downloaded / it.size) * 100;
      it.eta = (it.size - it.downloaded) / speed;
      if (it.fileCount > 0) it.files = Array.from({ length: Math.floor(it.percent / 100 * it.fileCount) }, (_, i) => 'C:\\mock\\' + String(i + 1).padStart(2, '0') + '.jpg');
      if (/fail/.test(it.url) && it.percent > 35) {
        clearInterval(h); it.status = 'error'; it.speed = 0; it.eta = 0;
        it.error = 'Network error: connection reset by peer'; emitItem(it); pump(); return;
      }
      if (it.percent >= 100) {
        clearInterval(h); it.percent = 100; it.speed = 0; it.eta = 0; it.status = 'merging'; emitItem(it);
        setTimeout(() => {
          if (!items.has(it.id)) return;
          it.status = 'completed';
          if (it.fileCount > 1) {
            it.folder = 'C:\\mock\\' + it.id;
            it.files = Array.from({ length: it.fileCount }, (_, i) => it.folder + '\\' + String(i + 1).padStart(2, '0') + '.jpg');
            it.filePath = it.files[0];
          } else if (it.fileCount === 1) {
            it.folder = 'C:\\mock'; it.filePath = 'C:\\mock\\' + it.id + '.jpg'; it.files = [it.filePath];
          } else { it.filePath = '/mock/' + it.id + '.mp4'; it.files = [it.filePath]; it.fileCount = 1; it.folder = '/mock'; }
          emitItem(it); pump();
        }, 900);
        return;
      }
      emitItem(it);
    }, TICK);
    timers.set(it.id, h);
  }

  function stop(it) { clearTimeout(timers.get(it.id)); clearInterval(timers.get(it.id)); timers.delete(it.id); }

  const ok = (extra) => Object.assign({ ok: true }, extra);

  window.api = {
    async getInfo(url) {
      await sleep(650);
      const site = siteOf(url);
      if (!site) return { ok: false, error: UNSUPPORTED };
      if (/private/.test(url)) return { ok: false, error: 'This post is private or login-only. Enable Settings > "Use browser cookies" and try again.' };
      const post = postOf(url, site);
      let kind = post.kind;
      let needs = false;
      if (kind !== 'video' && !gdInstalled()) {
        if (kind === 'image') return { ok: false, error: GD_MISSING };
        kind = 'video'; needs = true; // mixed post: only the yt-dlp (video) part is known
      }
      const vq = /audio-only/.test(url)
        ? [{ key: 'best', label: 'Best available' }, { key: 'audio', label: 'Audio only' }]
        : VIDEO_QUALITIES;
      const n = post.videoCount + post.imageCount;
      let qualities, thumbnails;
      if (kind === 'image') {
        qualities = [{ key: 'images', label: 'Images (' + post.imageCount + ')' }];
        thumbnails = PHOTOS.slice(0, Math.min(post.imageCount, 6));
      } else if (kind === 'mixed') {
        qualities = [{ key: 'media', label: 'Everything (' + n + ' files)' }, { key: 'images', label: 'Images only (' + post.imageCount + ')' }].concat(vq);
        thumbnails = [PHOTOS[2], PHOTOS[3], THUMBS[0]];
      } else {
        qualities = vq;
        thumbnails = [THUMBS[0]];
      }
      const info = {
        title: titleFor(url), thumbnail: thumbnails[0], thumbnails, duration: kind === 'image' ? 0 : 213,
        uploader: site === 'x' ? '@demo_user' : site === 'instagram' ? 'demo.studio' : 'Rick Astley', site, qualities,
        kind, videoCount: needs ? 1 : post.videoCount, imageCount: needs ? 0 : post.imageCount,
        engine: kind === 'image' ? 'gallery-dl' : kind === 'mixed' ? 'both' : 'yt-dlp'
      };
      if (needs) info.needsGallerydl = true;
      return ok({ info });
    },
    async add(url, quality) {
      await sleep(150);
      const site = siteOf(url);
      if (!site) return { ok: false, error: UNSUPPORTED };
      if (/private/.test(url)) return { ok: false, error: 'This post is private or login-only. Enable Settings > "Use browser cookies" and try again.' };
      const imgQ = quality === 'images' || quality === 'media';
      if (imgQ && site !== 'x' && site !== 'instagram') return { ok: false, error: 'Image downloads are only available for X and Instagram links.' };
      if (imgQ && !gdInstalled()) return { ok: false, error: GD_MISSING };
      const kind = quality === 'images' ? 'image' : quality === 'media' ? 'mixed' : 'video';
      const it = mk({ url, site, quality: quality || 'best', kind });
      emitItem(it);
      setTimeout(pump, 0);
      return ok({ item: JSON.parse(JSON.stringify(it)) });
    },
    async list() { return JSON.parse(JSON.stringify(Array.from(items.values()))); },
    async pause(id) { const it = items.get(id); if (!it) return { ok: false, error: 'Not found' }; stop(it); it.status = 'paused'; it.speed = 0; it.eta = 0; emitItem(it); pump(); return ok(); },
    async resume(id) { const it = items.get(id); if (!it) return { ok: false, error: 'Not found' }; it.status = 'queued'; emitItem(it); pump(); return ok(); },
    async cancel(id) { const it = items.get(id); if (!it) return { ok: false, error: 'Not found' }; stop(it); it.status = 'canceled'; it.speed = 0; it.eta = 0; it.percent = 0; it.downloaded = 0; emitItem(it); pump(); return ok(); },
    async remove(id, del) { const it = items.get(id); if (!it) return { ok: false, error: 'Not found' }; console.log('[mock] remove', id, 'deleteFiles=' + !!del, 'files=' + (it.files ? it.files.length : 0)); stop(it); items.delete(id); emit('removed', id); pump(); return ok(); },
    async openFile(id) { const it = items.get(id); console.log('[mock] openFile', id, it && it.filePath); return ok(); },
    async showInFolder(id) { console.log('[mock] showInFolder', id); return ok(); },
    async getSettings() { return Object.assign({}, settings); },
    async setSettings(p) { settings = Object.assign({}, settings, p); return Object.assign({}, settings); },
    async chooseFolder() { await sleep(100); return 'D:\\Videos\\Picked'; },
    async engineStatus() { return JSON.parse(JSON.stringify(engine)); },
    async installEngine() {
      const step = async (stage, name, inc) => { for (let p = 0; p <= 100; p += inc) { emit('engine', { stage, percent: p, message: 'Downloading ' + name + '... ' + p + '%' }); await sleep(120); } };
      if (!engine.ytdlp.installed) await step('ytdlp', 'yt-dlp', 10);
      if (!engine.ffmpeg.installed) await step('ffmpeg', 'ffmpeg', 20);
      if (!gdInstalled()) await step('gallerydl', 'gallery-dl', 20);
      engine.ytdlp = { installed: true, version: '2025.09.26', path: '/mock/yt-dlp' };
      engine.ffmpeg = { installed: true, path: '/mock/ffmpeg' };
      if (q.get('gdnote') === '1') return ok({ note: 'The image engine could not be installed (network error). Videos work; try Install again later.' });
      engine.gallerydl = { installed: true, version: '1.30.8', path: '/mock/gallery-dl' };
      return ok();
    },
    async updateEngine() {
      await sleep(900);
      engine.ytdlp.version = '2025.10.14';
      if (!gdInstalled()) engine.gallerydl = { installed: true, version: '1.30.9', path: '/mock/gallery-dl' };
      else engine.gallerydl.version = '1.30.9';
      return ok({ version: '2025.10.14', gallerydl: { version: '1.30.9' } });
    },
    async readClipboardUrl() { return q.get('clip') === '1' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : null; },
    onUpdate(cb) { listeners.update.add(cb); return () => listeners.update.delete(cb); },
    onRemoved(cb) { listeners.removed.add(cb); return () => listeners.removed.delete(cb); },
    onEngineProgress(cb) { listeners.engine.add(cb); return () => listeners.engine.delete(cb); }
  };
  // The seeded "paused" item should be resumable and the queue should pick up new work.
  setTimeout(pump, 0);
})();
