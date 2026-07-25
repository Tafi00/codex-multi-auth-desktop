import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { restartCodex } from "./codex-process.js";
import { generateTotpCode } from "./totp.js";
import { buildOAuthAutomationScript, buildPageStateScript } from "./login-automation.js";
import {
  createPhoneVerificationSession,
  hasPhoneNumberError,
  isAuthenticatorPrompt,
  isNumberRejection,
  isSmsCodePrompt,
} from "./phone-verification.js";
import {
  DEFAULT_SMS_SETTINGS,
  SMS_SETTINGS_VERSION,
  createSmsClient,
  migrateSmsSettings,
  normalizeSmsSettings,
} from "./sms-provider.js";
import { extractUsageQuota, quotaDistance } from "./usage-quota.js";
import {
  applyTokenResponse,
  buildCodexAuthFile,
  buildUsageHeaders,
  extractIdentity,
} from "./codex-auth.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const APP_DIR = join(CODEX_HOME, "multi-auth-desktop");
const ACCOUNTS_PATH = join(APP_DIR, "accounts.json");
const QUOTA_PATH = join(APP_DIR, "quota-cache.json");
const SETTINGS_PATH = join(APP_DIR, "settings.json");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const LEGACY_ACCOUNTS_PATH = join(CODEX_HOME, "multi-auth", "openai-codex-accounts.json");
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_REDIRECT = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE = "openid profile email offline_access";

let mainWindow;
let pendingLogin = null;
let quotaRefreshTask = null;
const accountRefreshTasks = new Map();
const QUOTA_REFRESH_CONCURRENCY = 4;

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

