'use strict';
// Routes downloads and metadata lookups between the two engines:
//   yt-dlp     -> videos (every site)
//   gallery-dl -> images / "media" (X, Instagram and the LINKGRAB_ALLOW_ANY_HOST test hook)
// Pure Node: must not require 'electron'. Both runners are injected (createRunner / createGalleryRunner shapes).

const y = require('./ytdlp');
const sites = require('./sites');
const gal = require('./gallerydl');

const GALLERY_SITES = ['x', 'instagram'];
const IMAGE_QUALITIES = ['images', 'media'];
const NEEDS_IMAGE_ENGINE = 'Image downloads need the image engine. Click Install engine in the banner.';
const NO_IMAGES_FOR_SITE = 'Image downloads are only available for X and Instagram posts.';

function testHookEnabled() {
  return process.env.LINKGRAB_ALLOW_ANY_HOST === '1';
}

/** URL to hand to gallery-dl for this link, or null when gallery-dl must not be used for it. */
function galleryTargetFor(url, site) {
  if (GALLERY_SITES.includes(site)) return sites.parseHttpUrl(url) ? url : null; // plain http(s) only: no `generic:` etc.
  if (site === 'test' && testHookEnabled()) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    // the generic: extractor of gallery-dl lets the tests serve an HTML page of images from 127.0.0.1
    if (u.pathname.endsWith('/gallery.html')) return gal.GENERIC_PREFIX + u.href;
  }
  return null;
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

async function safeInfo(runner, url, opts, missingText) {
  if (!runner || typeof runner.getInfo !== 'function') return { ok: false, error: missingText, missing: true };
  try {
    const r = await runner.getInfo(url, opts);
    return r && typeof r === 'object' ? r : { ok: false, error: 'Could not read this link.' };
  } catch (e) {
    return { ok: false, error: 'Could not read this link: ' + (e && e.message ? e.message : e) };
  }
}

function isGalleryMissing(g) {
  return !!g && !g.ok && (g.missing === true || g.error === gal.MISSING_MESSAGE);
}

function isYtdlpMissing(r) {
  return !!r && !r.ok && (r.missing === true || /is not installed|was not found/i.test(String(r.error || '')));
}

const LOGIN_RE = /Use browser cookies|signed in|sign in|log ?in/i;

/** Both engines failed (or one is unavailable): pick the message that helps the person most. */
function pickError(yr, g) {
  const yMissing = isYtdlpMissing(yr);
  const gMissing = isGalleryMissing(g);
  if (yMissing && gMissing) return { error: yr.error };
  if (gMissing) {
    // yt-dlp ran and said "no video": the post is probably image-only, which needs the other engine
    if (y.isNoVideoMessage(yr.error)) return { error: NEEDS_IMAGE_ENGINE, needsGallerydl: true };
    return { error: yr.error };
  }
  if (yMissing) return { error: g.error };
  const ye = String(yr.error || '');
  const ge = String(g.error || '');
  if (LOGIN_RE.test(ge) && LOGIN_RE.test(ye)) return { error: ge };
  if (LOGIN_RE.test(ye)) return { error: ye };
  if (LOGIN_RE.test(ge)) return { error: ge };
  if (y.isNoVideoMessage(ye) || /does not point to a downloadable video/i.test(ye)) return { error: ge || ye };
  if (ge && !/^Download failed/i.test(ge)) return { error: ge };
  return { error: ye || ge || 'Could not read this link.' };
}

