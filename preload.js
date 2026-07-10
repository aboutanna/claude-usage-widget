const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUsageUpdate: (callback) => {
    ipcRenderer.on('usage-update', (_event, payload) => callback(payload));
  },
  onUsageError: (callback) => {
    ipcRenderer.on('usage-error', (_event, err) => callback(err));
  },
  onPinState: (callback) => {
    ipcRenderer.on('pin-state', (_event, pinned) => callback(pinned));
  },
  onCollapseState: (callback) => {
    ipcRenderer.on('collapse-state', (_event, state) => callback(state));
  },
  refresh: () => ipcRenderer.send('widget-refresh'),
  hide: () => ipcRenderer.send('widget-hide'),
  openLogin: () => ipcRenderer.send('widget-open-login'),
  togglePin: () => ipcRenderer.send('widget-toggle-pin'),
  hoverEnter: () => ipcRenderer.send('widget-hover', true),
  hoverLeave: () => ipcRenderer.send('widget-hover', false),
});
