import assert from "node:assert/strict";
import test from "node:test";

import { restartCodex } from "./codex-process.js";

test("restarts Codex with the macOS application commands", async () => {
  const calls = [];
  const pauses = [];
  await restartCodex({
    platform: "darwin",
    run: async (...args) => { calls.push(args); },
    pause: async (milliseconds) => { pauses.push(milliseconds); },
  });

  assert.deepEqual(calls, [
    ["osascript", ["-e", 'tell application "Codex" to quit']],
    ["open", ["-a", "Codex"]],
  ]);
  assert.deepEqual(pauses, [700]);
});

test("restarts Codex through PowerShell on Windows", async () => {
  const calls = [];
  await restartCodex({
    platform: "win32",
    run: async (...args) => { calls.push(args); },
  });

  assert.equal(calls.length, 1);
  const [file, args, options] = calls[0];
  assert.equal(file, "powershell.exe");
  assert.ok(args.includes("-NoProfile"));
  assert.ok(args.includes("-NonInteractive"));
  const script = args.at(-1);
  assert.match(script, /Get-Process -Name 'Codex'/);
  assert.match(script, /Stop-Process -Force/);
  assert.match(script, /Get-StartApps/);
  assert.match(script, /shell:AppsFolder/);
  assert.match(script, /\^\(OpenAI\\s\+\)\?Codex\$/);
  assert.match(script, /-notmatch '\\\\WindowsApps\\\\'/);
  assert.ok(script.indexOf("Get-StartApps") < script.indexOf("$knownPaths ="));
  assert.deepEqual(options, { windowsHide: true, timeout: 20_000 });
});

test("returns a useful error when Windows restart fails", async () => {
  await assert.rejects(
    restartCodex({
      platform: "win32",
      run: async () => {
        const error = new Error("PowerShell failed");
        error.stderr = "Codex executable was not found";
        throw error;
      },
    }),
    /Could not restart Codex on Windows: Codex executable was not found/,
  );
});

test("does not silently claim restart support on other platforms", async () => {
  await assert.rejects(restartCodex({ platform: "linux" }), /not supported on linux/);
});
