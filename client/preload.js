/* The only bridge between the renderer and Node. Deliberately tiny: the
 * renderer can ask for /api/* JSON, manage accounts, and set the theme.
 * It gets no filesystem, no shell, no arbitrary URLs — and no way to reach
 * one account's session while another is active. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  api: {
    get: (path) => ipcRenderer.invoke('api:get', path),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: () => ipcRenderer.invoke('accounts:add'),
    switch: (id) => ipcRenderer.invoke('accounts:switch', id),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    onChanged: (fn) => ipcRenderer.on('accounts:changed', (_e, v) => fn(v)),
  },
  auth: {
    check: () => ipcRenderer.invoke('auth:check'),
  },
  theme: {
    set: (mode) => ipcRenderer.invoke('app:setTheme', mode),
    shouldUseDark: () => ipcRenderer.invoke('app:shouldUseDark'),
    onChanged: (fn) => ipcRenderer.on('theme:changed', (_e, v) => fn(v)),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
