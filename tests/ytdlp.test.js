'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const y = require('../src/main/ytdlp');

const base = { url: 'https://youtu.be/abc', outDir: path.join('/tmp', 'dl') };

test('does not load electron', () => {
  assert.ok(!Object.keys(require.cache).some((k) => /node_modules[\\/]electron[\\/]/.test(k)));
});

test('build args: required flags, URL last after --', () => {
  const a = y.buildDownloadArgs(Object.assign({ quality: 'best' }, base));
  for (const f of ['--newline', '--no-playlist', '--no-colors', '--windows-filenames', '--continue', '--no-overwrites', '--progress-template']) {
    assert.ok(a.includes(f), f);
  }
  assert.equal(a[a.indexOf('--progress-template') + 1],
    'download:LGP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s');
  assert.equal(a[a.indexOf('-o') + 1], path.join('/tmp/dl', '%(title).150B [%(id)s].%(ext)s'));
  assert.ok(a.includes('after_move:LGF|%(filepath)s'));
  assert.equal(a[a.indexOf('-f') + 1], 'bv*+ba/b');
  assert.equal(a[a.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(a[a.length - 2], '--');
  assert.equal(a[a.length - 1], base.url);
  assert.ok(!a.includes('-x'));
  assert.ok(!a.includes('--ffmpeg-location'));
  assert.ok(!a.includes('--limit-rate'));
  assert.ok(!a.includes('--cookies-from-browser'));
});

test('build args: format selectors per quality', () => {
  const sel = (q) => {
    const a = y.buildDownloadArgs(Object.assign({ quality: q }, base));
    return a[a.indexOf('-f') + 1];
  };
  assert.equal(sel('best'), 'bv*+ba/b');
  for (const n of ['1080', '720', '480', '360']) assert.equal(sel(n), `bv*[height<=${n}]+ba/b[height<=${n}]/bv*+ba/b`);
  assert.equal(sel('audio'), 'ba/b');
  assert.equal(sel('nonsense'), 'bv*+ba/b');
  const au = y.buildDownloadArgs(Object.assign({ quality: 'audio' }, base));
  assert.deepEqual(au.slice(au.indexOf('-x'), au.indexOf('-x') + 3), ['-x', '--audio-format', 'mp3']);
  assert.ok(!au.includes('--merge-output-format'));
});

test('build args: optional ffmpeg, rate limit and cookies', () => {
  const a = y.buildDownloadArgs(Object.assign({ quality: '720', ffmpegPath: '/opt/ff/ffmpeg', limitRate: '2M', cookiesFrom: 'firefox' }, base));
  assert.equal(a[a.indexOf('--ffmpeg-location') + 1], '/opt/ff/ffmpeg');
  assert.equal(a[a.indexOf('--limit-rate') + 1], '2M');
  assert.equal(a[a.indexOf('--cookies-from-browser') + 1], 'firefox');
});

test('security: user text can never become an option', () => {
  const evil = y.buildDownloadArgs(Object.assign({}, base, {
    quality: '--exec rm -rf /',
    limitRate: '1M --exec touch /tmp/pwn',
    cookiesFrom: 'chrome:/etc; rm -rf /',
    url: '--exec=touch /tmp/pwn',
  }));
  assert.ok(!evil.some((x) => /exec rm|pwn.*1M|chrome:\//.test(x) && x !== evil[evil.length - 1]));
  assert.ok(!evil.includes('--limit-rate'));
  assert.ok(!evil.includes('--cookies-from-browser'));
  assert.equal(evil[evil.length - 2], '--');
  assert.equal(evil[evil.length - 1], '--exec=touch /tmp/pwn'); // after "--" it is only ever a positional URL
  const info = y.buildInfoArgs({ url: '-J', cookiesFrom: 'brave' });
  assert.deepEqual(info.slice(-2), ['--', '-J']);
});

test('output template escapes % in the folder name', () => {
  const a = y.buildDownloadArgs(Object.assign({}, base, { outDir: '/tmp/100%(title)s' }));
  assert.ok(a[a.indexOf('-o') + 1].startsWith(path.join('/tmp/100%%(title)s')));
});

test('sanitizers', () => {
  assert.equal(y.sanitizeCookiesFrom('Chrome'), 'chrome');
  assert.equal(y.sanitizeCookiesFrom(' edge '), 'edge');
  assert.equal(y.sanitizeCookiesFrom('netscape'), '');
  assert.equal(y.sanitizeCookiesFrom(null), '');
  assert.equal(y.sanitizeRateLimit('500K'), '500K');
  assert.equal(y.sanitizeRateLimit('1.5m'), '1.5m');
  assert.equal(y.sanitizeRateLimit('2000000'), '2000000');
  assert.equal(y.sanitizeRateLimit('0'), '');
  assert.equal(y.sanitizeRateLimit('-1'), '');
  assert.equal(y.sanitizeRateLimit('5M;ls'), '');
  assert.equal(y.sanitizeRateLimit(''), '');
});

test('progress parsing', () => {
  assert.deepEqual(y.parseLine('LGP|1024|72441|NA|NA|NA'),
    { type: 'progress', downloaded: 1024, total: 72441, totalIsEstimate: false, speed: null, eta: null });
  assert.deepEqual(y.parseLine('LGP|5000|NA|10000|2500.5|2'),
    { type: 'progress', downloaded: 5000, total: 10000, totalIsEstimate: true, speed: 2500.5, eta: 2 });
  const na = y.parseLine('LGP|NA|72441|NA|NA|NA');
  assert.equal(na.downloaded, null);
  assert.equal(y.parseLine('LGP|NA|NA|NA|NA|NA').total, null);
  assert.equal(y.parseLine('LGP|12|34|NA|1e3|NA\r').speed, 1000);
  assert.equal(y.parseProgressLine('LGF|/x'), null);
  assert.equal(y.parseProgressLine('LGP|1|2|NA|NA|NA').type, 'progress');
});

test('file / title / merging lines', () => {
  assert.deepEqual(y.parseLine('LGF|/home/u/LinkGrab/My Video [abc].mp4'), { type: 'file', path: '/home/u/LinkGrab/My Video [abc].mp4' });
  assert.deepEqual(y.parseLine('LGF|C:\\Users\\u\\Downloads\\LinkGrab\\a | b [x].mp4'), { type: 'file', path: 'C:\\Users\\u\\Downloads\\LinkGrab\\a | b [x].mp4' });
  assert.deepEqual(y.parseLine('LGT|abc|Title | with pipe'), { type: 'title', id: 'abc', title: 'Title | with pipe' });
  assert.deepEqual(y.parseLine('[Merger] Merging formats into "/x/y.mp4"'), { type: 'merging' });
  assert.deepEqual(y.parseLine('[ExtractAudio] Destination: /x/y.mp3'), { type: 'merging' });
  assert.equal(y.parseLine('Merging formats into "x"').type, 'merging');
  assert.equal(y.parseLine('[download] Destination: /x'), null);
  assert.equal(y.parseLine(''), null);
  assert.equal(y.parseLine('LGF|'), null);
  assert.equal(y.parseLine(undefined), null);
});

test('lineSplitter handles chunk boundaries and carriage returns', () => {
  const got = [];
  const s = y.lineSplitter((l) => got.push(l));
  s.write('LGP|1|2');
  s.write('|NA|NA|NA\nsecond\r');
  s.write('third');
  s.end();
  assert.deepEqual(got, ['LGP|1|2|NA|NA|NA', 'second', 'third']);
});

test('friendly errors suggest browser cookies for login-only content', () => {
  const samples = [
    'ERROR: [facebook] 123: This video is only available for registered users. Use --cookies-from-browser',
    'ERROR: [youtube] abc: Sign in to confirm you\u2019re not a bot',
    'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video',
    'ERROR: [linkedin] x: login required',
    'ERROR: [facebook] 1: Cannot parse data; this video may require login. Use --cookies',
    'ERROR: [youtube] abc: This video is age-restricted',
    'ERROR: [youtube] abc: Join this channel to get access to members-only content',
  ];
  for (const s of samples) {
    const m = y.friendlyError(s, { site: 'facebook' });
    assert.match(m, /Use browser cookies/, s);
  }
  // unknown-parse failures on facebook/linkedin without cookies also get the hint
  assert.match(y.friendlyError('ERROR: [facebook] 1: Cannot parse data', { site: 'facebook' }), /Use browser cookies/);
  assert.match(y.friendlyError('ERROR: Unsupported URL: https://www.linkedin.com/feed', { site: 'linkedin' }), /Use browser cookies/);
});

test('friendly errors: other categories', () => {
  assert.match(y.friendlyError('ERROR: could not find chrome cookies database in "/x"'), /could not read cookies/);
  assert.match(y.friendlyError('ERROR: Failed to decrypt with DPAPI'), /could not read cookies/);
  assert.match(y.friendlyError('ERROR: [youtube] a: Video unavailable'), /not available/);
  assert.match(y.friendlyError('ERROR: unable to download video data: HTTP Error 404: Not Found'), /not available/);
  assert.match(y.friendlyError('ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>'), /Network/);
  assert.match(y.friendlyError('ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install'), /ffmpeg/);
  assert.match(y.friendlyError('ERROR: HTTP Error 429: Too Many Requests'), /rate-limiting/);
  assert.match(y.friendlyError('ERROR: [Errno 28] No space left on device'), /disk is full/);
  assert.equal(y.friendlyError('ERROR: something odd happened'), 'Download failed: something odd happened');
  assert.equal(y.friendlyError(''), 'Download failed for an unknown reason.');
  // youtube login problem when cookies already configured still suggests the setting
  assert.match(y.friendlyError('Sign in to confirm', { site: 'youtube', cookiesFrom: 'chrome' }), /cookies/);
});

test('qualities: only heights that exist, plus best and audio', () => {
  const keys = (hs) => y.bucketQualities(hs).map((q) => q.key);
  assert.deepEqual(keys([1080, 720, 360, 144]), ['best', '1080', '720', '360', 'audio']);
  assert.deepEqual(keys([240]), ['best', '360', 'audio']);
  assert.deepEqual(keys([2160, 1440, 1080, 720, 480, 360]), ['best', '1080', '720', '480', '360', 'audio']);
  assert.deepEqual(keys([]), ['best', 'audio']);
  assert.equal(y.bucketQualities([2160, 720])[0].label, 'Best available (2160p)');
  for (const q of y.bucketQualities([720])) assert.ok(q.key && q.label);
});

test('infoFromJson maps yt-dlp -J output', () => {
  const info = y.infoFromJson({
    title: 'T', duration: 61, uploader: 'U', thumbnail: 'https://i/x.jpg',
    formats: [
      { vcodec: 'none', acodec: 'mp4a', height: null },
      { vcodec: 'avc1', height: 720 }, { vcodec: 'avc1', height: 1080 }, { vcodec: 'avc1', height: 480 },
    ],
  }, 'https://youtu.be/abc');
  assert.equal(info.title, 'T');
  assert.equal(info.duration, 61);
  assert.equal(info.uploader, 'U');
  assert.equal(info.site, 'youtube');
  assert.equal(info.thumbnail, 'https://i/x.jpg');
  assert.deepEqual(info.qualities.map((q) => q.key), ['best', '1080', '720', '480', 'audio']);
  const pl = y.infoFromJson({ _type: 'playlist', entries: [{ title: 'First', thumbnails: [{ url: 'a' }, { url: 'b' }], formats: [] }] }, 'https://youtu.be/x');
  assert.equal(pl.title, 'First');
  assert.equal(pl.thumbnail, 'b');
});

test('runDownload reports a missing binary as a friendly error', async () => {
  const h = y.runDownload({ binary: '/nonexistent/yt-dlp', args: ['--version'] });
  const res = await h.done;
  assert.notEqual(res.code, 0);
  assert.match(res.error, /not found/);
});

test('getInfo rejects unsupported URLs before spawning anything', async () => {
  const r = await y.getInfo({ binary: '/nonexistent/yt-dlp', url: 'https://example.com/a' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unsupported link/);
});