function sendLog(message, tone = "") {
  console.info(`[login] ${message}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("manager:log", { message, tone, at: Date.now() });
  }
}

function normalizeAccount(account) {
  if (!account || typeof account.refreshToken !== "string" || !account.refreshToken.trim()) return null;
  return {
    id: typeof account.id === "string" ? account.id : randomBytes(12).toString("hex"),
    email: typeof account.email === "string" ? account.email.trim().toLowerCase() : null,
    accountId: typeof account.accountId === "string" ? account.accountId : null,
    usageAccountId: typeof account.usageAccountId === "string" ? account.usageAccountId : null,
    planType: typeof account.planType === "string" ? account.planType : null,
    refreshToken: account.refreshToken,
    accessToken: typeof account.accessToken === "string" ? account.accessToken : null,
    idToken: typeof account.idToken === "string" ? account.idToken : null,
    expiresAt: Number.isFinite(account.expiresAt) ? account.expiresAt : null,
    addedAt: Number.isFinite(account.addedAt) ? account.addedAt : Date.now(),
    savedLogin: account.savedLogin && typeof account.savedLogin.email === "string" && typeof account.savedLogin.password === "string"
      ? {
        email: account.savedLogin.email.trim().toLowerCase(),
        password: account.savedLogin.password,
        totpSecret: typeof account.savedLogin.totpSecret === "string" ? account.savedLogin.totpSecret : null,
      }
      : null,
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

async function refreshAccount(account) {
  const refreshKey = account.id || account.refreshToken;
  let task = accountRefreshTasks.get(refreshKey);
  if (!task) {
    task = (async () => {
      const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: OAUTH_CLIENT_ID,
          refresh_token: account.refreshToken,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("Session has expired. Please login again.");
      return applyTokenResponse(account, data);
    })();
    accountRefreshTasks.set(refreshKey, task);
  }
  try {
    const updated = await task;
    Object.assign(account, updated);
    return account.accessToken;
  } finally {
    if (accountRefreshTasks.get(refreshKey) === task) accountRefreshTasks.delete(refreshKey);
  }
}

async function usableAccessToken(account) {
  if (account.accessToken && Number.isFinite(account.expiresAt) && account.expiresAt > Date.now() + 60_000) {
    return account.accessToken;
  }
  return refreshAccount(account);
}

async function fetchUsage(account) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let accessToken = await usableAccessToken(account);
    const request = () => fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: buildUsageHeaders(account, accessToken),
      signal: controller.signal,
    });
    let response = await request();
    if (response.status === 401) {
      accessToken = await refreshAccount(account);
      response = await request();
    }
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
  return readJson(QUOTA_PATH, { version: 3, byLocalId: {} });
}

function quotaForAccount(account, cache) {
  return account.id ? cache.byLocalId?.[account.id] ?? null : null;
}

async function runUsageQuotaRefresh(targetAccountIds = null) {
  const storage = await loadStorage();
  const cache = await loadQuotaCache();
  cache.version = 3;
  cache.byLocalId ??= {};
  const errors = [];
  const targets = storage.accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => !targetAccountIds || targetAccountIds.has(account.id));
  let nextTarget = 0;
  const refreshWorker = async () => {
    while (nextTarget < targets.length) {
      const { index, account } = targets[nextTarget++];
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
  };
  await Promise.all(
    Array.from(
      { length: Math.min(QUOTA_REFRESH_CONCURRENCY, targets.length) },
      () => refreshWorker(),
    ),
  );
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
    const windowExhausted = [quota?.primary, quota?.secondary]
      .filter(Boolean)
      .some((window) => window.usedPercent >= 100);
    return {
      index,
      email: account.email,
      label: account.email || `Account ${index + 1}`,
      planType: quota?.planType || account.planType,
      current: index === storage.activeIndex,
      enabled: true,
      hasSavedLogin: Boolean(account.savedLogin?.password),
      markers: quota && (quota.limitReached === true || quota.allowed === false || windowExhausted)
        ? ["quota-exhausted"]
        : [],
      quota: quota ? {
        primaryUsedPercent: quota.primary?.usedPercent ?? null,
        primaryResetAtMs: quota.primary?.resetAtMs ?? null,
        secondaryUsedPercent: quota.secondary?.usedPercent ?? null,
        secondaryResetAtMs: quota.secondary?.resetAtMs ?? null,
        updatedAt: quota.updatedAt,
      } : null,
    };
  });
  return { accounts, updatedAt: Date.now() };
}

async function syncAccountToCodex(account) {
  await usableAccessToken(account);
  await writeSecretJson(AUTH_PATH, buildCodexAuthFile(account));
}

function normalizeLoginAutomation(credentials) {
  const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  const totpSecret = typeof credentials?.totpSecret === "string" ? credentials.totpSecret.trim() : "";
  if (!email || !password) throw new Error("Email and password are required.");
  return { email, password, totpSecret };
}

function encryptLoginSecret(value) {
  if (!value) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this device.");
  return safeStorage.encryptString(value).toString("base64");
}

function decryptLoginSecret(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this device.");
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

async function loadSmsSettings() {
  const stored = await readJson(SETTINGS_PATH, null);
  const storedSms = stored?.sms ?? {};
  const sms = {
    ...migrateSmsSettings(storedSms, stored?.version),
    baseUrl: DEFAULT_SMS_SETTINGS.baseUrl,
    service: DEFAULT_SMS_SETTINGS.service,
    maxAttempts: DEFAULT_SMS_SETTINGS.maxAttempts,
    codeTimeoutMs: DEFAULT_SMS_SETTINGS.codeTimeoutMs,
  };
  let settings;
  try {
    settings = normalizeSmsSettings(sms);
  } catch {
    settings = normalizeSmsSettings({});
  }
  return { settings, encryptedApiKey: typeof storedSms.apiKey === "string" ? storedSms.apiKey : null };
}

async function saveSmsSettings(input) {
  const { encryptedApiKey: previousKey } = await loadSmsSettings();
  const settings = normalizeSmsSettings({
    ...input,
    baseUrl: DEFAULT_SMS_SETTINGS.baseUrl,
    service: DEFAULT_SMS_SETTINGS.service,
    maxAttempts: DEFAULT_SMS_SETTINGS.maxAttempts,
    codeTimeoutMs: DEFAULT_SMS_SETTINGS.codeTimeoutMs,
  });
  const rawApiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  // An empty field keeps the stored key so the UI never has to echo it back.
  const encryptedApiKey = rawApiKey ? encryptLoginSecret(rawApiKey) : previousKey;
  if (settings.enabled && !encryptedApiKey) throw new Error("A HeroSMS API key is required to rent numbers.");
  await writeSecretJson(SETTINGS_PATH, {
    version: SMS_SETTINGS_VERSION,
    sms: { ...settings, apiKey: encryptedApiKey },
  });
  return { ...settings, hasApiKey: Boolean(encryptedApiKey) };
}

async function createSmsSessionForLogin() {
  const { settings, encryptedApiKey } = await loadSmsSettings();
  if (!settings.enabled || !encryptedApiKey) return null;
  const client = createSmsClient({ settings, apiKey: decryptLoginSecret(encryptedApiKey) });
  return createPhoneVerificationSession({ client, log: (message) => sendLog(message) });
}

function savedLoginFor(account) {
  const login = account?.savedLogin;
  if (!login?.email || !login.password) return null;
  return {
    email: login.email,
    password: decryptLoginSecret(login.password),
    totpSecret: decryptLoginSecret(login.totpSecret),
  };
}

function createOAuthLoginWindow(url, automation, callback, smsSession = null) {
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
  let filling = false;
  const completedActionKeys = new Set();
  let phoneSession = smsSession;
  let rotatePhone = false;

  const readPageState = () => loginWindow.webContents.executeJavaScript(buildPageStateScript(), true);

  const stopPhoneAutomation = (message) => {
    sendLog(`Phone verification stopped: ${message}`, "error");
    phoneSession?.dispose("phone automation stopped");
    phoneSession = null;
    rotatePhone = false;
  };

  /** Rents a number, rotating whenever OpenAI refuses the current one. */
  const resolvePhoneNumber = async (state) => {
    if (!phoneSession || !state.hasPhoneField) return "";
    const current = phoneSession.current;
    if (current?.submitted && hasPhoneNumberError(state)) {
      phoneSession.reject(state.errorText);
    }
    const activation = await phoneSession.acquire();
    return activation.phoneNumber;
  };

  /**
   * True while a code field belongs to the rented number rather than to the
   * account's authenticator app. Any code prompt that shows up after a number
   * was rented is the phone verification unless the page says otherwise.
   */
  const isSmsCodeStage = (state) => {
    if (!state.hasCodeField) return false;
    // Page evidence must win even after the HeroSMS session was stopped or a
    // number timed out. Otherwise the next tick can type account TOTP here.
    if (isSmsCodePrompt(state)) return true;
    if (!phoneSession?.current?.submitted) return false;
    return !isAuthenticatorPrompt(state);
  };

  /** Waits for the rented number's SMS, rotating the number when none arrives. */
  const resolveSmsCode = async (state) => {
    if (!isSmsCodeStage(state)) return "";
    if (!phoneSession.current) return "";
    // A provider only ever returns the same code, so a refused code means the
    // number itself has to go.
    if (phoneSession.current.codeSubmitted && isNumberRejection(state.errorText)) {
      phoneSession.reject(state.errorText);
      rotatePhone = true;
      return "";
    }
    if (phoneSession.current.codeSubmitted) return "";
    phoneSession.markSubmitted();
    sendLog(`Waiting for the SMS code on ${phoneSession.current.phoneNumber}…`);
    const code = await phoneSession.waitForCode();
    if (!code) {
      rotatePhone = true;
      return "";
    }
    return code;
  };

  const tryAutofill = async () => {
    if (filling || loginWindow.isDestroyed()) return;
    if (loginWindow.webContents.isLoadingMainFrame()) return;
    let pageUrl;
    try {
      pageUrl = new URL(loginWindow.webContents.getURL());
    } catch {
      return;
    }
    if (pageUrl.hostname !== "auth.openai.com") return;

    filling = true;
    try {
      const state = await readPageState();
      const values = { totpCode: "", smsCode: "", phoneNumber: "", rotatePhone: false };

      if (rotatePhone) {
        values.rotatePhone = true;
      } else {
        try {
          values.phoneNumber = await resolvePhoneNumber(state);
          values.smsCode = await resolveSmsCode(state);
          // resolveSmsCode can time out during this same tick. Carry the new
          // rotate state into the script so it cannot click Continue first.
          if (rotatePhone && !values.smsCode) values.rotatePhone = true;
        } catch (error) {
          stopPhoneAutomation(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      // The authenticator code must never be typed into an SMS prompt; that
      // wrong guess is what used to loop the phone verification step.
      if (!values.smsCode && !isSmsCodeStage(state) && automation.totpSecret) {
        try {
          values.totpCode = generateTotpCode(automation.totpSecret);
        } catch (error) {
          // A malformed secret must not silently stall the whole login.
          sendLog(`Saved 2FA secret is unusable: ${error instanceof Error ? error.message : String(error)}`, "error");
          automation.totpSecret = "";
        }
      }

      if (loginWindow.isDestroyed()) return;
      const result = await loginWindow.webContents.executeJavaScript(
        buildOAuthAutomationScript(automation, values, [...completedActionKeys]),
        true,
      );
      if (result?.needsPhoneReset) {
        if (loginWindow.webContents.canGoBack()) {
          completedActionKeys.clear();
          loginWindow.webContents.goBack();
          sendLog("Returning to the phone form to rent another number.");
        } else {
          stopPhoneAutomation("the page offers no way back to phone entry. Finish this login by hand.");
        }
        return;
      }
      if (result?.acted && result.key) {
        completedActionKeys.add(result.key);
        if (result.action === "phone") {
          phoneSession?.markSubmitted();
          sendLog(`Submitted ${values.phoneNumber} to OpenAI.`);
        }
        if (result.action === "rotate-phone" || result.action === "rotate-phone-ready") rotatePhone = false;
        if (result.action === "sms-code") phoneSession?.markCodeSubmitted();
        const details = result.url
          ? ` (${result.url}; smsSelected=${String(result.smsSelected ?? "n/a")})`
          : "";
        console.info(`[OAuth automation] ${result.action}${details}`);
      }
    } catch {
      // The auth page may still be changing between redirects; navigation will retry.
    } finally {
      filling = false;
    }
  };

  const retryTimer = setInterval(() => { void tryAutofill(); }, 100);
  const resetAction = () => {
    completedActionKeys.clear();
  };
  const resetAndAutofill = () => {
    resetAction();
    void tryAutofill();
  };
  loginWindow.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) resetAction();
  });
  loginWindow.webContents.on("dom-ready", tryAutofill);
  loginWindow.webContents.on("did-finish-load", tryAutofill);
  loginWindow.webContents.on("did-navigate", resetAndAutofill);
  loginWindow.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) resetAndAutofill();
  });
  loginWindow.on("closed", () => {
    clearInterval(retryTimer);
    phoneSession?.dispose("login window closed");
    callback.close();
  });
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
  const smsSession = await createSmsSessionForLogin().catch((error) => {
    sendLog(`Phone verification is off: ${error instanceof Error ? error.message : String(error)}`, "error");
    return null;
  });
  const cancel = async () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    smsSession?.dispose("login finished");
    await callback.close();
  };
  pendingLogin = { close: () => { void cancel(); } };
  try {
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code", client_id: OAUTH_CLIENT_ID, redirect_uri: OAUTH_REDIRECT,
      scope: OAUTH_SCOPE, code_challenge: challenge, code_challenge_method: "S256", state,
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs", prompt: "login",
    }).toString();
    loginWindow = createOAuthLoginWindow(url.toString(), automation, callback, smsSession);
    const code = await callback.wait();
    if (!code) throw new Error("Login was cancelled or timed out.");
    // OpenAI accepted the phone step, so close the activation instead of refunding it.
    await smsSession?.finish();
    const response = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: OAUTH_CLIENT_ID, code, code_verifier: verifier, redirect_uri: OAUTH_REDIRECT }),
    });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorCode = typeof tokens.error === "string" ? `: ${tokens.error}` : "";
      throw new Error(`OpenAI OAuth exchange failed (${response.status}${errorCode}).`);
    }
    if (typeof tokens.access_token !== "string") throw new Error("OpenAI did not return a valid access token.");
    const identity = extractIdentity(tokens.access_token, tokens.id_token);
    const loginEmail = identity.email?.toLowerCase() ?? null;
    const storage = await loadStorage();
    const wasEmpty = storage.accounts.length === 0;
    const existingIndex = storage.accounts.findIndex((account) =>
      (identity.accountId && account.accountId === identity.accountId) || (loginEmail && account.email === loginEmail),
    );
    const wasActive = existingIndex === storage.activeIndex;
    const existingAccount = existingIndex >= 0 ? storage.accounts[existingIndex] : null;
    if (typeof tokens.refresh_token !== "string" && !existingAccount?.refreshToken) {
      throw new Error("OpenAI did not return a reusable refresh token. Please try signing in again.");
    }
    const tokenState = applyTokenResponse(existingAccount ?? {}, tokens);
    const account = {
      ...tokenState,
      id: existingAccount?.id ?? randomBytes(12).toString("hex"),
      addedAt: existingAccount?.addedAt ?? Date.now(),
      savedLogin: {
        email: automation.email,
        password: encryptLoginSecret(automation.password),
        totpSecret: encryptLoginSecret(automation.totpSecret),
      },
    };
    if (existingIndex >= 0) storage.accounts[existingIndex] = account;
    else storage.accounts.push(account);
    if (wasEmpty) storage.activeIndex = 0;
    if (wasEmpty || wasActive) await syncAccountToCodex(account);
    await writeSecretJson(ACCOUNTS_PATH, storage);
    // Login is complete only after the new active account has a fresh quota row.
    await refreshUsageQuota(new Set([account.id])).catch(() => undefined);
    return { dashboard: await getDashboard() };
  } finally {
    await cancel();
    automation = null;
    pendingLogin = null;
  }
}

function assertImportShape(value, { allowSavedLogin = false } = {}) {
  const accounts = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(accounts) || accounts.length > 100) throw new Error("Invalid session export.");
  const normalized = accounts.map((account) => {
    const result = normalizeAccount(account);
    if (result && !allowSavedLogin) result.savedLogin = null;
    return result;
  }).filter(Boolean);
  if (normalized.length !== accounts.length) throw new Error("Every imported account needs a refresh token.");
  return normalized;
}

function portableAccounts(storage) {
  return storage.accounts.map((account) => ({
    ...account,
    savedLogin: account.savedLogin ? savedLoginFor(account) : null,
  }));
}

function secureImportedLogins(accounts) {
  return accounts.map((account) => {
    if (!account.savedLogin) return account;
    return {
      ...account,
      savedLogin: {
        email: account.savedLogin.email,
        password: encryptLoginSecret(account.savedLogin.password),
        totpSecret: encryptLoginSecret(account.savedLogin.totpSecret),
      },
    };
  });
}

ipcMain.handle("settings:load-sms", async () => {
  const { settings, encryptedApiKey } = await loadSmsSettings();
  // The API key never leaves the main process; the UI only learns that one exists.
  return { ...settings, hasApiKey: Boolean(encryptedApiKey), defaults: DEFAULT_SMS_SETTINGS };
});
ipcMain.handle("settings:save-sms", (_event, input) => saveSmsSettings(input));
ipcMain.handle("settings:test-sms", async (_event, input) => {
  const { settings, encryptedApiKey } = await loadSmsSettings();
  const rawApiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = rawApiKey || (encryptedApiKey ? decryptLoginSecret(encryptedApiKey) : "");
  const testSettings = normalizeSmsSettings({
    ...settings,
  });
  const client = createSmsClient({ settings: testSettings, apiKey });
  return { balance: await client.getBalance() };
});
ipcMain.handle("settings:list-sms-countries", async (_event, input) => {
  const { settings, encryptedApiKey } = await loadSmsSettings();
  const rawApiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = rawApiKey || (encryptedApiKey ? decryptLoginSecret(encryptedApiKey) : "");
  if (!apiKey) throw new Error("Enter a HeroSMS API key before loading prices.");
  const service = DEFAULT_SMS_SETTINGS.service;
  const client = createSmsClient({
    settings,
    apiKey,
  });
  return { service, offers: await client.getCountryOffers(service) };
});
ipcMain.handle("accounts:load", () => getDashboard());
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
ipcMain.handle("accounts:refresh-current-quota", async () => {
  const storage = await loadStorage();
  const account = storage.accounts[storage.activeIndex];
  if (!account) return { dashboard: await getDashboard(), probeErrors: [] };
  const probeErrors = await refreshUsageQuota(new Set([account.id]));
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
ipcMain.handle("accounts:relogin", async (_event, index) => {
  const storage = await loadStorage();
  const account = storage.accounts[index];
  if (!account) throw new Error("Account was not found.");
  const credentials = savedLoginFor(account);
  if (!credentials) throw new Error("This account has no saved login details.");
  return startBrowserLogin(credentials);
});
ipcMain.handle("accounts:copy-login", async (_event, index, field) => {
  const storage = await loadStorage();
  const account = storage.accounts[index];
  if (!account) throw new Error("Account was not found.");
  const credentials = savedLoginFor(account);
  if (!credentials) throw new Error("This account has no saved login details.");

  let value;
  if (field === "email") value = credentials.email;
  else if (field === "password") value = credentials.password;
  else if (field === "totp") {
    if (!credentials.totpSecret) throw new Error("This account has no saved 2FA secret.");
    value = generateTotpCode(credentials.totpSecret);
  } else throw new Error("Unknown login field.");

  clipboard.writeText(value);
  return { field };
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
  const exportData = {
    version: 3,
    encrypted: false,
    accounts: portableAccounts(storage),
    activeIndex: storage.activeIndex,
  };
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, { title: "Export Codex sessions", defaultPath: `codex-sessions-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (canceled || !filePath) return { cancelled: true };
  await writeSecretJson(filePath, exportData);
  return { cancelled: false, count: storage.accounts.length };
});
ipcMain.handle("accounts:import", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, { title: "Import Codex sessions", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (canceled || !filePaths[0]) return { cancelled: true };
  const exportData = JSON.parse(await fs.readFile(filePaths[0], "utf8"));
  if (exportData?.encrypted) {
    throw new Error("Password-protected export files are no longer supported. Export the sessions again as plain JSON.");
  }
  const incoming = secureImportedLogins(assertImportShape(exportData, { allowSavedLogin: exportData?.version === 3 }));
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
