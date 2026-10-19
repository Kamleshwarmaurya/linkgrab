'use strict';
// Download queue. Pure Node (no electron). The yt-dlp layer is injected so tests can use fakes.
//
// ytdlp  : { download(params, onEvent) -> { done: Promise<result>, kill(): Promise } }
//          params = { url, quality, outDir, limitRate, cookiesFrom, site }
//          events = {type:'title',id,title} | {type:'progress',downloaded,total,speed,eta}
//                   | {type:'merging'} | {type:'file',path}
//                   | {type:'files',files:[abs paths done so far],folder,fileCount}   (gallery-dl runs)
//          progress events may carry `size` instead of `total` and an explicit `percent` (gallery-dl).
//          result  = { code, error, filePath, files?, folder?, fileCount? }
// settings: object with get() -> { downloadDir, maxConcurrent, speedLimit, cookiesFrom } (or a plain object)
// storePath: JSON file with the persisted list

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const sites = require('./sites');

const ACTIVE = new Set(['fetching', 'downloading', 'merging']);
const QUALITIES = ['best', '1080', '720', '480', '360', 'audio', 'images', 'media'];
const IMAGE_QUALITIES = ['images', 'media'];
const KINDS = ['video', 'image', 'mixed'];
const MAX_FILES = 200;
const STATUSES = ['queued', 'fetching', 'downloading', 'paused', 'merging', 'completed', 'error', 'canceled'];
const UPDATE_INTERVAL_MS = 250; // at most ~4 progress emits per second per item
const PARTIAL_RE = /\.(part|ytdl|temp|tmp)$|\.part-Frag\d+$|\.f[A-Za-z0-9_-]+\.[A-Za-z0-9]+(\.part|\.ytdl)?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when gallery-dl handles this site (images / media qualities are allowed there). */
function supportsImages(site) {
  if (typeof sites.supportsImages === 'function') return !!sites.supportsImages(site);
  return site === 'x' || site === 'instagram' || site === 'test';
}

