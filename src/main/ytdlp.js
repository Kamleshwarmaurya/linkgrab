'use strict';
// yt-dlp argument building, output parsing, process control and metadata lookup.
// Pure Node: must not require 'electron'. Never uses a shell; the URL is always passed after `--`.

const { spawn } = require('node:child_process');
const path = require('node:path');
const sites = require('./sites');

// Qualities yt-dlp understands, plus the gallery-dl-only keys 'images' / 'media' (v1.1). The latter two are
// accepted by isValidQuality but are treated as invalid for yt-dlp (buildDownloadArgs falls back to 'best').
const VIDEO_QUALITIES = ['best', '1080', '720', '480', '360', 'audio'];
const GALLERY_QUALITIES = ['images', 'media'];
const QUALITIES = VIDEO_QUALITIES.concat(GALLERY_QUALITIES);
const HEIGHT_QUALITIES = [1080, 720, 480, 360];
const COOKIE_BROWSERS = ['chrome', 'firefox', 'edge', 'brave', 'opera', 'vivaldi', 'safari', 'chromium'];

const PROGRESS_TEMPLATE =
  'download:LGP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

/** Stable sentence friendlyError returns for X/Instagram posts that contain no video (the router relies on it). */
const NO_VIDEO_MESSAGE = 'This post does not contain a video.';
function isNoVideoMessage(text) {
  return typeof text === 'string' && text.includes(NO_VIDEO_MESSAGE);
}

const LOGIN_HINT =
  'Open Settings and turn on "Use browser cookies" (pick the browser where you are signed in), then try again.';

// ---------------------------------------------------------------- argument building

function isValidQuality(q) {
  return QUALITIES.includes(q);
}

function formatSelector(quality) {
  switch (quality) {
    case '1080':
    case '720':
    case '480':
    case '360':
      // Falls back to best when the site reports no height for its formats (some Facebook/LinkedIn
      // streams), instead of failing with "Requested format is not available".
      return `bv*[height<=${quality}]+ba/b[height<=${quality}]/bv*+ba/b`;
    case 'audio':
      return 'ba/b';
    case 'best':
    default:
      return 'bv*+ba/b';
  }
}

/** Only a known browser name may reach --cookies-from-browser. Returns '' when invalid. */
function sanitizeCookiesFrom(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  return COOKIE_BROWSERS.includes(s) ? s : '';
}

/** Accepts '', '500K', '2M', '1.5M', '800000'. Returns '' when invalid. */
function sanitizeRateLimit(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return /^\d+(\.\d+)?[KkMm]?$/.test(s) && parseFloat(s) > 0 ? s : '';
}

/** Escape '%' so a directory name can never be interpreted as an output template field. */
function escapeTemplate(s) {
  return String(s).replace(/%/g, '%%');
}

function outputTemplate(outDir) {
  return path.join(escapeTemplate(outDir), '%(title).150B [%(id)s].%(ext)s');
}

/**
 * Arguments for a download. The URL is always last, after `--`.
 * @param {{url:string, quality?:string, outDir:string, ffmpegPath?:string, limitRate?:string, cookiesFrom?:string}} o
 * @returns {string[]}
 */
function buildDownloadArgs(o) {
  const quality = VIDEO_QUALITIES.includes(o.quality) ? o.quality : 'best';
  const args = [
    // yt-dlp also reads yt-dlp.conf from the working directory and the user profile (any `--exec` in there would
    // run): never load them, so behaviour (and the parsed output) is the same on every machine.
    '--ignore-config',
    '--newline',
    '--no-playlist',
    '--no-colors',
    // --print would otherwise imply --quiet, which also hides progress and merge lines.
    '--no-quiet',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '-o', outputTemplate(o.outDir),
    '--windows-filenames',
    '--continue',
    '--no-overwrites',
    '--print', 'before_dl:LGT|%(id)s|%(title)s',
    '--print', 'after_move:LGF|%(filepath)s',
  ];
  if (o.ffmpegPath) args.push('--ffmpeg-location', o.ffmpegPath);
  args.push('-f', formatSelector(quality));
  if (quality === 'audio') {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('--merge-output-format', 'mp4');
  }
  const rate = sanitizeRateLimit(o.limitRate);
  if (rate) args.push('--limit-rate', rate);
  const cookies = sanitizeCookiesFrom(o.cookiesFrom);
  if (cookies) args.push('--cookies-from-browser', cookies);
  args.push('--', o.url);
  return args;
}

function buildInfoArgs(o) {
  const args = ['--ignore-config', '-J', '--no-playlist', '--no-warnings', '--no-colors'];
  const cookies = sanitizeCookiesFrom(o.cookiesFrom);
  if (cookies) args.push('--cookies-from-browser', cookies);
  args.push('--', o.url);
  return args;
}

