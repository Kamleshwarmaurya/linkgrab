'use strict';
// Locate / install / update the yt-dlp, ffmpeg and gallery-dl binaries.
// Pure Node: the app data directory is injected (binDir), electron is never required here.
// Only yt-dlp, ffmpeg and gallery-dl (verified with --version / -version) are ever executed by this module.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { runCapture } = require('./ytdlp');
const zip = require('./zip');

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFMPEG_WIN_ZIP = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const LATEST_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
// gallery-dl (image engine). Standalone binaries have been published in two places:
//  - mikf/gallery-dl releases: gallery-dl.exe / gallery-dl.bin (older releases; verified absent from
//    v1.32.x, where /releases/latest/download/gallery-dl.exe answers 404)
//  - gdl-org/builds releases (the project's own binary builds): gallery-dl_windows.exe / gallery-dl_linux
// The installer therefore tries, in order: the asset list of the latest mikf release, the plain
// latest/download URL, then the gdl-org/builds binary.
const GALLERYDL_RELEASE_API = 'https://api.github.com/repos/mikf/gallery-dl/releases/latest';
const GALLERYDL_BASE = 'https://github.com/mikf/gallery-dl/releases/latest/download/';
const GALLERYDL_BUILDS_BASE = 'https://github.com/gdl-org/builds/releases/latest/download/';
const UA = 'LinkGrab/1.0 (+https://github.com/yt-dlp/yt-dlp)';

// ---------------------------------------------------------------- HTTP helpers

/**
 * Download a URL to a file following up to `maxRedirects` redirects.
 * https only unless opts.allowHttp (used by tests against a local server).
 */
function downloadFile(url, dest, opts) {
  const o = opts || {};
  const maxRedirects = o.maxRedirects === undefined ? 5 : o.maxRedirects;
  return new Promise((resolve, reject) => {
    const go = (current, redirectsLeft) => {
      let u;
      try { u = new URL(current); } catch (e) { return reject(new Error('Invalid download URL')); }
      const isHttps = u.protocol === 'https:';
      if (!isHttps && !(o.allowHttp && u.protocol === 'http:')) return reject(new Error('Refusing non-https download URL'));
      const mod = isHttps ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          let next;
          try { next = new URL(res.headers.location, u).href; } catch (e) { return reject(new Error('Bad redirect')); }
          return go(next, redirectsLeft - 1);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`Download failed (HTTP ${code})`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        let lastCb = 0;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        const fail = (err) => {
          out.destroy();
          fs.rm(dest, { force: true }, () => reject(err));
        };
        res.on('data', (chunk) => {
          got += chunk.length;
          if (o.onProgress) {
            const now = Date.now();
            if (now - lastCb > 120) {
              lastCb = now;
              o.onProgress(got, total);
            }
          }
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Connection lost during download')));
        out.on('error', fail);
        let complete = false;
        out.on('finish', () => {
          if (total && got !== total) return fail(new Error('Download was incomplete'));
          complete = true;
        });
        // Resolve on 'close' (fd released), not 'finish': executing the file while the write
        // descriptor is still open fails intermittently with ETXTBSY on Linux.
        out.on('close', () => {
          if (!complete) return;
          if (o.onProgress) o.onProgress(got, total);
          resolve();
        });
        res.pipe(out);
      });
      req.setTimeout(o.timeoutMs || 30000, () => req.destroy(new Error('Connection timed out')));
      req.on('error', reject);
    };
    go(url, maxRedirects);
  });
}

function getJson(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' && o.allowHttp ? http : https;
    if (u.protocol !== 'https:' && !(o.allowHttp && u.protocol === 'http:')) return reject(new Error('Refusing non-https URL'));
    const req = mod.get(u, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 5e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.setTimeout(o.timeoutMs || 15000, () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
  });
}

/**
 * Pick the standalone gallery-dl asset out of a GitHub release asset list.
 * Pure function (exported for tests). Returns the https download URL or null.
 * @param {Array<{name:string, browser_download_url:string}>} assets
 * @param {{platform?:string, arch?:string}} [opts]
 */
