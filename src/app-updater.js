const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function startAppUpdater({
  app,
  updater,
  dialog,
  getWindow,
  notify = () => undefined,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
}) {
  if (!app.isPackaged) return { enabled: false, stop: () => undefined };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let updatePromptOpen = false;
  let checkInProgress = false;

  const onChecking = () => notify("Đang kiểm tra bản cập nhật...");
  const onAvailable = (info) => notify(`Đã tìm thấy bản ${info.version}, đang tải xuống...`);
  const onNotAvailable = () => notify("Ứng dụng đang ở phiên bản mới nhất.");
  const onError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    notify(`Không thể cập nhật tự động: ${message}`, "error");
  };
  const onDownloaded = async (info) => {
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
      if (result.response === 0) updater.quitAndInstall(false, true);
    } catch (error) {
      onError(error);
    } finally {
      updatePromptOpen = false;
    }
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
      updater.removeListener("checking-for-update", onChecking);
      updater.removeListener("update-available", onAvailable);
      updater.removeListener("update-not-available", onNotAvailable);
      updater.removeListener("update-downloaded", onDownloaded);
      updater.removeListener("error", onError);
    },
  };
}