// ---------------------------------------------------------------- output parsing

function num(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!t || t === 'NA' || t === 'None' || t === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one line of yt-dlp output.
 * @returns {null | {type:'progress',downloaded:number|null,total:number|null,speed:number|null,eta:number|null}
 *   | {type:'title',id:string,title:string} | {type:'file',path:string} | {type:'merging'}}
 */
function parseLine(rawLine) {
  if (typeof rawLine !== 'string') return null;
  const line = rawLine.replace(/\r/g, '').trim();
  if (!line) return null;
  if (line.startsWith('LGP|')) {
    const p = line.split('|');
    const total = num(p[2]);
    const estimate = num(p[3]);
    return {
      type: 'progress',
      downloaded: num(p[1]),
      total: total !== null ? total : estimate,
      totalIsEstimate: total === null && estimate !== null,
      speed: num(p[4]),
      eta: num(p[5]),
    };
  }
  if (line.startsWith('LGF|')) {
    const fp = line.slice(4);
    return fp ? { type: 'file', path: fp } : null;
  }
  if (line.startsWith('LGT|')) {
    const rest = line.slice(4);
    const i = rest.indexOf('|');
    if (i < 0) return null;
    return { type: 'title', id: rest.slice(0, i), title: rest.slice(i + 1) };
  }
  if (/^\[Merger\]/.test(line) || /Merging formats/i.test(line) || /^\[ExtractAudio\]/.test(line) ||
      /^\[VideoConvertor\]/.test(line) || /^\[Fixup/.test(line)) {
    return { type: 'merging' };
  }
  return null;
}

/** Same as parseLine for progress lines only (kept for readability in tests). */
function parseProgressLine(line) {
  const r = parseLine(line);
  return r && r.type === 'progress' ? r : null;
}

/**
 * Turn raw stderr into a message a normal person can act on.
 * @param {string} text
 * @param {{site?:string, cookiesFrom?:string}} [ctx]
 */
function friendlyError(text, ctx) {
  const c = ctx || {};
  const raw = String(text || '');
  const errLines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l));
  const last = (errLines.length ? errLines[errLines.length - 1] : raw.trim().split(/\r?\n/).pop() || '')
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s+[^:\s]+:\s*/, '')
    .trim();
  const hay = raw;

  if (/could not (find|copy).*cookie|failed to decrypt|cookies? database|unable to (read|load).*cookies|DPAPI|keyring|could not read cookies|unsupported browser/i.test(hay)) {
    return 'LinkGrab could not read cookies from your browser. Close that browser completely and retry, or choose a different browser (Firefox or Edge work best) in Settings > Use browser cookies.';
  }
  if (/ffmpeg|ffprobe/i.test(hay) && /not found|not installed|is not available|Postprocessing|install/i.test(hay)) {
    return 'ffmpeg is missing or not working. Use the engine setup banner (Install) to download it, then try again.';
  }
  if (/login required|sign in|log in|logged in|private video|this video is private|is private|cookies|members[- ]only|authentication|age[- ]restricted|confirm your age|not available without|requires? (a )?(login|authentication)|rate-limit reached|restricted video|empty media response|checkpoint/i.test(hay)) {
    if (c.site === 'x' || c.site === 'instagram') {
      const name = c.site === 'x' ? 'X' : 'Instagram';
      return c.cookiesFrom
        ? `This ${name} post needs you to be signed in. Make sure you are logged in to ${name} in the browser chosen under Settings > Use browser cookies (close that browser first), then try again.`
        : `This ${name} post needs you to be signed in (it is private, age-restricted or login-only). ${LOGIN_HINT}`;
    }
    return `This video needs you to be signed in (it is private, restricted or login-only). ${LOGIN_HINT}`;
  }
  if ((c.site === 'x' || c.site === 'instagram') &&
      /no video could be found|there is no video in this|no video formats|no video in this|does not contain (a )?video/i.test(hay)) {
    return NO_VIDEO_MESSAGE;
  }
  if (/HTTP Error 429|Too Many Requests/i.test(hay)) {
    return 'The site is rate-limiting requests right now. Wait a few minutes and try again.';
  }
  if (/unsupported url/i.test(hay)) {
    const extra = (c.site === 'facebook' || c.site === 'linkedin') && !c.cookiesFrom
      ? ` If the post is private, ${LOGIN_HINT.charAt(0).toLowerCase()}${LOGIN_HINT.slice(1)}`
      : '';
    return `This link does not point to a downloadable video.${extra}`;
  }
  if (/video unavailable|no longer available|has been removed|been deleted|does not exist|HTTP Error 404|HTTP Error 410|not available in your country|geo.?restrict|blocked it|copyright/i.test(hay)) {
    return 'This video is not available (removed, region-blocked or deleted).';
  }
  if (/getaddrinfo|name resolution|Network is unreachable|timed out|Connection (reset|refused|aborted)|Unable to download|SSL|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(hay)) {
    return 'Network problem while talking to the site. Check your internet connection and try again.';
  }
  if (/No space left|ENOSPC|disk full/i.test(hay)) return 'The disk is full. Free some space or choose another folder in Settings.';
  if (/Permission denied|EACCES|EPERM/i.test(hay)) return 'LinkGrab is not allowed to write to the download folder. Choose another folder in Settings.';
  if ((c.site === 'facebook' || c.site === 'linkedin') && !c.cookiesFrom &&
      /cannot parse data|no video formats|unable to extract|no video could be found|there is no video/i.test(hay)) {
    return `Could not read this ${c.site === 'facebook' ? 'Facebook' : 'LinkedIn'} post. It may be private or login-only. ${LOGIN_HINT}`;
  }
  return last ? `Download failed: ${last}` : 'Download failed for an unknown reason.';
}

