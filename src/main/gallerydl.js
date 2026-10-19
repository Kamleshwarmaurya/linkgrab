'use strict';
// gallery-dl runner (images and mixed posts from X / Instagram). Pure Node: must not require 'electron'.
// Never uses a shell; the URL is always the last argument after `--`; no user text ever becomes an option.
// Event/result shapes mirror ytdlp.createRunner (see runDownload there), plus `files` events and
// `files` / `folder` / `fileCount` on the final result.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ytdlp = require('./ytdlp');
const sites = require('./sites');

const MAX_FILES = 200;
const INFO_CACHE_MS = 10 * 60 * 1000;
const INFO_CACHE_MAX = 30;
const GENERIC_PREFIX = 'generic:';

const IMAGE_EXTS = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg'];
const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ts', 'mpg', 'mpeg', '3gp', 'gifv'];

const MISSING_MESSAGE = 'The image engine (gallery-dl) is not installed. Use the engine setup banner to install it.';
const NO_FILES_MESSAGE = 'No downloadable images or videos were found for this link.';
const LOGIN_HINT =
  'Open Settings and turn on "Use browser cookies" (pick the browser where you are signed in), then try again.';

// Metadata keys that identify a post / the person who made it, in order of preference.
const POST_KEYS = ['tweet_id', 'post_shortcode', 'post_id', 'shortcode', 'id', 'media_id', 'pk'];
const TEXT_KEYS = ['content', 'description', 'caption', 'title', 'text'];

// ---------------------------------------------------------------- small pure helpers

