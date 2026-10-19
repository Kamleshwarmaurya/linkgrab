'use strict';
// Pure module: URL validation and site detection. Must not require 'electron'.

const SITE_HOSTS = {
  youtube: ['youtube.com', 'youtu.be'],
  facebook: ['facebook.com', 'fb.watch'],
  linkedin: ['linkedin.com'],
  x: ['x.com', 'twitter.com'],
  instagram: ['instagram.com', 'instagr.am'],
};

// Sites whose posts can contain images and are handled by the gallery-dl engine
// (the local 'test' site only exists behind the LINKGRAB_ALLOW_ANY_HOST test hook).
const IMAGE_SITES = ['x', 'instagram', 'test'];

// m.youtube.com, music.youtube.com, www.*, web.facebook.com, mobile.twitter.com, etc. are all
// covered by the subdomain rule below. The rule requires a dot boundary, so look-alikes such as
// notx.com, x.com.evil.com or evilinstagram.com never match.
function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function parseHttpUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 4096) return null;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // never accept credentials embedded in a URL
  return u;
}

function isLocalTestHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// Internal test hook. LINKGRAB_ALLOW_ANY_HOST is only ever set by the test-suite, never by the app.
function testHookEnabled() {
  return process.env.LINKGRAB_ALLOW_ANY_HOST === '1';
}

/**
 * Which supported site a link belongs to.
 * @returns {'youtube'|'facebook'|'linkedin'|'x'|'instagram'|'test'|null} 'test' only with the
 *   LINKGRAB_ALLOW_ANY_HOST test hook enabled and a loopback host; null for anything unsupported or invalid.
 */
function detectSite(input) {
  const u = parseHttpUrl(input);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  for (const site of Object.keys(SITE_HOSTS)) {
    if (SITE_HOSTS[site].some((d) => hostMatches(host, d))) return site;
  }
  if (testHookEnabled() && isLocalTestHost(host)) return 'test';
  return null;
}

/** True when images / whole-post downloads (gallery-dl) can be used for this site key. */
function supportsImages(site) {
  return IMAGE_SITES.includes(site);
}

const UNSUPPORTED_MESSAGE =
  'Unsupported link. LinkGrab supports YouTube, Facebook, LinkedIn, X and Instagram links (http or https).';

/**
 * Validate a user supplied URL.
 * @returns {{ok:true,url:string,site:string}|{ok:false,error:string}}
 */
function validateUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'Please enter a link.' };
  }
  const u = parseHttpUrl(input);
  if (!u) return { ok: false, error: 'That is not a valid http(s) link.' };
  const site = detectSite(input);
  if (!site) return { ok: false, error: UNSUPPORTED_MESSAGE };
  return { ok: true, url: u.href, site };
}

const URL_RE = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;

function cleanTrailing(s) {
  // strip trailing punctuation that is usually not part of the link
  let out = s;
  for (;;) {
    const m = /[.,;:!?)\]]+$/.exec(out);
    if (!m) break;
    // keep a closing paren if the URL contains a matching opening one
    if (m[0][0] === ')' && out.includes('(') && out.split('(').length > out.split(')').length) break;
    out = out.slice(0, -1);
  }
  return out;
}

/** Every http(s) URL found in text (supported or not). */
function extractAllUrls(text) {
  if (typeof text !== 'string') return [];
  const found = text.match(URL_RE) || [];
  return found.map(cleanTrailing).filter(Boolean);
}

/**
 * Supported (YouTube, Facebook, LinkedIn, X, Instagram) URLs found in text, de-duplicated, in
 * order. Trailing sentence punctuation is stripped; query strings (e.g. ?s=20) are kept.
 */
function extractUrls(text) {
  const seen = new Set();
  const out = [];
  for (const raw of extractAllUrls(text)) {
    if (!detectSite(raw)) continue;
    const u = parseHttpUrl(raw);
    if (!u) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
  }
  return out;
}

module.exports = {
  detectSite,
  validateUrl,
  extractUrls,
  extractAllUrls,
  supportsImages,
  parseHttpUrl,
  UNSUPPORTED_MESSAGE,
};
