import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
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
import electronUpdater from "electron-updater";
import { startAppUpdater } from "./app-updater.js";
import { createControlledGuestChrome } from "./controlled-chrome.js";
import {
  findMatchingAccountIndex,
  mergeImportedAccounts,
  serializeJson,
  verifySerializedJson,
} from "./session-transfer.js";
import {
  DEFAULT_GITHUB_SYNC_FILE,
  DEFAULT_GITHUB_SYNC_REPO,
  createGitHubSyncClient,
  pollGitHubDeviceToken,
  refreshGitHubDeviceToken,
  requestGitHubDeviceCode,
} from "./github-sync.js";
import {
  accountSyncKey,
  createSyncRecords,
  decryptSyncVault,
  isLegacyEncryptedSyncVault,
  mergeSyncRecords,
  normalizeSyncPayload,
  syncRecordFingerprint,
  tombstonesFromRecords,
} from "./sync-vault.js";

const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const APP_DIR = join(CODEX_HOME, "multi-auth-desktop");
const ACCOUNTS_PATH = join(APP_DIR, "accounts.json");
const QUOTA_PATH = join(APP_DIR, "quota-cache.json");
const SETTINGS_PATH = join(APP_DIR, "settings.json");
const GITHUB_SYNC_PATH = join(APP_DIR, "github-sync.json");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const LEGACY_ACCOUNTS_PATH = join(CODEX_HOME, "multi-auth", "openai-codex-accounts.json");
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_REDIRECT = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE = "openid profile email offline_access";
const GITHUB_OAUTH_CLIENT_ID = "Ov23liX3HZFNMIvYaKmW";
const GITHUB_OAUTH_SCOPE = "repo offline_access";

let mainWindow;
let pendingLogin = null;
let quotaRefreshTask = null;
let githubSyncTask = null;
let githubLoginTask = null;
let githubLoginController = null;
let pendingGithubUserCode = null;
let appUpdaterController = null;
const accountRefreshTasks = new Map();
const QUOTA_REFRESH_CONCURRENCY = 4;
const { autoUpdater } = electronUpdater;

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
    await fs.writeFile(temp, serializeJson(value), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, path);
    if (process.platform !== "win32") await fs.chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function writeVerifiedExport(path, value) {
  const expected = serializeJson(value);
  await writeSecretJson(path, value);
  const written = await fs.readFile(path, "utf8");
  // Reading back the saved bytes catches truncation and malformed data before
  // the UI is allowed to report a successful export.
  verifySerializedJson(written, expected);
  return Buffer.byteLength(written, "utf8");
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
    syncKey: typeof account.syncKey === "string" && account.syncKey.length <= 512 ? account.syncKey : null,
    syncUpdatedAt: Number.isFinite(account.syncUpdatedAt) ? account.syncUpdatedAt : null,
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
      const updated = applyTokenResponse(account, data);
      if (updated.refreshToken !== account.refreshToken || updated.idToken !== account.idToken) {
        updated.syncUpdatedAt = Date.now();
      }
      return updated;
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

function attachOAuthAutomation(page, automation, callback, smsSession = null) {
  let filling = false;
  const completedActionKeys = new Set();
  let phoneSession = smsSession;
  let rotatePhone = false;

  const readPageState = () => page.executeJavaScript(buildPageStateScript());

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
    if (filling || await page.isDestroyed()) return;
    if (await page.isLoading()) return;
    let pageUrl;
    try {
      pageUrl = new URL(await page.getURL());
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

      if (await page.isDestroyed()) return;
      const result = await page.executeJavaScript(
        buildOAuthAutomationScript(automation, values, [...completedActionKeys]),
      );
      if (result?.needsPhoneReset) {
        if (await page.canGoBack()) {
          completedActionKeys.clear();
          await page.goBack();
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
  page.onNavigation(resetAndAutofill);
  page.onClosed(() => {
    clearInterval(retryTimer);
    phoneSession?.dispose("login window closed");
    void callback.close();
  });
  void tryAutofill();
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
  const webContents = loginWindow.webContents;
  const page = {
    close: () => loginWindow.close(),
    isDestroyed: () => loginWindow.isDestroyed(),
    isLoading: () => webContents.isLoadingMainFrame(),
    getURL: () => webContents.getURL(),
    executeJavaScript: (expression) => webContents.executeJavaScript(expression, true),
    canGoBack: () => webContents.navigationHistory?.canGoBack() ?? webContents.canGoBack(),
    goBack: () => webContents.navigationHistory?.goBack() ?? webContents.goBack(),
    onNavigation: (listener) => {
      webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame) listener();
      });
      webContents.on("did-navigate", listener);
      webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
        if (isMainFrame) listener();
      });
    },
    onClosed: (listener) => loginWindow.on("closed", listener),
  };
  attachOAuthAutomation(page, automation, callback, smsSession);
  loginWindow.loadURL(url);
  return loginWindow;
}

