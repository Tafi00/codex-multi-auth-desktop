const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  load: () => ipcRenderer.invoke("accounts:load"),
  login: (credentials) => ipcRenderer.invoke("accounts:login", credentials),
  cancelLogin: () => ipcRenderer.invoke("accounts:cancel-login"),
  refreshQuota: () => ipcRenderer.invoke("accounts:refresh-quota"),
  refreshCurrentQuota: () => ipcRenderer.invoke("accounts:refresh-current-quota"),
  switchAccount: (index) => ipcRenderer.invoke("accounts:switch", index),
  relogin: (index) => ipcRenderer.invoke("accounts:relogin", index),
  copyLogin: (index, field) => ipcRenderer.invoke("accounts:copy-login", index, field),
  deleteAccount: (index) => ipcRenderer.invoke("accounts:delete", index),
  exportSessions: () => ipcRenderer.invoke("accounts:export"),
  importSessions: () => ipcRenderer.invoke("accounts:import"),
  loadSmsSettings: () => ipcRenderer.invoke("settings:load-sms"),
  saveSmsSettings: (settings) => ipcRenderer.invoke("settings:save-sms", settings),
  testSmsSettings: (input) => ipcRenderer.invoke("settings:test-sms", input),
  listSmsCountries: (input) => ipcRenderer.invoke("settings:list-sms-countries", input),
  onLog: (listener) => {
    const callback = (_event, entry) => listener(entry);
    ipcRenderer.on("manager:log", callback);
    return () => ipcRenderer.removeListener("manager:log", callback);
  },
});
