'use strict';
// Shared test helpers: tiny sample media, a throttled Range-capable HTTP server, temp dirs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'lg-test-'));
}

function findFfmpeg() {
  if (process.env.LINKGRAB_FFMPEG) return process.env.LINKGRAB_FFMPEG;
  try {
    const p = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall through */ }
  const w = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}

function findYtdlp() {
  if (process.env.LINKGRAB_YTDLP) return process.env.LINKGRAB_YTDLP;
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  const w = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}

let sampleDir = null;
/** Create (once per process) a ~1MB mp4 with video + audio (5 seconds). */
function sampleVideo() {
  if (sampleDir) return path.join(sampleDir, 'sample.mp4');
  const ff = findFfmpeg();
  if (!ff) throw new Error('ffmpeg not available for tests');
  sampleDir = mkTmp('lg-sample-');
  execFileSync(ff, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-b:v', '1500k', '-minrate', '1500k', '-maxrate', '1500k', '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(sampleDir, 'sample.mp4'),
  ]);
  return path.join(sampleDir, 'sample.mp4');
}

/**
 * Serve `file` for any path ending in .mp4 (so each name is a different "video id").
 * Supports Range. `bytesPerSec` throttles the body (0 = unthrottled).
 * Extra static dir: opts.staticDir serves files from that directory under /static/.
 */
function startServer(file, opts) {
  const o = opts || {};
  const data = fs.readFileSync(file);
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, range: req.headers.range || null });
    if (o.staticDir && url.pathname.startsWith('/static/')) {
      const f = path.join(o.staticDir, path.basename(url.pathname));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const buf = fs.readFileSync(f);
      const ct = f.endsWith('.mpd') ? 'application/dash+xml' : f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (url.pathname.startsWith('/redirect/')) {
      res.writeHead(302, { Location: '/' + url.pathname.slice('/redirect/'.length) });
      return res.end();
    }
    if (url.pathname === '/missing.mp4') { res.writeHead(404); return res.end('nope'); }
    if (!url.pathname.endsWith('.mp4')) { res.writeHead(404); return res.end(); }
    let start = 0;
    let end = data.length - 1;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    let status = 200;
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(end, parseInt(m[2], 10));
      status = 206;
    }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const bps = o.bytesPerSec || 0;
    if (!bps) return res.end(data.subarray(start, end + 1));
    let pos = start;
    const chunk = Math.max(1024, Math.floor(bps / 10));
    const timer = setInterval(() => {
      if (res.destroyed || pos > end) { clearInterval(timer); if (!res.destroyed) res.end(); return; }
      const next = Math.min(end + 1, pos + chunk);
      res.write(data.subarray(pos, next));
      pos = next;
      if (pos > end) { clearInterval(timer); res.end(); }
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: (name) => `http://127.0.0.1:${server.address().port}/${name}`,
        requests,
        size: data.length,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > (timeoutMs || 15000)) throw new Error('Timed out waiting for ' + (label || 'condition'));
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { mkTmp, findFfmpeg, findYtdlp, sampleVideo, startServer, waitFor };
