'use strict';
// Service wiring + the implementation behind every window.api method.
// Pure Node: everything that needs electron (dialogs, shell, clipboard) is injected via `host`.

const fs = require('node:fs');
const path = require('node:path');
const sites = require('./sites');
const ytdlp = require('./ytdlp');
const { Settings } = require('./settings');
const { createEngine } = require('./engine');
const { DownloadQueue, supportsImages } = require('./queue');
const { createGalleryRunner } = require('./gallerydl');
const { createRouter } = require('./router');

const IMAGE_QUALITIES = ['images', 'media'];
const NO_IMAGES_MESSAGE = 'Image downloads are only available for X and Instagram posts.';
const NO_GALLERYDL_MESSAGE = 'Image downloads need the image engine. Click Install engine in the banner.';

const BLOCKED_OPEN_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.lnk', '.url', '.hta', '.jar', '.reg', '.dll', '.cpl', '.sh', '.appimage', '.app', '.command', '.desktop',
  '.pif', '.msc', '.msp', '.mst', '.ws', '.wsc', '.sct', '.scf', '.inf', '.psc1', '.application', '.gadget',
  '.appx', '.msix', '.appinstaller', '.vb', '.library-ms', '.search-ms', '.settingcontent-ms',
]);

/**
 * True when the file's extension is on the do-not-open list. Windows ignores trailing dots and spaces
 * ("setup.exe." / "setup.exe " still run) and an NTFS stream suffix ("a.exe:x"), so those are stripped first.
 */
function isBlockedToOpen(file) {
  const name = String(file).split(/[\\/]/).pop();
  return [name, name.split(':')[0]].some((n) => BLOCKED_OPEN_EXT.has(path.extname(n.replace(/[. ]+$/, '')).toLowerCase()));
}
const INFO_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{userDataDir:string, defaultDownloadDir?:string, onEngineProgress?:Function, platform?:string}} o
 */
function createServices(o) {
  const settings = new Settings({
    filePath: path.join(o.userDataDir, 'settings.json'),
    defaultDownloadDir: o.defaultDownloadDir,
  });
  const engine = createEngine({
    binDir: path.join(o.userDataDir, 'bin'),
    onProgress: o.onEngineProgress,
    platform: o.platform,
  });
  const runner = ytdlp.createRunner({
    getBinary: () => engine.getYtdlpPath(),
    getFfmpeg: () => engine.getFfmpegPath(),
  });
  const gallery = createGalleryRunner({
    getBinary: () => (typeof engine.getGallerydlPath === 'function' ? engine.getGallerydlPath() : null),
    getFfmpeg: () => engine.getFfmpegPath(),
  });
  const router = createRouter({ ytdlp: runner, gallery, getSiteOf: sites.detectSite });
  const queue = new DownloadQueue({
    ytdlp: router,
    settings,
    storePath: path.join(o.userDataDir, 'downloads.json'),
  });
  settings.on('change', () => queue.pump());
  return { settings, engine, runner, gallery, router, queue };
}

const fail = (e) => ({ ok: false, error: e && e.message ? e.message : String(e) });

/**
 * @param {{settings,engine,runner,queue,router?,gallery?}} services
 * @param {{openPath:(p:string)=>Promise<string>, showItemInFolder:(p:string)=>void,
 *          readClipboardText:()=>string, chooseFolder:(current:string)=>Promise<string|null>}} host
 */