async function startBrowserLogin(credentials = null) {
  if (pendingLogin) throw new Error("A login is already in progress.");
  let automation = normalizeLoginAutomation(credentials);
  // Electron's embedded Chromium cannot surface the macOS platform
  // authenticator in the version this app ships with. On macOS, use a real
  // English Chrome Guest window controlled through Playwright so automation is
  // preserved while Touch ID/iCloud Keychain can show its native passkey UI.
  const useControlledGuestChrome = process.platform === "darwin";
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
    if (loginWindow && !loginWindow.isDestroyed()) await loginWindow.close();
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
    if (useControlledGuestChrome) {
      loginWindow = await createControlledGuestChrome(url.toString());
      attachOAuthAutomation(loginWindow, automation, callback, smsSession);
      sendLog("Opened English Chrome Guest and connected Playwright login automation.");
    } else {
      loginWindow = createOAuthLoginWindow(url.toString(), automation, callback, smsSession);
    }
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
      syncUpdatedAt: Date.now(),
      // Browser OAuth owns the credential entry (including Google sign-in),
      // so this flow intentionally does not retain a password in app storage.
      savedLogin: credentials ? {
        email: automation.email,
        password: encryptLoginSecret(automation.password),
        totpSecret: encryptLoginSecret(automation.totpSecret),
      } : null,
    };
    if (existingIndex >= 0) storage.accounts[existingIndex] = account;
    else storage.accounts.push(account);
    if (wasEmpty) storage.activeIndex = 0;
    if (wasEmpty || wasActive) await syncAccountToCodex(account);
    await writeSecretJson(ACCOUNTS_PATH, storage);
    // Login is complete only after the new active account has a fresh quota row.
    await refreshUsageQuota(new Set([account.id])).catch(() => undefined);
    await cancel();
    const syncWarning = await autoSyncGithubSessions();
    return { dashboard: await getDashboard(), syncWarning };
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

function emptyGithubSyncSettings() {
  return {
    version: 1,
    enabled: false,
    login: null,
    repo: DEFAULT_GITHUB_SYNC_REPO,
    file: DEFAULT_GITHUB_SYNC_FILE,
    legacyEncryptedPassphrase: null,
    encryptedAccessToken: null,
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    tombstones: {},
    lastSyncAt: null,
  };
}