function extOf(meta, url) {
  let e = meta && typeof meta.extension === 'string' ? meta.extension : '';
  if (!e && typeof url === 'string') {
    try {
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(new URL(url).pathname);
      if (m) e = m[1];
    } catch (_) { /* ignore */ }
  }
  return e.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function kindOfExt(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return 'other';
}

/** Keep a value usable as a Windows-safe file/folder name part. */
function safeSegment(s, max) {
  const out = String(s === undefined || s === null ? '' : s)
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, max || 40);
  return out;
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

function siteLabel(site) {
  if (site === 'x') return 'X';
  if (site === 'instagram') return 'Instagram';
  if (site === 'test') return 'Test';
  const s = safeSegment(site, 20);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Gallery';
}

/**
 * Accepts a plain http(s) URL or the `generic:` + http(s) URL the router builds for the test hook.
 * @returns {{ok:true,url:string,arg:string,prefixed:boolean}|{ok:false,error:string}}
 */
function parseTarget(input) {
  if (typeof input !== 'string') return { ok: false, error: 'That is not a valid http(s) link.' };
  let s = input.trim();
  let prefixed = false;
  if (s.toLowerCase().startsWith(GENERIC_PREFIX)) {
    prefixed = true;
    s = s.slice(GENERIC_PREFIX.length);
  }
  const u = sites.parseHttpUrl(s);
  if (!u) return { ok: false, error: 'That is not a valid http(s) link.' };
  return { ok: true, url: u.href, arg: (prefixed ? GENERIC_PREFIX : '') + u.href, prefixed };
}

function pyList(items) {
  return '(' + items.map((x) => `'${x}'`).join(',') + ',)';
}

/** Python expression for `--filter` (only fixed constants end up in it). */
function filterExpr(quality) {
  const exts = quality === 'images' ? IMAGE_EXTS : IMAGE_EXTS.concat(VIDEO_EXTS);
  return `str(extension).lower() in ${pyList(exts)}`;
}

function wanted(quality, ext) {
  const k = kindOfExt(ext);
  return quality === 'images' ? k === 'image' : k !== 'other';
}

function pickString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function firstLine(s, max) {
  const t = pickString(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function userOf(meta) {
  if (!meta) return '';
  const cands = [
    meta.author && (meta.author.name || meta.author.nick),
    meta.user && typeof meta.user === 'object' ? meta.user.name || meta.user.nick || meta.user.username : meta.user,
    meta.username,
    meta.owner && meta.owner.username,
    meta.uploader,
    meta.fullname,
  ];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}

function displayNameOf(meta) {
  if (!meta) return '';
  const cands = [meta.author && meta.author.nick, meta.fullname, meta.user && meta.user.nick, userOf(meta)];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}

// ---------------------------------------------------------------- parsing `gallery-dl -j`

/**
 * Parse the JSON array printed by `gallery-dl -j` (message type 2 = directory, 3 = file, 6 = queued URL,
 * -1 = error). Note that gallery-dl exits 0 even when it dumps errors.
 * @returns {{ok:boolean, files:object[], dir:object|null, errors:string[], queued:number}}
 */
function parseDump(stdout) {
  const out = { ok: false, files: [], dir: null, errors: [], queued: 0 };
  let arr;
  try {
    arr = JSON.parse(String(stdout || '').trim() || '[]');
  } catch (_) {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  out.ok = true;
  for (const e of arr) {
    if (!Array.isArray(e)) continue;
    if (e[0] === 2 && e[1] && typeof e[1] === 'object') {
      if (!out.dir) out.dir = e[1];
    } else if (e[0] === 3 && typeof e[1] === 'string') {
      const meta = e[2] && typeof e[2] === 'object' ? e[2] : {};
      out.files.push({ url: e[1], meta, ext: extOf(meta, e[1]) });
    } else if (e[0] === 6) {
      out.queued += 1;
    } else if (e[0] === -1 && e[1]) {
      const m = e[1];
      out.errors.push(`${m.error || 'Error'}: ${m.message || ''}`.trim());
    }
  }
  return out;
}

function numOf(meta) {
  const n = Number(meta && meta.num);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Which metadata key (if any) identifies the post in every one of these files. */
function postKeyOf(files) {
  if (!files.length) return null;
  for (const k of POST_KEYS) {
    if (files.every((f) => f.meta[k] !== undefined && f.meta[k] !== null && String(f.meta[k]) !== '')) return k;
  }
  return null;
}

/** Counts, thumbnails and descriptive text for a (already filtered) file list. */
function describeFiles(files, site, url) {
  const images = files.filter((f) => kindOfExt(f.ext) === 'image');
  const videos = files.filter((f) => kindOfExt(f.ext) === 'video');
  const first = files[0] ? files[0].meta : {};
  const postKey = postKeyOf(files);
  const posts = postKey ? Array.from(new Set(files.map((f) => String(f.meta[postKey])))) : [];
  const user = userOf(first);
  let text = '';
  for (const k of TEXT_KEYS) {
    text = firstLine(first[k], 120);
    if (text) break;
  }
  const label = siteLabel(site);
  const idPart = posts.length === 1 ? posts[0] : '';
  const title = text || [displayNameOf(first) || user, idPart].filter(Boolean).join(' - ') || `${label} post`;
  const thumbs = [];
  for (const f of images) {
    if (thumbs.length >= 6) break;
    if (/^https?:\/\//i.test(f.url) && !thumbs.includes(f.url)) thumbs.push(f.url);
  }
  return {
    title,
    uploader: displayNameOf(first) || user,
    imageCount: images.length,
    videoCount: videos.length,
    thumbnails: thumbs,
    postKey,
    posts,
    user,
    url,
  };
}

function qualitiesFor(imageCount, videoCount) {
  const total = imageCount + videoCount;
  if (imageCount && videoCount) {
    return [
      { key: 'media', label: `Everything (${total} files)` },
      { key: 'images', label: `Images only (${imageCount})` },
    ];
  }
  if (imageCount) return [{ key: 'images', label: `Images (${imageCount})` }];
  return [{ key: 'media', label: videoCount > 1 ? `Videos (${videoCount})` : 'Video (original quality)' }];
}

function kindFor(imageCount, videoCount) {
  if (imageCount && videoCount) return 'mixed';
  return imageCount ? 'image' : 'video';
}

function infoFromDump(dump, o) {
  const files = dump.files.filter((f) => kindOfExt(f.ext) !== 'other').slice(0, MAX_FILES);
  const d = describeFiles(files, o.site, o.url);
  return {
    title: d.title,
    thumbnail: d.thumbnails[0] || '',
    duration: 0,
    uploader: d.uploader,
    site: o.site || null,
    qualities: qualitiesFor(d.imageCount, d.videoCount),
    kind: kindFor(d.imageCount, d.videoCount),
    imageCount: d.imageCount,
    videoCount: d.videoCount,
    fileCount: files.length,
    engine: 'gallery-dl',
    thumbnails: d.thumbnails,
  };
}

// ---------------------------------------------------------------- layout planning

/**
 * Decide where each file goes. Exactly 1 file -> `<outDir>/<Site> <postid>.<ext>` ;
 * more than 1 -> `<outDir>/<Site> <postid or user>/01.ext, 02.ext, ...`.
 * @param {{files:object[], site?:string, url:string, quality:string, outDir:string}} o
 * @returns {{ok:false,error:string}|{ok:true,total:number,mode:'single'|'folder',folder:string,dir:string,format:string,expected:string[],postKey:string|null}}
 */
function planDownload(o) {
  const quality = o.quality === 'images' ? 'images' : 'media';
  const sel = o.files.filter((f) => wanted(quality, f.ext)).slice(0, MAX_FILES);
  if (!sel.length) {
    return { ok: false, error: quality === 'images' ? 'No images were found in this post.' : NO_FILES_MESSAGE };
  }
  const label = siteLabel(o.site);
  const postKey = postKeyOf(sel);
  const posts = postKey ? Array.from(new Set(sel.map((f) => String(f.meta[postKey])))) : [];
  const user = safeSegment(userOf(sel[0].meta), 30);
  const postId = posts.length === 1 ? safeSegment(posts[0], 40) : '';

  if (sel.length === 1) {
    const id = postId || user || shortHash(o.url);
    const ext = sel[0].ext || 'bin';
    const name = `${label} ${id}.${ext}`;
    return {
      ok: true, total: 1, mode: 'single', postKey, id,
      folder: o.outDir, dir: o.outDir,
      format: `${label} ${id}.{extension}`,
      expected: [path.join(o.outDir, name)],
    };
  }

  const id = postId || user || shortHash(o.url);
  const dirName = `${label} ${id}`;
  const dir = path.join(o.outDir, dirName);
  const nums = sel.map((f) => numOf(f.meta));
  const keyed = !!postKey && posts.length > 1;
  const keys = sel.map((f, i) => (keyed ? `${String(f.meta[postKey])}:${nums[i]}` : String(nums[i])));
  const usable = nums.every((n) => n !== null) && new Set(keys).size === keys.length &&
    (!keyed || sel.every((f) => /^[A-Za-z0-9_-]+$/.test(String(f.meta[postKey]))));
  const pad = (n) => String(n).padStart(2, '0');
  const expected = sel.map((f, i) => path.join(dir, `${pad(i + 1)}.${f.ext || 'bin'}`));
  let format;
  if (!usable) {
    format = '{filename}.{extension}';
  } else if (!keyed && nums.every((n, i) => n === i + 1)) {
    format = '{num:02}.{extension}';
  } else if (!keyed) {
    const map = keys.map((k, i) => `${k}:${i + 1}`).join(',');
    format = `\\fE '%02d.%s' % ({${map}}.get(num, num), extension)`;
  } else {
    const map = keys.map((k, i) => `'${k}':${i + 1}`).join(',');
    format = `\\fE '%02d.%s' % ({${map}}.get('%s:%s' % (${postKey}, num), num), extension)`;
  }
  return { ok: true, total: sel.length, mode: 'folder', id, folder: dir, dir, format, expected, postKey };
}

// ---------------------------------------------------------------- arguments

function commonArgs(o) {
  const args = [
    '--config-ignore', // never read a global gallery-dl.conf: output must be deterministic
    '--no-input',
    '--range', `1-${MAX_FILES}`,
    '-o', 'ratelimit=abort', // fail with a clear message instead of sleeping for minutes
  ];
  const cookies = ytdlp.sanitizeCookiesFrom(o.cookiesFrom);
  if (cookies) args.push('--cookies-from-browser', cookies);
  return args;
}

/** `gallery-dl -j` (metadata only, nothing is downloaded). */
function buildInfoArgs(o) {
  const args = commonArgs(o);
  args.push(o.resolve ? '-J' : '-j');
  args.push('--', o.arg);
  return args;
}

/**
 * Download arguments for a plan from planDownload().
 * @param {{arg:string, plan:object, quality:string, limitRate?:string, cookiesFrom?:string}} o
 */
function buildDownloadArgs(o) {
  const args = commonArgs(o);
  args.push(
    '--windows-filenames',
    '--filter', filterExpr(o.quality === 'images' ? 'images' : 'media'),
    '-D', o.plan.dir,
    '-f', o.plan.format,
    '--Print', 'after:LGF|{_path}',
    '--Print', 'skip:LGS|{_path}'
  );
  const rate = ytdlp.sanitizeRateLimit(o.limitRate);
  if (rate) args.push('--limit-rate', rate);
  args.push('--', o.arg);
  return args;
}

/** Parse one stdout line. Only our own tagged lines count; gallery-dl's bare path lines are ignored. */
function parseLine(rawLine) {
  if (typeof rawLine !== 'string') return null;
  const line = rawLine.replace(/\r/g, '').trim();
  if (line.startsWith('LGF|') && line.length > 4) return { type: 'done', path: line.slice(4), skipped: false };
  if (line.startsWith('LGS|') && line.length > 4) return { type: 'done', path: line.slice(4), skipped: true };
  return null;
}

// ---------------------------------------------------------------- errors

/**
 * Turn gallery-dl output into a message a normal person can act on.
 * @param {string} text  stderr (and/or the messages of -1 entries of a -j dump)
 * @param {{site?:string, cookiesFrom?:string}} [ctx]
 */
function friendlyError(text, ctx) {
  const c = ctx || {};
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errLines = lines.filter((l) => /\[error\]/i.test(l) || /^(\w*Error|\w*Exception)\b/.test(l));
  const last = (errLines.length ? errLines[errLines.length - 1] : lines[lines.length - 1] || '')
    .replace(/^\[[^\]]+\]\[error\]\s*/i, '')
    .trim();
  const hay = raw;
  const xi = c.site === 'x' || c.site === 'instagram';
  const name = c.site === 'x' ? 'X' : c.site === 'instagram' ? 'Instagram' : 'the site';
  const cookieAdvice = xi && !c.cookiesFrom ? ` ${LOGIN_HINT}` : '';

  if (/could not (find|copy|read).*cookie|failed to decrypt|cookies? database|unable to (read|load).*cookies|DPAPI|keyring|unsupported browser|cookies?.*(locked|in use)/i.test(hay)) {
    return 'LinkGrab could not read cookies from your browser. Close that browser completely and retry, or choose a different browser (Firefox or Edge work best) in Settings > Use browser cookies.';
  }
  if (/unsupported url|no suitable extractor|no extractor|UnsupportedError/i.test(hay)) {
    return `This link does not point to a post with downloadable images or videos.${cookieAdvice}`;
  }
  if (/\b429\b|too many requests|rate.?limit|please wait a few minutes/i.test(hay)) {
    return `${name === 'the site' ? 'The site' : name} is rate-limiting requests right now. Wait a few minutes and try again.${xi && !c.cookiesFrom ? ' Being signed in (Settings > Use browser cookies) also helps.' : ''}`;
  }
  if (/nsfw|age[- ]?(restrict|verif|gate)|confirm your age|sensitive (content|media)|mature/i.test(hay)) {
    return `This post is age-restricted or marked sensitive, so ${name} only shows it to signed-in users.${xi ? (c.cookiesFrom ? ' Make sure you are signed in to that site in the browser chosen under Settings > Use browser cookies.' : ` ${LOGIN_HINT}`) : ''}`;
  }
  if (/protected|private (account|profile|post|user)|not authori[sz]ed to view|only (visible|available) to (approved )?followers|this account is private/i.test(hay)) {
    return `This post belongs to a private or protected account.${xi
      ? (c.cookiesFrom
        ? ' You can only download it if the account you are signed in with in that browser is allowed to see it.'
        : ` ${LOGIN_HINT} The signed-in account must be allowed to see it.`)
      : ''}`;
  }
  if (/login required|\blog ?in\b|logged in|sign in|signed in|AuthRequired|AuthenticationError|AuthorizationError|\b401\b|\b403\b|unauthori[sz]ed|forbidden|checkpoint|challenge_required|csrf|requires? (a )?(login|authentication)/i.test(hay)) {
    if (xi) {
      return c.cookiesFrom
        ? `This ${name} post needs you to be signed in. Make sure you are logged in to ${name} in the browser chosen under Settings > Use browser cookies (close that browser first), then try again.`
        : `This ${name} post needs you to be signed in (it is private, age-restricted or login-only). ${LOGIN_HINT}`;
    }
    return `This post needs you to be signed in. ${LOGIN_HINT}`;
  }
  if (/\b404\b|\b410\b|not ?found|does not exist|deleted|removed|unavailable|suspended|no longer/i.test(hay)) {
    return `This post is not available (it was deleted, removed or the link is wrong).${cookieAdvice ? ` If it should exist, it may be private. ${LOGIN_HINT}` : ''}`;
  }
  if (/getaddrinfo|name resolution|Network is unreachable|timed out|Connection (reset|refused|aborted)|NewConnectionError|ConnectionError|ProxyError|SSL|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(hay)) {
    return 'Network problem while talking to the site. Check your internet connection and try again.';
  }
  if (/No space left|ENOSPC|disk full/i.test(hay)) return 'The disk is full. Free some space or choose another folder in Settings.';
  if (/Permission denied|EACCES|EPERM/i.test(hay)) return 'LinkGrab is not allowed to write to the download folder. Choose another folder in Settings.';
  return last ? `Download failed: ${last}` : 'Download failed for an unknown reason.';
}

function spawnErrorText(e) {
  if (e && e.code === 'ENOENT') return MISSING_MESSAGE;
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'gallery-dl could not be started (permission denied).';
  return `Could not start gallery-dl: ${e && e.message ? e.message : e}`;
}

// ---------------------------------------------------------------- process helpers

function childEnv(extra, ffmpeg) {
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }, extra || {});
  // gallery-dl looks for `ffmpeg` on PATH (ugoira, HLS); only helps when the file is called ffmpeg[.exe].
  if (ffmpeg && /^ffmpeg(\.exe)?$/i.test(path.basename(ffmpeg))) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = path.dirname(ffmpeg) + path.delimiter + (env[key] || '');
  }
  return env;
}

/**
 * Run to completion capturing output. Returns { child (null if the spawn failed), done }.
 * `done` resolves { code, stdout, stderr, spawnError?, timedOut? } and never rejects.
 */
function capture(binary, args, env, timeoutMs) {
  let child = null;
  let settle;
  const done = new Promise((r) => { settle = r; });
  let finished = false;
  const finish = (r) => { if (!finished) { finished = true; clearTimeout(timer); settle(r); } };
  let stdout = '';
  let stderr = '';
  let timer = null;
  try {
    child = spawn(binary, args, {
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  } catch (e) {
    finish({ code: -1, stdout, stderr: String(e && e.message), spawnError: e });
    return { child: null, done };
  }
  timer = setTimeout(() => {
    ytdlp.killTree(child);
    finish({ code: -1, stdout, stderr, timedOut: true });
  }, timeoutMs || 90000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { if (stdout.length < 64 * 1024 * 1024) stdout += d; });
  child.stderr.on('data', (d) => { if (stderr.length < 1000000) stderr += d; });
  child.on('error', (e) => finish({ code: -1, stdout, stderr, spawnError: e }));
  child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));
  return { child, done };
}

function statSize(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

// ---------------------------------------------------------------- runner

/**
 * @param {{getBinary:()=>string|null, getFfmpeg?:()=>string|null, env?:object}} deps
 *   `env` (optional) is merged into the environment of every gallery-dl process (tests use it to set a proxy).
 */
function createGalleryRunner(deps) {
  const infoCache = new Map(); // key -> { at, dump }

  function cacheKey(arg, cookies) { return `${arg}|${cookies || ''}`; }
  function cacheGet(key) {
    const hit = infoCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > INFO_CACHE_MS) { infoCache.delete(key); return null; }
    return hit.dump;
  }
  function cachePut(key, dump) {
    infoCache.set(key, { at: Date.now(), dump });
    while (infoCache.size > INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
  }

  /**
   * List the files of a post. `track(child)` lets download() kill a listing that is still running.
   * @returns {Promise<{ok:true,dump:object}|{ok:false,error:string,missing?:boolean}>}
   */
  async function listFiles(binary, target, o, track) {
    const cookies = ytdlp.sanitizeCookiesFrom(o.cookiesFrom);
    const key = cacheKey(target.arg, cookies);
    const cached = o.useCache === false ? null : cacheGet(key);
    if (cached) return { ok: true, dump: cached };
    const env = childEnv(deps.env, deps.getFfmpeg ? deps.getFfmpeg() : null);
    let dump = null;
    let lastRes = null;
    for (const resolve of [false, true]) {
      const run = capture(binary, buildInfoArgs({ arg: target.arg, cookiesFrom: cookies, resolve }), env, o.timeoutMs || 90000);
      if (track) track(run.child);
      const res = await run.done;
      if (track) track(null);
      lastRes = res;
      if (res.spawnError) return { ok: false, error: spawnErrorText(res.spawnError), missing: res.spawnError.code === 'ENOENT' };
      if (res.timedOut) return { ok: false, error: 'Timed out while reading the link. Check your connection and try again.' };
      dump = parseDump(res.stdout);
      // only unresolved child URLs? retry once with -J, which resolves them
      if (dump.ok && !dump.files.length && dump.queued > 0 && !resolve) continue;
      break;
    }
    if (!dump || !dump.ok) {
      const stderr = lastRes ? lastRes.stderr : '';
      return { ok: false, error: friendlyError(stderr, { site: o.site, cookiesFrom: cookies }), stderr };
    }
    if (!dump.files.length) {
      const text = dump.errors.join('\n') + '\n' + (lastRes ? lastRes.stderr : '');
      if (dump.errors.length || (lastRes && lastRes.code)) {
        return { ok: false, error: friendlyError(text, { site: o.site, cookiesFrom: cookies }), stderr: text };
      }
      const xi = o.site === 'x' || o.site === 'instagram';
      return {
        ok: false,
        error: `No images or videos were found in this post.${xi && !cookies ? ` If the post is private or login-only: ${LOGIN_HINT.charAt(0).toLowerCase()}${LOGIN_HINT.slice(1)}` : ''}`,
        noMedia: true,
      };
    }
    cachePut(key, dump);
    return { ok: true, dump };
  }

  function missingHandle() {
    return {
      child: null,
      done: Promise.resolve({
        code: -1, signal: null, killed: false, filePath: null, stderr: '', files: [], folder: null, fileCount: 0,
        error: MISSING_MESSAGE,
      }),
      kill: () => Promise.resolve(),
    };
  }

  function failHandle(error) {
    return {
      child: null,
      done: Promise.resolve({
        code: 1, signal: null, killed: false, filePath: null, stderr: '', files: [], folder: null, fileCount: 0, error,
      }),
      kill: () => Promise.resolve(),
    };
  }

  return {
    /**
     * @param {{url,quality,outDir,limitRate,cookiesFrom,site}} p ; @param {(ev)=>void} onEvent
     * Events: {type:'progress',percent,downloaded,size,speed,eta} and {type:'files',files,folder,fileCount}.
     * Result (always resolves): { code, signal, killed, error, filePath, stderr, files, folder, fileCount }.
     */
    download(p, onEvent) {
      const binary = deps.getBinary();
      if (!binary) return missingHandle();
      const target = parseTarget(p && p.url);
      if (!target.ok) return failHandle(target.error);
      if (!p.outDir || typeof p.outDir !== 'string') return failHandle('No download folder was given.');
      // always absolute: a relative value starting with '-' could otherwise be mistaken for an option
      const outDir = path.resolve(p.outDir);
      const emit = (ev) => { try { if (onEvent) onEvent(ev); } catch (_) { /* listener errors must not kill the stream */ } };
      const quality = p.quality === 'images' ? 'images' : 'media';
      const cookies = ytdlp.sanitizeCookiesFrom(p.cookiesFrom);
      const ctx = { site: p.site, cookiesFrom: cookies };

      let killed = false;
      let current = null; // child currently running (listing or download)
      const track = (c) => { current = c; if (killed && c) ytdlp.killTree(c); };

      const run = async () => {
        const base = { signal: null, stderr: '', files: [], folder: null, fileCount: 0 };
        const listed = await listFiles(binary, target, { cookiesFrom: cookies, site: p.site }, track);
        if (killed) return Object.assign({ code: null, killed: true, error: null, filePath: null }, base);
        if (!listed.ok) {
          return Object.assign({ code: listed.missing ? -1 : 1, killed: false, error: listed.error, filePath: null }, base, { stderr: listed.stderr || '' });
        }
        const plan = planDownload({ files: listed.dump.files, site: p.site, url: target.url, quality, outDir });
        if (!plan.ok) return Object.assign({ code: 1, killed: false, error: plan.error, filePath: null }, base);
        try {
          fs.mkdirSync(plan.dir, { recursive: true });
        } catch (e) {
          return Object.assign({ code: 1, killed: false, error: 'Could not create the download folder. Choose another folder in Settings.', filePath: null }, base);
        }

        // Tell the queue which name stem this download uses ("<Site> <id>..."), so cancel / remove can find and
        // delete its .part files even before the first file has finished (the queue keys cleanup on this id).
        emit({ type: 'title', id: plan.id });
        const args = buildDownloadArgs({ arg: target.arg, plan, quality, limitRate: p.limitRate, cookiesFrom: cookies });
        const env = childEnv(deps.env, deps.getFfmpeg ? deps.getFfmpeg() : null);
        const doneFiles = [];
        const seen = new Set();
        let bytesDone = 0;
        let bytesNew = 0;
        let newCount = 0;
        let stderrBuf = '';
        const t0 = Date.now();
        let lastTick = { t: t0, bytes: 0 };
        let speed = 0;
        let lastDownloaded = 0;

        let child;
        try {
          child = spawn(binary, args, {
            shell: false, windowsHide: true, detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'], env,
          });
        } catch (e) {
          return Object.assign({ code: -1, killed: false, error: spawnErrorText(e), filePath: null }, base);
        }
        track(child);

        const partBytes = () => {
          let sum = 0;
          let n = 0;
          for (const f of plan.expected) {
            if (seen.has(f)) continue;
            const s = statSize(f + '.part');
            if (s) { sum += s; n += 1; }
            if (n >= 2) break; // gallery-dl downloads sequentially: at most one partial file is live
          }
          return sum;
        };

        const emitProgress = (final) => {
          const part = final ? 0 : partBytes();
          const downloaded = Math.max(lastDownloaded, bytesDone + part);
          lastDownloaded = downloaded;
          const now = Date.now();
          const dt = (now - lastTick.t) / 1000;
          if (dt >= 0.4) {
            const inst = (bytesNew + part - lastTick.bytes) / dt;
            speed = speed ? speed * 0.6 + Math.max(0, inst) * 0.4 : Math.max(0, inst);
            lastTick = { t: now, bytes: bytesNew + part };
          }
          const n = doneFiles.length;
          const partFrac = !final && newCount > 0 && part > 0 ? Math.min(0.95, part / Math.max(1, bytesNew / newCount)) : 0;
          let percent = final ? 100 : Math.min(99.9, ((n + partFrac) / plan.total) * 100);
          percent = Math.round(percent * 10) / 10;
          const elapsed = (now - t0) / 1000;
          let eta = null;
          if (!final && newCount > 0 && elapsed > 0.5) {
            eta = Math.max(0, Math.round(((plan.total - n - partFrac) * elapsed) / (newCount + partFrac)));
          }
          emit({
            type: 'progress', percent, downloaded, size: null, speed: final ? 0 : Math.round(speed), eta,
            total: null, filesDone: n, filesTotal: plan.total,
          });
        };

        const onLine = (line) => {
          const ev = parseLine(line);
          if (!ev) return;
          const file = path.isAbsolute(ev.path) ? ev.path : path.resolve(ev.path);
          const rel = path.relative(plan.dir, file);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // never report files outside our folder
          if (seen.has(file)) return;
          seen.add(file);
          if (doneFiles.length >= MAX_FILES) return;
          doneFiles.push(file);
          const size = statSize(file);
          bytesDone += size;
          if (!ev.skipped) { bytesNew += size; newCount += 1; }
          emit({ type: 'files', files: doneFiles.slice(), folder: plan.folder, fileCount: plan.total });
          emitProgress(false);
        };
        const out = ytdlp.lineSplitter(onLine);
        const err = ytdlp.lineSplitter((l) => {
          stderrBuf += l + '\n';
          if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => out.write(d));
        child.stderr.on('data', (d) => err.write(d));
        emitProgress(false);
        const ticker = setInterval(() => emitProgress(false), 700);
        if (ticker.unref) ticker.unref();

        const exit = await new Promise((resolve) => {
          child.on('error', (e) => resolve({ code: -1, signal: null, spawnError: e }));
          child.on('close', (code, signal) => resolve({ code, signal }));
        });
        clearInterval(ticker);
        out.end();
        err.end();
        track(null);

        const files = doneFiles.slice();
        const result = {
          code: exit.code, signal: exit.signal || null, killed, error: null,
          filePath: files[0] || null, stderr: stderrBuf, files, folder: plan.folder, fileCount: plan.total,
        };
        if (killed) return result;
        if (exit.spawnError) {
          result.error = spawnErrorText(exit.spawnError);
        } else if (exit.code === 0) {
          if (!files.length) {
            result.code = 1;
            result.error = NO_FILES_MESSAGE;
          } else {
            emitProgress(true);
          }
        } else {
          let msg = friendlyError(stderrBuf, ctx);
          if (files.length) {
            if (/^This post is not available/.test(msg)) msg = 'Some of the files are no longer available.';
            msg = `Only ${files.length} of ${plan.total} files could be downloaded. ${msg}`;
          }
          result.error = msg;
        }
        return result;
      };

      const done = run().catch((e) => ({
        code: -1, signal: null, killed, error: 'Download failed: ' + (e && e.message ? e.message : e),
        filePath: null, stderr: '', files: [], folder: null, fileCount: 0,
      }));

      return {
        get child() { return current; },
        done,
        kill() {
          killed = true;
          if (current) ytdlp.killTree(current);
          return done.then(() => undefined);
        },
      };
    },

    /**
     * Metadata only (`gallery-dl -j`), nothing is downloaded.
     * @returns {Promise<{ok:true,info:object}|{ok:false,error:string,missing?:boolean}>}
     */
    async getInfo(url, opts) {
      const binary = deps.getBinary();
      if (!binary) return { ok: false, error: MISSING_MESSAGE, missing: true };
      const target = parseTarget(url);
      if (!target.ok) return { ok: false, error: target.error };
      const o = opts || {};
      const site = o.site || sites.detectSite(target.url) || null;
      const listed = await listFiles(binary, target, { cookiesFrom: o.cookiesFrom, site, timeoutMs: o.timeoutMs, useCache: false }, null);
      if (!listed.ok) {
        const r = { ok: false, error: listed.error };
        if (listed.missing) r.missing = true;
        if (listed.noMedia) r.noMedia = true;
        return r;
      }
      return { ok: true, info: infoFromDump(listed.dump, { site, url: target.url }) };
    },
  };
}

module.exports = {
  MAX_FILES,
  IMAGE_EXTS,
  VIDEO_EXTS,
  MISSING_MESSAGE,
  NO_FILES_MESSAGE,
  GENERIC_PREFIX,
  createGalleryRunner,
  parseTarget,
  parseDump,
  parseLine,
  planDownload,
  buildDownloadArgs,
  buildInfoArgs,
  filterExpr,
  infoFromDump,
  qualitiesFor,
  kindOfExt,
  siteLabel,
  safeSegment,
  friendlyError,
};
