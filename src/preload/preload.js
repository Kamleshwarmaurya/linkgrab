'use strict';
// Exposes the LinkGrab bridge as window.api. Channel names follow IPC_CHANNELS.md.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, payload) => {
      try { cb(payload); } catch (err) { console.error('[linkgrab] listener error', err); }
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('api', {
  getInfo: invoke('api:getInfo'),
  add: invoke('api:add'),
  list: invoke('api:list'),
  pause: invoke('api:pause'),
  resume: invoke('api:resume'),
  cancel: invoke('api:cancel'),
  remove: (id, deleteFile) => ipcRenderer.invoke('api:remove', id, !!deleteFile),
  openFile: invoke('api:openFile'),
  showInFolder: invoke('api:showInFolder'),
  getSettings: invoke('api:getSettings'),
  setSettings: invoke('api:setSettings'),
  chooseFolder: invoke('api:chooseFolder'),
  engineStatus: invoke('api:engineStatus'),
  installEngine: invoke('api:installEngine'),
  updateEngine: invoke('api:updateEngine'),
  readClipboardUrl: invoke('api:readClipboardUrl'),
  onUpdate: subscribe('evt:update'),
  onRemoved: subscribe('evt:removed'),
  onEngineProgress: subscribe('evt:engine')
});
