const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_DOWNLOADED_PROMPT_DELAY_MS = 2_500;
const DEFAULT_INSTALL_DELAY_MS = 150;

export function startAppUpdater({
  app,
  updater,
  dialog,
  getWindow,
  notify = () => undefined,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  downloadedPromptDelayMs = DEFAULT_DOWNLOADED_PROMPT_DELAY_MS,
  installDelayMs = DEFAULT_INSTALL_DELAY_MS,
}) {
  if (!app.isPackaged) return { enabled: false, stop: () => undefined };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let updatePromptOpen = false;
  let updatePromptTimer = null;
  let checkInProgress = false;

  const onChecking = () => notify("Đang kiểm tra bản cập nhật...");
  const onAvailable = (info) => notify(`Đã tìm thấy bản ${info.version}, đang tải xuống...`);
  const onNotAvailable = () => notify("Ứng dụng đang ở phiên bản mới nhất.");
  const onError = (error) => {
    if (updatePromptTimer) {
      clearTimeout(updatePromptTimer);
      updatePromptTimer = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    notify(`Không thể cập nhật tự động: ${message}`, "error");
  };
  const showDownloadedPrompt = async (info) => {
    updatePromptTimer = null;
    notify(`Đã tải xong bản ${info.version}.`);
    if (updatePromptOpen) return;
    updatePromptOpen = true;
    try {
      const options = {
        type: "info",
        title: "Cập nhật đã sẵn sàng",
        message: `Codex Multi Auth ${info.version} đã được tải xuống.`,
        detail: "Khởi động lại ứng dụng để cài bản mới ngay bây giờ.",
        buttons: ["Khởi động lại và cập nhật", "Để sau"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const parent = getWindow?.();
      const result = parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) {
        // Hide first so the transition feels immediate and macOS never has a
        // stale app window to redraw while Squirrel replaces the bundle.
        if (parent && !parent.isDestroyed()) parent.hide();
        setTimeout(() => {
          try {
            updater.quitAndInstall(true, true);
          } catch (error) {
            if (parent && !parent.isDestroyed()) parent.show();
            onError(error);
          }
        }, installDelayMs);
      }
    } catch (error) {
      onError(error);
    } finally {
      updatePromptOpen = false;
    }
  };
  const onDownloaded = (info) => {
    if (updatePromptTimer || updatePromptOpen) return;
    // Squirrel.Mac emits update-downloaded shortly before it finishes code
    // signature validation. Give it time to report a validation error so the
    // app never offers to install an update that macOS has already rejected.
    updatePromptTimer = setTimeout(
      () => void showDownloadedPrompt(info),
      downloadedPromptDelayMs,
    );
    updatePromptTimer.unref?.();
  };

  updater.on("checking-for-update", onChecking);
  updater.on("update-available", onAvailable);
  updater.on("update-not-available", onNotAvailable);
  updater.on("update-downloaded", onDownloaded);
  updater.on("error", onError);

  const check = async () => {
    if (checkInProgress) return { checking: true };
    checkInProgress = true;
    try {
      const result = await updater.checkForUpdates();
      return { checking: false, result };
    } catch (error) {
      onError(error);
      return { checking: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      checkInProgress = false;
    }
  };

  const firstCheck = setTimeout(() => void check(), 3_000);
  const interval = setInterval(() => void check(), checkIntervalMs);
  firstCheck.unref?.();
  interval.unref?.();

  return {
    enabled: true,
    check,
    stop() {
      clearTimeout(firstCheck);
      clearInterval(interval);
      if (updatePromptTimer) clearTimeout(updatePromptTimer);
      updater.removeListener("checking-for-update", onChecking);
      updater.removeListener("update-available", onAvailable);
      updater.removeListener("update-not-available", onNotAvailable);
      updater.removeListener("update-downloaded", onDownloaded);
      updater.removeListener("error", onError);
    },
  };
}