// ---------------------------------------------------------------- process helpers

/**
 * Split a stream into lines (handles \n and \r), calling onLine for each complete line.
 */
function lineSplitter(onLine) {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/** Kill a process and everything it spawned (ffmpeg children). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch (_) { /* ignore */ } });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { child.kill('SIGTERM'); }
      const t = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
      }, 3000);
      if (t.unref) t.unref();
      child.once('exit', () => clearTimeout(t));
    }
  } catch (_) { /* ignore */ }
}

/**
 * Run a download. Returns a handle: { child, done, kill }.
 * `done` always resolves: { code, signal, killed, error, filePath, stderr }.
 * @param {{binary:string,args:string[],onEvent?:(ev:object)=>void,ctx?:object,env?:object}} o
 */
function runDownload(o) {
  const onEvent = o.onEvent || (() => {});
  let filePath = null;
  let killedByUs = false;
  let stderrBuf = '';
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let finished = false;
  const finish = (res) => {
    if (finished) return;
    finished = true;
    resolveDone(res);
  };

  let child;
  try {
    child = spawn(o.binary, o.args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, o.env || {}),
    });
  } catch (e) {
    finish({ code: -1, signal: null, killed: false, error: spawnErrorText(e), filePath: null, stderr: String(e && e.message) });
    return { child: null, done, kill: () => Promise.resolve() };
  }

  const handleLine = (line) => {
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === 'file') filePath = ev.path;
    try { onEvent(ev); } catch (_) { /* listener errors must not kill the stream */ }
  };
  const out = lineSplitter(handleLine);
  const err = lineSplitter((l) => {
    stderrBuf += l + '\n';
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
    handleLine(l);
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => out.write(d));
  child.stderr.on('data', (d) => err.write(d));

  child.on('error', (e) => {
    finish({ code: -1, signal: null, killed: killedByUs, error: spawnErrorText(e), filePath, stderr: stderrBuf });
  });
  child.on('close', (code, signal) => {
    out.end();
    err.end();
    const ok = code === 0;
    finish({
      code,
      signal,
      killed: killedByUs,
      error: ok || killedByUs ? null : friendlyError(stderrBuf, o.ctx),
      filePath,
      stderr: stderrBuf,
    });
  });

  return {
    child,
    done,
    kill() {
      killedByUs = true;
      killTree(child);
      return done.then(() => undefined);
    },
  };
}

function spawnErrorText(e) {
  if (e && e.code === 'ENOENT') return 'yt-dlp was not found. Use the engine setup banner to install it.';
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'yt-dlp could not be started (permission denied).';
  return `Could not start yt-dlp: ${e && e.message ? e.message : e}`;
}

/** Run a command to completion, capturing output (used for -J, --version, -U). */
function runCapture(binary, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }, o.env || {}),
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message), spawnError: e });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const max = o.maxBuffer || 64 * 1024 * 1024;
    const settle = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      killTree(child);
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      settle({ code: -1, stdout, stderr, timedOut: true });
    }, o.timeoutMs || 60000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1000000) stderr += d; });
    child.on('error', (e) => settle({ code: -1, stdout, stderr, spawnError: e }));
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- metadata

function bucketQualities(heights) {
  const hs = heights.filter((h) => Number.isFinite(h) && h > 0);
  const out = [];
  const maxH = hs.length ? Math.max(...hs) : 0;
  out.push({ key: 'best', label: maxH ? `Best available (${maxH}p)` : 'Best available' });
  const labels = { 1080: '1080p (Full HD)', 720: '720p (HD)', 480: '480p', 360: '360p or lower' };
  HEIGHT_QUALITIES.forEach((n, i) => {
    const lower = i + 1 < HEIGHT_QUALITIES.length ? HEIGHT_QUALITIES[i + 1] : 0;
    // Offer N only when a real stream exists in the bucket (lower, N].
    if (hs.some((h) => h <= n && h > lower)) out.push({ key: String(n), label: labels[n] });
  });
  out.push({ key: 'audio', label: 'Audio only (MP3)' });
  return out;
}