function dedupe(list, max) {
  const out = [];
  for (const u of list) {
    if (typeof u === 'string' && u && !out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function mergeInfo(yr, g, site) {
  const yOk = !!yr.ok;
  const gOk = !!g.ok;
  if (!yOk && !gOk) {
    const p = pickError(yr, g);
    const out = { ok: false, error: p.error };
    if (p.needsGallerydl) out.needsGallerydl = true;
    return out;
  }
  const gi = gOk ? g.info : null;
  const yi = yOk ? yr.info : null;
  const gImages = gi ? Number(gi.imageCount) || 0 : 0;
  const gVideos = gi ? Number(gi.videoCount) || 0 : 0;

  if (yOk) {
    const videoCount = gVideos || 1;
    const base = {
      title: yi.title, duration: yi.duration, uploader: yi.uploader || (gi && gi.uploader) || '', site: yi.site || site,
    };
    if (gOk && gImages > 0) {
      const total = gImages + videoCount;
      const thumbs = dedupe((gi.thumbnails || []).concat([yi.thumbnail]), 6);
      return {
        ok: true,
        info: Object.assign(base, {
          thumbnail: yi.thumbnail || thumbs[0] || '',
          thumbnails: thumbs,
          kind: 'mixed',
          videoCount,
          imageCount: gImages,
          fileCount: total,
          engine: 'both',
          qualities: [
            { key: 'media', label: `Everything (${total} files)` },
            { key: 'images', label: `Images only (${gImages})` },
          ].concat(yi.qualities || []),
        }),
      };
    }
    const info = Object.assign(base, {
      thumbnail: yi.thumbnail || '',
      thumbnails: dedupe([yi.thumbnail], 6),
      kind: 'video',
      videoCount,
      imageCount: 0,
      fileCount: videoCount,
      engine: 'yt-dlp',
      qualities: yi.qualities,
    });
    if (isGalleryMissing(g)) info.needsGallerydl = true; // images (if any) cannot be listed without gallery-dl
    return { ok: true, info };
  }

  // yt-dlp failed (no video, login, not installed ...) but gallery-dl found files
  const kind = gImages && gVideos ? 'mixed' : gImages ? 'image' : 'video';
  return {
    ok: true,
    info: {
      title: gi.title,
      thumbnail: gi.thumbnail || (gi.thumbnails && gi.thumbnails[0]) || '',
      thumbnails: dedupe(gi.thumbnails || [], 6),
      duration: 0,
      uploader: gi.uploader || '',
      site: gi.site || site,
      kind,
      videoCount: gVideos,
      imageCount: gImages,
      fileCount: gImages + gVideos,
      engine: 'gallery-dl',
      qualities: gal.qualitiesFor(gImages, gVideos),
    },
  };
}

/**
 * @param {{ytdlp:{download:Function,getInfo:Function}, gallery?:{download:Function,getInfo:Function}|null, getSiteOf?:(url:string)=>string|null}} deps
 */
function createRouter(deps) {
  const yt = deps.ytdlp;
  const gallery = deps.gallery || null;
  const getSite = typeof deps.getSiteOf === 'function' ? deps.getSiteOf : (u) => sites.detectSite(u);

  return {
    /** @param {{url,quality,outDir,limitRate,cookiesFrom,site}} p ; @param {(ev)=>void} onEvent */
    download(p, onEvent) {
      const quality = p && p.quality;
      if (!IMAGE_QUALITIES.includes(quality)) return yt.download(p, onEvent);
      const site = p.site || getSite(p.url);
      const target = galleryTargetFor(p.url, site);
      if (!target) return failHandle(NO_IMAGES_FOR_SITE);
      if (!gallery || typeof gallery.download !== 'function') return failHandle(gal.MISSING_MESSAGE);
      return gallery.download(Object.assign({}, p, { url: target, site }), onEvent);
    },

    /** @returns {Promise<{ok:true,info:object}|{ok:false,error:string,needsGallerydl?:boolean}>} */
    async getInfo(url, opts) {
      const site = getSite(url);
      const target = galleryTargetFor(url, site);
      if (!target) return yt.getInfo(url, opts);
      const o = opts || {};
      const [yS, gS] = await Promise.allSettled([
        safeInfo(yt, url, o, 'yt-dlp is not installed. Use the engine setup banner to install it.'),
        safeInfo(gallery, target, Object.assign({}, o, { site }), gal.MISSING_MESSAGE),
      ]);
      const yr = yS.status === 'fulfilled' ? yS.value : { ok: false, error: 'Could not read this link.' };
      const g = gS.status === 'fulfilled' ? gS.value : { ok: false, error: 'Could not read this link.' };
      return mergeInfo(yr, g, site);
    },
  };
}

module.exports = {
  createRouter,
  galleryTargetFor,
  mergeInfo,
  pickError,
  NEEDS_IMAGE_ENGINE,
  NO_IMAGES_FOR_SITE,
  GALLERY_SITES,
  IMAGE_QUALITIES,
};