const RESET_FILES = { filePath: null, files: [], fileCount: 0, folder: null };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Keep only plain non-empty absolute-looking path strings, de-duplicated, capped. */
function cleanFiles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const f of list) {
    if (typeof f !== 'string' || !f || f.includes('\0') || !path.isAbsolute(f) || /(^|[\\/])\.\.([\\/]|$)/.test(f) || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function kindForQuality(q, hint) {
  if (q === 'images') return 'image';
  if (q === 'media') return hint === 'image' || hint === 'mixed' ? hint : 'mixed';
  return 'video';
}

/** True when `child` lies strictly inside `root` (lexical check). */
function strictlyInside(root, child) {
  if (!root || !child) return false;
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return !!rel && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class DownloadQueue extends EventEmitter {
  /**
   * @param {{ytdlp:object, settings:object, storePath?:string}} opts
   */
  constructor(opts) {
    super();
    const o = opts || {};
    if (!o.ytdlp || typeof o.ytdlp.download !== 'function') throw new Error('DownloadQueue needs a ytdlp runner');
    this.ytdlp = o.ytdlp;
    this.settings = o.settings || {};
    this.storePath = o.storePath || null;
    /** @type {Map<string, any>} */
    this.recs = new Map();
    this._saveTimer = null;
    this._load();
  }

  // ------------------------------------------------------------ helpers

  _cfg() {
    const s = typeof this.settings.get === 'function' ? this.settings.get() : this.settings;
    return Object.assign({ downloadDir: '', maxConcurrent: 3, speedLimit: '', cookiesFrom: '' }, s);
  }

  _maxConcurrent() {
    const n = Math.round(Number(this._cfg().maxConcurrent));
    return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3;
  }

  _public(rec) {
    return Object.assign({}, rec.item);
  }

  _publish(rec, force) {
    const now = Date.now();
    if (!force && now - (rec.lastEmit || 0) < UPDATE_INTERVAL_MS) {
      this._scheduleSave();
      return;
    }
    rec.lastEmit = now;
    this.emit('update', this._public(rec));
    this._scheduleSave();
  }

  _setStatus(rec, status, patch) {
    Object.assign(rec.item, patch || {});
    rec.item.status = status;
    this._publish(rec, true);
    this.save();
  }

  // ------------------------------------------------------------ persistence

  _load() {
    if (!this.storePath) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    } catch (_) {
      return;
    }
    const entries = data && Array.isArray(data.items) ? data.items : [];
    for (const e of entries) {
      const it = e && e.item;
      if (!it || typeof it.id !== 'string' || typeof it.url !== 'string') continue;
      const item = this._normalize(it);
      if (ACTIVE.has(item.status)) {
        item.status = 'paused';
        item.speed = 0;
        item.eta = null;
      }
      this.recs.set(item.id, {
        item,
        outDir: typeof e.outDir === 'string' && e.outDir ? e.outDir : this._cfg().downloadDir,
        vid: typeof e.vid === 'string' ? e.vid : '',
        handle: null,
        intent: null,
        lastEmit: 0,
        base: 0,
        lastDl: 0,
        lastTotal: 0,
      });
    }
    this.save();
  }

  _normalize(it) {
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const filePath = typeof it.filePath === 'string' && it.filePath ? it.filePath : null;
    const quality = QUALITIES.includes(it.quality) ? it.quality : 'best';
    let files = cleanFiles(it.files);
    // items saved by v1.0 have no files list: a completed one owns exactly its filePath
    if (!files.length && filePath && it.status === 'completed') files = [filePath];
    return {
      id: it.id,
      url: it.url,
      site: it.site || sites.detectSite(it.url) || null,
      title: typeof it.title === 'string' && it.title ? it.title : it.url,
      thumbnail: typeof it.thumbnail === 'string' ? it.thumbnail : '',
      status: STATUSES.includes(it.status) ? it.status : 'error',
      percent: n(it.percent),
      speed: n(it.speed),
      eta: it.eta === null || it.eta === undefined ? null : n(it.eta),
      size: n(it.size),
      downloaded: n(it.downloaded),
      filePath,
      error: typeof it.error === 'string' && it.error ? it.error : null,
      quality,
      addedAt: n(it.addedAt) || Date.now(),
      kind: KINDS.includes(it.kind) ? it.kind : kindForQuality(quality),
      fileCount: Math.max(0, Math.min(1e9, Math.floor(n(it.fileCount)))) || files.length,
      files,
      folder: typeof it.folder === 'string' && it.folder ? it.folder : (filePath ? path.dirname(filePath) : null),
    };
  }

  _scheduleSave() {
    if (!this.storePath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 1500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** Synchronous, atomic write. */
  save() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.storePath) return;
    try {
      const items = [...this.recs.values()].map((r) => ({ item: r.item, outDir: r.outDir, vid: r.vid }));
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const tmp = this.storePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }));
      fs.renameSync(tmp, this.storePath);
    } catch (_) {
      // persistence is best effort
    }
  }

  // ------------------------------------------------------------ public API

  list() {
    return [...this.recs.values()].map((r) => this._public(r)).sort((a, b) => a.addedAt - b.addedAt);
  }

  get(id) {
    const r = this.recs.get(id);
    return r ? this._public(r) : null;
  }

  /**
   * Add a link and start it as soon as a slot is free. Throws Error with a friendly message.
   * @param {string} url
   * @param {string} [quality]
   * @param {{title?:string, thumbnail?:string, kind?:string, fileCount?:number}} [meta]
   */
  add(url, quality, meta) {
    const v = sites.validateUrl(url);
    if (!v.ok) throw new Error(v.error);
    const q = quality === undefined || quality === null || quality === '' ? 'best' : quality;
    if (!QUALITIES.includes(q)) throw new Error('Unknown quality: ' + String(quality));
    if (IMAGE_QUALITIES.includes(q) && !supportsImages(v.site)) {
      throw new Error('Image downloads are only available for X and Instagram posts.');
    }
    for (const r of this.recs.values()) {
      if (r.item.url === v.url && r.item.quality === q && !['completed', 'canceled', 'error'].includes(r.item.status)) {
        throw new Error('This link is already in your download list.');
      }
    }
    const m = meta || {};
    const rec = {
      item: {
        id: crypto.randomBytes(6).toString('hex'),
        url: v.url,
        site: v.site,
        title: typeof m.title === 'string' && m.title ? m.title : v.url,
        thumbnail: typeof m.thumbnail === 'string' ? m.thumbnail : '',
        status: 'queued',
        percent: 0,
        speed: 0,
        eta: null,
        size: 0,
        downloaded: 0,
        filePath: null,
        error: null,
        quality: q,
        addedAt: Date.now(),
        kind: kindForQuality(q, m.kind),
        fileCount: isNum(m.fileCount) && m.fileCount > 0 ? Math.min(1e9, Math.floor(m.fileCount)) : 0,
        files: [],
        folder: null,
      },
      outDir: this._cfg().downloadDir,
      vid: '',
      handle: null,
      intent: null,
      lastEmit: 0,
      base: 0,
      lastDl: 0,
      lastTotal: 0,
    };
    this.recs.set(rec.item.id, rec);
    this._publish(rec, true);
    this.save();
    this.pump();
    return this._public(rec);
  }

  /** Start (or restart) a queued, paused, failed or canceled item. */
  start(id) {
    const rec = this.recs.get(id);
    if (!rec) return { ok: false, error: 'Download not found.' };
    const st = rec.item.status;
    if (ACTIVE.has(st) || st === 'completed') return { ok: true };
    if (st === 'canceled') {
      Object.assign(rec.item, { percent: 0, downloaded: 0, size: 0, filePath: null, files: [], folder: null });
      rec.vid = '';
    }
    rec.item.error = null;
    this._setStatus(rec, 'queued', { speed: 0, eta: null });
    this.pump();
    return { ok: true };
  }

  resume(id) {
    return this.start(id);
  }

  /** Pause = stop the process but keep the partial files so resume can continue. */
  async pause(id) {
    const rec = this.recs.get(id);
    if (!rec) return { ok: false, error: 'Download not found.' };
    if (rec.item.status === 'queued') {
      this._setStatus(rec, 'paused', { speed: 0, eta: null });
      return { ok: true };
    }
    if (ACTIVE.has(rec.item.status) && rec.handle) {
      rec.intent = 'pause';
      await rec.handle.kill();
      await rec.exited;
    }
    return { ok: true };
  }

  /** Cancel = stop and delete partial files. */
  async cancel(id) {
    const rec = this.recs.get(id);
    if (!rec) return { ok: false, error: 'Download not found.' };
    const st = rec.item.status;
    if (ACTIVE.has(st) && rec.handle) {
      rec.intent = 'cancel';
      await rec.handle.kill();
      await rec.exited;
      return { ok: true };
    }
    if (st === 'completed' || st === 'canceled') return { ok: true };
    await this._cleanupPartials(rec);
    this._setStatus(rec, 'canceled', Object.assign({ speed: 0, eta: null, percent: 0, downloaded: 0, size: 0, error: null }, RESET_FILES));
    this.pump();
    return { ok: true };
  }

  /** Remove from the list. Optionally delete the finished file (or, for unfinished items, the partials). */
  async remove(id, deleteFile) {
    const rec = this.recs.get(id);
    if (!rec) return { ok: false, error: 'Download not found.' };
    if (ACTIVE.has(rec.item.status) && rec.handle) {
      rec.intent = 'remove';
      await rec.handle.kill();
      await rec.exited;
    }
    if (deleteFile) {
      if (rec.item.status !== 'completed' || !rec.item.filePath) await this._cleanupPartials(rec);
      // every finished file the item lists (files + filePath), each one checked to lie inside a download root
      await this._deleteItemFiles(rec);
    }
    this.recs.delete(id);
    this.save();
    this.emit('removed', id);
    this.pump();
    return { ok: true };
  }

  /** Start queued items while slots are free. */
  pump() {
    const max = this._maxConcurrent();
    let active = [...this.recs.values()].filter((r) => ACTIVE.has(r.item.status)).length;
    if (active >= max) return;
    const queued = [...this.recs.values()]
      .filter((r) => r.item.status === 'queued')
      .sort((a, b) => a.item.addedAt - b.item.addedAt);
    for (const rec of queued) {
      if (active >= max) break;
      this._run(rec);
      active++;
    }
  }

  /** Stop everything (app quitting): running items become paused and the list is saved. */
  async shutdown() {
    const running = [...this.recs.values()].filter((r) => r.handle);
    for (const r of running) r.intent = 'shutdown';
    await Promise.all(running.map((r) => r.handle.kill().then(() => r.exited)));
    this.save();
  }

  // ------------------------------------------------------------ running

  _run(rec) {
    const cfg = this._cfg();
    rec.intent = null;
    rec.base = 0;
    rec.lastDl = 0;
    rec.lastTotal = 0;
    // The store on disk is not trusted: only a currently valid, supported http(s) link may reach a downloader
    // (this also keeps gallery-dl's `generic:` prefix unreachable from a hand-edited downloads.json).
    const link = sites.validateUrl(rec.item.url);
    if (!link.ok) {
      this._setStatus(rec, 'error', { speed: 0, eta: null, error: link.error });
      return;
    }
    try {
      fs.mkdirSync(rec.outDir, { recursive: true });
    } catch (e) {
      this._setStatus(rec, 'error', {
        speed: 0, eta: null,
        error: 'Could not create the download folder. Choose another folder in Settings.',
      });
      return;
    }
    this._setStatus(rec, 'fetching', { error: null, speed: 0, eta: null });
    let handle;
    try {
      handle = this.ytdlp.download(
        {
          url: rec.item.url,
          quality: rec.item.quality,
          outDir: rec.outDir,
          limitRate: cfg.speedLimit || '',
          cookiesFrom: cfg.cookiesFrom || '',
          site: link.site,
        },
        (ev) => this._onEvent(rec, ev)
      );
    } catch (e) {
      this._setStatus(rec, 'error', { speed: 0, eta: null, error: 'Could not start the download: ' + (e && e.message) });
      return;
    }
    rec.handle = handle;
    rec.exited = handle.done.then((res) => this._onExit(rec, res)).catch((e) => this._onExit(rec, {
      code: -1, error: 'Download failed: ' + (e && e.message), filePath: null,
    }));
  }

  _onEvent(rec, ev) {
    if (!ev || rec.intent) return;
    const item = rec.item;
    switch (ev.type) {
      case 'title': {
        if (ev.id) rec.vid = ev.id;
        if (ev.title && ev.title !== 'NA' && ev.title !== item.title) {
          item.title = ev.title;
          this._publish(rec, true);
        }
        break;
      }
      case 'progress': {
        if (item.status === 'merging') return;
        if (ev.downloaded === null || ev.downloaded === undefined) return;
        // a new, smaller counter means yt-dlp moved on to the next stream (video then audio)
        if (rec.lastDl > 0 && ev.downloaded < rec.lastDl * 0.9) rec.base += rec.lastTotal;
        rec.lastDl = ev.downloaded;
        const rawTotal = ev.total !== undefined && ev.total !== null ? ev.total : ev.size; // gallery-dl names it `size`
        const total = rawTotal && rawTotal > 0 ? rawTotal : 0;
        if (total) rec.lastTotal = total;
        const size = rec.base + (total || ev.downloaded);
        const dl = rec.base + ev.downloaded;
        const changedStatus = item.status !== 'downloading';
        item.status = 'downloading';
        item.downloaded = dl;
        item.size = size;
        if (isNum(ev.percent)) item.percent = Math.min(100, Math.max(0, Math.round(ev.percent * 10) / 10)); // explicit (gallery-dl)
        else item.percent = total ? Math.min(100, Math.round((dl / size) * 1000) / 10) : item.percent;
        item.speed = ev.speed || 0;
        item.eta = ev.eta === null || ev.eta === undefined ? null : ev.eta;
        this._publish(rec, changedStatus);
        if (changedStatus) this.save();
        break;
      }
      case 'merging': {
        if (item.status === 'merging') return;
        this._setStatus(rec, 'merging', { speed: 0, eta: null });
        break;
      }
      case 'file': {
        item.filePath = ev.path;
        break;
      }
      case 'files': {
        const files = cleanFiles(ev.files);
        if (files.length) {
          item.files = files;
          item.filePath = files[0];
        }
        if (typeof ev.folder === 'string' && ev.folder) item.folder = ev.folder;
        const count = isNum(ev.fileCount) ? Math.floor(ev.fileCount) : 0;
        item.fileCount = Math.max(count, files.length, item.fileCount || 0);
        this._publish(rec, true);
        break;
      }
      default:
    }
  }

  async _onExit(rec, res) {
    const intent = rec.intent;
    rec.handle = null;
    rec.intent = null;
    const item = rec.item;
    if (intent === 'cancel' || intent === 'remove') {
      if (intent === 'cancel') {
        await this._cleanupPartials(rec);
        this._setStatus(rec, 'canceled', Object.assign({ speed: 0, eta: null, percent: 0, downloaded: 0, size: 0, error: null }, RESET_FILES));
      }
    } else if (intent === 'pause' || intent === 'shutdown') {
      this._setStatus(rec, 'paused', { speed: 0, eta: null });
    } else if (res && res.code === 0) {
      let files = cleanFiles(res.files);
      if (!files.length) files = cleanFiles(item.files);
      const fp = (res.filePath || files[0] || item.filePath) || null;
      if (!files.length && fp) files = [fp];
      const multi = files.length > 1 || (isNum(res.fileCount) && res.fileCount > 1);
      let size = item.size;
      if (multi) {
        let sum = 0;
        for (const f of files) {
          try { sum += (await fs.promises.stat(f)).size; } catch (_) { /* missing file: skip */ }
        }
        if (sum > 0) size = sum;
      } else if (fp) {
        try { size = fs.statSync(fp).size; } catch (_) { /* keep previous */ }
      }
      const count = Math.max(isNum(res.fileCount) ? Math.floor(res.fileCount) : 0, files.length);
      const folder = (typeof res.folder === 'string' && res.folder) || item.folder || (fp ? path.dirname(fp) : null);
      this._setStatus(rec, 'completed', {
        filePath: fp, files, fileCount: count, folder, percent: 100, speed: 0, eta: null, error: null,
        size: size || item.size, downloaded: size || item.downloaded,
      });
      this.emit('completed', this._public(rec));
    } else {
      this._setStatus(rec, 'error', {
        speed: 0, eta: null,
        error: (res && res.error) || 'Download failed for an unknown reason.',
      });
    }
    this.pump();
  }

  // ------------------------------------------------------------ file cleanup

  async _unlinkQuiet(file) {
    for (let i = 0; i < 4; i++) {
      try {
        await fs.promises.unlink(file);
        return true;
      } catch (e) {
        if (e && e.code === 'ENOENT') return true;
        await sleep(200); // Windows may hold the handle for a moment after the process dies
      }
    }
    return false;
  }

  /** Delete .part / .ytdl / intermediate stream files that belong to this item. */
  async _cleanupPartials(rec) {
    const id = rec.vid;
    if (id) {
      let names;
      try {
        names = await fs.promises.readdir(rec.outDir);
      } catch (_) {
        names = [];
      }
      const marker = `[${id}]`;
      // gallery-dl names: "<Site> <postid>.<ext>(.part)" in the download dir
      const galleryRe = new RegExp('^[A-Za-z]+ ' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[. ]');
      const isGallery = IMAGE_QUALITIES.includes(rec.item.quality);
      for (const name of names) {
        if (!PARTIAL_RE.test(name)) continue;
        if (name.includes(marker) || (isGallery && galleryRe.test(name))) {
          await this._unlinkQuiet(path.join(rec.outDir, name));
        }
      }
    }
    if (IMAGE_QUALITIES.includes(rec.item.quality)) await this._cleanupGalleryFolder(rec);
  }

  /** Directories this item may legitimately delete from: the folder it was started in and the configured one. */
  _roots(rec) {
    return [rec.outDir, this._cfg().downloadDir].filter((d) => typeof d === 'string' && d);
  }

  /**
   * Resolve `dir` and return it only when it is a real directory (not a symlink) that lies strictly inside
   * one of the download roots, also after resolving symlinks. Otherwise null.
   */
  async _safeItemDir(rec, dir) {
    if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return null;
    try {
      const st = await fs.promises.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
      const realDir = await fs.promises.realpath(dir);
      for (const root of this._roots(rec)) {
        if (!strictlyInside(root, dir)) continue;
        let realRoot;
        try { realRoot = await fs.promises.realpath(root); } catch (_) { continue; }
        if (strictlyInside(realRoot, realDir)) return realDir;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  /** Remove leftover .part files inside the item's folder, then the folder itself when it is empty. */
  async _cleanupGalleryFolder(rec) {
    let folder = rec.item.folder;
    if (!folder && rec.vid) {
      // folder not reported yet: gallery-dl names it "<Site> <post id>" inside the download dir
      try {
        const names = await fs.promises.readdir(rec.outDir);
        const hit = names.find((n) => new RegExp('^[A-Za-z]+ ' + rec.vid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').test(n));
        if (hit) folder = path.join(rec.outDir, hit);
      } catch (_) { /* ignore */ }
    }
    const dir = await this._safeItemDir(rec, folder);
    if (!dir) return;
    let names;
    try { names = await fs.promises.readdir(dir); } catch (_) { return; }
    for (const name of names) {
      if (PARTIAL_RE.test(name)) await this._unlinkQuiet(path.join(dir, name));
    }
    await this._rmdirIfEmpty(dir);
  }

  async _rmdirIfEmpty(dir) {
    try {
      if ((await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir); // rmdir never removes a non-empty dir
    } catch (_) { /* leave it */ }
  }

  /**
   * Where `file` may be deleted: the real path of its parent directory must lie inside (or be) one of the
   * item's download roots (the folder the item was started in, the configured download folder), after
   * resolving symlinks. A tampered downloads.json therefore cannot make LinkGrab delete arbitrary files.
   * Returns the path to unlink (real parent + file name), or null when the file must be left alone.
   */
  async _safeFileTarget(rec, file) {
    if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file)) return null;
    const base = path.basename(file);
    if (!base || base === '.' || base === '..') return null;
    let realParent;
    try { realParent = await fs.promises.realpath(path.dirname(file)); } catch (_) { return null; }
    for (const root of this._roots(rec)) {
      if (path.parse(path.resolve(root)).root === path.resolve(root)) continue; // never trust "/" or "C:\" as a root
      let realRoot;
      try { realRoot = await fs.promises.realpath(root); } catch (_) { continue; }
      const rel = path.relative(realRoot, realParent);
      if (rel === '' || (!/^\.\.([\\/]|$)/.test(rel) && !path.isAbsolute(rel))) return path.join(realParent, base);
    }
    return null;
  }

  /** Delete every file the item lists (and its filePath), then the item's folder if that is now empty and safe. */
  async _deleteItemFiles(rec) {
    const item = rec.item;
    const targets = new Set(cleanFiles(item.files));
    if (item.filePath && item.status === 'completed') for (const f of cleanFiles([item.filePath])) targets.add(f);
    for (const f of targets) {
      const target = await this._safeFileTarget(rec, f);
      if (!target) continue; // outside every download root: skip
      try {
        const st = await fs.promises.lstat(target);
        if (st.isDirectory()) continue; // only ever delete files (or a symlink itself), never directories
      } catch (_) {
        continue;
      }
      await this._unlinkQuiet(target);
    }
    if (item.kind !== 'video' || item.files.length > 1) {
      if (item.folder) {
        const dir = await this._safeItemDir(rec, item.folder);
        if (dir) {
          let names = [];
          try { names = await fs.promises.readdir(dir); } catch (_) { /* gone */ }
          for (const name of names) {
            if (PARTIAL_RE.test(name)) await this._unlinkQuiet(path.join(dir, name));
          }
          await this._rmdirIfEmpty(dir);
        }
      }
    }
  }
}

module.exports = { DownloadQueue, ACTIVE, PARTIAL_RE, QUALITIES, MAX_FILES, supportsImages };