async function loadGithubSyncSettings() {
  const stored = await readJson(GITHUB_SYNC_PATH, null);
  const fallback = emptyGithubSyncSettings();
  if (!stored || stored.version !== 1) return fallback;
  return {
    ...fallback,
    enabled: stored.enabled === true,
    login: typeof stored.login === "string" ? stored.login : null,
    repo: typeof stored.repo === "string" && stored.repo ? stored.repo : fallback.repo,
    file: typeof stored.file === "string" && stored.file ? stored.file : fallback.file,
    // Version 1 stored the passphrase under this name. Retain it only until an
    // encrypted vault can be migrated to the private-repository format.
    legacyEncryptedPassphrase: typeof stored.legacyEncryptedPassphrase === "string"
      ? stored.legacyEncryptedPassphrase
      : (typeof stored.encryptedPassphrase === "string" ? stored.encryptedPassphrase : null),
    encryptedAccessToken: typeof stored.encryptedAccessToken === "string" ? stored.encryptedAccessToken : null,
    encryptedRefreshToken: typeof stored.encryptedRefreshToken === "string" ? stored.encryptedRefreshToken : null,
    accessTokenExpiresAt: Number.isFinite(stored.accessTokenExpiresAt) ? stored.accessTokenExpiresAt : null,
    refreshTokenExpiresAt: Number.isFinite(stored.refreshTokenExpiresAt) ? stored.refreshTokenExpiresAt : null,
    tombstones: stored.tombstones && typeof stored.tombstones === "object" ? stored.tombstones : {},
    lastSyncAt: Number.isFinite(stored.lastSyncAt) ? stored.lastSyncAt : null,
  };
}

async function saveGithubSyncSettings(settings) {
  await writeSecretJson(GITHUB_SYNC_PATH, { ...emptyGithubSyncSettings(), ...settings, version: 1 });
}

function githubSyncStatus(settings, extra = {}) {
  return {
    installed: true,
    authenticated: extra.authenticated ?? Boolean(settings.encryptedAccessToken || settings.encryptedRefreshToken),
    connected: settings.enabled === true,
    login: settings.login,
    activeLogin: extra.activeLogin ?? null,
    repo: settings.repo,
    repositoryUrl: settings.login ? `https://github.com/${settings.login}/${settings.repo}` : null,
    lastSyncAt: settings.lastSyncAt,
    error: extra.error ?? null,
  };
}

function sendGithubSyncStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("github-sync:status", status);
}

function sendGithubDeviceCode(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("github-sync:device-code", value);
}

function githubDeviceVerificationUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://github.com" || url.pathname !== "/login/device") {
    throw new Error("GitHub trả về device verification URL không hợp lệ.");
  }
  return url.toString();
}

function settingsWithGithubTokens(settings, tokens, { preserveRefreshToken = false } = {}) {
  const refreshToken = tokens.refreshToken
    ? encryptLoginSecret(tokens.refreshToken)
    : (preserveRefreshToken ? settings.encryptedRefreshToken : null);
  return {
    ...settings,
    encryptedAccessToken: encryptLoginSecret(tokens.accessToken),
    encryptedRefreshToken: refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt
      ?? (preserveRefreshToken ? settings.refreshTokenExpiresAt : null),
  };
}

