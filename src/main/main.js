'use strict';
// Electron entry point. Everything testable lives in api.js / queue.js / engine.js / ytdlp.js.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Notification, session } = require('electron');
const { createServices, createApi, API_METHODS } = require('./api');

const SMOKE = process.argv.includes('--smoke-test');
const CH = { update: 'evt:update', removed: 'evt:removed', engine: 'evt:engine' };

/** @type {BrowserWindow|null} */
let mainWindow = null;
let services = null;
let quitting = false;

function sendToRenderer(channel, payload) {
  const w = mainWindow;
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  try {
    w.webContents.send(channel, payload);
  } catch (_) {
    // window is closing
  }
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function openExternalSafe(u) {
  if (isHttpUrl(u)) shell.openExternal(u).catch(() => {});
}

function buildServices(userDataDir, downloadsDir) {
  return createServices({
    userDataDir,
    defaultDownloadDir: path.join(downloadsDir, 'LinkGrab'),
    onEngineProgress: (p) => sendToRenderer(CH.engine, p),
  });
}

function registerIpc(api) {
  for (const name of API_METHODS) {
    ipcMain.handle('api:' + name, async (_event, ...args) => {
      try {
        return await api[name](...args);
      } catch (e) {
        // Handlers already catch their own errors; this is the last line of defence.
        if (name === 'list') return [];
        if (name === 'getSettings' || name === 'setSettings') return services.settings.get();
        if (name === 'chooseFolder' || name === 'readClipboardUrl') return null;
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161a',
    title: 'LinkGrab',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only uses contextBridge/ipcRenderer
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // Links that try to open a new window go to the default browser (http/https only).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // The app UI never navigates; any attempt (dropped link, clicked anchor) is handled safely.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalSafe(url);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function wireQueueEvents() {
  const { queue } = services;
  queue.on('update', (item) => sendToRenderer(CH.update, item));
  queue.on('removed', (id) => sendToRenderer(CH.removed, id));
  queue.on('completed', (item) => {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Download complete', body: item.title || 'Your download is ready.', silent: false });
        n.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
        });
        n.show();
      }
    } catch (_) {
      // notifications are optional
    }
  });
}

async function runSmokeTest() {
  // Uses a throwaway directory so the check never touches the real profile; no window is created.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkgrab-smoke-'));
  try {
    services = createServices({ userDataDir: tmp, defaultDownloadDir: path.join(tmp, 'dl') });
    const api = createApi(services, {
      openPath: async () => '',
      showItemInFolder: () => {},
      readClipboardText: () => '',
      chooseFolder: async () => null,
    });
    for (const name of API_METHODS) {
      if (typeof api[name] !== 'function') throw new Error('missing api method ' + name);
    }
    const s = await api.getSettings();
    if (!s || !s.downloadDir) throw new Error('settings failed');
    const list = await api.list();
    if (!Array.isArray(list)) throw new Error('queue failed');
    const st = await api.engineStatus();
    if (!st || !st.ytdlp || !st.ffmpeg) throw new Error('engine status failed');
    if (!st.gallerydl || typeof st.gallerydl.installed !== 'boolean') throw new Error('image engine status failed');
    const router = services.router;
    if (!router || typeof router.download !== 'function' || typeof router.getInfo !== 'function') throw new Error('router failed');
    if (services.gallery && (typeof services.gallery.download !== 'function' || typeof services.gallery.getInfo !== 'function')) {
      throw new Error('gallery runner failed');
    }
    await services.queue.shutdown();
    process.stdout.write('LINKGRAB_SMOKE_OK\n');
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(0);
  } catch (e) {
    process.stderr.write('LINKGRAB_SMOKE_FAIL ' + (e && e.stack ? e.stack : e) + '\n');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    app.exit(1);
  }
}

if (SMOKE) {
  // Headless: no single-instance lock (so it can run beside a live app), no window, no GPU.
  app.disableHardwareAcceleration();
  runSmokeTest();
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      Menu.setApplicationMenu(null);
      // This app needs no web permissions (camera, geolocation, notifications from pages...).
      session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

      services = buildServices(app.getPath('userData'), app.getPath('downloads'));
      const api = createApi(services, {
        openPath: (p) => shell.openPath(p),
        showItemInFolder: (p) => shell.showItemInFolder(p),
        readClipboardText: () => clipboard.readText(),
        chooseFolder: async (current) => {
          const opts = { properties: ['openDirectory', 'createDirectory'], defaultPath: current };
          const res = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showOpenDialog(mainWindow, opts)
            : await dialog.showOpenDialog(opts);
          return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
        },
      });
      registerIpc(api);
      wireQueueEvents();
      createWindow();
      services.queue.pump(); // continue items that were still queued when the app last closed

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('window-all-closed', () => {
      app.quit();
    });

    app.on('before-quit', (event) => {
      if (quitting || !services) return;
      // Stop running yt-dlp processes first (they become "paused" and keep their partial files).
      quitting = true;
      event.preventDefault();
      Promise.race([services.queue.shutdown(), new Promise((r) => setTimeout(r, 6000))])
        .catch(() => {})
        .finally(() => app.quit());
    });
  }
}
