'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sites = require('../src/main/sites');

test('detects supported hosts', () => {
  const cases = {
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'youtube',
    'https://youtube.com/watch?v=abc': 'youtube',
    'https://m.youtube.com/watch?v=abc': 'youtube',
    'https://music.youtube.com/watch?v=abc': 'youtube',
    'https://youtu.be/dQw4w9WgXcQ': 'youtube',
    'https://www.youtube.com/shorts/abc123': 'youtube',
    'http://youtube.com/watch?v=1': 'youtube',
    'https://www.facebook.com/watch/?v=123': 'facebook',
    'https://facebook.com/user/videos/123': 'facebook',
    'https://m.facebook.com/story.php?id=1': 'facebook',
    'https://web.facebook.com/reel/123': 'facebook',
    'https://fb.watch/abcd/': 'facebook',
    'https://www.linkedin.com/posts/someone_activity-123': 'linkedin',
    'https://linkedin.com/feed/update/urn:li:activity:123/': 'linkedin',
    'HTTPS://WWW.YOUTUBE.COM/watch?v=1': 'youtube',
  };
  for (const [u, site] of Object.entries(cases)) assert.equal(sites.detectSite(u), site, u);
});

test('rejects look-alike and unsupported hosts', () => {
  const bad = [
    'https://evilyoutube.com/watch?v=1',
    'https://youtube.com.evil.example/watch?v=1',
    'https://notfacebook.com/x',
    'https://example.com/youtube.com',
    'https://youtube.com@evil.example/',
    'https://user:pw@www.youtube.com/watch?v=1',
    'https://vimeo.com/123',
    'https://t.co/abcdef',
    'ftp://youtube.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'youtube.com/watch?v=1',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    'http://127.0.0.1:8000/x.mp4',
    'http://localhost/x.mp4',
  ];
  for (const u of bad) assert.equal(sites.detectSite(u), null, String(u));
});

test('validateUrl gives friendly errors', () => {
  assert.equal(sites.validateUrl('https://youtu.be/abc').ok, true);
  assert.equal(sites.validateUrl('  https://youtu.be/abc  ').url, 'https://youtu.be/abc');
  const a = sites.validateUrl('https://vimeo.com/1');
  assert.equal(a.ok, false);
  assert.match(a.error, /YouTube, Facebook, LinkedIn, X and Instagram/);
  assert.equal(sites.validateUrl('not a url').ok, false);
  assert.equal(sites.validateUrl('').ok, false);
  assert.equal(sites.validateUrl('--exec=evil').ok, false);
  assert.equal(sites.validateUrl('-o /etc/passwd https://youtu.be/a').ok, false);
});

test('test hook only works with LINKGRAB_ALLOW_ANY_HOST=1 and only for loopback', () => {
  const prev = process.env.LINKGRAB_ALLOW_ANY_HOST;
  try {
    process.env.LINKGRAB_ALLOW_ANY_HOST = '1';
    assert.equal(sites.detectSite('http://127.0.0.1:8000/a.mp4'), 'test');
    assert.equal(sites.detectSite('http://localhost:8000/a.mp4'), 'test');
    assert.equal(sites.detectSite('https://example.com/a.mp4'), null);
    assert.equal(sites.detectSite('http://192.168.1.10/a.mp4'), null);
    process.env.LINKGRAB_ALLOW_ANY_HOST = '0';
    assert.equal(sites.detectSite('http://127.0.0.1:8000/a.mp4'), null);
    delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    assert.equal(sites.detectSite('http://127.0.0.1:8000/a.mp4'), null);
  } finally {
    if (prev === undefined) delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    else process.env.LINKGRAB_ALLOW_ANY_HOST = prev;
  }
});

test('the app sources never set the test hook env var', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/LINKGRAB_ALLOW_ANY_HOST\s*=[^=]/.test(src.replace(/process\.env\.LINKGRAB_ALLOW_ANY_HOST\s*===/g, '')), f);
  }
});

