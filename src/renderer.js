import { parseLoginCredentials } from "./login-credentials.js";

const $ = (selector) => document.querySelector(selector);
const body = $("#accountsBody");
const emptyState = $("#emptyState");
const summary = $("#summary");
const toast = $("#toast");
const dialog = $("#confirmDialog");
const loginDialog = $("#loginDialog");
const loginForm = $("#loginForm");
const transferDialog = $("#transferDialog");
const transferForm = $("#transferForm");
let dashboard = { accounts: [] };
let busy = false;
let loginInProgress = false;
const loginButton = $("#loginButton");
const AUTO_REFRESH_MS = 5 * 60 * 1000;

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
  if (used === null || used === undefined) return '<span class="muted">Chưa kiểm tra</span>';
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
    const copyMenuPosition = accountPosition >= accounts.length - 2 ? "above" : "";
    const savedLoginActions = account.hasSavedLogin
      ? `<button class="icon-button action-icon" data-relogin="${account.index}" aria-label="Sign in again with saved credentials" title="Sign in again">↻</button><details class="copy-menu ${copyMenuPosition}"><summary class="icon-button action-icon" aria-label="Copy login details" title="Copy login details">⧉</summary><div class="copy-popover"><button data-copy="email" data-index="${account.index}">Copy email</button><button data-copy="password" data-index="${account.index}">Copy password</button><button data-copy="totp" data-index="${account.index}">Copy 2FA code</button></div></details>`
      : `<button class="icon-button action-icon" disabled aria-label="Login details were not saved for this account" title="Login details were not saved">↻</button>`;
    const switchLabel = account.current ? "Đang chọn" : "Switch";
    const deleteButton = account.current ? "" : `<button class="icon-button" data-delete="${account.index}" aria-label="Remove ${escapeHtml(displayName)}" title="Remove account">×</button>`;
    return `<tr>
      <td><div class="account" title="${escapeHtml(displayName)}"><span class="account-name">${escapeHtml(displayName)}${account.current ? '<span class="current-pill">CURRENT</span>' : ""}</span></div></td>
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

function promptTransferPassword(mode) {
  const exporting = mode === "export";
  const password = $("#transferPassword");
  const passwordConfirm = $("#transferPasswordConfirm");
  $("#transferTitle").textContent = exporting ? "Export protected file" : "Import protected file";
  $("#transferMessage").textContent = exporting
    ? "Choose a password to encrypt the exported sessions and saved login details. This password cannot be recovered."
    : "Enter the password used to encrypt this export file.";
  $("#transferPasswordLabel").textContent = exporting ? "Export password" : "Export password";
  $("#transferSubmit").textContent = exporting ? "Export encrypted file" : "Import encrypted file";
  $("#transferConfirmField").hidden = !exporting;
  password.autocomplete = exporting ? "new-password" : "current-password";
  passwordConfirm.required = exporting;
  transferForm.reset();
  transferDialog.showModal();
  return new Promise((resolve) => {
    transferDialog.addEventListener("close", () => {
      const result = transferDialog.returnValue === "confirm" ? { password: password.value, passwordConfirm: passwordConfirm.value } : null;
      transferForm.reset();
      resolve(result);
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
    if (successMessage) showToast(successMessage, "success");
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

$("#exportButton").addEventListener("click", async () => {
  const approved = await confirmAction("Export sessions?", "File export có thể đăng nhập các account này trên thiết bị khác. Chỉ lưu và chuyển qua kênh bạn tin cậy.");
  if (!approved) return;
  const credentials = await promptTransferPassword("export");
  if (!credentials) return;
  if (credentials.password !== credentials.passwordConfirm) {
    showToast("Export passwords do not match.", "error");
    return;
  }
  await run(() => window.codexAuth.exportSessions(credentials.password), "Đã export sessions.");
});

$("#importButton").addEventListener("click", async () => {
  const approved = await confirmAction("Import sessions?", "Chỉ import file do bạn export. Account trùng sẽ được bỏ qua; account hiện tại được giữ nguyên.");
  if (!approved) return;
  const credentials = await promptTransferPassword("import");
  if (!credentials) return;
  await run(() => window.codexAuth.importSessions(credentials.password), "Đã import sessions.");
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
  const approved = await confirmAction("Switch account?", `Codex sẽ đóng và mở lại với ${account?.email || account?.label || `account ${index + 1}`}.`);
  if (approved) await run(() => window.codexAuth.switchAccount(index), "Đã switch account và mở lại Codex.");
});

async function startDashboard() {
  await run(() => window.codexAuth.load(), "");
  window.setInterval(refreshQuotaInBackground, AUTO_REFRESH_MS);
}

startDashboard();
