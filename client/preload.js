/* The only bridge between the renderer and Node. Deliberately tiny: the
 * renderer can ask for /api/* JSON, manage accounts, set the theme, and ask
 * the OS to show a reminder. It gets no filesystem, no shell, no arbitrary
 * URLs — and no way to reach one account's session while another is active. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  api: {
    request: (path, opts) => ipcRenderer.invoke('api:request', {
      path,
      method: opts?.method || 'GET',
      body: opts?.body,
    }),
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
  notify: {
    show: (o) => ipcRenderer.invoke('notify:show', o),
    onClicked: (fn) => ipcRenderer.on('notify:clicked', (_e, key) => fn(key)),
  },
  autoStart: {
    get: () => ipcRenderer.invoke('app:getAutoStart'),
    set: (on) => ipcRenderer.invoke('app:setAutoStart', on),
  },
  theme: {
    set: (mode) => ipcRenderer.invoke('app:setTheme', mode),
    shouldUseDark: () => ipcRenderer.invoke('app:shouldUseDark'),
    onChanged: (fn) => ipcRenderer.on('theme:changed', (_e, v) => fn(v)),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