test('extractUrls finds supported links in free text', () => {
  const text = `Check this https://youtu.be/abc123, and (https://www.facebook.com/watch/?v=9).
    Also https://example.com/nope and https://youtu.be/abc123 again; https://www.linkedin.com/posts/x-1?utm=1.`;
  assert.deepEqual(sites.extractUrls(text), [
    'https://youtu.be/abc123',
    'https://www.facebook.com/watch/?v=9',
    'https://www.linkedin.com/posts/x-1?utm=1',
  ]);
  assert.deepEqual(sites.extractUrls(''), []);
  assert.deepEqual(sites.extractUrls(null), []);
  assert.deepEqual(sites.extractUrls('no links here'), []);
  assert.equal(sites.extractAllUrls('a https://example.com/x b').length, 1);
});

test('detects X and Instagram hosts (including www./mobile. subdomains)', () => {
  const cases = {
    'https://x.com/jack/status/20': 'x',
    'https://www.x.com/jack/status/20': 'x',
    'https://mobile.x.com/jack/status/20': 'x',
    'https://twitter.com/jack/status/20': 'x',
    'https://www.twitter.com/jack/status/20': 'x',
    'https://mobile.twitter.com/jack/status/20': 'x',
    'http://twitter.com/i/web/status/20': 'x',
    'https://x.com/i/status/1790000000000000000': 'x',
    'HTTPS://X.COM/Jack/status/20': 'x',
    'https://instagram.com/p/CxYz123/': 'instagram',
    'https://www.instagram.com/p/CxYz123/': 'instagram',
    'https://www.instagram.com/reel/CxYz123/': 'instagram',
    'https://www.instagram.com/tv/CxYz123/': 'instagram',
    'https://www.instagram.com/someuser/p/CxYz123/': 'instagram',
    'https://m.instagram.com/p/CxYz123/': 'instagram',
    'https://instagr.am/p/CxYz123/': 'instagram',
    'https://www.instagr.am/p/CxYz123/': 'instagram',
    'HTTPS://WWW.INSTAGRAM.COM/reel/CxYz123/': 'instagram',
  };
  for (const [u, site] of Object.entries(cases)) assert.equal(sites.detectSite(u), site, u);
});

test('X and Instagram look-alike hosts and credential tricks are rejected', () => {
  const bad = [
    'https://notx.com/jack/status/20',
    'https://xx.com/jack/status/20',
    'https://x.com.evil.com/jack/status/20',
    'https://x.com.evil.io/jack/status/20',
    'https://twitter.com.evil.example/a/status/1',
    'https://eviltwitter.com/a/status/1',
    'https://nottwitter.com/a/status/1',
    'https://x.co/jack/status/20',
    'https://t.co/abc',
    'https://evilinstagram.com/p/abc/',
    'https://instagram.com.evil.io/p/abc/',
    'https://instagram.org/p/abc/',
    'https://instagr.am.evil.io/p/abc/',
    'https://notinstagr.am/p/abc/',
    'https://example.com/x.com/jack/status/20',
    'https://example.com/?u=https://www.instagram.com/p/abc/',
    'https://x.com@evil.example/jack/status/20',
    'https://user:pw@x.com/jack/status/20',
    'https://user:pw@twitter.com/jack/status/20',
    'https://user@www.instagram.com/p/abc/',
    'https://:pw@instagr.am/p/abc/',
    'ftp://x.com/jack/status/20',
    'x.com/jack/status/20',
    'javascript:alert(1)//x.com',
  ];
  for (const u of bad) assert.equal(sites.detectSite(u), null, u);
  for (const u of bad) assert.equal(sites.validateUrl(u).ok, false, u);
});

test('validateUrl accepts X/Instagram links and the unsupported message names every site', () => {
  const x = sites.validateUrl('  https://x.com/jack/status/20?s=20  ');
  assert.deepEqual(x, { ok: true, url: 'https://x.com/jack/status/20?s=20', site: 'x' });
  const ig = sites.validateUrl('https://www.instagram.com/reel/CxYz123/');
  assert.equal(ig.ok, true);
  assert.equal(ig.site, 'instagram');
  for (const name of ['YouTube', 'Facebook', 'LinkedIn', 'X', 'Instagram']) {
    assert.ok(sites.UNSUPPORTED_MESSAGE.includes(name), name);
  }
  assert.match(sites.validateUrl('https://notx.com/a').error, /Instagram/);
});

