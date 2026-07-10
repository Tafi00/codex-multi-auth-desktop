import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { restartCodex } from "./codex-process.js";
import { generateTotpCode } from "./totp.js";

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
    usageAccountId: typeof account.usageAccountId === "string" ? account.usageAccountId : null,
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
    sourceAccountId: typeof data?.account_id === "string" ? data.account_id : null,
    sourceEmail: typeof data?.email === "string" ? data.email.trim().toLowerCase() : null,
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
        ...(account.usageAccountId || account.accountId
          ? { "ChatGPT-Account-ID": account.usageAccountId || account.accountId }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Usage request returned ${response.status}.`);
    const quota = extractUsageQuota(await response.json(), Date.now());
    if (account.email && quota.sourceEmail && account.email !== quota.sourceEmail) {
      throw new Error("Usage response identity did not match this account.");
    }
    if (account.usageAccountId && quota.sourceAccountId && account.usageAccountId !== quota.sourceAccountId) {
      throw new Error("Usage response account ID did not match the verified session.");
    }
    if (!account.usageAccountId && quota.sourceAccountId) account.usageAccountId = quota.sourceAccountId;
    return quota;
  } finally {
    clearTimeout(timeout);
  }
}

function quotaDistance(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  return Math.abs(first.primary.usedPercent - second.primary.usedPercent) +
    Math.abs(first.secondary.usedPercent - second.secondary.usedPercent);
}

function cacheIsRecent(quota) {
  return Number.isFinite(quota?.updatedAt) && Date.now() - quota.updatedAt < 10 * 60_000;
}

async function fetchStableUsage(account, previous) {
  const first = await fetchUsage(account);
  // Normal changes, or a stale/missing cache, need no second request.
  if (!cacheIsRecent(previous) || quotaDistance(first, previous) < 15) return first;

  // The usage endpoint occasionally serves a transient, mismatched window.
  // Confirm a large jump before replacing a fresh local measurement.
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = await fetchUsage(account);
  if (quotaDistance(first, second) < 5 || quotaDistance(previous, second) < 5) return second;

  const error = new Error("Quota response was inconsistent; keeping the last verified value.");
  error.keepCache = true;
  throw error;
}

async function loadQuotaCache() {
  return readJson(QUOTA_PATH, { version: 2, byLocalId: {} });
}

function quotaForAccount(account, cache) {
  return account.id ? cache.byLocalId?.[account.id] ?? null : null;
}

async function runUsageQuotaRefresh(targetAccountIds = null) {
  const storage = await loadStorage();
  const cache = await loadQuotaCache();
  cache.version = 2;
  cache.byLocalId ??= {};
  const errors = [];
  const targets = storage.accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => !targetAccountIds || targetAccountIds.has(account.id));
  for (const { index, account } of targets) {
    try {
      const previous = quotaForAccount(account, cache);
      const quota = await fetchStableUsage(account, previous);
      cache.byLocalId[account.id] = quota;
    } catch (error) {
      errors.push(`Account ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      // Never render an old value as though it were a fresh quota snapshot.
      // A failed check is clearer as “not checked” than a misleading cache row.
      if (!error?.keepCache) {
        delete cache.byLocalId[account.id];
      }
    }
  }
  await writeSecretJson(ACCOUNTS_PATH, storage);
  await writeSecretJson(QUOTA_PATH, cache);
  return errors;
}

async function refreshUsageQuota(targetAccountIds = null) {
  if (quotaRefreshTask) return quotaRefreshTask;
  quotaRefreshTask = runUsageQuotaRefresh(targetAccountIds).finally(() => { quotaRefreshTask = null; });
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
      close: () => {
        if (closed) return;
        closed = true;
        server.close();
      },
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

function normalizeLoginAutomation(credentials) {
  const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  const totpSecret = typeof credentials?.totpSecret === "string" ? credentials.totpSecret.trim() : "";
  if (!email || !password) throw new Error("Email and password are required.");
  return { email, password, totpSecret };
}

function buildAutofillScript(selector, value) {
  return `(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field || field.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    const form = field.closest("form");
    const submit = [...(form?.querySelectorAll("button") ?? [])].find((button) =>
      !button.disabled && button.textContent.trim() === "Continue",
    );
    if (!submit) return false;
    submit.click();
    return true;
  })()`;
}

function createOAuthLoginWindow(url, automation, callback) {
  const loginWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 460,
    minHeight: 640,
    parent: mainWindow,
    title: "Sign in to Codex",
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const steps = [
    { selector: 'input[type="email"], input[autocomplete="username"]', value: automation.email },
    { selector: 'input[type="password"][autocomplete="current-password"], input[type="password"]', value: automation.password },
    ...(automation.totpSecret ? [{ selector: 'input[autocomplete="one-time-code"], input[inputmode="numeric"]', value: () => generateTotpCode(automation.totpSecret) }] : []),
  ];
  let nextStep = 0;
  let filling = false;

  const tryAutofill = async () => {
    if (filling || loginWindow.isDestroyed() || nextStep >= steps.length) return;
    let pageUrl;
    try {
      pageUrl = new URL(loginWindow.webContents.getURL());
    } catch {
      return;
    }
    if (pageUrl.hostname !== "auth.openai.com") return;

    filling = true;
    try {
      const step = steps[nextStep];
      const value = typeof step.value === "function" ? step.value() : step.value;
      const submitted = await loginWindow.webContents.executeJavaScript(buildAutofillScript(step.selector, value), true);
      if (submitted) nextStep += 1;
    } catch {
      // The auth page may still be changing between redirects; navigation will retry.
    } finally {
      filling = false;
    }
  };

  loginWindow.webContents.on("did-finish-load", tryAutofill);
  loginWindow.webContents.on("did-navigate", tryAutofill);
  loginWindow.on("closed", callback.close);
  loginWindow.loadURL(url);
  return loginWindow;
}

async function startBrowserLogin(credentials) {
  if (pendingLogin) throw new Error("A login is already in progress.");
  let automation = normalizeLoginAutomation(credentials);
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(32));
  const callback = await startOAuthCallbackServer(state).catch(() => {
    throw new Error("Port 1455 is unavailable. Close another login flow and try again.");
  });
  let loginWindow;
  const cancel = () => {
    callback.close();
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  };
  pendingLogin = { close: cancel };
  try {
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT,
      scope: OAUTH_SCOPE, code_challenge: challenge, code_challenge_method: "S256", state,
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs", prompt: "login",
    }).toString();
    loginWindow = createOAuthLoginWindow(url.toString(), automation, callback);
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
    else storage.accounts.push(account);
    storage.activeIndex = existingIndex >= 0 ? existingIndex : storage.accounts.length - 1;
    await syncAccountToCodex(account);
    await writeSecretJson(ACCOUNTS_PATH, storage);
    // Login is complete only after the new active account has a fresh quota row.
    await refreshUsageQuota(new Set([account.id])).catch(() => undefined);
    return { dashboard: await getDashboard() };
  } finally {
    cancel();
    automation = null;
    pendingLogin = null;
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
ipcMain.handle("accounts:login", (_event, credentials) => startBrowserLogin(credentials));
ipcMain.handle("accounts:cancel-login", () => {
  const activeLogin = pendingLogin;
  activeLogin?.close();
  return { cancelled: Boolean(activeLogin) };
});
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
