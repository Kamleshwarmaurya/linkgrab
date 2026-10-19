'use strict';
// Minimal streaming zip reader (stored + deflate, zip64 sizes) with no dependencies.
// Used to pull ffmpeg.exe / ffprobe.exe out of the FFmpeg-Builds archive without loading it into memory.
// Pure Node: no electron.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

// Limits against hostile or corrupt archives (the real ffmpeg.exe is ~200 MB, its central directory a few KB).
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;

/** Passes data through and fails as soon as more than `max` bytes went by (inflate bombs declare small sizes). */
function byteLimit(max) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > max) return cb(new Error('Zip entry is larger than its declared size'));
      cb(null, chunk);
    },
  });
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_EOCD64_LOC = 0x07064b50;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  if (off !== length) throw new Error('Unexpected end of zip file');
  return buf;
}

/** List central-directory entries: [{name, method, compSize, size, localOffset}] */
async function listEntries(zipPath) {
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    if (fileSize < 22) throw new Error('Not a zip file');
    const tailLen = Math.min(fileSize, 65557);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64: the locator sits right before the EOCD record
      const locPos = eocd - 20;
      if (locPos < 0 || tail.readUInt32LE(locPos) !== SIG_EOCD64_LOC) throw new Error('Unsupported zip64 layout');
      const eocd64Off = Number(tail.readBigUInt64LE(locPos + 8));
      const rec = await readAt(fh, eocd64Off, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('Bad zip64 end record');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }

    if (cdSize > MAX_CENTRAL_DIR_BYTES || cdOffset + cdSize > fileSize) throw new Error('Corrupt zip central directory');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new Error('Corrupt zip central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }
      entries.push({ name, method, compSize, size, localOffset, encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Extract one entry to destPath (written to destPath + '.tmp' first, then renamed). */
async function extractEntry(zipPath, entry, destPath) {
  if (entry.encrypted) throw new Error('Encrypted zip entries are not supported');
  if (entry.method !== 0 && entry.method !== 8) throw new Error('Unsupported zip compression method ' + entry.method);
  if (!(entry.size >= 0) || entry.size > MAX_ENTRY_BYTES) throw new Error(`Zip entry ${entry.name} is too large`);
  const fh = await fs.promises.open(zipPath, 'r');
  let dataStart;
  try {
    const lh = await readAt(fh, entry.localOffset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOC) throw new Error('Corrupt zip local header');
    dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = destPath + '.tmp';
  const input = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1 });
  const out = fs.createWriteStream(tmp);
  try {
    if (entry.method === 8) await pipeline(input, zlib.createInflateRaw(), byteLimit(entry.size), out);
    else await pipeline(input, byteLimit(entry.size), out);
    const st = await fs.promises.stat(tmp);
    if (st.size !== entry.size) throw new Error(`Extracted size mismatch for ${entry.name}`);
    await fs.promises.rename(tmp, destPath);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Extract files by base name (case-insensitive) from anywhere in the archive.
 * @param {string} zipPath
 * @param {Record<string,string>} wanted  e.g. { 'ffmpeg.exe': '/dest/ffmpeg.exe' }
 * @returns {Promise<string[]>} base names that were extracted
 */
async function extractByBasename(zipPath, wanted) {
  const entries = await listEntries(zipPath);
  const lookup = {};
  for (const k of Object.keys(wanted)) lookup[k.toLowerCase()] = wanted[k];
  const done = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const base = e.name.split('/').pop().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lookup, base) && !done.includes(base)) {
      await extractEntry(zipPath, e, lookup[base]);
      done.push(base);
    }
  }
  return done;
}

module.exports = { listEntries, extractEntry, extractByBasename, MAX_ENTRY_BYTES };
