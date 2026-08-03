import { parseLoginCredentials } from "./login-credentials.js";
import { createAutoRefreshScheduler } from "./auto-refresh-scheduler.js";

const $ = (selector) => document.querySelector(selector);
const body = $("#accountsBody");
const emptyState = $("#emptyState");
const summary = $("#summary");
const toast = $("#toast");
const dialog = $("#confirmDialog");
const loginDialog = $("#loginDialog");
const loginForm = $("#loginForm");
let dashboard = { accounts: [] };
let busy = false;
let loginInProgress = false;
const loginButton = $("#loginButton");
const STARTUP_AUTO_REFRESH_SETUP_DELAY_MS = 2_500;
const AUTO_REFRESH_TICK_MS = 5_000;
const CURRENT_ACCOUNT_REFRESH_MS = 60_000;
const FULL_ACCOUNT_REFRESH_MS = 10 * 60_000;
let autoRefreshScheduler = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function resetLabel(timestamp) {
  if (!timestamp) return "—";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "resetting";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${restMinutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function quotaHtml(quota, type) {
  const used = type === "primary" ? quota?.primaryUsedPercent : quota?.secondaryUsedPercent;
  const reset = type === "primary" ? quota?.primaryResetAtMs : quota?.secondaryResetAtMs;
  if (!quota) return '<span class="muted">Chưa kiểm tra</span>';
  if (used === null || used === undefined) return '<span class="muted">Unlimited</span>';
  const usedPercent = Math.max(0, Math.min(100, used));
  const remainingPercent = 100 - usedPercent;
  const tone = remainingPercent < 30 ? "danger" : remainingPercent <= 70 ? "warning" : "";
  return `<div class="quota"><progress class="meter ${tone}" value="${remainingPercent}" max="100" aria-label="${type === "primary" ? "5 hour" : "Weekly"}: ${remainingPercent.toFixed(0)}% remaining"></progress><div class="quota-line"><strong>${escapeHtml(remainingPercent.toFixed(0))}%</strong><span>resets in ${escapeHtml(resetLabel(reset))}</span></div></div>`;
}

function statusFor(account) {
  const markers = account.markers ?? [];
  if (!account.enabled || markers.some((marker) => marker.includes("quota-exhausted") || marker.includes("rate-limited"))) return ["offline", "Hết quota / giới hạn"];
  if (markers.some((marker) => marker.includes("cooldown"))) return ["warning", "Đang chờ cooldown"];
  return ["ready", account.current ? "Đang sử dụng" : "Sẵn sàng"];
}

function render(data) {
  dashboard = data;
  const accounts = data.accounts ?? [];
  summary.textContent = accounts.length ? `${accounts.length} accounts` : "No accounts";
  body.innerHTML = accounts.map((account, accountPosition) => {
    const [tone, status] = statusFor(account);
    const displayName = account.email || account.label;
    const plan = account.planType ? `<span class="account-plan">${escapeHtml(account.planType)}</span>` : "";
    const current = account.current ? '<span class="current-pill">CURRENT</span>' : "";
    const accountMeta = plan || current ? `<span class="account-meta">${plan}${current}</span>` : "";
    const copyMenuPosition = accountPosition >= accounts.length - 2 ? "above" : "";
    const savedLoginActions = account.hasSavedLogin
      ? `<button class="icon-button action-icon" data-relogin="${account.index}" aria-label="Sign in again with saved credentials" title="Sign in again">↻</button><details class="copy-menu ${copyMenuPosition}"><summary class="icon-button action-icon" aria-label="Copy login details" title="Copy login details">⧉</summary><div class="copy-popover"><button data-copy="email" data-index="${account.index}">Copy email</button><button data-copy="password" data-index="${account.index}">Copy password</button><button data-copy="totp" data-index="${account.index}">Copy 2FA code</button></div></details>`
      : `<button class="icon-button action-icon" disabled aria-label="Login details were not saved for this account" title="Login details were not saved">↻</button>`;
    const switchLabel = account.current ? "Đang chọn" : "Switch";
    const deleteButton = account.current ? "" : `<button class="icon-button" data-delete="${account.index}" aria-label="Remove ${escapeHtml(displayName)}" title="Remove account">×</button>`;
    return `<tr>
      <td><div class="account" title="${escapeHtml(displayName)}"><span class="account-name">${escapeHtml(displayName)}</span>${accountMeta}</div></td>
      <td><span class="status ${tone}"><i class="dot"></i>${escapeHtml(status)}</span></td>
      <td>${quotaHtml(account.quota, "primary")}</td>
      <td>${quotaHtml(account.quota, "secondary")}</td>
      <td><div class="row-actions"><button class="button compact ${account.current ? "secondary" : "primary"}" data-switch="${account.index}" ${account.current ? "disabled" : ""}>${switchLabel}</button>${savedLoginActions}${deleteButton}</div></td>
    </tr>`;
  }).join("");
  emptyState.hidden = accounts.length > 0;
}

let toastTimer;
function showToast(message, type = "") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function setBusy(next) {
  busy = next;
  document.querySelectorAll("button").forEach((button) => { if (!button.matches("#clearLogButton")) button.disabled = next; });
  if (loginInProgress) loginButton.disabled = false;
}

function confirmAction(title, message) {
  $("#dialogTitle").textContent = title;
  $("#dialogMessage").textContent = message;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function promptLoginCredentials() {
  loginForm.reset();
  loginDialog.showModal();
  return new Promise((resolve) => {
    loginDialog.addEventListener("close", () => {
      const rawCredentials = loginDialog.returnValue === "confirm" ? $("#loginCredentials").value : null;
      loginForm.reset();
      resolve(rawCredentials);
    }, { once: true });
  });
}

async function run(action, successMessage) {
  if (busy) return;
  setBusy(true);
  try {
    const result = await action();
    if (result?.dashboard) render(result.dashboard);
    else if (result?.accounts) render(result);
    const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
    if (message) showToast(message, "success");
    return result;
  } catch (error) {
    showToast(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function runLogin(action) {
  if (loginInProgress) {
    await window.codexAuth.cancelLogin();
    return;
  }
  loginInProgress = true;
  loginButton.textContent = "Cancel login";
  setBusy(true);
  try {
    const result = await action();
    if (result?.dashboard) render(result.dashboard);
    showToast("Đăng nhập thành công.", "success");
  } catch (error) {
    showToast(error?.message || String(error), "error");
  } finally {
    loginInProgress = false;
    loginButton.textContent = "+ Login account";
    setBusy(false);
  }
}

async function handleLogin() {
  const rawCredentials = await promptLoginCredentials();
  if (!rawCredentials) return;
  let credentials;
  try {
    credentials = parseLoginCredentials(rawCredentials);
  } catch (error) {
    showToast(error?.message || String(error), "error");
    return;
  }
  await runLogin(() => window.codexAuth.login(credentials));
}

loginButton.addEventListener("click", handleLogin);
$("#refreshButton").addEventListener("click", async () => {
  const result = await run(() => window.codexAuth.refreshQuota(), "Đã cập nhật quota.");
  if (result?.probeErrors?.length) showToast(`Đã cập nhật; ${result.probeErrors.length} account không thể kiểm tra.`, "error");
});

async function refreshQuotaInBackground() {
  if (busy) return;
  try {
    const result = await window.codexAuth.refreshQuota();
    if (result?.dashboard) render(result.dashboard);
  } catch {
    // Keep the last known quota visible; the next 5-minute pass will retry.
  }
}

async function refreshCurrentQuotaInBackground() {
  if (busy) return;
  try {
    const result = await window.codexAuth.refreshCurrentQuota();
    if (result?.dashboard) render(result.dashboard);
  } catch {
    // Keep cached quota visible; the scheduler will retry on the next interval.
  }
}

function startAutoRefreshScheduler() {
  autoRefreshScheduler?.stop();
  autoRefreshScheduler = createAutoRefreshScheduler([
    {
      key: "full:codex",
      label: "Codex full quota refresh",
      intervalMs: FULL_ACCOUNT_REFRESH_MS,
      run: refreshQuotaInBackground,
    },
    {
      key: "current:codex",
      label: "Codex current account quota refresh",
      intervalMs: CURRENT_ACCOUNT_REFRESH_MS,
      run: refreshCurrentQuotaInBackground,
    },
  ], {
    tickMs: AUTO_REFRESH_TICK_MS,
    maxConcurrent: 1,
  });
  autoRefreshScheduler.start();
}

const smsDialog = $("#smsDialog");
const smsForm = $("#smsForm");
const smsCountry = $("#smsCountry");
const smsCountrySearch = $("#smsCountrySearch");
const smsCountryCombobox = $("#smsCountryCombobox");
const smsCountryOptions = $("#smsCountryOptions");
let smsCountryOffers = [];
let highlightedCountryIndex = -1;
let smsCountryQuery = "";

function applySmsSettings(settings) {
  $("#smsEnabled").checked = Boolean(settings.enabled);
  smsCountryOffers = [];
  setSelectedSmsCountry(settings.country);
  $("#smsApiKey").value = "";
  $("#smsApiKey").placeholder = settings.hasApiKey
    ? "Đã lưu key — để trống nếu không đổi"
    : "Dán API key HeroSMS";
  $("#smsBalanceValue").textContent = "—";
}

function formatSmsPrice(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function smsCountryLabel(offer) {
  return offer
    ? `${offer.name} · ${formatSmsPrice(offer.price)}`
    : `Country ID ${smsCountry.value}`;
}

function setSelectedSmsCountry(countryId) {
  smsCountry.value = String(countryId ?? "");
  const offer = smsCountryOffers.find((item) => item.id === smsCountry.value);
  smsCountrySearch.value = smsCountryLabel(offer);
}

function filteredSmsCountries(query = "") {
  const normalized = String(query).trim().toLowerCase();
  if (!normalized) return smsCountryOffers;
  return smsCountryOffers.filter((offer) =>
    `${offer.name} ${offer.id} ${formatSmsPrice(offer.price)}`.toLowerCase().includes(normalized)
  );
}

function closeSmsCountryDropdown({ restoreSelection = false } = {}) {
  smsCountryOptions.hidden = true;
  smsCountrySearch.setAttribute("aria-expanded", "false");
  smsCountrySearch.removeAttribute("aria-activedescendant");
  highlightedCountryIndex = -1;
  smsCountryQuery = "";
  if (restoreSelection) setSelectedSmsCountry(smsCountry.value);
}

function renderSmsCountryOptions(query = smsCountryQuery) {
  smsCountryQuery = query;
  const offers = filteredSmsCountries(query);
  highlightedCountryIndex = Math.min(highlightedCountryIndex, offers.length - 1);
  smsCountryOptions.replaceChildren();
  if (!offers.length) {
    const empty = document.createElement("div");
    empty.className = "country-options-empty";
    empty.textContent = "Không tìm thấy quốc gia";
    smsCountryOptions.append(empty);
  } else {
    offers.forEach((offer, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "country-option";
      option.dataset.countryId = offer.id;
      option.id = `sms-country-option-${offer.id}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(offer.id === smsCountry.value));
      if (index === highlightedCountryIndex) option.classList.add("highlighted");

      const identity = document.createElement("span");
      identity.className = "country-option-identity";
      const name = document.createElement("strong");
      name.textContent = offer.name;
      const id = document.createElement("small");
      id.textContent = `ID ${offer.id}`;
      identity.append(name, id);

      const details = document.createElement("span");
      details.className = "country-option-details";
      const price = document.createElement("strong");
      price.textContent = formatSmsPrice(offer.price);
      const stock = document.createElement("small");
      stock.textContent = `${offer.count} số`;
      details.append(price, stock);
      option.append(identity, details);
      smsCountryOptions.append(option);
    });
  }
  smsCountryOptions.hidden = false;
  smsCountrySearch.setAttribute("aria-expanded", "true");
  const highlighted = smsCountryOptions.querySelector(".highlighted");
  if (highlighted) smsCountrySearch.setAttribute("aria-activedescendant", highlighted.id);
  else smsCountrySearch.removeAttribute("aria-activedescendant");
  if (!query && highlightedCountryIndex < 0) {
    smsCountryOptions.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  return offers;
}

function chooseSmsCountry(countryId) {
  setSelectedSmsCountry(countryId);
  closeSmsCountryDropdown();
  smsCountrySearch.focus();
}

async function loadSmsCountryOffers(selectedCountry = smsCountry.value) {
  smsCountrySearch.disabled = true;
  smsCountrySearch.placeholder = "Đang tải quốc gia và giá…";
  try {
    const { offers } = await window.codexAuth.listSmsCountries({
      apiKey: $("#smsApiKey").value,
    });
    smsCountryOffers = offers;
    const nextCountry = offers.some((offer) => offer.id === selectedCountry)
      ? selectedCountry
      : (selectedCountry || offers[0]?.id || "");
    setSelectedSmsCountry(nextCountry);
  } catch (error) {
    showToast(error?.message || String(error), "error");
  } finally {
    smsCountrySearch.disabled = false;
    smsCountrySearch.placeholder = "Tìm quốc gia…";
  }
}

function readSmsForm() {
  return {
    enabled: $("#smsEnabled").checked,
    apiKey: $("#smsApiKey").value,
    country: smsCountry.value,
  };
}

$("#smsSettingsButton").addEventListener("click", async () => {
  let settings;
  try {
    settings = await window.codexAuth.loadSmsSettings();
    applySmsSettings(settings);
  } catch (error) {
    showToast(error?.message || String(error), "error");
    return;
  }
  smsDialog.showModal();
  void checkSmsApiKey();
});

async function checkSmsApiKey() {
  const button = $("#smsTestButton");
  const balance = $("#smsBalanceValue");
  button.disabled = true;
  balance.textContent = "…";
  try {
    const result = await window.codexAuth.testSmsSettings(readSmsForm());
    balance.textContent = formatSmsPrice(result.balance);
    void loadSmsCountryOffers(smsCountry.value);
  } catch (error) {
    balance.textContent = "Invalid";
    showToast(error?.message || String(error), "error");
  } finally {
    button.disabled = false;
  }
}

$("#smsTestButton").addEventListener("click", checkSmsApiKey);

smsCountrySearch.addEventListener("focus", () => {
  smsCountrySearch.select();
  renderSmsCountryOptions("");
});

smsCountrySearch.addEventListener("click", () => {
  if (smsCountryOptions.hidden) renderSmsCountryOptions();
});

smsCountrySearch.addEventListener("input", () => {
  highlightedCountryIndex = -1;
  renderSmsCountryOptions(smsCountrySearch.value);
});

smsCountrySearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSmsCountryDropdown({ restoreSelection: true });
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  const offers = filteredSmsCountries(smsCountryOptions.hidden ? "" : smsCountryQuery);
  if (!offers.length) return;
  event.preventDefault();
  if (event.key === "Enter") {
    const offer = offers[Math.max(0, highlightedCountryIndex)];
    if (offer) chooseSmsCountry(offer.id);
    return;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  highlightedCountryIndex = (highlightedCountryIndex + direction + offers.length) % offers.length;
  renderSmsCountryOptions(smsCountryOptions.hidden ? "" : smsCountryQuery);
  smsCountryOptions.querySelector(".highlighted")?.scrollIntoView({ block: "nearest" });
});

smsCountryOptions.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

smsCountryOptions.addEventListener("click", (event) => {
  const option = event.target.closest("[data-country-id]");
  if (option) chooseSmsCountry(option.dataset.countryId);
});

document.addEventListener("click", (event) => {
  if (!smsCountryCombobox.contains(event.target)) closeSmsCountryDropdown({ restoreSelection: true });
});

smsDialog.addEventListener("close", async () => {
  closeSmsCountryDropdown();
  if (smsDialog.returnValue !== "confirm") return;
  const input = readSmsForm();
  smsForm.reset();
  try {
    await window.codexAuth.saveSmsSettings(input);
    showToast("Đã lưu cấu hình phone verification.", "success");
  } catch (error) {
    showToast(error?.message || String(error), "error");
  }
});

window.codexAuth.onLog((entry) => {
  if (entry?.message) showToast(entry.message, entry.tone || "");
});

$("#exportButton").addEventListener("click", async () => {
  const approved = await confirmAction("Export sessions?", "File JSON không mã hóa sẽ chứa refresh token và thông tin đăng nhập đã lưu. Chỉ lưu và chuyển qua kênh bạn tin cậy.");
  if (!approved) return;
  await run(() => window.codexAuth.exportSessions(), "Đã export sessions.");
});

$("#importButton").addEventListener("click", async () => {
  const approved = await confirmAction("Import sessions?", "Chỉ import file JSON do bạn tin cậy. Account trùng sẽ được cập nhật bằng dữ liệu trong file; account hiện tại vẫn được giữ làm account đang chọn.");
  if (!approved) return;
  await run(
    () => window.codexAuth.importSessions(),
    (result) => `Đã import: ${result?.added ?? 0} account mới, ${result?.updated ?? 0} account được cập nhật.`,
  );
});

body.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-switch], [data-delete], [data-relogin], [data-copy]");
  if (!button) return;
  const index = Number(button.dataset.switch ?? button.dataset.delete ?? button.dataset.relogin ?? button.dataset.index);
  const account = dashboard.accounts.find((item) => item.index === index);
  if (button.dataset.copy) {
    const field = button.dataset.copy;
    const label = { email: "Email", password: "Password", totp: "2FA code" }[field] || "Value";
    await run(() => window.codexAuth.copyLogin(index, field), `${label} copied.`);
    button.closest(".copy-menu")?.removeAttribute("open");
    return;
  }
  if (button.dataset.relogin !== undefined) {
    await runLogin(() => window.codexAuth.relogin(index));
    return;
  }
  if (button.dataset.delete !== undefined) {
    const approved = await confirmAction("Remove account?", `Session của ${account?.email || account?.label || `account ${index + 1}`} sẽ bị xóa khỏi máy này.`);
    if (approved) await run(() => window.codexAuth.deleteAccount(index), "Đã xóa account.");
    return;
  }
  const approved = await confirmAction(
    "Switch account?",
    `Codex sẽ đóng và mở lại với ${account?.email || account?.label || `account ${index + 1}`}. Task Codex đang chạy sẽ bị dừng.`,
  );
  if (approved) await run(() => window.codexAuth.switchAccount(index), "Đã switch account và mở lại Codex.");
});

async function startDashboard() {
  await run(() => window.codexAuth.load(), "");
  void refreshQuotaInBackground();
  window.setTimeout(startAutoRefreshScheduler, STARTUP_AUTO_REFRESH_SETUP_DELAY_MS);
}

startDashboard();
