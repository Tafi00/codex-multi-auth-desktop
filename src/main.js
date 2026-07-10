import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const APP_DIR = join(CODEX_HOME, "multi-auth-desktop");
const ACCOUNTS_PATH = join(APP_DIR, "accounts.json");
const QUOTA_PATH = join(APP_DIR, "quota-cache.json");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const LEGACY_ACCOUNTS_PATH = join(CODEX_HOME, "multi-auth", "openai-codex-accounts.json");
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_REDIRECT = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE = "openid profile email offline_access";

let mainWindow;
let pendingLogin = null;
let quotaRefreshTask = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#0d1117",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(app.getAppPath(), "src", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(join(app.getAppPath(), "src", "index.html"));
}

function emptyStorage() {
  return { version: 1, accounts: [], activeIndex: 0 };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeSecretJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, path);
    if (process.platform !== "win32") await fs.chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

function normalizeAccount(account) {
  if (!account || typeof account.refreshToken !== "string" || !account.refreshToken.trim()) return null;
  return {
    id: typeof account.id === "string" ? account.id : randomBytes(12).toString("hex"),
    email: typeof account.email === "string" ? account.email.trim().toLowerCase() : null,
    accountId: typeof account.accountId === "string" ? account.accountId : null,
    refreshToken: account.refreshToken,
    accessToken: typeof account.accessToken === "string" ? account.accessToken : null,
    idToken: typeof account.idToken === "string" ? account.idToken : null,
    expiresAt: Number.isFinite(account.expiresAt) ? account.expiresAt : null,
    addedAt: Number.isFinite(account.addedAt) ? account.addedAt : Date.now(),
  };
}

async function loadStorage() {
  const storage = await readJson(ACCOUNTS_PATH, null);
  if (storage?.version === 1 && Array.isArray(storage.accounts)) return storage;

  // One-time compatibility migration only. All subsequent reads/writes use the
  // desktop app's own state and do not execute or import codex-multi-auth.
  const legacy = await readJson(LEGACY_ACCOUNTS_PATH, null);
  const migrated = {
    version: 1,
    accounts: (legacy?.accounts ?? []).map(normalizeAccount).filter(Boolean),
    activeIndex: Number.isInteger(legacy?.activeIndex) ? legacy.activeIndex : 0,
  };
  if (migrated.activeIndex >= migrated.accounts.length) migrated.activeIndex = 0;
  await writeSecretJson(ACCOUNTS_PATH, migrated);
  return migrated;
}

function base64Url(value) {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function extractIdentity(accessToken, idToken) {
  const claims = { ...decodeJwt(accessToken), ...decodeJwt(idToken) };
  const findId = (value) => {
    if (!value || typeof value !== "object") return null;
    for (const [key, candidate] of Object.entries(value)) {
      if (typeof candidate === "string" && /(?:account|organization|org).*id/i.test(key)) return candidate;
      if (candidate && typeof candidate === "object") {
        const nested = findId(candidate);
        if (nested) return nested;
      }
    }
    return null;
  };
  return {
    email: typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null,
    accountId: findId(claims),
  };
}

async function refreshAccount(account) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: account.refreshToken,
  });
  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new Error("Session has expired. Please login again.");
  }
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token;
  account.idToken = typeof data.id_token === "string" ? data.id_token : account.idToken;
  account.expiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
  const identity = extractIdentity(account.accessToken, account.idToken);
  account.email ??= identity.email;
  account.accountId ??= identity.accountId;
  return account.accessToken;
}

