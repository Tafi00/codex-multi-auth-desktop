import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startAppUpdater } from "./app-updater.js";

test("updater is disabled for development builds", () => {
  const updater = new EventEmitter();
  const result = startAppUpdater({ app: { isPackaged: false }, updater });
  assert.equal(result.enabled, false);
  assert.equal(updater.listenerCount("update-downloaded"), 0);
});

test("downloaded update can restart and install", async () => {
  const updater = new EventEmitter();
  let checks = 0;
  updater.checkForUpdates = async () => { checks += 1; };
  let installArguments = null;
  updater.quitAndInstall = (...args) => { installArguments = args; };
  const result = startAppUpdater({
    app: { isPackaged: true },
    updater,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    getWindow: () => null,
    checkIntervalMs: 60_000,
    downloadedPromptDelayMs: 0,
  });

  updater.emit("update-downloaded", { version: "1.2.3" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(installArguments, [false, true]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  await result.check();
  assert.equal(checks, 1);
  result.stop();
});

test("a signature error cancels the downloaded update prompt", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => undefined;
  updater.quitAndInstall = () => assert.fail("invalid update must not be installed");
  let prompts = 0;
  const notifications = [];
  const result = startAppUpdater({
    app: { isPackaged: true },
    updater,
    dialog: { showMessageBox: async () => { prompts += 1; return { response: 0 }; } },
    getWindow: () => null,
    notify: (...args) => notifications.push(args),
    checkIntervalMs: 60_000,
    downloadedPromptDelayMs: 20,
  });

  updater.emit("update-downloaded", { version: "1.2.3" });
  updater.emit("error", new Error("code signature did not pass validation"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts, 0);
  assert.equal(notifications.at(-1)?.[1], "error");
  result.stop();
});