function createApi(services, host) {
  const { settings, engine, queue } = services;
  const infoSource = services.router || services.runner; // router merges yt-dlp + gallery-dl info
  const infoCache = new Map(); // url -> { at, info }

  const cached = (url) => {
    const c = infoCache.get(url);
    if (c && Date.now() - c.at < INFO_TTL_MS) return c.info;
    infoCache.delete(url);
    return null;
  };

  const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length < 200;

  const imageQualityError = (site, quality) =>
    (IMAGE_QUALITIES.includes(quality) && !supportsImages(site) ? NO_IMAGES_MESSAGE : null);

  /** @param {string} url  @param {string} [quality] optional: lets the caller ask whether this quality is possible */
  async function getInfo(url, quality) {
    try {
      const v = sites.validateUrl(url);
      if (!v.ok) return v;
      const qErr = imageQualityError(v.site, quality);
      if (qErr) return { ok: false, error: qErr };
      const hit = cached(v.url);
      if (hit) return { ok: true, info: hit };
      const res = await infoSource.getInfo(v.url, { cookiesFrom: settings.get().cookiesFrom });
      if (res.ok) {
        infoCache.set(v.url, { at: Date.now(), info: res.info });
        if (infoCache.size > 50) infoCache.delete(infoCache.keys().next().value);
      }
      return res;
    } catch (e) {
      return fail(e);
    }
  }

  async function add(url, quality) {
    try {
      const v = sites.validateUrl(url);
      if (!v.ok) return v;
      const q = quality || 'best';
      const qErr = imageQualityError(v.site, q);
      if (qErr) return { ok: false, error: qErr };
      if (IMAGE_QUALITIES.includes(q)) {
        if (typeof engine.getGallerydlPath !== 'function' || !engine.getGallerydlPath()) {
          return { ok: false, error: NO_GALLERYDL_MESSAGE };
        }
      } else if (!engine.getYtdlpPath()) {
        return { ok: false, error: 'yt-dlp is not installed yet. Click Install in the engine setup banner first.' };
      }
      const info = cached(v.url);
      let meta;
      if (info) {
        meta = { title: info.title, thumbnail: info.thumbnail };
        if (IMAGE_QUALITIES.includes(q)) {
          meta.kind = info.kind;
          const imgs = Number(info.imageCount) || 0;
          const vids = Number(info.videoCount) || 0;
          const n = q === 'images' ? imgs : imgs + vids;
          if (n > 0) meta.fileCount = n;
        }
      }
      const item = queue.add(v.url, q, meta);
      return { ok: true, item };
    } catch (e) {
      return fail(e);
    }
  }

  const wrapId = (fn) => async (id) => {
    try {
      if (!isStr(id)) return { ok: false, error: 'Missing download id.' };
      const r = await fn(id);
      return r && typeof r === 'object' && 'ok' in r ? r : { ok: true };
    } catch (e) {
      return fail(e);
    }
  };

  function fileOf(id) {
    const item = queue.get(id);
    if (!item) return { error: 'Download not found.' };
    const first = (Array.isArray(item.files) && item.files[0]) || item.filePath;
    if (item.status !== 'completed' || !first) return { item, error: 'The file is not ready yet.' };
    if (!fs.existsSync(first)) return { item, error: 'The file no longer exists on disk (moved or deleted).' };
    return { item, file: first };
  }

  const isDir = (p) => {
    try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
  };

  async function openFile(id) {
    try {
      if (!isStr(id)) return { ok: false, error: 'Missing download id.' };
      const f = fileOf(id);
      if (!f.file) return { ok: false, error: f.error };
      if (isBlockedToOpen(f.file)) {
        return { ok: false, error: 'For safety LinkGrab will not open this type of file. Use "Show in folder" instead.' };
      }
      const err = await host.openPath(f.file);
      return err ? { ok: false, error: String(err) } : { ok: true };
    } catch (e) {
      return fail(e);
    }
  }

  /** With a completed item: reveal the file. With no/unknown id: open the download folder. */
  async function showInFolder(id) {
    try {
      const f = isStr(id) ? fileOf(id) : {};
      if (f.file) {
        host.showItemInFolder(f.file);
        return { ok: true };
      }
      const item = f.item || (isStr(id) ? queue.get(id) : null);
      if (item) {
        // not finished (or file gone): reveal the first file that already exists, else open the item's folder
        const first = (Array.isArray(item.files) && item.files[0]) || null;
        if (first && fs.existsSync(first)) {
          host.showItemInFolder(first);
          return { ok: true };
        }
        const folder = item.folder;
        if (folder && isDir(folder)) {
          const err = await host.openPath(folder);
          return err ? { ok: false, error: String(err) } : { ok: true };
        }
      }
      const dir = settings.get().downloadDir;
      fs.mkdirSync(dir, { recursive: true });
      const err = await host.openPath(dir);
      return err ? { ok: false, error: String(err) } : { ok: true };
    } catch (e) {
      return fail(e);
    }
  }

  async function chooseFolder() {
    try {
      const picked = await host.chooseFolder(settings.get().downloadDir);
      return typeof picked === 'string' && picked ? picked : null;
    } catch (_) {
      return null;
    }
  }

  async function readClipboardUrl() {
    try {
      const text = host.readClipboardText();
      const urls = sites.extractUrls(typeof text === 'string' ? text.slice(0, 20000) : '');
      return urls[0] || null;
    } catch (_) {
      return null;
    }
  }

  async function engineStatus() {
    try {
      const st = await engine.status();
      if (st && typeof st === 'object' && !st.gallerydl) {
        const p = typeof engine.getGallerydlPath === 'function' ? engine.getGallerydlPath() : null;
        st.gallerydl = { installed: !!p, version: null, path: p || null };
      }
      return st;
    } catch (_) {
      return {
        ytdlp: { installed: false, version: null, path: null },
        ffmpeg: { installed: false, path: null },
        gallerydl: { installed: false, version: null, path: null },
      };
    }
  }

  return {
    getInfo,
    add,
    async list() { try { return queue.list(); } catch (_) { return []; } },
    pause: wrapId((id) => queue.pause(id)),
    resume: wrapId((id) => queue.resume(id)),
    cancel: wrapId((id) => queue.cancel(id)),
    async remove(id, deleteFile) {
      try {
        if (!isStr(id)) return { ok: false, error: 'Missing download id.' };
        return await queue.remove(id, deleteFile === true);
      } catch (e) {
        return fail(e);
      }
    },
    openFile,
    showInFolder,
    async getSettings() { return settings.get(); },
    async setSettings(partial) {
      try {
        return settings.set(partial && typeof partial === 'object' ? partial : {});
      } catch (_) {
        return settings.get();
      }
    },
    chooseFolder,
    engineStatus,
    async installEngine() {
      const r = await engine.install();
      queue.pump();
      return r;
    },
    async updateEngine() { return engine.update(); },
    readClipboardUrl,
  };
}

/** Names of every window.api method that has a matching 'api:<name>' IPC channel. */
const API_METHODS = [
  'getInfo', 'add', 'list', 'pause', 'resume', 'cancel', 'remove', 'openFile', 'showInFolder',
  'getSettings', 'setSettings', 'chooseFolder', 'engineStatus', 'installEngine', 'updateEngine', 'readClipboardUrl',
];

module.exports = { createServices, createApi, API_METHODS, BLOCKED_OPEN_EXT, isBlockedToOpen, NO_IMAGES_MESSAGE, NO_GALLERYDL_MESSAGE };
