const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  getSummary: () => ipcRenderer.invoke('app:summary'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  openProjectFolder: () => ipcRenderer.invoke('config:open-folder'),
  
  openTokenDir: () => ipcRenderer.invoke('token:open-dir'),
  getTokenStatus: () => ipcRenderer.invoke('token:status'),
  getSmsOverview: () => ipcRenderer.invoke('sms:overview'),
  testMail: () => ipcRenderer.invoke('mail:test'),
  startRun: (options) => ipcRenderer.invoke('runtime:start', options),
  stopRun: () => ipcRenderer.invoke('runtime:stop'),
  importOutlook: (payload) => ipcRenderer.invoke('outlook:import', payload),
  getOutlookAccounts: () => ipcRenderer.invoke('outlook:accounts'),
  resetOutlookAccount: (email) => ipcRenderer.invoke('outlook:reset', { email }),
  testOutlookAccount: (email) => ipcRenderer.invoke('outlook:test', { email }),
  getOutlookDetail: (email) => ipcRenderer.invoke('outlook:detail', { email }),
  getOutlookMails: (email, limit = 50) => ipcRenderer.invoke('outlook:mails', { email, limit }),
  getAccounts: () => ipcRenderer.invoke('accounts:list'),
  pickOutlookFile: () => ipcRenderer.invoke('outlook:pick-file'),
  onRuntimeLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('runtime:log', listener);
    return () => ipcRenderer.removeListener('runtime:log', listener);
  },
  onRuntimeState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('runtime:state', listener);
    return () => ipcRenderer.removeListener('runtime:state', listener);
  },
});


