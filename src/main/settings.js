'use strict';
// Settings store. Pure Node: paths are injected, electron is never required here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sanitizeCookiesFrom, sanitizeRateLimit } = require('./ytdlp');

function defaults(defaultDownloadDir) {
  return {
    downloadDir: defaultDownloadDir || path.join(os.homedir(), 'Downloads', 'LinkGrab'),
    maxConcurrent: 3,
    speedLimit: '',
    cookiesFrom: '',
  };
}

class Settings extends EventEmitter {
  /**
   * @param {{filePath?:string, defaultDownloadDir?:string}} [opts]  filePath omitted = in-memory only
   */
  constructor(opts) {
    super();
    const o = opts || {};
    this.filePath = o.filePath || null;
    this.defaults = defaults(o.defaultDownloadDir);
    this.values = Object.assign({}, this.defaults);
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.values = this._merge(this.defaults, raw);
    } catch (_) {
      this.values = Object.assign({}, this.defaults);
    }
  }

  /** Validate a partial object against base; unknown or invalid keys are ignored. */
  _merge(base, partial) {
    const out = Object.assign({}, base);
    if (!partial || typeof partial !== 'object') return out;
    if (typeof partial.downloadDir === 'string') {
      const d = partial.downloadDir.trim();
      if (d && path.isAbsolute(d) && !d.includes('\0')) out.downloadDir = d;
    }
    if (partial.maxConcurrent !== undefined) {
      const n = Math.round(Number(partial.maxConcurrent));
      if (Number.isFinite(n)) out.maxConcurrent = Math.min(10, Math.max(1, n));
    }
    if (partial.speedLimit !== undefined) {
      const raw = partial.speedLimit === null ? '' : String(partial.speedLimit).trim();
      if (raw === '') out.speedLimit = '';
      else {
        const s = sanitizeRateLimit(raw);
        if (s) out.speedLimit = s;
      }
    }
    if (partial.cookiesFrom !== undefined) {
      const raw = partial.cookiesFrom === null ? '' : String(partial.cookiesFrom).trim();
      if (raw === '') out.cookiesFrom = '';
      else {
        const c = sanitizeCookiesFrom(raw);
        if (c) out.cookiesFrom = c;
      }
    }
    return out;
  }

  get() {
    return Object.assign({}, this.values);
  }

  set(partial) {
    this.values = this._merge(this.values, partial);
    this._save();
    this.emit('change', this.get());
    return this.get();
  }

  _save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (_) {
      // Settings still apply for this session even if the disk write failed.
    }
  }
}

module.exports = { Settings, defaults };
