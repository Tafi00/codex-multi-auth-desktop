const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  load: () => ipcRenderer.invoke("accounts:load"),
  login: (credentials) => ipcRenderer.invoke("accounts:login", credentials),
  cancelLogin: () => ipcRenderer.invoke("accounts:cancel-login"),
  refreshQuota: () => ipcRenderer.invoke("accounts:refresh-quota"),
  switchAccount: (index) => ipcRenderer.invoke("accounts:switch", index),
  relogin: (index) => ipcRenderer.invoke("accounts:relogin", index),
  copyLogin: (index, field) => ipcRenderer.invoke("accounts:copy-login", index, field),
  deleteAccount: (index) => ipcRenderer.invoke("accounts:delete", index),
  exportSessions: (password) => ipcRenderer.invoke("accounts:export", password),
  importSessions: (password) => ipcRenderer.invoke("accounts:import", password),
  onLog: (listener) => {
    const callback = (_event, entry) => listener(entry);
    ipcRenderer.on("manager:log", callback);
    return () => ipcRenderer.removeListener("manager:log", callback);
  },
});