test('supportsImages is true only for x, instagram and test', () => {
  for (const s of ['x', 'instagram', 'test']) assert.equal(sites.supportsImages(s), true, s);
  for (const s of ['youtube', 'facebook', 'linkedin', null, undefined, '', 'X', 'Instagram', 'twitter', 42, {}]) {
    assert.equal(sites.supportsImages(s), false, String(s));
  }
});

test('the test site stays hook-only and does not shadow X/Instagram', () => {
  const prev = process.env.LINKGRAB_ALLOW_ANY_HOST;
  try {
    process.env.LINKGRAB_ALLOW_ANY_HOST = '1';
    assert.equal(sites.detectSite('http://127.0.0.1:8000/gallery.html'), 'test');
    assert.equal(sites.detectSite('https://x.com/a/status/1'), 'x');
    assert.equal(sites.detectSite('https://www.instagram.com/p/a/'), 'instagram');
    assert.equal(sites.detectSite('https://notx.com/a/status/1'), null);
    delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    assert.equal(sites.detectSite('http://127.0.0.1:8000/gallery.html'), null);
  } finally {
    if (prev === undefined) delete process.env.LINKGRAB_ALLOW_ANY_HOST;
    else process.env.LINKGRAB_ALLOW_ANY_HOST = prev;
  }
});

test('extractUrls finds X and Instagram links in mixed text', () => {
  const text = [
    'Look at this tweet https://x.com/jack/status/20?s=20&t=AbCdEf_123, it is great!',
    'and this reel (https://www.instagram.com/reel/CxYz123/?igsh=MWx1Zg==).',
    'Not these: https://notx.com/a/status/1 https://x.com.evil.com/a/status/1 https://evilinstagram.com/p/a/',
    'Old style: https://twitter.com/jack/status/20?lang=en; and https://instagr.am/p/Abc_-9/!',
    'Dupe: https://x.com/jack/status/20?s=20&t=AbCdEf_123 and a bare mobile https://mobile.twitter.com/jack/status/21.',
    'Reel again: https://www.instagram.com/reel/CxYz123/?igsh=MWx1Zg==?',
  ].join('\n');
  assert.deepEqual(sites.extractUrls(text), [
    'https://x.com/jack/status/20?s=20&t=AbCdEf_123',
    'https://www.instagram.com/reel/CxYz123/?igsh=MWx1Zg==',
    'https://twitter.com/jack/status/20?lang=en',
    'https://instagr.am/p/Abc_-9/',
    'https://mobile.twitter.com/jack/status/21',
  ]);
});

test('extractUrls strips trailing punctuation from X/Instagram links and keeps tracking params', () => {
  assert.deepEqual(sites.extractUrls('see https://x.com/jack/status/20?s=20.'), ['https://x.com/jack/status/20?s=20']);
  assert.deepEqual(sites.extractUrls('"https://www.instagram.com/reel/CxYz123/",'), ['https://www.instagram.com/reel/CxYz123/']);
  assert.deepEqual(sites.extractUrls('(https://www.instagram.com/p/CxYz123/)'), ['https://www.instagram.com/p/CxYz123/']);
  assert.deepEqual(sites.extractUrls('https://www.instagram.com/reel/CxYz123/!!!'), ['https://www.instagram.com/reel/CxYz123/']);
  assert.deepEqual(sites.extractUrls('wow https://x.com/i/status/1790000000000000000?s=46&t=zz;'), ['https://x.com/i/status/1790000000000000000?s=46&t=zz']);
  // credentials embedded in an otherwise supported host are never extracted
  assert.deepEqual(sites.extractUrls('https://user:pw@x.com/a/status/1 https://tok@www.instagram.com/p/a/'), []);
  // all-urls helper still reports unsupported ones
  assert.equal(sites.extractAllUrls('https://x.com/a/status/1 https://example.com/').length, 2);
});
