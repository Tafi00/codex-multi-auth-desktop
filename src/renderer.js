const $ = (selector) => document.querySelector(selector);
const body = $("#accountsBody");
const emptyState = $("#emptyState");
const summary = $("#summary");
const toast = $("#toast");
const dialog = $("#confirmDialog");
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
  body.innerHTML = accounts.map((account) => {
    const [tone, status] = statusFor(account);
    const displayName = account.email || account.label;
    return `<tr>
      <td><div class="account" title="${escapeHtml(displayName)}"><span class="account-name">${escapeHtml(displayName)}${account.current ? '<span class="current-pill">CURRENT</span>' : ""}</span></div></td>
      <td><span class="status ${tone}"><i class="dot"></i>${escapeHtml(status)}</span></td>
      <td>${quotaHtml(account.quota, "primary")}</td>
      <td>${quotaHtml(account.quota, "secondary")}</td>
      <td><div class="row-actions"><button class="button compact ${account.current ? "secondary" : "primary"}" data-switch="${account.index}" ${account.current ? "disabled" : ""}>${account.current ? "Đang chọn" : "Switch"}</button>${account.current ? "" : `<button class="icon-button" data-delete="${account.index}" aria-label="Remove ${escapeHtml(displayName)}" title="Remove account">×</button>`}</div></td>
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
    const message = error?.message || String(error);
    showToast(message, "error");
  } finally {
    setBusy(false);
  }
}

async function handleLogin() {
  if (loginInProgress) {
    await window.codexAuth.cancelLogin();
    return;
  }
  loginInProgress = true;
  loginButton.textContent = "Cancel login";
  setBusy(true);
  try {
    const result = await window.codexAuth.login();
    if (result?.dashboard) render(result.dashboard);
    showToast("Đăng nhập thành công.", "success");
  } catch (error) {
    const message = error?.message || String(error);
    showToast(message, "error");
  } finally {
    loginInProgress = false;
    loginButton.textContent = "+ Login account";
    setBusy(false);
  }
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
  const result = await run(() => window.codexAuth.exportSessions(), "Đã export sessions.");
});
$("#importButton").addEventListener("click", async () => {
  const approved = await confirmAction("Import sessions?", "Chỉ import file do bạn export. Account trùng sẽ được bỏ qua; account hiện tại được giữ nguyên.");
  if (!approved) return;
  const result = await run(() => window.codexAuth.importSessions(), "Đã import sessions.");
});
body.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-switch], [data-delete]");
  if (!button) return;
  const index = Number(button.dataset.switch ?? button.dataset.delete);
  const account = dashboard.accounts.find((item) => item.index === index);
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
