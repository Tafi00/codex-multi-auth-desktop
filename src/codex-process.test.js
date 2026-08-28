import assert from "node:assert/strict";
import test from "node:test";

import { restartCodex } from "./codex-process.js";

test("restarts Codex with the macOS application commands", async () => {
  const calls = [];
  let running = true;
  const run = async (...args) => {
    calls.push(args);
    if (args[0] === "pgrep") return { stdout: running ? "123\n" : "" };
    if (args[0] === "osascript") running = false;
    if (args[0] === "kill" && args[1][0] === "-0" && !running) throw new Error("not running");
    if (args[0] === "open") running = true;
  };
  await restartCodex({
    platform: "darwin",
    run,
    pause: async () => undefined,
  });

  assert.deepEqual(calls, [
    ["pgrep", ["-f", "(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)"]],
    ["osascript", [
      "-e",
      'tell application "System Events" to set frontmost of (first process whose unix id is 123) to true',
      "-e",
      'tell application "System Events" to keystroke "q" using command down',
    ]],
    ["kill", ["-0", "123"]],
    ["open", ["-a", "Codex"]],
    ["pgrep", ["-f", "(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)"]],
  ]);
});

test("captures credentials before stopping Codex", async () => {
  const order = [];
  let running = true;
  const run = async (...args) => {
    if (args[0] === "pgrep") return { stdout: running ? "123\n" : "" };
    if (args[0] === "osascript") running = false;
    if (args[0] === "kill" && args[1][0] === "-0" && !running) throw new Error("not running");
    if (args[0] === "open") running = true;
    order.push(args[0]);
  };

  await restartCodex({
    platform: "darwin",
    run,
    pause: async () => undefined,
    beforeStop: async () => { order.push("beforeStop"); },
    beforeLaunch: async () => { order.push("beforeLaunch"); },
  });

  assert.equal(order[0], "beforeStop");
  assert.ok(order.indexOf("beforeLaunch") < order.indexOf("open"));
});

test("accepts Codex's running-task quit confirmation before terminating it", async () => {
  const calls = [];
  let running = true;
  let checksAfterQuit = 0;
  const run = async (...args) => {
    calls.push(args);
    if (args[0] === "pgrep") {
      return { stdout: running ? "234\n" : "" };
    }
    if (args[0] === "kill" && args[1][0] === "-0") {
      checksAfterQuit += 1;
      if (!running) throw new Error("not running");
    }
    if (args[0] === "osascript" && args[1].some((value) => value.includes?.('click button "Quit"'))) {
      running = false;
    }
    if (args[0] === "open") running = true;
  };

  await restartCodex({
    platform: "darwin",
    run,
    pause: async () => undefined,
  });

  assert.ok(checksAfterQuit > 1);
  assert.ok(calls.some(([file, args]) => file === "osascript" && args.some((value) => value.includes?.('click button "Quit"'))));
  assert.ok(!calls.some(([file, args]) => file === "kill" && args[0] === "-15"));
  assert.ok(!calls.some(([file, args]) => file === "kill" && args[0] === "-9"));
  const quitIndex = calls.findIndex(([file, args]) => file === "osascript" && args.some((value) => value.includes?.('click button "Quit"')));
  const openIndex = calls.findIndex(([file]) => file === "open");
  assert.ok(quitIndex >= 0 && openIndex > quitIndex);
});

test("uses Cockpit's SIGTERM fallback when the quit confirmation cannot be automated", async () => {
  const calls = [];
  let running = true;
  const run = async (...args) => {
    calls.push(args);
    if (args[0] === "pgrep") return { stdout: running ? "235\n" : "" };
    if (args[0] === "kill" && args[1][0] === "-0" && !running) throw new Error("not running");
    if (args[0] === "kill" && args[1][0] === "-15") running = false;
    if (args[0] === "open") running = true;
  };

  await restartCodex({
    platform: "darwin",
    run,
    pause: async () => undefined,
  });

  assert.ok(calls.some(([file, args]) => file === "osascript" && args.some((value) => value.includes?.('click button "Quit"'))));
  assert.ok(calls.some(([file, args]) => file === "kill" && args[0] === "-15"));
  assert.ok(!calls.some(([file, args]) => file === "kill" && args[0] === "-9"));
});

test("force kills Codex only when graceful termination also stalls", async () => {
  const calls = [];
  let running = true;
  const run = async (...args) => {
    calls.push(args);
    if (args[0] === "pgrep") return { stdout: running ? "345\n" : "" };
    if (args[0] === "kill" && args[1][0] === "-0" && !running) throw new Error("not running");
    if (args[0] === "kill" && args[1][0] === "-9") running = false;
    if (args[0] === "open") running = true;
  };

  await restartCodex({
    platform: "darwin",
    run,
    pause: async () => undefined,
  });

  assert.ok(calls.some(([file, args]) => file === "kill" && args[0] === "-15"));
  assert.ok(calls.some(([file, args]) => file === "kill" && args[0] === "-9"));
});

test("restarts Codex through PowerShell on Windows", async () => {
  const calls = [];
  const order = [];
  await restartCodex({
    platform: "win32",
    run: async (...args) => {
      calls.push(args);
      order.push(args[1].at(-1).startsWith("$restartMode = 'stop'") ? "stop" : "start");
    },
    pause: async (milliseconds) => { order.push(`pause:${milliseconds}`); },
    beforeLaunch: async () => { order.push("switch"); },
  });

  assert.equal(calls.length, 2);
  const [file, args, options] = calls[0];
  assert.equal(file, "powershell.exe");
  assert.ok(args.includes("-NoProfile"));
  assert.ok(args.includes("-NonInteractive"));
  const script = args.at(-1);
  assert.match(script, /Get-Process -Name 'Codex'/);
  assert.match(script, /Get-Process -Name 'ChatGPT'/);
  assert.match(script, /Get-CodexProcesses/);
  assert.match(script, /Get-CodexUiProcesses/);
  assert.match(script, /Get-CodexProcesses \$Package/);
  assert.match(script, /Stop-Process -Force/);
  assert.match(script, /\$exitDeadline = \[DateTime\]::UtcNow.AddSeconds\(10\)/);
  assert.match(script, /Codex processes were still running after force quit/);
  assert.match(script, /Get-AppxPackage -Name 'OpenAI\.Codex'/);
  assert.match(script, /Get-StartApps/);
  assert.match(script, /shell:AppsFolder/);
  assert.match(script, /\^\(OpenAI\\s\+\)\?Codex\$/);
  assert.match(script, /-notmatch '\\\\WindowsApps\\\\'/);
  assert.match(script, /Start-Sleep -Milliseconds 800/);
  assert.match(script, /Windows accepted the launch request, but Codex did not start/);
  assert.deepEqual(options, { windowsHide: true, timeout: 20_000 });
  assert.deepEqual(order, ["stop", "switch", "pause:400", "start"]);
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

test("reopens Codex on Windows when switching credentials fails", async () => {
  const scripts = [];
  await assert.rejects(
    restartCodex({
      platform: "win32",
      run: async (_file, args) => { scripts.push(args.at(-1)); },
      pause: async () => undefined,
      beforeLaunch: async () => { throw new Error("Could not write auth.json"); },
    }),
    /Could not write auth\.json/,
  );

  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].startsWith("$restartMode = 'stop'"));
  assert.ok(scripts[1].startsWith("$restartMode = 'start'"));
});

test("does not silently claim restart support on other platforms", async () => {
  await assert.rejects(restartCodex({ platform: "linux" }), /not supported on linux/);
});