async function usableAccessToken(account) {
  if (account.accessToken && Number.isFinite(account.expiresAt) && account.expiresAt > Date.now() + 60_000) {
    return account.accessToken;
  }
  return refreshAccount(account);
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUsageWindow(window) {
  return {
    usedPercent: Math.max(0, Math.min(100, finiteNumber(window?.used_percent ?? window?.percent_used))),
    windowMinutes: finiteNumber(window?.window_minutes ?? window?.windowMinutes),
    resetAtMs: timestampMs(window?.reset_at ?? window?.resets_at ?? window?.resetAt),
  };
}

function extractUsageQuota(data, now) {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? data?.rate_limits_by_limit_id?.codex ?? data;
  const primary = rateLimit?.primary_window ?? rateLimit?.primary;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondary;
  if (!primary || !secondary) throw new Error("Usage response did not include 5 hour and Weekly windows.");
  return {
    updatedAt: now,
    primary: normalizeUsageWindow(primary),
    secondary: normalizeUsageWindow(secondary),
  };
}

async function fetchUsage(account) {
  const accessToken = await usableAccessToken(account);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(account.accountId ? { "ChatGPT-Account-ID": account.accountId } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Usage request returned ${response.status}.`);
    return extractUsageQuota(await response.json(), Date.now());
  } finally {
    clearTimeout(timeout);
  }
}

async function loadQuotaCache() {
  return readJson(QUOTA_PATH, { version: 1, byAccountId: {}, byEmail: {} });
}

function quotaForAccount(account, cache) {
  return (account.accountId && cache.byAccountId?.[account.accountId]) ||
    (account.email && cache.byEmail?.[account.email]) || null;
}

async function runUsageQuotaRefresh() {
  const storage = await loadStorage();
  const cache = await loadQuotaCache();
  cache.byAccountId ??= {};
  cache.byEmail ??= {};
  const errors = [];
  for (const [index, account] of storage.accounts.entries()) {
    try {
      const quota = await fetchUsage(account);
      if (account.accountId) cache.byAccountId[account.accountId] = quota;
      if (account.email) cache.byEmail[account.email] = quota;
    } catch (error) {
      errors.push(`Account ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      // Never render an old value as though it were a fresh quota snapshot.
      // A failed check is clearer as “not checked” than a misleading cache row.
      if (account.accountId) delete cache.byAccountId[account.accountId];
      if (account.email) delete cache.byEmail[account.email];
    }
  }
  await writeSecretJson(ACCOUNTS_PATH, storage);
  await writeSecretJson(QUOTA_PATH, cache);
  return errors;
}

async function refreshUsageQuota() {
  if (quotaRefreshTask) return quotaRefreshTask;
  quotaRefreshTask = runUsageQuotaRefresh().finally(() => { quotaRefreshTask = null; });
  return quotaRefreshTask;
}

async function getDashboard() {
  const storage = await loadStorage();
  const cache = await loadQuotaCache();
  const accounts = storage.accounts.map((account, index) => {
    const quota = quotaForAccount(account, cache);
    const primaryRemaining = quota ? 100 - quota.primary.usedPercent : null;
    return {
      index,
      email: account.email,
      label: account.email || `Account ${index + 1}`,
      current: index === storage.activeIndex,
      enabled: true,
      markers: primaryRemaining === 0 ? ["quota-exhausted"] : [],
      quota: quota ? {
        primaryUsedPercent: quota.primary.usedPercent,
        primaryResetAtMs: quota.primary.resetAtMs,
        secondaryUsedPercent: quota.secondary.usedPercent,
        secondaryResetAtMs: quota.secondary.resetAtMs,
        updatedAt: quota.updatedAt,
      } : null,
    };
  });
  return { accounts, updatedAt: Date.now() };
}

async function syncAccountToCodex(account) {
  const accessToken = await usableAccessToken(account);
  // The Codex file credential format requires an id_token field. OAuth refresh
  // responses do not always include one; the official CLI-compatible fallback
  // is the access token, which still carries the necessary identity claims.
  const idToken = account.idToken || accessToken;
  account.idToken = idToken;
  const current = await readJson(AUTH_PATH, {});
  await writeSecretJson(AUTH_PATH, {
    ...current,
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: account.refreshToken,
      account_id: account.accountId,
    },
    last_refresh: new Date().toISOString(),
    email: account.email,
    desktopAuthSyncVersion: Date.now(),
  });
}

function startOAuthCallbackServer(state) {
  let code = null;
  let closed = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost:1455");
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid OAuth callback.");
      return;
    }
    code = url.searchParams.get("code");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h2>Login complete</h2><p>You may close this browser tab.</p>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(1455, "127.0.0.1", () => resolve({
      close: () => { closed = true; server.close(); },
      wait: () => new Promise((finish) => {
        const started = Date.now();
        const interval = setInterval(() => {
          if (code || closed || Date.now() - started > 5 * 60_000) {
            clearInterval(interval);
            finish(code);
          }
        }, 150);
      }),
    }));
  });
}