function clearGithubTokens(settings) {
  return {
    ...settings,
    encryptedAccessToken: null,
    encryptedRefreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

async function usableGithubAccessToken(settings) {
  if (
    settings.encryptedAccessToken
    && (!settings.accessTokenExpiresAt || settings.accessTokenExpiresAt > Date.now() + 60_000)
  ) {
    return { accessToken: decryptLoginSecret(settings.encryptedAccessToken), settings };
  }
  if (
    settings.encryptedRefreshToken
    && (!settings.refreshTokenExpiresAt || settings.refreshTokenExpiresAt > Date.now() + 60_000)
  ) {
    const refreshed = await refreshGitHubDeviceToken({
      clientId: GITHUB_OAUTH_CLIENT_ID,
      refreshToken: decryptLoginSecret(settings.encryptedRefreshToken),
    });
    const nextSettings = settingsWithGithubTokens(settings, refreshed, { preserveRefreshToken: true });
    await saveGithubSyncSettings(nextSettings);
    return { accessToken: refreshed.accessToken, settings: nextSettings };
  }
  throw new Error("GitHub cần đăng nhập lại.");
}

async function authorizeGithubDevice(settings) {
  if (githubLoginTask) return githubLoginTask;
  githubLoginController = new AbortController();
  githubLoginTask = (async () => {
    const device = await requestGitHubDeviceCode({
      clientId: GITHUB_OAUTH_CLIENT_ID,
      scope: GITHUB_OAUTH_SCOPE,
    });
    pendingGithubUserCode = device.userCode;
    clipboard.writeText(device.userCode);
    sendGithubDeviceCode({
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: Date.now() + device.expiresIn * 1000,
    });
    await shell.openExternal(githubDeviceVerificationUrl(device.verificationUri));
    const tokens = await pollGitHubDeviceToken({
      clientId: GITHUB_OAUTH_CLIENT_ID,
      deviceCode: device.deviceCode,
      intervalMs: device.intervalMs,
      expiresIn: device.expiresIn,
      signal: githubLoginController.signal,
    });
    return { accessToken: tokens.accessToken, settings: settingsWithGithubTokens(settings, tokens) };
  })().finally(() => {
    sendGithubDeviceCode(null);
    pendingGithubUserCode = null;
    githubLoginController = null;
    githubLoginTask = null;
  });
  return githubLoginTask;
}

async function loginGithub() {
  const settings = await loadGithubSyncSettings();
  let auth;
  try {
    auth = await usableGithubAccessToken(settings);
  } catch {
    auth = await authorizeGithubDevice(settings);
  }
  const client = createGitHubSyncClient({ accessToken: auth.accessToken });
  const user = await client.getAuthenticatedUser();
  if (settings.enabled && settings.login && settings.login.toLowerCase() !== user.login.toLowerCase()) {
    throw new Error(`Vault này đã kết nối với @${settings.login}; GitHub vừa đăng nhập là @${user.login}.`);
  }
  const nextSettings = { ...auth.settings, login: user.login };
  await saveGithubSyncSettings(nextSettings);
  const status = githubSyncStatus(nextSettings, { authenticated: true, activeLogin: user.login });
  sendGithubSyncStatus(status);
  return status;
}

async function probeGithubSyncStatus() {
  const settings = await loadGithubSyncSettings();
  if (!settings.encryptedAccessToken && !settings.encryptedRefreshToken) {
    return githubSyncStatus(settings, {
      authenticated: false,
      error: settings.enabled ? "GitHub cần đăng nhập lại." : null,
    });
  }
  try {
    const auth = await usableGithubAccessToken(settings);
    const client = createGitHubSyncClient({ accessToken: auth.accessToken });
    const user = await client.getAuthenticatedUser();
    const error = settings.enabled && settings.login && settings.login.toLowerCase() !== user.login.toLowerCase()
      ? `Vault đã kết nối với @${settings.login}, nhưng token hiện tại thuộc @${user.login}.`
      : null;
    return githubSyncStatus(auth.settings, { authenticated: true, activeLogin: user.login, error });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return githubSyncStatus(settings, {
      authenticated: false,
      error: settings.enabled ? message : null,
    });
  }
}

function legacySyncPassphrase(settings) {
  if (settings.legacyEncryptedPassphrase) return decryptLoginSecret(settings.legacyEncryptedPassphrase);
  throw new Error("GitHub vault cũ vẫn được mã hóa. Hãy sync một lần từ máy còn lưu passphrase cũ để chuyển vault sang private-repository sync.");
}

function mergePortableAccounts(existingAccounts, records) {
  const incomingAccounts = records.filter((record) => !record.deletedAt).map((record) => record.account);
  const remaining = incomingAccounts.map((account) => ({ ...account }));
  const accounts = [];
  for (const existing of existingAccounts) {
    const index = findMatchingAccountIndex(remaining, existing);
    if (index < 0) continue;
    const incoming = remaining.splice(index, 1)[0];
    accounts.push({
      ...existing,
      ...incoming,
      id: existing.id || incoming.id,
      addedAt: existing.addedAt ?? incoming.addedAt,
    });
  }
  accounts.push(...remaining);
  return accounts;
}

async function runGithubSync({ interactiveAuth = false } = {}) {
  const storedSettings = await loadGithubSyncSettings();
  let auth;
  try {
    auth = await usableGithubAccessToken(storedSettings);
  } catch (error) {
    if (!interactiveAuth) throw error;
    auth = await authorizeGithubDevice(storedSettings);
  }
  const client = createGitHubSyncClient({ accessToken: auth.accessToken });
  const user = await client.getAuthenticatedUser();
  if (storedSettings.enabled && storedSettings.login && storedSettings.login.toLowerCase() !== user.login.toLowerCase()) {
    throw new Error(`Vault này đã kết nối với @${storedSettings.login}, nhưng GitHub vừa đăng nhập là @${user.login}.`);
  }
  const settings = { ...auth.settings, login: user.login };
  await saveGithubSyncSettings(settings);

  const repo = settings.repo || DEFAULT_GITHUB_SYNC_REPO;
  const path = settings.file || DEFAULT_GITHUB_SYNC_FILE;
  await client.ensurePrivateRepository(user.login, repo);
  const remoteFile = await client.readVault(user.login, repo, path);
  let remotePayload = { version: 1, updatedAt: 0, records: [] };
  let legacyEncryptedVault = false;
  if (remoteFile) {
    let vault;
    try {
      vault = JSON.parse(remoteFile.content);
    } catch {
      throw new Error("GitHub vault file không phải JSON hợp lệ.");
    }
    legacyEncryptedVault = isLegacyEncryptedSyncVault(vault);
    remotePayload = legacyEncryptedVault
      ? await decryptSyncVault(vault, legacySyncPassphrase(settings))
      : normalizeSyncPayload(vault);
  }

  const storage = await loadStorage();
  const portable = portableAccounts(storage);
  const localRecords = createSyncRecords(portable, settings.tombstones);
  const mergedRecords = mergeSyncRecords(remotePayload.records, localRecords);
  const activePlainAccounts = mergePortableAccounts(portable, mergedRecords);
  const normalizedAccounts = assertImportShape({ accounts: activePlainAccounts }, { allowSavedLogin: true });
  const previousActive = portable[storage.activeIndex] ?? null;
  const nextActiveIndex = previousActive ? findMatchingAccountIndex(normalizedAccounts, previousActive) : -1;
  if (previousActive && nextActiveIndex < 0) {
    throw new Error("Account đang dùng đã bị xóa trên thiết bị khác. Hãy switch sang account khác rồi sync lại.");
  }
  const now = Date.now();

  const wroteRemote = !remoteFile
    || legacyEncryptedVault
    || syncRecordFingerprint(remotePayload.records) !== syncRecordFingerprint(mergedRecords);
  if (wroteRemote) {
    const payload = normalizeSyncPayload({ version: 1, updatedAt: now, records: mergedRecords });
    await client.writeVault(user.login, serializeJson(payload), { repo, path, sha: remoteFile?.sha ?? null });
  }

  storage.accounts = secureImportedLogins(normalizedAccounts);
  storage.activeIndex = nextActiveIndex >= 0 ? nextActiveIndex : 0;
  await writeSecretJson(ACCOUNTS_PATH, storage);

  const nextSettings = {
    ...settings,
    enabled: true,
    login: user.login,
    repo,
    file: path,
    legacyEncryptedPassphrase: null,
    tombstones: tombstonesFromRecords(mergedRecords),
    lastSyncAt: now,
  };
  await saveGithubSyncSettings(nextSettings);
  const status = githubSyncStatus(nextSettings, { authenticated: true, activeLogin: user.login });
  sendGithubSyncStatus(status);
  return {
    dashboard: await getDashboard(),
    status,
    accountCount: storage.accounts.length,
    wroteRemote,
  };
}

async function syncGithubSessions(options = {}) {
  if (githubSyncTask) return githubSyncTask;
  githubSyncTask = runGithubSync(options).finally(() => { githubSyncTask = null; });
  return githubSyncTask;
}

async function autoSyncGithubSessions() {
  const settings = await loadGithubSyncSettings();
  if (!settings.enabled) return null;
  try {
    await syncGithubSessions();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendGithubSyncStatus(githubSyncStatus(settings, { error: message }));
    return message;
  }
}

async function rememberAccountDeletion(account) {
  const settings = await loadGithubSyncSettings();
  const deletedAt = Date.now();
  settings.tombstones[accountSyncKey(account)] = deletedAt;
  await saveGithubSyncSettings(settings);
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
ipcMain.handle("github-sync:status", () => probeGithubSyncStatus());
ipcMain.handle("github-sync:login", () => loginGithub());
ipcMain.handle("github-sync:cancel-login", () => {
  const active = Boolean(githubLoginController);
  githubLoginController?.abort();
  return { cancelled: active };
});
ipcMain.handle("github-sync:copy-device-code", () => {
  if (!pendingGithubUserCode) throw new Error("Không có GitHub login code đang hoạt động.");
  clipboard.writeText(pendingGithubUserCode);
  return { copied: true };
});
ipcMain.handle("github-sync:connect", () => syncGithubSessions({ interactiveAuth: true }));
ipcMain.handle("github-sync:sync", () => syncGithubSessions({ interactiveAuth: true }));
ipcMain.handle("github-sync:auto", async () => {
  const syncWarning = await autoSyncGithubSessions();
  return { dashboard: await getDashboard(), status: await probeGithubSyncStatus(), syncWarning };
});
ipcMain.handle("github-sync:disconnect", async () => {
  const settings = await loadGithubSyncSettings();
  const nextSettings = clearGithubTokens({ ...settings, enabled: false, legacyEncryptedPassphrase: null, login: null });
  await saveGithubSyncSettings(nextSettings);
  const status = githubSyncStatus(nextSettings);
  sendGithubSyncStatus(status);
  return status;
});
ipcMain.handle("accounts:load", () => getDashboard());
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("app:check-for-updates", async () => {
  if (!appUpdaterController?.enabled) return { enabled: false };
  const status = await appUpdaterController.check();
  return { enabled: true, ...status };
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
  await restartCodex({
    beforeLaunch: async () => {
      storage.activeIndex = index;
      await syncAccountToCodex(account);
      await writeSecretJson(ACCOUNTS_PATH, storage);
    },
  });
  return getDashboard();
});
ipcMain.handle("accounts:relogin", async (_event, index) => {
  const storage = await loadStorage();
  const account = storage.accounts[index];
  if (!account) throw new Error("Account was not found.");
  return startBrowserLogin(savedLoginFor(account));
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
  const deletedAccount = storage.accounts[index];
  storage.accounts.splice(index, 1);
  if (storage.activeIndex > index) storage.activeIndex -= 1;
  await writeSecretJson(ACCOUNTS_PATH, storage);
  await rememberAccountDeletion(deletedAccount);
  const syncWarning = await autoSyncGithubSessions();
  return { dashboard: await getDashboard(), syncWarning };
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
  const bytes = await writeVerifiedExport(filePath, exportData);
  return { cancelled: false, count: storage.accounts.length, bytes };
});
ipcMain.handle("accounts:import", async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, { title: "Import Codex sessions", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (canceled || !filePaths[0]) return { cancelled: true };
  const exportData = JSON.parse(await fs.readFile(filePaths[0], "utf8"));
  if (exportData?.encrypted) {
    throw new Error("Password-protected export files are no longer supported. Export the sessions again as plain JSON.");
  }
  const importedAt = Date.now();
  const incoming = secureImportedLogins(
    assertImportShape(exportData, { allowSavedLogin: exportData?.version === 3 })
      .map((account) => ({ ...account, syncUpdatedAt: importedAt })),
  );
  const storage = await loadStorage();
  const merged = mergeImportedAccounts(storage.accounts, incoming);
  storage.accounts = merged.accounts;
  await writeSecretJson(ACCOUNTS_PATH, storage);
  const syncWarning = await autoSyncGithubSessions();
  return { cancelled: false, added: merged.added, updated: merged.updated, dashboard: await getDashboard(), syncWarning };
});

app.whenReady().then(() => {
  createWindow();
  appUpdaterController = startAppUpdater({
    app,
    updater: autoUpdater,
    dialog,
    getWindow: () => mainWindow,
    notify: sendLog,
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
