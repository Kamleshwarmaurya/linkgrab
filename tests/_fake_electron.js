'use strict';
// Preloaded with `node -r` to stand in for the 'electron' module when exercising main.js without Electron.
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const userData = process.env.FAKE_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lg-fake-electron-'));
const handlers = new Map();
const sent = [];
const appEvents = {};
let windowOptions = null;
let loaded = null;

const app = {
  disableHardwareAcceleration() {},
  requestSingleInstanceLock: () => true,
  quit() { process.emit('fake-quit'); },
  exit(code) { process.exit(code); },
  on(ev, fn) { (appEvents[ev] = appEvents[ev] || []).push(fn); return app; },
  whenReady: () => Promise.resolve(),
  getPath: (n) => (n === 'userData' ? userData : path.join(userData, n)),
};
class BrowserWindow {
  constructor(opts) {
    windowOptions = opts;
    this.webContents = {
      send: (ch, payload) => sent.push([ch, payload]),
      isDestroyed: () => false,
      setWindowOpenHandler: (fn) => { this._open = fn; },
      on: () => {},
    };
  }
  once() {}
  on() {}
  isDestroyed() { return false; }
  loadFile(f) { loaded = f; }
  static getAllWindows() { return [1]; }
}
const electron = {
  app, BrowserWindow,
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder() {}, openExternal: async () => {} },
  clipboard: { readText: () => 'see https://youtu.be/zzz111 ok' },
  Menu: { setApplicationMenu(m) { electron.__menu = m; } },
  Notification: class { static isSupported() { return false; } },
  session: { defaultSession: { setPermissionRequestHandler() {} } },
  __handlers: handlers, __sent: sent, __appEvents: appEvents,
  __info: () => ({ windowOptions, loaded, menu: electron.__menu }),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  return origLoad.call(this, request, parent, isMain);
};
global.__FAKE_ELECTRON__ = electron;