async function startBrowserLogin() {
  if (pendingLogin) throw new Error("A login is already in progress.");
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(32));
  const callback = await startOAuthCallbackServer(state).catch(() => {
    throw new Error("Port 1455 is unavailable. Close another login flow and try again.");
  });
  pendingLogin = callback;
  try {
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT,
      scope: OAUTH_SCOPE, code_challenge: challenge, code_challenge_method: "S256", state,
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs", prompt: "login",
    }).toString();
    await shell.openExternal(url.toString());
    const code = await callback.wait();
    if (!code) throw new Error("Login was cancelled or timed out.");
    const response = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: OAUTH_CLIENT_ID, code, code_verifier: verifier, redirect_uri: OAUTH_REDIRECT }),
    });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("OpenAI did not return a valid session.");
    const identity = extractIdentity(tokens.access_token, tokens.id_token);
    const storage = await loadStorage();
    const existingIndex = storage.accounts.findIndex((account) =>
      (identity.accountId && account.accountId === identity.accountId) || (identity.email && account.email === identity.email),
    );
    const account = {
      id: existingIndex >= 0 ? storage.accounts[existingIndex].id : randomBytes(12).toString("hex"),
      email: identity.email,
      accountId: identity.accountId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: typeof tokens.id_token === "string" ? tokens.id_token : null,
      expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
      addedAt: existingIndex >= 0 ? storage.accounts[existingIndex].addedAt : Date.now(),
    };
    if (existingIndex >= 0) storage.accounts[existingIndex] = account;
    else { storage.accounts.push(account); storage.activeIndex = storage.accounts.length - 1; }
    await syncAccountToCodex(account);
    await writeSecretJson(ACCOUNTS_PATH, storage);
    return { dashboard: await getDashboard() };
  } finally {
    callback.close();
    pendingLogin = null;
  }
}

async function restartCodex() {
  if (process.platform === "darwin") {
    await execFileAsync("osascript", ["-e", 'tell application "Codex" to quit']).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await execFileAsync("open", ["-a", "Codex"]);
  }
}

function assertImportShape(value) {
  const accounts = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 100) throw new Error("Invalid session export.");
  const normalized = accounts.map(normalizeAccount).filter(Boolean);
  if (normalized.length !== accounts.length) throw new Error("Every imported account needs a refresh token.");
  return normalized;
}

ipcMain.handle("accounts:load", async () => {
  const probeErrors = await refreshUsageQuota();
  return { ...(await getDashboard()), probeErrors };
});
ipcMain.handle("accounts:login", () => startBrowserLogin());
ipcMain.handle("accounts:cancel-login", () => { pendingLogin?.close(); return { cancelled: Boolean(pendingLogin) }; });
ipcMain.handle("accounts:refresh-quota", async () => {
  const probeErrors = await refreshUsageQuota();
  return { dashboard: await getDashboard(), probeErrors };
});
ipcMain.handle("accounts:switch", async (_event, index) => {
  const storage = await loadStorage();
  const account = storage.accounts[index];
  if (!account) throw new Error("Account was not found.");
  storage.activeIndex = index;
  await syncAccountToCodex(account);
  await writeSecretJson(ACCOUNTS_PATH, storage);
  await restartCodex();
  return getDashboard();
});
ipcMain.handle("accounts:delete", async (_event, index) => {
  const storage = await loadStorage();
  if (!storage.accounts[index]) throw new Error("Account was not found.");
  if (index === storage.activeIndex) throw new Error("Switch to another account before removing the active account.");
  storage.accounts.splice(index, 1);
  if (storage.activeIndex > index) storage.activeIndex -= 1;
  await writeSecretJson(ACCOUNTS_PATH, storage);
  return getDashboard();
});
ipcMain.handle("accounts:export", async () => {
  const storage = await loadStorage();
  if (!storage.accounts.length) throw new Error("There are no accounts to export.");
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, { title: "Export Codex sessions", defaultPath: `codex-sessions-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (canceled || !filePath) return { cancelled: true };
  await writeSecretJson(filePath, { version: 1, accounts: storage.accounts, activeIndex: storage.activeIndex });
  return { cancelled: false, count: storage.accounts.length };
});
ipcMain.handle("accounts:import", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, { title: "Import Codex sessions", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (canceled || !filePaths[0]) return { cancelled: true };
  const incoming = assertImportShape(JSON.parse(await fs.readFile(filePaths[0], "utf8")));
  const storage = await loadStorage();
  const existing = new Set(storage.accounts.map((account) => account.accountId || account.email || account.refreshToken));
  const additions = incoming.filter((account) => !existing.has(account.accountId || account.email || account.refreshToken));
  storage.accounts.push(...additions);
  await writeSecretJson(ACCOUNTS_PATH, storage);
  return { cancelled: false, added: additions.length, skipped: incoming.length - additions.length, dashboard: await getDashboard() };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
