const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  load: () => ipcRenderer.invoke("accounts:load"),
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
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
  githubSyncStatus: () => ipcRenderer.invoke("github-sync:status"),
  githubLogin: () => ipcRenderer.invoke("github-sync:login"),
  githubCancelLogin: () => ipcRenderer.invoke("github-sync:cancel-login"),
  githubCopyDeviceCode: () => ipcRenderer.invoke("github-sync:copy-device-code"),
  githubConnect: (input) => ipcRenderer.invoke("github-sync:connect", input),
  githubSync: (input) => ipcRenderer.invoke("github-sync:sync", input),
  githubAutoSync: () => ipcRenderer.invoke("github-sync:auto"),
  githubDisconnect: () => ipcRenderer.invoke("github-sync:disconnect"),
  loadSmsSettings: () => ipcRenderer.invoke("settings:load-sms"),
  saveSmsSettings: (settings) => ipcRenderer.invoke("settings:save-sms", settings),
  testSmsSettings: (input) => ipcRenderer.invoke("settings:test-sms", input),
  listSmsCountries: (input) => ipcRenderer.invoke("settings:list-sms-countries", input),
  onLog: (listener) => {
    const callback = (_event, entry) => listener(entry);
    ipcRenderer.on("manager:log", callback);
    return () => ipcRenderer.removeListener("manager:log", callback);
  },
  onGithubSyncStatus: (listener) => {
    const callback = (_event, status) => listener(status);
    ipcRenderer.on("github-sync:status", callback);
    return () => ipcRenderer.removeListener("github-sync:status", callback);
  },
  onGithubDeviceCode: (listener) => {
    const callback = (_event, value) => listener(value);
    ipcRenderer.on("github-sync:device-code", callback);
    return () => ipcRenderer.removeListener("github-sync:device-code", callback);
  },
});
