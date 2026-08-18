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
  });

  updater.emit("update-downloaded", { version: "1.2.3" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(installArguments, [false, true]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  await result.check();
  assert.equal(checks, 1);
  result.stop();
});