function pickGallerydlAsset(assets, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  if (!Array.isArray(assets)) return null;
  const list = assets.filter((a) => a && typeof a.name === 'string'
    && typeof a.browser_download_url === 'string' && /^https:\/\/github\.com\//.test(a.browser_download_url));
  const byName = (re) => list.find((a) => re.test(a.name));
  let hit = null;
  if (platform === 'win32') {
    hit = byName(/^gallery-dl\.exe$/i)
      || (arch === 'ia32' ? byName(/^gallery-dl.*(x86|win32).*\.exe$/i) : null)
      || byName(/^gallery-dl[_-]?(windows|win|win64|x64)?\.exe$/i);
  } else if (platform === 'linux') {
    hit = byName(/^gallery-dl\.bin$/i) || byName(/^gallery-dl[_-]linux(\.bin)?$/i);
  }
  return hit ? hit.browser_download_url : null;
}

// ---------------------------------------------------------------- engine

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {{binDir:string, onProgress?:(p:{stage:string,percent:number,message:string})=>void, platform?:string, arch?:string}} opts
 */
function createEngine(opts) {
  const o = opts || {};
  if (!o.binDir) throw new Error('createEngine needs binDir');
  const binDir = o.binDir;
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const win = platform === 'win32';
  const exeExt = win ? '.exe' : '';
  const ytdlpName = 'yt-dlp' + exeExt;
  const ffmpegName = 'ffmpeg' + exeExt;
  const ffprobeName = 'ffprobe' + exeExt;
  const gallerydlName = 'gallery-dl' + exeExt;
  const versionCache = new Map();
  let installing = null;
  let updating = null;

  const emit = (stage, percent, message) => {
    if (!o.onProgress) return;
    try { o.onProgress({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message }); } catch (_) { /* ignore */ }
  };

  function searchPath(name) {
    const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
      const p = path.join(d.replace(/^"|"$/g, ''), name);
      if (isExecutableFile(p)) return p;
    }
    return null;
  }

  function locate(envVar, name) {
    const fromEnv = process.env[envVar];
    if (fromEnv && path.isAbsolute(fromEnv) && isExecutableFile(fromEnv)) return { path: fromEnv, source: 'env' };
    const own = path.join(binDir, name);
    if (isExecutableFile(own)) return { path: own, source: 'userData' };
    const onPath = searchPath(name);
    if (onPath) return { path: onPath, source: 'path' };
    return null;
  }

  const findYtdlp = () => locate('LINKGRAB_YTDLP', ytdlpName);
  const findFfmpeg = () => locate('LINKGRAB_FFMPEG', ffmpegName);
  const getYtdlpPath = () => { const f = findYtdlp(); return f ? f.path : null; };
  const getFfmpegPath = () => { const f = findFfmpeg(); return f ? f.path : null; };
  const findGallerydl = () => locate('LINKGRAB_GALLERYDL', gallerydlName);
  /** Sync lookup: env LINKGRAB_GALLERYDL, then userData/bin, then PATH. null when not found. */
  const getGallerydlPath = () => { const g = findGallerydl(); return g ? g.path : null; };

  async function versionOf(binary, args, parse) {
    let key;
    try { key = binary + ':' + fs.statSync(binary).mtimeMs; } catch (_) { return null; }
    if (versionCache.has(key)) return versionCache.get(key);
    const r = await runCapture(binary, args, { timeoutMs: 20000 });
    if (r.code !== 0) return null;
    const v = parse(r.stdout);
    if (v) versionCache.set(key, v);
    return v;
  }

  const ytdlpVersion = (p) => versionOf(p, ['--version'], (s) => {
    const m = /^(\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?)/m.exec(s.trim());
    return m ? m[1] : null;
  });
  const ffmpegVersion = (p) => versionOf(p, ['-version'], (s) => {
    const m = /ffmpeg version (\S+)/i.exec(s);
    return m ? m[1] : null;
  });

  const parseGallerydlVersion = (s) => {
    const m = /^(\d+\.\d+\.\d+\S*)/m.exec(String(s || '').trim());
    return m ? m[1] : null;
  };
  const gallerydlVersion = (p) => versionOf(p, ['--version'], parseGallerydlVersion);

  async function status() {
    const y = findYtdlp();
    const f = findFfmpeg();
    const g = findGallerydl();
    const yv = y ? await ytdlpVersion(y.path) : null;
    const gv = g ? await gallerydlVersion(g.path) : null;
    return {
      ytdlp: { installed: !!(y && yv), version: yv || null, path: y ? y.path : null },
      ffmpeg: { installed: !!f, path: f ? f.path : null },
      gallerydl: { installed: !!(g && gv), version: gv || null, path: g ? g.path : null },
    };
  }

  // -------- install

  function ytdlpAssetName() {
    if (win) return arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
    if (platform === 'darwin') return 'yt-dlp_macos';
    return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  }

  async function installYtdlp(overrideUrl, allowHttp) {
    const url = overrideUrl || YTDLP_BASE + ytdlpAssetName();
    const tmp = path.join(binDir, 'yt-dlp.new' + exeExt);
    const finalPath = path.join(binDir, ytdlpName);
    emit('ytdlp', 0, 'Downloading yt-dlp...');
    await downloadFile(url, tmp, {
      allowHttp,
      onProgress: (got, total) => emit('ytdlp', total ? (got / total) * 95 : 50, `Downloading yt-dlp... ${(got / 1048576).toFixed(1)} MB`),
    });
    try {
      try { fs.chmodSync(tmp, 0o755); } catch (_) { /* not meaningful on Windows */ }
      emit('ytdlp', 96, 'Verifying yt-dlp...');
      const r = await runCapture(tmp, ['--version'], { timeoutMs: 30000 });
      if (r.code !== 0 || !/^\d{4}\.\d{1,2}\.\d{1,2}/.test(r.stdout.trim())) {
        throw new Error('The downloaded yt-dlp did not run correctly.');
      }
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    versionCache.clear();
    emit('ytdlp', 100, 'yt-dlp is ready');
  }

  async function installFfmpegWindows(overrideUrl, allowHttp) {
    const zipPath = path.join(binDir, 'ffmpeg.zip.download');
    emit('ffmpeg', 0, 'Downloading ffmpeg...');
    try {
      await downloadFile(overrideUrl || FFMPEG_WIN_ZIP, zipPath, {
        allowHttp,
        timeoutMs: 60000,
        onProgress: (got, total) => emit('ffmpeg', total ? (got / total) * 85 : 40, `Downloading ffmpeg... ${(got / 1048576).toFixed(0)} MB`),
      });
      emit('ffmpeg', 88, 'Extracting ffmpeg...');
      const extracted = await zip.extractByBasename(zipPath, {
        [ffmpegName]: path.join(binDir, ffmpegName),
        [ffprobeName]: path.join(binDir, ffprobeName),
      });
      if (!extracted.includes(ffmpegName.toLowerCase())) throw new Error('ffmpeg.exe was not found in the downloaded archive.');
      for (const n of [ffmpegName, ffprobeName]) {
        try { fs.chmodSync(path.join(binDir, n), 0o755); } catch (_) { /* absent or not meaningful on Windows */ }
      }
    } finally {
      fs.rmSync(zipPath, { force: true });
    }
    emit('ffmpeg', 97, 'Verifying ffmpeg...');
    versionCache.clear();
    const v = await ffmpegVersion(path.join(binDir, ffmpegName));
    if (!v) throw new Error('The downloaded ffmpeg did not run correctly.');
    emit('ffmpeg', 100, 'ffmpeg is ready');
  }

  /** Why gallery-dl cannot be fetched automatically on this platform, or null when it can. */
  function gallerydlUnsupportedNote() {
    if (platform === 'darwin') return 'Image downloads need gallery-dl, which is not installed automatically on macOS. Install it with Homebrew (brew install gallery-dl) and restart LinkGrab.';
    if (!win && platform !== 'linux') return 'Image downloads need gallery-dl, which is not installed automatically on this system.';
    if (!win && arch !== 'x64') return 'Image downloads need gallery-dl, which has no ready-made download for this CPU. Install it with pip (pip install gallery-dl).';
    return null;
  }

  /**
   * Ordered download sources for the standalone gallery-dl binary (async resolvers, tried lazily so
   * a working first source costs no extra requests). `t` carries the unit-test overrides.
   */
  function gallerydlSources(t) {
    if (t.gallerydlUrl) return [].concat(t.gallerydlUrl).map((u) => async () => u);
    return [];
  }

  async function resolveGallerydlFromApi(apiUrl, allowHttp) {
    const rel = await getJson(apiUrl, { allowHttp, timeoutMs: 8000 });
    return pickGallerydlAsset(rel && rel.assets, { platform, arch });
  }

  async function installGallerydl(t) {
    const tmp = path.join(binDir, 'gallery-dl.new' + exeExt);
    const finalPath = path.join(binDir, gallerydlName);
    const allowHttp = t.allowHttp;
    const plain = (win ? GALLERYDL_BASE + 'gallery-dl.exe' : GALLERYDL_BASE + 'gallery-dl.bin');
    const builds = (win ? GALLERYDL_BUILDS_BASE + 'gallery-dl_windows.exe' : GALLERYDL_BUILDS_BASE + 'gallery-dl_linux');
    const sources = gallerydlSources(t);
    if (!t.gallerydlUrl) {
      sources.push(() => resolveGallerydlFromApi(t.gallerydlApi || GALLERYDL_RELEASE_API, allowHttp));
      sources.push(async () => plain);
      sources.push(async () => builds);
    } else if (t.gallerydlApi) {
      sources.push(() => resolveGallerydlFromApi(t.gallerydlApi, allowHttp));
    }
    emit('gallerydl', 0, 'Downloading gallery-dl...');
    const tried = new Set();
    const problems = [];
    for (const getUrl of sources) {
      let url;
      try { url = await getUrl(); } catch (e) { problems.push(e && e.message ? e.message : String(e)); continue; }
      if (!url || tried.has(url)) continue;
      tried.add(url);
      try {
        await downloadFile(url, tmp, {
          allowHttp,
          timeoutMs: 60000,
          onProgress: (got, total) => emit('gallerydl', total ? (got / total) * 95 : 50, `Downloading gallery-dl... ${(got / 1048576).toFixed(1)} MB`),
        });
        try { fs.chmodSync(tmp, 0o755); } catch (_) { /* not meaningful on Windows */ }
        emit('gallerydl', 96, 'Verifying gallery-dl...');
        const r = await runCapture(tmp, ['--version'], { timeoutMs: 30000 });
        if (r.code !== 0 || !parseGallerydlVersion(r.stdout)) {
          throw new Error('The downloaded gallery-dl did not run correctly.');
        }
        fs.renameSync(tmp, finalPath);
        versionCache.clear();
        emit('gallerydl', 100, 'gallery-dl is ready');
        return;
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        problems.push(e && e.message ? e.message : String(e));
      }
    }
    throw new Error(problems.length ? problems[problems.length - 1] : 'no download was available');
  }

  /** Best effort: resolves a note string when gallery-dl could not be provided, otherwise undefined. */
  async function ensureGallerydl(t, force) {
    if (!force && findGallerydl()) {
      emit('gallerydl', 100, 'gallery-dl already installed');
      return undefined;
    }
    const unsupported = gallerydlUnsupportedNote();
    if (unsupported) {
      emit('gallerydl', 100, unsupported);
      return unsupported;
    }
    try {
      await installGallerydl(t);
      return undefined;
    } catch (e) {
      const note = `Videos will work, but image downloads need the image engine (gallery-dl), which could not be installed: ${e && e.message ? e.message : e}`;
      emit('gallerydl', 100, note);
      return note;
    }
  }

  /**
   * Install whatever is missing. Resolves { ok, error?, note? }.
   * A gallery-dl failure never fails the install (ok:true with a note).
   * `testOverrides` ({ytdlpUrl, ffmpegUrl, gallerydlUrl, gallerydlApi, allowHttp}) exists for unit tests only.
   */
  function install(testOverrides) {
    if (installing) return installing;
    const t = testOverrides || {};
    installing = (async () => {
      try {
        fs.mkdirSync(binDir, { recursive: true });
        const notes = [];
        if (!findYtdlp()) {
          await installYtdlp(t.ytdlpUrl, t.allowHttp);
        } else {
          emit('ytdlp', 100, 'yt-dlp already installed');
        }
        if (!findFfmpeg()) {
          if (win) {
            await installFfmpegWindows(t.ffmpegUrl, t.allowHttp);
          } else {
            const n = 'ffmpeg was not found. Install it with your package manager (for example: sudo apt install ffmpeg) so videos can be merged.';
            notes.push(n);
            emit('ffmpeg', 100, n);
          }
        } else {
          emit('ffmpeg', 100, 'ffmpeg already installed');
        }
        const gnote = await ensureGallerydl(t, false);
        if (gnote) notes.push(gnote);
        return notes.length ? { ok: true, note: notes.join(' ') } : { ok: true };
      } catch (e) {
        return { ok: false, error: `Engine setup failed: ${e && e.message ? e.message : e}` };
      }
    })();
    // cleared after the promise is stored, so a fully synchronous run cannot leave a stale entry
    const p = installing;
    p.then(() => { if (installing === p) installing = null; });
    return p;
  }

  // -------- update

  /** Compare installed yt-dlp with the latest GitHub release. Resolves { current, latest, updateAvailable }. */
  async function checkUpdate() {
    const p = getYtdlpPath();
    const current = p ? await ytdlpVersion(p) : null;
    const rel = await getJson(LATEST_API);
    const latest = String(rel.tag_name || '').trim();
    const norm = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
    const a = norm(current);
    const b = norm(latest);
    let cmp = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && !cmp; i++) cmp = (a[i] || 0) - (b[i] || 0);
    return { current, latest, updateAvailable: !!latest && cmp < 0 };
  }

  function update(testOverrides) {
    if (updating) return updating;
    const t = testOverrides || {};
    updating = (async () => {
      try {
        const found = findYtdlp();
        if (!found) return { ok: false, error: 'yt-dlp is not installed yet.' };
        emit('ytdlp', 5, 'Updating yt-dlp...');
        const r = await runCapture(found.path, ['-U'], { timeoutMs: 180000 });
        let ok = r.code === 0 && !/^ERROR/im.test(r.stderr);
        if (!ok && found.source === 'userData') {
          // self-update failed (permissions, locked file...): fall back to a clean re-download
          await installYtdlpReplacing();
          ok = true;
        }
        if (!ok) {
          const msg = (r.stderr || r.stdout || '').trim().split('\n').pop() || 'update failed';
          return { ok: false, error: `Could not update yt-dlp: ${msg}` };
        }
        versionCache.clear();
        const p = getYtdlpPath();
        const version = p ? await ytdlpVersion(p) : null;
        emit('ytdlp', 100, version ? `yt-dlp ${version}` : 'yt-dlp updated');
        // gallery-dl: a copy LinkGrab installed is re-downloaded (latest); a missing one is installed;
        // one that comes from PATH / LINKGRAB_GALLERYDL belongs to the user and is left alone.
        // Trouble here never fails the yt-dlp update.
        const g = findGallerydl();
        let gnote;
        if (!g || g.source === 'userData') {
          fs.mkdirSync(binDir, { recursive: true });
          gnote = await ensureGallerydl(t, true);
        } else {
          emit('gallerydl', 100, 'gallery-dl is managed outside LinkGrab');
        }
        const gp = getGallerydlPath();
        const gv = gp ? await gallerydlVersion(gp) : null;
        const out = { ok: true };
        if (version) out.version = version;
        if (gv) out.gallerydlVersion = gv;
        if (gnote) out.note = gnote;
        return out;
      } catch (e) {
        return { ok: false, error: `Could not update yt-dlp: ${e && e.message ? e.message : e}` };
      }
    })();
    const p = updating;
    p.then(() => { if (updating === p) updating = null; });
    return p;
  }

  async function installYtdlpReplacing() {
    fs.mkdirSync(binDir, { recursive: true });
    await installYtdlp();
  }

  return {
    binDir,
    findYtdlp,
    findFfmpeg,
    getYtdlpPath,
    getFfmpegPath,
    findGallerydl,
    getGallerydlPath,
    status,
    install,
    update,
    checkUpdate,
    ytdlpAssetName,
  };
}

module.exports = {
  createEngine,
  downloadFile,
  getJson,
  pickGallerydlAsset,
  YTDLP_BASE,
  FFMPEG_WIN_ZIP,
  GALLERYDL_BASE,
  GALLERYDL_BUILDS_BASE,
  GALLERYDL_RELEASE_API,
};