/** Convert the JSON from `yt-dlp -J` into the info object returned by api.getInfo. */
function infoFromJson(json, url) {
  let j = json;
  if (j && Array.isArray(j.entries) && j.entries.length) j = j.entries.find(Boolean) || j;
  const formats = Array.isArray(j.formats) ? j.formats : [];
  const heights = formats
    .filter((f) => f && f.vcodec !== 'none' && Number(f.height) > 0)
    .map((f) => Number(f.height));
  if (!heights.length && Number(j.height) > 0) heights.push(Number(j.height));
  let thumbnail = j.thumbnail || '';
  if (!thumbnail && Array.isArray(j.thumbnails) && j.thumbnails.length) {
    const t = j.thumbnails.filter((x) => x && x.url).pop();
    thumbnail = t ? t.url : '';
  }
  return {
    title: j.title || j.fulltitle || url,
    thumbnail,
    duration: Number.isFinite(Number(j.duration)) ? Number(j.duration) : 0,
    uploader: j.uploader || j.channel || j.uploader_id || '',
    site: sites.detectSite(url),
    qualities: bucketQualities(heights),
  };
}

/**
 * @param {{binary:string,url:string,cookiesFrom?:string,timeoutMs?:number}} o
 * @returns {Promise<{ok:true,info:object}|{ok:false,error:string}>}
 */
async function getInfo(o) {
  const v = sites.validateUrl(o.url);
  if (!v.ok) return v;
  const res = await runCapture(o.binary, buildInfoArgs({ url: v.url, cookiesFrom: o.cookiesFrom }), {
    timeoutMs: o.timeoutMs || 60000,
  });
  if (res.spawnError) return { ok: false, error: spawnErrorText(res.spawnError) };
  if (res.timedOut) return { ok: false, error: 'Timed out while reading the link. Check your connection and try again.' };
  if (res.code !== 0) {
    return { ok: false, error: friendlyError(res.stderr, { site: v.site, cookiesFrom: o.cookiesFrom }) };
  }
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch (_) {
    return { ok: false, error: 'Could not understand the response for this link.' };
  }
  return { ok: true, info: infoFromJson(json, v.url) };
}

/**
 * A runner binds the process helpers to "where is the binary" lookups so the queue never
 * needs to know about the filesystem layout. getBinary/getFfmpeg are synchronous.
 * @param {{getBinary:()=>string|null, getFfmpeg?:()=>string|null}} deps
 */
function createRunner(deps) {
  return {
    /** @param {{url,quality,outDir,limitRate,cookiesFrom,site}} p ; @param {(ev)=>void} onEvent */
    download(p, onEvent) {
      const binary = deps.getBinary();
      if (!binary) {
        return {
          child: null,
          done: Promise.resolve({
            code: -1, signal: null, killed: false, filePath: null, stderr: '',
            error: 'yt-dlp is not installed. Use the engine setup banner to install it.',
          }),
          kill: () => Promise.resolve(),
        };
      }
      const ffmpegPath = deps.getFfmpeg ? deps.getFfmpeg() : null;
      const args = buildDownloadArgs({
        url: p.url, quality: p.quality, outDir: p.outDir, ffmpegPath: ffmpegPath || undefined,
        limitRate: p.limitRate, cookiesFrom: p.cookiesFrom,
      });
      return runDownload({ binary, args, onEvent, ctx: { site: p.site, cookiesFrom: p.cookiesFrom } });
    },
    async getInfo(url, opts) {
      const binary = deps.getBinary();
      if (!binary) return { ok: false, error: 'yt-dlp is not installed. Use the engine setup banner to install it.' };
      return getInfo({ binary, url, cookiesFrom: opts && opts.cookiesFrom });
    },
  };
}

module.exports = {
  QUALITIES,
  VIDEO_QUALITIES,
  GALLERY_QUALITIES,
  NO_VIDEO_MESSAGE,
  isNoVideoMessage,
  COOKIE_BROWSERS,
  PROGRESS_TEMPLATE,
  isValidQuality,
  formatSelector,
  sanitizeCookiesFrom,
  sanitizeRateLimit,
  buildDownloadArgs,
  buildInfoArgs,
  parseLine,
  parseProgressLine,
  friendlyError,
  lineSplitter,
  killTree,
  runDownload,
  runCapture,
  bucketQualities,
  infoFromJson,
  getInfo,
  createRunner,
};
