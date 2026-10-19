/* LinkGrab renderer. All dynamic text goes through textContent / DOM APIs, never innerHTML. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    pause: 'M8 5v14M16 5v14',
    play: 'M7 4.5l12 7.5-12 7.5z',
    stop: 'M6 6h12v12H6z',
    x: 'M6 6l12 12M18 6L6 18',
    trash: 'M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
    list: 'M4 6h16M4 12h16M4 18h16',
    check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6',
    alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16v.5',
    refresh: 'M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5',
    open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    clipboard: 'M9 4h6v3H9zM7 5.5H5.5V20h13V5.5H17',
    film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.5',
    trashfile: 'M5 4h9l5 5v11H5zM14 4v5h5M9.5 13.5l5 5M14.5 13.5l-5 5',
    image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5M15 9.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    layers: 'M8 8h12v12H8zM4 16V4h12'
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.info);
    svg.appendChild(p);
    return svg;
  }

  function hydrateIcons(root) {
    $$('[data-ic]', root).forEach((n) => {
      if (!n.firstChild) n.appendChild(icon(n.dataset.ic));
    });
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n == null || n <= 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + ' ' + u[i];
  }
  function fmtSpeed(n) {
    if (!isFinite(n) || n == null || n <= 0) return '—';
    return fmtBytes(n) + '/s';
  }
  function fmtEta(s) {
    if (!isFinite(s) || s == null || s < 0) return '—';
    s = Math.round(s);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (s < 3600) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(s / 3600);
    if (h < 100) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return '99h+';
  }
  function fmtDuration(s) {
    if (!isFinite(s) || s == null || s <= 0) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  const SITE_NAMES = { youtube: 'YouTube', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram' };
  const QUALITY_LABELS = { best: 'Best', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p', audio: 'Audio only', images: 'Images', media: 'Everything', auto: 'Auto' };
  const KIND_LABELS = { video: 'Video', image: 'Images', mixed: 'Images and video' };
  const KIND_ICONS = { video: 'film', image: 'image', mixed: 'layers' };
  const GD_MISSING_MSG = 'Image downloads need the image engine. Click Install engine in the banner.';
  const DEFAULT_QUALITIES = [
    { key: 'best', label: 'Best available' },
    { key: '1080', label: '1080p' },
    { key: '720', label: '720p' },
    { key: '480', label: '480p' },
    { key: '360', label: '360p' },
    { key: 'audio', label: 'Audio only' }
  ];
  // Used when several links are pasted: the quality applies per link (see qualityForLink).
  const MULTI_QUALITIES = [{ key: 'auto', label: 'Auto (best for each link)' }].concat(DEFAULT_QUALITIES.filter((q) => q.key !== 'best'));
  const STATUS_LABELS = {
    queued: 'Queued', fetching: 'Fetching info', downloading: 'Downloading', paused: 'Paused',
    merging: 'Merging', completed: 'Completed', error: 'Failed', canceled: 'Canceled'
  };
  const ACTIVE = ['queued', 'fetching', 'downloading', 'paused', 'merging'];
  const kindOf = (i) => (i && (i.kind === 'image' || i.kind === 'mixed')) ? i.kind : 'video';
  const hasImages = (i) => kindOf(i) !== 'video';
  const hasVideo = (i) => kindOf(i) !== 'image';
  const FILTERS = {
    all: () => true,
    active: (i) => ACTIVE.indexOf(i.status) !== -1,
    completed: (i) => i.status === 'completed',
    failed: (i) => i.status === 'error' || i.status === 'canceled',
    images: hasImages,
    videos: hasVideo
  };
  const EMPTY_MSG = { active: 'No active downloads.', completed: 'No completed downloads yet.', failed: 'No failed downloads.', images: 'No image downloads yet.', videos: 'No video downloads yet.', all: '' };

  function siteFromUrl(u) {
    try {
      const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
      if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'youtube';
      if (/(^|\.)facebook\.com$/.test(h) || h === 'fb.watch') return 'facebook';
      if (/(^|\.)linkedin\.com$/.test(h)) return 'linkedin';
      if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return 'x';
      if (/(^|\.)instagram\.com$/.test(h) || h === 'instagr.am') return 'instagram';
    } catch (e) { /* ignore */ }
    return null;
  }
  const isImageEngineSite = (site) => site === 'x' || site === 'instagram';
  const safeImg = (u) => typeof u === 'string' && /^(https:|data:image\/)/i.test(u);
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }
  // '1 video', '4 images', '2 images + 1 video'
  function mediaSummary(info) {
    if (!info) return '';
    const v = Number(info.videoCount), im = Number(info.imageCount);
    const parts = [];
    if (im > 0) parts.push(plural(im, 'image'));
    if (v > 0) parts.push(plural(v, 'video'));
    if (parts.length) return parts.join(' + ');
    if (info.kind === 'image') return 'Image post';
    if (info.kind === 'mixed') return 'Images and video';
    return '';
  }

  const BARE_HOST = /^(?:www\.|m\.|mobile\.|music\.)?(?:youtube\.com|youtu\.be|facebook\.com|fb\.watch|linkedin\.com|x\.com|twitter\.com|instagram\.com|instagr\.am)\//i;
  function parseUrls(text) {
    const out = [];
    let ignored = 0;
    String(text || '').split(/[\s,]+/).forEach((tok) => {
      if (!tok) return;
      let t = tok.replace(/^[<("']+|[>)"'.;]+$/g, '');
      if (BARE_HOST.test(t)) t = 'https://' + t;
      if (/^https?:\/\/\S+$/i.test(t)) {
        try { new URL(t); if (out.indexOf(t) === -1) out.push(t); } catch (e) { ignored++; }
      } else {
        ignored++;
      }
    });
    return { urls: out, ignored };
  }

  const debounce = (fn, ms) => {
    let t;
    return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); };
  };

  /* ------------------------------------------------------------------ state */
  const state = {
    items: new Map(),
    rows: new Map(),
    selected: new Set(),
    anchor: null,
    cursor: null,
    filter: 'all',
    settings: {},
    engine: null,
    engineBusy: false,
    gdDismissed: false,
    bannerSoft: false,
    clipDismissed: new Set(),
    clipUrl: null,
    lastFocusEl: null,
    modal: null
  };
  let api = null;

  /* ------------------------------------------------------------------ toasts */
  function toast(msg, opts) {
    opts = opts || {};
    const type = opts.type || 'info';
    const host = $('#toasts');
    const t = el('div', 'toast ' + type);
    t.appendChild(icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info'));
    t.appendChild(el('div', 't-msg', msg));
    if (opts.action) {
      const b = el('button', 'btn small t-act', opts.action.label);
      b.type = 'button';
      b.addEventListener('click', () => { opts.action.run(); dismiss(); });
      t.appendChild(b);
    }
    const x = el('button', 'icon-btn');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss notification');
    x.appendChild(icon('x'));
    x.addEventListener('click', () => dismiss());
    t.appendChild(x);
    host.appendChild(t);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    const timer = setTimeout(dismiss, opts.timeout || (type === 'error' ? 9000 : 4500));
    function dismiss() { clearTimeout(timer); if (t.parentNode) t.parentNode.removeChild(t); }
    return dismiss;
  }
  const toastError = (m, opts) => toast(m, Object.assign({ type: 'error' }, opts));

  function cookieAction(msg) {
    if (/image engine/i.test(msg || '')) return { label: 'Install', run: () => { state.gdDismissed = false; installEngine(); } };
    return /cookie/i.test(msg || '') ? { label: 'Settings', run: openSettings } : null;
  }

  /* ------------------------------------------------------------------ modals */
  function openModal(backdrop, focusEl) {
    closeContext();
    if (state.modal) closeModal(true);
    state.lastFocusEl = document.activeElement;
    backdrop.hidden = false;
    state.modal = backdrop;
    document.body.classList.add('has-modal');
    $$('#toasts .toast:not(.error)').forEach((t) => t.remove()); // keep them from covering the dialog buttons
    setTimeout(() => { (focusEl || $('input,textarea,select,button', backdrop)).focus(); }, 0);
  }
  function closeModal(silent) {
    if (!state.modal) return;
    const m = state.modal;
    m.hidden = true;
    state.modal = null;
    document.body.classList.remove('has-modal');
    if (m.onClose) { const f = m.onClose; m.onClose = null; f(); }
    if (!silent && state.lastFocusEl && state.lastFocusEl.focus && document.contains(state.lastFocusEl)) {
      state.lastFocusEl.focus();
    }
  }
  function trapTab(e) {
    if (!state.modal || e.key !== 'Tab') return;
    const f = $$('button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])', state.modal)
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !state.modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const m = $('#confirmModal');
      $('#cfTitle').textContent = title;
      $('#cfText').textContent = text;
      const ok = $('#cfOk');
      ok.textContent = okLabel || 'Confirm';
      let done = false;
      const finish = (v) => { if (done) return; done = true; ok.onclick = null; resolve(v); };
      ok.onclick = () => { finish(true); closeModal(); };
      openModal(m, $('.btn:not(.danger)', m));
      m.onClose = () => finish(false);
    });
  }

  /* ------------------------------------------------------------------ list rendering */
  const dirty = new Set();
  let fullDirty = true;
  let rafId = 0;
  function schedule(id) {
    if (id) dirty.add(id); else fullDirty = true;
    if (!rafId) rafId = requestAnimationFrame(flush);
  }

  function visibleItems() {
    const pred = FILTERS[state.filter] || FILTERS.all;
    return Array.from(state.items.values())
      .filter((i) => pred(i))
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  function buildRow(id) {
    const tr = el('tr');
    tr.dataset.id = id;
    tr.id = 'row-' + id;
    tr.setAttribute('role', 'row');
    tr.setAttribute('aria-selected', 'false');

    const tdTitle = el('td', 'c-title');
    const wrap = el('div', 'title-cell');
    const thumb = el('div', 'thumb');
    thumb.appendChild(icon('film'));
    const thumbWrap = el('div', 'thumb-wrap');
    const thumbBadge = el('span', 'thumb-count');
    thumbBadge.setAttribute('aria-hidden', 'true');
    thumbBadge.hidden = true;
    thumbWrap.append(thumb, thumbBadge);
    const tw = el('div', 'title-text');
    const titleRow = el('div', 't-row');
    const kindIc = el('span', 'kind-ic');
    kindIc.setAttribute('role', 'img');
    const title = el('span', 't-title');
    titleRow.append(kindIc, title);
    const sub = el('div', 't-sub');
    const siteSub = el('span', 'site-sub');
    const subText = el('span', 'sub-text');
    sub.append(siteSub, subText);
    tw.append(titleRow, sub);
    wrap.append(thumbWrap, tw);
    tdTitle.appendChild(wrap);

    const tdSite = el('td', 'c-site');
    const pill = el('span', 'site-pill');
    pill.append(el('i', 'site-dot'), el('span', 'site-name'));
    tdSite.appendChild(pill);

    const tdSize = el('td', 'c-size num');
    const tdProg = el('td', 'c-prog');
    const prog = el('div', 'prog');
    const bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = el('i');
    bar.appendChild(fill);
    const pct = el('span', 'pct');
    prog.append(bar, pct);
    tdProg.appendChild(prog);
    const tdSpeed = el('td', 'c-speed num');
    const tdEta = el('td', 'c-eta num');
    const tdStatus = el('td', 'c-status');
    const badge = el('span', 'badge');
    tdStatus.appendChild(badge);

    [tdTitle, tdSite, tdSize, tdProg, tdSpeed, tdEta, tdStatus].forEach((td) => { td.setAttribute('role', 'gridcell'); tr.appendChild(td); });
    const ref = { tr, thumb, thumbBadge, kindIc, kindKey: null, title, siteSub, subText, sub, pill, siteName: $('.site-name', pill), tdSize, bar, fill, pct, tdSpeed, tdEta, badge, thumbUrl: null };
    state.rows.set(id, ref);
    return ref;
  }

  function setThumb(ref, url, kind) {
    const ph = kind === 'image' ? 'image' : kind === 'mixed' ? 'layers' : 'film';
    if (ref.thumbUrl === url && ref.thumbPh === ph) return;
    ref.thumbUrl = url;
    ref.thumbPh = ph;
    ref.thumb.replaceChildren();
    if (safeImg(url)) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { ref.thumb.replaceChildren(icon(ph)); ref.thumbUrl = null; });
      img.src = url;
      ref.thumb.appendChild(img);
    } else {
      ref.thumb.appendChild(icon(ph));
    }
  }

  function fileCountOf(item) {
    const n = Number(item.fileCount);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function filesLabel(item) {
    const total = fileCountOf(item);
    if (total <= 1) return '';
    const done = Array.isArray(item.files) ? item.files.length : 0;
    if (item.status !== 'completed' && done > 0 && done < total) return done + ' of ' + total + ' files';
    return total + ' files';
  }

  function updateRow(item) {
    const ref = state.rows.get(item.id) || buildRow(item.id);
    const s = item.status;
    const tr = ref.tr;
    tr.dataset.status = s;
    const name = item.title || item.url || 'Untitled';
    ref.title.textContent = name;
    ref.title.title = name;
    const kind = kindOf(item);
    setThumb(ref, item.thumbnail, kind);
    if (ref.kindKey !== kind) {
      ref.kindKey = kind;
      ref.kindIc.replaceChildren(icon(KIND_ICONS[kind]));
      ref.kindIc.className = 'kind-ic k-' + kind;
      ref.kindIc.title = KIND_LABELS[kind];
      ref.kindIc.setAttribute('aria-label', KIND_LABELS[kind]);
    }
    const nFiles = fileCountOf(item);
    ref.thumbBadge.hidden = nFiles <= 1;
    ref.thumbBadge.textContent = nFiles > 1 ? String(nFiles) : '';

    const siteName = SITE_NAMES[item.site] || siteFromUrl(item.url) && SITE_NAMES[siteFromUrl(item.url)] || '';
    const q = QUALITY_LABELS[item.quality] || item.quality || '';
    ref.siteName.textContent = siteName || '—';
    ref.pill.className = 'site-pill site-' + (item.site || siteFromUrl(item.url) || 'none');
    ref.siteSub.textContent = siteName ? siteName + ' · ' : '';
    ref.siteSub.className = 'site-sub site-' + (item.site || siteFromUrl(item.url) || 'none');
    if (s === 'error' && item.error) {
      ref.sub.className = 't-sub err';
      ref.subText.textContent = item.error;
      ref.sub.title = item.error;
    } else {
      ref.sub.className = 't-sub';
      const fl = filesLabel(item);
      ref.subText.textContent = [fl, q].filter(Boolean).join(' · ');
      ref.sub.title = '';
    }

    ref.tdSize.textContent = item.size > 0 ? fmtBytes(item.size) : '—';
    ref.tdSize.title = item.downloaded > 0 && item.size > 0 && s !== 'completed' ? fmtBytes(item.downloaded) + ' of ' + fmtBytes(item.size) : '';

    let pct = s === 'completed' ? 100 : Math.max(0, Math.min(100, Number(item.percent) || 0));
    ref.fill.style.width = pct + '%';
    ref.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    ref.bar.setAttribute('aria-label', name + ' progress');
    ref.pct.textContent = (s === 'fetching' || s === 'queued' || ((s === 'error' || s === 'canceled') && pct === 0)) ? '' : Math.floor(pct) + '%';

    const running = s === 'downloading';
    ref.tdSpeed.textContent = running ? fmtSpeed(item.speed) : '—';
    ref.tdEta.textContent = running ? fmtEta(item.eta) : '—';
    ref.tdSpeed.classList.toggle('dim', !running);
    ref.tdEta.classList.toggle('dim', !running);

    ref.badge.className = 'badge s-' + s;
    ref.badge.textContent = STATUS_LABELS[s] || s;
    ref.badge.title = s === 'error' && item.error ? item.error : '';
    applySelectionClass(item.id);
    return ref;
  }

  function applySelectionClass(id) {
    const ref = state.rows.get(id);
    if (!ref) return;
    const on = state.selected.has(id);
    ref.tr.classList.toggle('selected', on);
    ref.tr.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  function flush() {
    rafId = 0;
    const full = fullDirty;
    fullDirty = false;
    const ids = Array.from(dirty);
    dirty.clear();

    const vis = visibleItems();
    const visIds = new Set(vis.map((i) => i.id));

    // remove rows that are gone or filtered out
    state.rows.forEach((ref, id) => {
      if (!state.items.has(id)) { ref.tr.remove(); state.rows.delete(id); }
      else if (!visIds.has(id) && ref.tr.parentNode) ref.tr.remove();
    });

    const tbody = $('#rows');
    vis.forEach((item, idx) => {
      let ref = state.rows.get(item.id);
      if (!ref || full || dirty.has(item.id) || ids.indexOf(item.id) !== -1 || !ref.tr.parentNode) ref = updateRow(item);
      if (tbody.children[idx] !== ref.tr) tbody.insertBefore(ref.tr, tbody.children[idx] || null);
    });

    // prune selection
    state.selected.forEach((id) => { if (!visIds.has(id)) state.selected.delete(id); });

    updateCounts();
    updateEmpty(vis.length);
    updateToolbar();
    updateStats();
  }

  function updateCounts() {
    const c = { all: 0, active: 0, completed: 0, failed: 0, images: 0, videos: 0 };
    state.items.forEach((i) => {
      c.all++;
      if (FILTERS.active(i)) c.active++;
      else if (FILTERS.completed(i)) c.completed++;
      else if (FILTERS.failed(i)) c.failed++;
      if (hasImages(i)) c.images++;
      if (hasVideo(i)) c.videos++;
    });
    $('#cntImages').textContent = c.images;
    $('#cntVideos').textContent = c.videos;
    $('#cntAll').textContent = c.all;
    $('#cntActive').textContent = c.active;
    $('#cntCompleted').textContent = c.completed;
    $('#cntFailed').textContent = c.failed;
  }

  function updateEmpty(visCount) {
    const empty = $('#empty');
    if (visCount > 0) { empty.hidden = true; return; }
    empty.hidden = false;
    const none = state.items.size === 0;
    $('#emptyTitle').textContent = none ? 'No downloads yet' : 'Nothing here';
    $('#emptyBody').hidden = !none;
    $('#emptyAdd').hidden = !none;
    if (!none) {
      $('#emptyTitle').textContent = EMPTY_MSG[state.filter] || 'Nothing here';
    }
  }

  function updateStats() {
    let speed = 0, active = 0;
    state.items.forEach((i) => { if (i.status === 'downloading') { active++; speed += Number(i.speed) || 0; } });
    const n = state.items.size;
    const base = n + (n === 1 ? ' download' : ' downloads');
    $('#footStats').textContent = active ? base + ' · ' + active + ' active · ↓ ' + fmtSpeed(speed) : base;
  }

  /* ------------------------------------------------------------------ selection */
  function selItems() { return Array.from(state.selected).map((id) => state.items.get(id)).filter(Boolean); }

  const can = {
    pause: (i) => ['downloading', 'queued', 'fetching'].indexOf(i.status) !== -1,
    resume: (i) => i.status === 'paused',
    retry: (i) => i.status === 'error' || i.status === 'canceled',
    cancel: (i) => ACTIVE.indexOf(i.status) !== -1,
    open: (i) => i.status === 'completed'
  };

  function updateToolbar() {
    const s = selItems();
    $('#tbPause').disabled = !s.some(can.pause);
    $('#tbResume').disabled = !s.some((i) => can.resume(i) || can.retry(i));
    $('#tbCancel').disabled = !s.some(can.cancel);
    $('#tbRemove').disabled = s.length === 0;
    $('#tbFolder').disabled = s.length === 0 && !lastCompleted();
    $('#tbFolder').title = s.length ? 'Show in folder' : 'Show latest download in folder';
  }

  function lastCompleted() {
    let best = null;
    state.items.forEach((i) => { if (i.status === 'completed' && (!best || (i.addedAt || 0) > (best.addedAt || 0))) best = i; });
    return best;
  }

  function setSelection(ids, cursor) {
    const prev = new Set(state.selected);
    state.selected = new Set(ids);
    state.cursor = cursor != null ? cursor : (ids.length ? ids[ids.length - 1] : null);
    prev.forEach(applySelectionClass);
    state.selected.forEach(applySelectionClass);
    const grid = $('#grid');
    if (state.cursor && state.rows.has(state.cursor)) grid.setAttribute('aria-activedescendant', 'row-' + state.cursor);
    else grid.removeAttribute('aria-activedescendant');
    updateToolbar();
  }

  function visibleIds() { return visibleItems().map((i) => i.id); }

  function onRowClick(e) {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    $('#grid').focus({ preventScroll: true });
    if (e.shiftKey && state.anchor && state.rows.has(state.anchor)) {
      const ids = visibleIds();
      const a = ids.indexOf(state.anchor), b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelection(ids.slice(lo, hi + 1), id);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(state.selected);
      if (next.has(id)) next.delete(id); else next.add(id);
      state.anchor = id;
      setSelection(Array.from(next), id);
      return;
    }
    state.anchor = id;
    setSelection([id], id);
  }

  function moveCursor(delta, extend) {
    const ids = visibleIds();
    if (!ids.length) return;
    let idx = ids.indexOf(state.cursor);
    idx = idx === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, idx + delta));
    const id = ids[idx];
    if (extend && state.anchor) {
      const a = ids.indexOf(state.anchor);
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      setSelection(ids.slice(lo, hi + 1), id);
    } else {
      state.anchor = id;
      setSelection([id], id);
    }
    const ref = state.rows.get(id);
    if (ref) ref.tr.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------ actions */
  async function call(fn, errPrefix) {
    try {
      const r = await fn();
      if (r && r.ok === false) { toastError((errPrefix ? errPrefix + ': ' : '') + (r.error || 'Action failed'), { action: cookieAction(r.error) }); return r; }
      return r;
    } catch (err) {
      toastError((errPrefix ? errPrefix + ': ' : '') + (err && err.message ? err.message : String(err)));
      return { ok: false };
    }
  }

  const doPause = (items) => Promise.all(items.filter(can.pause).map((i) => call(() => api.pause(i.id), 'Pause')));
  const doResume = (items) => Promise.all(items.filter(can.resume).map((i) => call(() => api.resume(i.id), 'Resume')));
  const doCancel = (items) => Promise.all(items.filter(can.cancel).map((i) => call(() => api.cancel(i.id), 'Cancel')));
  async function doRetry(items) {
    for (const i of items.filter(can.retry)) {
      const rm = await call(() => api.remove(i.id, false), 'Retry');
      if (rm && rm.ok === false) continue;
      dropItem(i.id);
      const r = await call(() => api.add(i.url, i.quality || 'best'), 'Retry');
      if (r && r.ok && r.item) upsert(r.item);
    }
  }
  async function doRemove(items, del) {
    if (!items.length) return;
    if (del) {
      let nFiles = 0;
      items.forEach((i) => { const n = fileCountOf(i); nFiles += n > 0 ? n : (i.filePath || i.status === 'completed') ? 1 : 0; });
      const multi = items.some((i) => fileCountOf(i) > 1);
      const what = nFiles ? (nFiles === 1 ? 'the downloaded file' : 'all ' + nFiles + ' downloaded files') : 'any partial files';
      const ok = await confirmDialog('Delete ' + (nFiles > 1 || multi ? 'files' : 'file') + '?',
        'Remove ' + plural(items.length, 'download') + ' from the list and delete ' + what + ' from disk? This cannot be undone.', 'Remove and delete');
      if (!ok) return;
    }
    for (const i of items) {
      const r = await call(() => api.remove(i.id, !!del), 'Remove');
      if (r && r.ok !== false) dropItem(i.id);
    }
  }
  function dropItem(id) {
    state.items.delete(id);
    state.selected.delete(id);
    if (state.cursor === id) state.cursor = null;
    if (state.anchor === id) state.anchor = null;
    schedule();
  }
  const doOpen = (i) => call(() => api.openFile(i.id), 'Open file');
  const doShow = (i) => call(() => api.showInFolder(i.id), 'Show in folder');

  function toggleSelected() {
    const s = selItems();
    if (s.some(can.pause)) doPause(s);
    else if (s.some(can.resume)) doResume(s);
  }

  /* ------------------------------------------------------------------ item events */
  function upsert(item) {
    if (!item || !item.id) return;
    const prev = state.items.get(item.id);
    state.items.set(item.id, item);
    schedule(item.id);
    if (!prev) { if (!state.booting) schedule(); return; }
    if (prev.status !== item.status) {
      schedule();
      const name = item.title || item.url;
      if (item.status === 'error') {
        toastError((name ? name + ': ' : '') + (item.error || 'Download failed'), { action: cookieAction(item.error) });
      } else if (item.status === 'completed') {
        const fl = fileCountOf(item) > 1 ? ' (' + fileCountOf(item) + ' files)' : '';
        toast('Download complete: ' + name + fl, { type: 'success', action: { label: 'Open', run: () => doOpen(item) } });
      }
    }
  }

  /* ------------------------------------------------------------------ context menu */
  function closeContext() {
    const m = $('#ctxMenu');
    if (!m.hidden) { m.hidden = true; m.replaceChildren(); }
  }
  function openContext(x, y) {
    const s = selItems();
    if (!s.length) return;
    const m = $('#ctxMenu');
    m.replaceChildren();
    const single = s.length === 1;
    const multiFile = single && fileCountOf(s[0]) > 1 && can.open(s[0]);
    const defs = [
      { label: multiFile ? 'Open first file' : 'Open file', ic: 'open', on: single && can.open(s[0]), run: () => doOpen(s[0]) },
      { label: multiFile ? 'Open folder' : 'Show in folder', ic: 'folder', on: single, run: () => doShow(s[0]) },
      '-',
      { label: 'Pause', ic: 'pause', on: s.some(can.pause), run: () => doPause(s) },
      { label: 'Resume', ic: 'play', on: s.some(can.resume), run: () => doResume(s) },
      { label: 'Cancel', ic: 'stop', on: s.some(can.cancel), run: () => doCancel(s) },
      { label: 'Retry', ic: 'refresh', on: s.some(can.retry), run: () => doRetry(s) },
      '-',
      { label: 'Remove', ic: 'trash', on: true, run: () => doRemove(s, false) },
      { label: 'Remove and delete files', ic: 'trashfile', on: true, danger: true, run: () => doRemove(s, true) }
    ];
    defs.forEach((d) => {
      if (d === '-') { m.appendChild(el('hr')); return; }
      const b = el('button', d.danger ? 'danger' : '');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.appendChild(icon(d.ic));
      b.appendChild(el('span', '', d.label));
      if (!d.on) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', () => { if (!d.on) return; closeContext(); d.run(); });
      m.appendChild(b);
    });
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    const first = $('button:not([aria-disabled="true"])', m);
    if (first) first.focus();
  }
  function ctxKey(e) {
    const m = $('#ctxMenu');
    if (m.hidden) return false;
    const items = $$('button:not([aria-disabled="true"])', m);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { closeContext(); $('#grid').focus(); }
    else if (e.key === 'Tab') { closeContext(); return false; }
    else return false;
    e.preventDefault();
    return true;
  }

  /* ------------------------------------------------------------------ Add URL modal */
  const add = { urls: [], ignored: 0, infoCache: new Map(), inflight: new Map(), seq: 0, infoUrl: null, info: null, quality: 'best', busy: false };

  function renderQualities(list, multi) {
    const g = $('#qualityGroup');
    g.replaceChildren();
    const qs = (list && list.length ? list : multi ? MULTI_QUALITIES : DEFAULT_QUALITIES);
    if (!qs.some((q) => q.key === add.quality)) add.quality = qs[0].key;
    qs.forEach((q) => {
      const lab = el('label');
      const inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'quality'; inp.value = q.key; inp.checked = q.key === add.quality;
      inp.addEventListener('change', () => { add.quality = q.key; });
      lab.append(inp, el('span', '', q.label || QUALITY_LABELS[q.key] || q.key));
      g.appendChild(lab);
    });
  }

  function previewState(kind, msg, extra) {
    const p = $('#addPreview');
    p.replaceChildren();
    p.className = 'preview';
    p.hidden = false;
    const wrap = el('div', 'pv-state' + (kind === 'err' ? ' err' : ''));
    if (kind === 'loading') wrap.appendChild(el('span', 'spinner'));
    else wrap.appendChild(icon('alert'));
    const t = el('div');
    t.appendChild(el('div', '', msg));
    if (extra) t.appendChild(extra);
    wrap.appendChild(t);
    p.appendChild(wrap);
  }

  function imgInto(box, url, fallbackIcon, alt) {
    if (safeImg(url)) {
      const img = document.createElement('img');
      img.alt = alt || '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => box.replaceChildren(icon(fallbackIcon)));
      img.src = url;
      box.appendChild(img);
    } else box.appendChild(icon(fallbackIcon));
  }

  function installLink(label) {
    const b = el('button', 'link-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => { state.gdDismissed = false; installEngine(); });
    return b;
  }

  function renderPreview(info, url) {
    const p = $('#addPreview');
    p.replaceChildren();
    p.hidden = false;
    const kind = kindOf(info);
    p.className = 'preview k-' + kind;
    const thumbs = (Array.isArray(info.thumbnails) ? info.thumbnails : []).filter(safeImg).slice(0, 6);
    const gallery = kind !== 'video' && thumbs.length > 1;
    const total = (Number(info.videoCount) || 0) + (Number(info.imageCount) || 0);

    const meta = el('div', 'pv-info');
    meta.appendChild(el('div', 'pv-title', info.title || url));
    const bits = [];
    if (info.uploader) bits.push(info.uploader);
    const site = SITE_NAMES[info.site] || SITE_NAMES[siteFromUrl(url)];
    if (site) bits.push(site);
    meta.appendChild(el('div', 'pv-meta', bits.join(' · ')));
    const summary = mediaSummary(info);
    if (summary) {
      const chip = el('div', 'pv-summary k-' + kind);
      chip.append(icon(KIND_ICONS[kind]), el('span', '', summary));
      meta.appendChild(chip);
    }
    if (info.needsGallerydl) {
      const note = el('div', 'pv-note');
      note.append(el('span', '', 'This post also has images. Install the image engine to download them. '), installLink('Install image engine'));
      meta.appendChild(note);
    }

    if (gallery) {
      const top = el('div', 'pv-top');
      const badge = el('div', 'pv-kind k-' + kind);
      badge.appendChild(icon(KIND_ICONS[kind]));
      top.append(badge, meta);
      const grid = el('div', 'pv-grid');
      grid.setAttribute('role', 'list');
      grid.setAttribute('aria-label', 'Preview of ' + (summary || 'media'));
      thumbs.forEach((u, i) => {
        const tile = el('div', 'pv-tile');
        tile.setAttribute('role', 'listitem');
        imgInto(tile, u, 'image', 'Preview ' + (i + 1) + ' of ' + (total || thumbs.length));
        if (i === thumbs.length - 1 && total > thumbs.length) {
          const more = el('span', 'pv-more', '+' + (total - thumbs.length));
          more.setAttribute('aria-label', (total - thumbs.length) + ' more');
          tile.appendChild(more);
        }
        grid.appendChild(tile);
      });
      p.append(top, grid);
      return;
    }

    const th = el('div', 'pv-thumb');
    imgInto(th, info.thumbnail || thumbs[0], KIND_ICONS[kind], '');
    const dur = fmtDuration(info.duration);
    if (dur) th.appendChild(el('span', 'pv-dur', dur));
    p.append(th, meta);
  }

  function renderList() {
    const ul = $('#addList');
    ul.replaceChildren();
    ul.hidden = add.urls.length < 2;
    add.urls.forEach((u) => {
      const site = siteFromUrl(u);
      const li = el('li', site ? '' : 'bad');
      const s = el('span', 'll-site site-' + (site || 'none'));
      s.append(el('i', 'site-dot'), el('span', '', site ? SITE_NAMES[site] : 'Unsupported'));
      const url = el('span', 'll-url', u);
      url.title = u;
      li.append(s, url);
      if (isImageEngineSite(site)) {
        const c = add.infoCache.get(u);
        let txt, cls = 'll-kind';
        if (c && c.info) txt = mediaSummary(c.info) || KIND_LABELS[kindOf(c.info)];
        else if (add.inflight.has(u)) { txt = 'Checking…'; cls += ' pending'; }
        else if (add.failed && add.failed.has(u)) { txt = 'Info unavailable'; cls += ' bad'; }
        if (txt) { const k = el('span', cls, txt); if (add.failed && add.failed.has(u)) k.title = add.failed.get(u); li.appendChild(k); }
      }
      const rm = el('button', 'icon-btn');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove link from list');
      rm.appendChild(icon('x'));
      rm.addEventListener('click', () => {
        const ta = $('#addUrls');
        ta.value = add.urls.filter((x) => x !== u).join('\n');
        onAddInput(true);
      });
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  add.failed = new Map();
  // One shared lookup per URL: used by the single-link preview, the multi-link list and submit.
  function getInfoOnce(url) {
    if (add.infoCache.has(url)) return Promise.resolve(add.infoCache.get(url));
    if (add.inflight.has(url)) return add.inflight.get(url);
    const pr = (async () => {
      let res;
      try { res = await api.getInfo(url); } catch (err) { res = { ok: false, error: err && err.message ? err.message : String(err) }; }
      if (res && res.ok && res.info) { add.infoCache.set(url, res); add.failed.delete(url); }
      else add.failed.set(url, (res && res.error) || 'Could not read this link.');
      return res;
    })();
    add.inflight.set(url, pr);
    pr.then(() => { add.inflight.delete(url); }, () => { add.inflight.delete(url); });
    return pr;
  }

  const fetchPreview = debounce(async () => {
    if (add.urls.length !== 1) return;
    const url = add.urls[0];
    const seq = ++add.seq;
    if (!add.infoCache.has(url)) previewState('loading', 'Fetching post info…');
    const res = await getInfoOnce(url);
    if (seq !== add.seq || add.urls[0] !== url) return;
    showInfoResult(res, url);
  }, 450);

  // Fills in the per-link kind in multi-link mode (only X / Instagram can be image posts).
  const fetchKinds = debounce(async () => {
    if (add.urls.length < 2) return;
    const seq = add.seq;
    const todo = add.urls.filter((u) => isImageEngineSite(siteFromUrl(u)) && !add.infoCache.has(u));
    if (!todo.length) { renderList(); return; }
    renderList();
    for (const u of todo) {
      await getInfoOnce(u);
      if (seq !== add.seq) return;
      renderList();
    }
  }, 300);

  function showInfoResult(res, url) {
    if (res && res.ok && res.info) {
      add.info = res.info;
      renderPreview(res.info, url);
      const k = kindOf(res.info);
      const qs = res.info.qualities;
      if (k !== 'video' && qs && qs.length) add.quality = qs[0].key; // image / mixed: first entry is the default
      renderQualities(qs);
    } else {
      add.info = null;
      const err = (res && res.error) || 'Could not read this link.';
      let extra = null;
      if (/image engine/i.test(err)) extra = installLink('Install image engine');
      else if (/cookie/i.test(err)) {
        extra = el('button', 'link-btn', 'Open Settings');
        extra.type = 'button';
        extra.addEventListener('click', () => openSettings());
      }
      previewState('err', err, extra);
      renderQualities(null);
    }
  }

  function onAddInput(immediate) {
    const { urls, ignored } = parseUrls($('#addUrls').value);
    add.urls = urls;
    add.ignored = ignored;
    add.seq++;
    $('#addError').hidden = true;
    const n = urls.length;
    $('#addGo').disabled = n === 0 || add.busy;
    $('#addGo').textContent = n > 1 ? 'Add ' + n + ' links' : 'Add';
    const hint = $('#addHint');
    hint.textContent = '';
    if (ignored && $('#addUrls').value.trim()) hint.textContent = ignored + (ignored === 1 ? ' entry is' : ' entries are') + ' not a link and will be skipped.';
    else if (n > 1) hint.textContent = n + ' links detected. Video links use the quality below; image and mixed posts are saved as images or everything.';
    $('#addHelp').hidden = n > 0;
    renderList();
    if (n === 1) {
      $('#addList').hidden = true;
      fetchPreview();
    } else {
      $('#addPreview').hidden = true;
      add.info = null;
      renderQualities(null, n > 1);
      if (n > 1) fetchKinds();
    }
    if (n === 0) { $('#addPreview').hidden = true; }
  }

  function openAdd(prefill) {
    add.info = null; add.urls = []; add.busy = false; add.quality = 'best'; add.seq++;
    const ta = $('#addUrls');
    ta.value = prefill ? (Array.isArray(prefill) ? prefill.join('\n') : String(prefill)) : '';
    $('#addPreview').hidden = true;
    $('#addList').hidden = true;
    $('#addError').hidden = true;
    renderQualities(null);
    onAddInput();
    openModal($('#addModal'), ta);
  }

  // Which quality key to send for one link. Single link with a loaded preview: whatever the picker says.
  // Otherwise (several links): Auto / a video quality applies to videos; image posts are always 'images',
  // mixed posts 'media' (everything). Unknown kinds fall back to the picked video quality.
  function qualityForLink(url, res, single) {
    const info = res && res.ok && res.info ? res.info : null;
    if (single && info) return add.quality;
    const k = info ? kindOf(info) : 'video';
    if (k === 'image') return 'images';
    if (k === 'mixed') return 'media';
    return add.quality === 'auto' ? 'best' : add.quality;
  }

  async function submitAdd() {
    if (add.busy || !add.urls.length) return;
    add.busy = true;
    const go = $('#addGo');
    go.disabled = true;
    const label = go.textContent;
    go.textContent = 'Adding…';
    const failed = [];
    let okCount = 0;
    const single = add.urls.length === 1;
    for (const url of add.urls.slice()) {
      let r;
      try {
        let res = null;
        if (isImageEngineSite(siteFromUrl(url))) res = await getInfoOnce(url); // need the kind to pick images vs video
        else res = add.infoCache.get(url) || null;
        const q = qualityForLink(url, res, single);
        r = await api.add(url, q);
      } catch (err) { r = { ok: false, error: err && err.message ? err.message : String(err) }; }
      if (r && r.ok) { okCount++; if (r.item) upsert(r.item); }
      else failed.push({ url, error: (r && r.error) || 'Could not add link' });
    }
    add.busy = false;
    go.textContent = label;
    if (!failed.length) {
      closeModal();
      toast(okCount > 1 ? okCount + ' downloads added' : 'Download added', { type: 'success' });
      return;
    }
    // keep only the failed links in the box so they can be fixed or retried
    $('#addUrls').value = failed.map((f) => f.url).join('\n');
    onAddInput();
    const box = $('#addError');
    box.replaceChildren();
    box.appendChild(el('div', '', okCount ? okCount + ' added. ' + failed.length + ' could not be added:' : 'Could not add the link:'));
    const ul = el('ul');
    failed.slice(0, 4).forEach((f) => ul.appendChild(el('li', '', failed.length > 1 ? f.url + ' — ' + f.error : f.error)));
    box.appendChild(ul);
    if (failed.some((f) => /image engine/i.test(f.error))) box.appendChild(installLink('Install image engine'));
    if (failed.some((f) => /cookie/i.test(f.error))) {
      const b = el('button', 'link-btn', 'Open Settings');
      b.type = 'button';
      b.addEventListener('click', () => openSettings());
      box.appendChild(b);
    }
    box.hidden = false;
    $('#addGo').disabled = false;
  }

  /* ------------------------------------------------------------------ Settings modal */
  async function openSettings() {
    let s = state.settings;
    try { s = await api.getSettings(); state.settings = s || {}; } catch (e) { /* use cached */ }
    $('#setDir').value = (s && s.downloadDir) || '';
    $('#setMax').value = (s && s.maxConcurrent) || 3;
    $('#setLimit').value = (s && s.speedLimit) || '';
    const ck = $('#setCookies');
    const cv = (s && s.cookiesFrom) || '';
    if (cv && !$$('option', ck).some((o) => o.value === cv)) {
      const o = el('option', '', cv.charAt(0).toUpperCase() + cv.slice(1));
      o.value = cv;
      ck.appendChild(o);
    }
    ck.value = cv;
    $('#setError').hidden = true;
    openModal($('#settingsModal'), $('#setDir'));
  }
  async function saveSettings() {
    const err = $('#setError');
    const max = parseInt($('#setMax').value, 10);
    const limit = $('#setLimit').value.trim();
    const dir = $('#setDir').value.trim();
    let problem = '';
    if (!dir) problem = 'Choose a download folder.';
    else if (!(max >= 1 && max <= 10)) problem = 'Max concurrent downloads must be between 1 and 10.';
    else if (limit && !/^\d+(\.\d+)?\s*[kKmMgG]?$/.test(limit)) problem = 'Speed limit looks like 500K or 2M. Leave it empty for no limit.';
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = $('#setSave');
    btn.disabled = true;
    try {
      const s = await api.setSettings({ downloadDir: dir, maxConcurrent: max, speedLimit: limit.replace(/\s+/g, ''), cookiesFrom: $('#setCookies').value });
      state.settings = s || state.settings;
      closeModal();
      toast('Settings saved', { type: 'success', timeout: 2500 });
    } catch (e) {
      err.textContent = 'Could not save settings: ' + (e && e.message ? e.message : e);
      err.hidden = false;
    } finally { btn.disabled = false; }
  }
  async function browseFolder() {
    try {
      const d = await api.chooseFolder();
      if (d) $('#setDir').value = d;
    } catch (e) { toastError('Could not open folder picker: ' + (e && e.message ? e.message : e)); }
  }

  /* ------------------------------------------------------------------ Engine */
  async function refreshEngine() {
    try { state.engine = await api.engineStatus(); } catch (e) { state.engine = null; }
    renderEngine();
  }

  function setBanner(o) {
    const banner = $('#banner');
    banner.hidden = false;
    banner.className = 'banner' + (o.cls ? ' ' + o.cls : '');
    $('#bannerTitle').textContent = o.title;
    $('#bannerText').textContent = o.text;
    $('#btnInstallLabel').textContent = o.btn;
    $('#btnInstall').disabled = !!state.engineBusy;
    state.bannerSoft = !!o.soft;
    $('#bannerClose').hidden = !o.soft;
  }

  function renderEngine() {
    const e = state.engine;
    const banner = $('#banner');
    const yt = $('#engYtdlp'), ff = $('#engFfmpeg'), gd = $('#engGallerydl');
    if (!e) { yt.textContent = '?'; ff.textContent = '?'; gd.textContent = '?'; banner.hidden = true; return; }
    const ytOk = !!(e.ytdlp && e.ytdlp.installed);
    const ffOk = !!(e.ffmpeg && e.ffmpeg.installed);
    const gdKnown = !!e.gallerydl;
    const gdOk = !gdKnown || !!e.gallerydl.installed;
    yt.textContent = ytOk ? (e.ytdlp.version || 'installed') : 'missing';
    yt.className = 'eng-val ' + (ytOk ? 'ok' : 'bad');
    ff.textContent = ffOk ? 'installed' : 'missing';
    ff.className = 'eng-val ' + (ffOk ? 'ok' : 'bad');
    gd.textContent = !gdKnown ? '—' : gdOk ? (e.gallerydl.version || 'installed') : 'missing';
    gd.className = 'eng-val ' + (!gdKnown ? '' : gdOk ? 'ok' : 'bad');
    $('#btnUpdateLabel').textContent = state.engineBusy ? 'Working…' : ytOk ? 'Update engine' : 'Install engine';
    $('#btnUpdate').disabled = state.engineBusy;

    const hard = !ytOk || !ffOk;
    const soft = !hard && !gdOk && !state.gdDismissed;
    if (hard) {
      setBanner({
        cls: ytOk ? 'warn' : '',
        title: ytOk ? 'ffmpeg is missing' : 'Download engine required',
        text: ytOk
          ? 'Needed to merge video with audio and to save audio only. One-time download.'
          : 'LinkGrab needs yt-dlp and ffmpeg for videos, plus gallery-dl for images. One-time download, about 100 MB.',
        btn: state.engineBusy ? 'Installing…' : 'Install'
      });
    } else if (soft) {
      setBanner({
        cls: 'soft', soft: true,
        title: 'Image downloads need the image engine',
        text: 'Photos and carousels from X and Instagram use gallery-dl. Videos work without it.',
        btn: state.engineBusy ? 'Installing…' : 'Install'
      });
    } else {
      banner.hidden = !state.engineBusy;
    }
  }

  function setBannerProgress(pct, msg) {
    const wrap = $('#bannerProgress');
    wrap.hidden = false;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    $('#bannerBar').style.width = p + '%';
    $('.bar', wrap).setAttribute('aria-valuenow', String(Math.round(p)));
    $('#bannerMsg').textContent = msg || '';
  }

  const STAGE_NAMES = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', gallerydl: 'gallery-dl' };
  function onEngineProgress(ev) {
    if (!ev) return;
    const name = STAGE_NAMES[ev.stage] || 'engine';
    const msg = ev.message || ('Downloading ' + name + '… ' + Math.round(ev.percent || 0) + '%');
    if (!$('#banner').hidden) setBannerProgress(ev.percent, msg);
    const m = $('#engMsg');
    m.hidden = false;
    m.className = 'eng-msg';
    m.textContent = msg;
  }

  async function installEngine() {
    if (state.engineBusy) return;
    state.engineBusy = true;
    const wasSoft = state.bannerSoft || (state.engine && state.engine.ytdlp && state.engine.ytdlp.installed && state.engine.ffmpeg && state.engine.ffmpeg.installed);
    renderEngine();
    $('#banner').hidden = false;
    $('#bannerClose').hidden = true;
    setBannerProgress(0, 'Starting…');
    let r;
    try { r = await api.installEngine(); } catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
    state.engineBusy = false;
    $('#bannerProgress').hidden = true;
    $('#engMsg').hidden = true;
    add.infoCache.clear(); // earlier previews may have been cut short by the missing engine
    await refreshEngine();
    if (r && r.ok) {
      toast('Download engine installed' + (r.note ? '. ' + r.note : ''), { type: r.note ? 'info' : 'success', timeout: r.note ? 9000 : undefined });
    } else {
      toastError('Engine install failed: ' + ((r && r.error) || 'unknown error'));
      setBanner({ cls: 'err', soft: wasSoft, title: 'Install failed', text: (r && r.error) || 'Check your connection and try again.', btn: 'Retry' });
    }
  }

  async function updateEngine() {
    if (state.engineBusy) return;
    if (!(state.engine && state.engine.ytdlp && state.engine.ytdlp.installed)) return installEngine();
    state.engineBusy = true;
    renderEngine();
    let r;
    try { r = await api.updateEngine(); } catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
    state.engineBusy = false;
    $('#engMsg').hidden = true;
    add.infoCache.clear();
    await refreshEngine();
    if (r && r.ok) {
      const g = state.engine && state.engine.gallerydl;
      const yv = r.version || (state.engine && state.engine.ytdlp && state.engine.ytdlp.version) || '';
      const gv = r.gallerydlVersion || (r.gallerydl && r.gallerydl.version) || (g && g.installed ? g.version : '') || '';
      const parts = [];
      if (yv) parts.push('yt-dlp ' + yv);
      if (gv) parts.push('gallery-dl ' + gv);
      toast(parts.length ? 'Engines are up to date: ' + parts.join(', ') : 'Engines are up to date' + (r.note ? '. ' + r.note : ''),
        { type: 'success', timeout: 6000 });
      if (r.note && parts.length) toast(r.note, { type: 'info', timeout: 9000 });
    } else toastError('Engine update failed: ' + ((r && r.error) || 'unknown error'));
  }

  /* ------------------------------------------------------------------ Clipboard chip */
  async function checkClipboard() {
    if (!api || state.modal) return;
    let url = null;
    try { url = await api.readClipboardUrl(); } catch (e) { url = null; }
    if (!url || state.clipDismissed.has(url)) { if (!url) hideClip(); return; }
    for (const it of state.items.values()) { if (it.url === url) { return; } }
    state.clipUrl = url;
    $('#clipUrl').textContent = url;
    $('#clipUrl').title = url;
    $('#clipBar').hidden = false;
  }
  function hideClip() { $('#clipBar').hidden = true; state.clipUrl = null; }

  /* ------------------------------------------------------------------ drag and drop / paste */
  let dragDepth = 0;
  function hasText(dt) {
    if (!dt || !dt.types) return false;
    const t = Array.from(dt.types);
    return t.indexOf('text/uri-list') !== -1 || t.indexOf('text/plain') !== -1 || t.indexOf('text/x-moz-url') !== -1;
  }
  function wireDnD() {
    window.addEventListener('dragenter', (e) => {
      if (state.modal || !hasText(e.dataTransfer)) return;
      e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (state.modal) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = hasText(e.dataTransfer) ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#dropOverlay').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      dragDepth = 0;
      $('#dropOverlay').hidden = true;
      if (state.modal) return;
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt) return;
      const text = (dt.getData('text/uri-list') || '') + '\n' + (dt.getData('text/plain') || '');
      const { urls } = parseUrls(text.split('\n').filter((l) => l && l[0] !== '#').join('\n'));
      if (!urls.length) { toastError('No link found in what you dropped.'); return; }
      openAdd(urls);
    });
    window.addEventListener('paste', (e) => {
      if (state.modal) return;
      const t = e.target;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      const text = e.clipboardData && e.clipboardData.getData('text');
      const { urls } = parseUrls(text || '');
      if (urls.length) { e.preventDefault(); openAdd(urls); }
    });
  }

  /* ------------------------------------------------------------------ wiring */
  function setFilter(f) {
    state.filter = f;
    $$('.filter').forEach((b) => {
      const on = b.dataset.filter === f;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    schedule();
  }

  function isTyping(t) { return t && /^(input|textarea|select)$/i.test(t.tagName); }

  function wire() {
    hydrateIcons(document);

    $('#tbAdd').addEventListener('click', () => openAdd());
    $('#emptyAdd').addEventListener('click', () => openAdd());
    $('#tbPause').addEventListener('click', () => doPause(selItems()));
    $('#tbResume').addEventListener('click', () => { const s = selItems(); doResume(s); doRetry(s); });
    $('#tbCancel').addEventListener('click', () => doCancel(selItems()));
    $('#tbRemove').addEventListener('click', () => doRemove(selItems(), false));
    $('#tbFolder').addEventListener('click', () => { const s = selItems(); const t = s[0] || lastCompleted(); if (t) doShow(t); });
    $('#tbSettings').addEventListener('click', openSettings);

    $$('.filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
    $('#btnInstall').addEventListener('click', installEngine);
    $('#bannerClose').addEventListener('click', () => { state.gdDismissed = true; renderEngine(); const g = $('#grid'); if (g) g.focus({ preventScroll: true }); });
    $('#btnUpdate').addEventListener('click', updateEngine);

    $('#clipAdd').addEventListener('click', () => { const u = state.clipUrl; if (u) state.clipDismissed.add(u); hideClip(); if (u) openAdd([u]); });
    $('#clipClose').addEventListener('click', () => { if (state.clipUrl) state.clipDismissed.add(state.clipUrl); hideClip(); });

    // modals
    $$('.backdrop').forEach((b) => {
      b.addEventListener('mousedown', (e) => { if (e.target === b && b.id !== 'confirmModal') closeModal(); });
      $$('[data-close]', b).forEach((c) => c.addEventListener('click', () => closeModal()));
    });
    $('#addUrls').addEventListener('input', () => onAddInput());
    $('#addUrls').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAdd(); } });
    $('#addGo').addEventListener('click', submitAdd);
    $('#addPaste').addEventListener('click', async () => {
      let u = null;
      try { u = await api.readClipboardUrl(); } catch (e) { /* ignore */ }
      if (!u) { $('#addHint').textContent = 'No supported link found in the clipboard.'; return; }
      const ta = $('#addUrls');
      const cur = parseUrls(ta.value).urls;
      if (cur.indexOf(u) === -1) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + u;
      onAddInput();
      ta.focus();
    });
    $('#setSave').addEventListener('click', saveSettings);
    $('#setBrowse').addEventListener('click', browseFolder);
    $('#settingsModal').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveSettings(); } });

    // table
    const rows = $('#rows');
    rows.addEventListener('click', onRowClick);
    rows.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const it = state.items.get(tr.dataset.id);
      if (it && can.open(it)) doOpen(it);
    });
    $('#tableWrap').addEventListener('contextmenu', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) { closeContext(); return; }
      e.preventDefault();
      if (!state.selected.has(tr.dataset.id)) { state.anchor = tr.dataset.id; setSelection([tr.dataset.id], tr.dataset.id); }
      openContext(e.clientX, e.clientY);
    });
    $('#tableWrap').addEventListener('mousedown', (e) => {
      if (!e.target.closest('tr[data-id]') && e.button === 0) { setSelection([]); $('#grid').focus({ preventScroll: true }); }
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxMenu')) closeContext(); }, true);
    window.addEventListener('blur', closeContext);
    window.addEventListener('resize', closeContext);
    $('#tableWrap').addEventListener('scroll', closeContext);

    $('#grid').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1, e.shiftKey); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1, e.shiftKey); }
      else if (e.key === 'Home') { e.preventDefault(); const ids = visibleIds(); if (ids.length) { state.anchor = ids[0]; setSelection([ids[0]], ids[0]); } }
      else if (e.key === 'End') { e.preventDefault(); const ids = visibleIds(); if (ids.length) { const l = ids[ids.length - 1]; state.anchor = l; setSelection([l], l); } }
      else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSelection(visibleIds(), state.cursor); }
      else if (e.key === 'Enter') { const s = selItems(); if (s.length === 1 && can.open(s[0])) { e.preventDefault(); doOpen(s[0]); } }
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        const ref = state.rows.get(state.cursor);
        if (ref) { e.preventDefault(); const r = ref.tr.getBoundingClientRect(); openContext(r.left + 60, r.bottom - 8); }
      }
    });

    // global keys
    document.addEventListener('keydown', (e) => {
      if (ctxKey(e)) return;
      trapTab(e);
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (state.modal) { e.preventDefault(); closeModal(); }
        return;
      }
      if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (!state.modal) openAdd(); return; }
      if (mod && e.key === ',') { e.preventDefault(); if (!state.modal) openSettings(); return; }
      if (state.modal || isTyping(e.target)) return;
      if (e.key === 'Delete') {
        const s = selItems();
        if (s.length) { e.preventDefault(); doRemove(s, e.shiftKey); }
      } else if (e.key === ' ' || e.code === 'Space') {
        const t = e.target;
        if (t === document.body || t === $('#grid') || (t && t.closest && t.closest('#grid'))) {
          e.preventDefault();
          toggleSelected();
        }
      }
    });

    let focusTimer;
    window.addEventListener('focus', () => { clearTimeout(focusTimer); focusTimer = setTimeout(checkClipboard, 250); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(focusTimer); focusTimer = setTimeout(checkClipboard, 250); } });

    wireDnD();
  }

  /* ------------------------------------------------------------------ boot */
  async function init() {
    wire();
    if (!window.api) {
      toastError('The LinkGrab bridge (window.api) is unavailable. Please restart the app.', { timeout: 60000 });
      return;
    }
    api = window.api;
    state.booting = true;

    api.onUpdate((item) => upsert(item));
    api.onRemoved((id) => dropItem(id));
    api.onEngineProgress(onEngineProgress);

    try { state.settings = (await api.getSettings()) || {}; } catch (e) { /* ignore */ }
    try {
      const list = await api.list();
      (list || []).forEach((i) => state.items.set(i.id, i));
    } catch (e) { toastError('Could not load downloads: ' + (e && e.message ? e.message : e)); }
    state.booting = false;
    schedule();
    await refreshEngine();
    checkClipboard();
    // test hook (harmless in production)
    window.__linkgrab = { state, openAdd, openSettings, upsert };
  }

  function boot() {
    const wantMock = /[?&]mock=1(?:&|$)/.test(location.search);
    if (wantMock && !window.api) {
      const s = document.createElement('script');
      s.src = 'dev-mock-api.js';
      s.onload = init;
      s.onerror = () => { toastError('Failed to load dev-mock-api.js'); init(); };
      document.head.appendChild(s);
    } else init();
  }
  boot();
})();
