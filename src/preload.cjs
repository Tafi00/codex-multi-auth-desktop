const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  load: () => ipcRenderer.invoke("accounts:load"),
  login: (credentials) => ipcRenderer.invoke("accounts:login", credentials),
  cancelLogin: () => ipcRenderer.invoke("accounts:cancel-login"),
  refreshQuota: () => ipcRenderer.invoke("accounts:refresh-quota"),
  switchAccount: (index) => ipcRenderer.invoke("accounts:switch", index),
  deleteAccount: (index) => ipcRenderer.invoke("accounts:delete", index),
  exportSessions: () => ipcRenderer.invoke("accounts:export"),
  importSessions: () => ipcRenderer.invoke("accounts:import"),
  onLog: (listener) => {
    const callback = (_event, entry) => listener(entry);
    ipcRenderer.on("manager:log", callback);
    return () => ipcRenderer.removeListener("manager:log", callback);
  },
});
