import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_RESTART_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

function Get-OpenAICodexPackage {
  if (-not (Get-Command -Name Get-AppxPackage -ErrorAction SilentlyContinue)) {
    return $null
  }

  return Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
}

function Get-CodexProcesses {
  param($Package)

  $processes = @(Get-Process -Name 'Codex' -ErrorAction SilentlyContinue)
  if ($Package) {
    $installPrefix = $Package.InstallLocation.TrimEnd('\') + '\'
    $processes = @($processes | Where-Object {
      try {
        $_.Path -and $_.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
      } catch {
        $false
      }
    })
    $processes += @(Get-CodexUiProcesses $Package)
  }

  return @($processes | Sort-Object Id -Unique)
}

function Get-CodexUiProcesses {
  param($Package)

  if (-not $Package) {
    return @()
  }

  $installPrefix = $Package.InstallLocation.TrimEnd('\') + '\'
  return @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue |
    Where-Object {
      try {
        $_.Path -and $_.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
      } catch {
        $false
      }
    })
}

function Get-CodexWindows {
  param($Package)

  return @(Get-CodexProcesses $Package | Where-Object {
    try {
      $_.MainWindowHandle -ne 0
    } catch {
      $false
    }
  })
}

function Request-CodexQuit {
  param($Package)

  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  } catch {
    return $false
  }

  $retryDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    foreach ($process in @(Get-CodexProcesses $Package)) {
      if ($process.MainWindowHandle -eq 0) {
        continue
      }

      try {
        # Use Codex's own File > Exit command. It calls app.quit(), allowing the
        # app to flush state and close its workers instead of being force-killed.
        $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $window.SetFocus()
        $fileCondition = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty,
          'File'
        )
        $fileMenu = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $fileCondition)
        if (-not $fileMenu) {
          continue
        }

        $expand = $fileMenu.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expand.Expand()
        $menuItemCondition = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::MenuItem
        )
        $menuDeadline = [DateTime]::UtcNow.AddSeconds(1)
        do {
          $exitItem = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $menuItemCondition
          ) | Where-Object {
            $_.Current.ProcessId -eq $process.Id -and $_.Current.Name -match '^Exit(?:\s|$)'
          } | Select-Object -First 1)
          if ($exitItem.Count -gt 0) {
            $invoke = $exitItem[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invoke.Invoke()
            return $true
          }
          Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $menuDeadline)

        try { $expand.Collapse() } catch {}
      } catch {
        # The UI may still be initializing; retry with a fresh process/window.
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $retryDeadline)

  return $false
}

function Request-CodexWindowClose {
  param($Package)

  # File > Exit sometimes is not exposed to UI Automation while Codex is
  # restoring its window. CloseMainWindow sends the same normal WM_CLOSE as
  # clicking the title-bar X; it is not a force kill and lets Codex flush state.
  foreach ($process in @(Get-CodexProcesses $Package)) {
    try {
      if ($process.MainWindowHandle -ne 0 -and $process.CloseMainWindow()) {
        return $true
      }
    } catch {
      # Refresh the process list and try another visible Codex window.
    }
  }

  return $false
}

function Wait-ForCodexStart {
  param($Package)

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if (@(Get-CodexWindows $Package).Count -gt 0) {
      return $true
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Start-PackagedCodex {
  param($Package)

  # The Microsoft Store/MSIX build cannot be started directly from WindowsApps.
  # It must be activated through its application user model ID (AUMID).
  try {
    if (-not $Package) {
      return $false
    }

    $manifestPath = Join-Path $Package.InstallLocation 'AppxManifest.xml'
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -ErrorAction Stop
    $application = @($manifest.Package.Applications.Application) |
      Where-Object { $_.Id } |
      Select-Object -First 1
    if (-not $application) {
      return $false
    }

    $aumid = "$($Package.PackageFamilyName)!$($application.Id)"
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $aumid) -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Start-StartMenuCodex {
  if (-not (Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue)) {
    return $false
  }

  try {
    $startApp = Get-StartApps -ErrorAction Stop |
      Where-Object { $_.Name -match '^(OpenAI\s+)?Codex$' } |
      Select-Object -First 1
    if (-not $startApp) {
      return $false
    }

    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $startApp.AppID) -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

$packagedCodex = Get-OpenAICodexPackage
$codexProcesses = @(Get-CodexProcesses $packagedCodex)
$executablePath = $codexProcesses |
  ForEach-Object {
    try { $_.Path } catch { $null }
  } |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if ($restartMode -eq 'stop') {
  # Codex on Windows can keep background workers alive after a normal window
  # close. Those workers may rewrite auth.json after the account switch. Kill
  # the exact Codex package processes, then wait until every old process is
  # gone before the caller writes the selected account.
  if ($codexProcesses.Count -gt 0) {
    $codexProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  $exitDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if (@(Get-CodexProcesses $packagedCodex).Count -eq 0) {
      Start-Sleep -Milliseconds 800
      exit 0
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $exitDeadline)

  throw 'Codex processes were still running after force quit.'
}

if ($restartMode -ne 'start') {
  throw ('Unknown Codex restart mode: ' + $restartMode)
}

$launched = Start-PackagedCodex $packagedCodex
if (-not $launched) {
  $launched = Start-StartMenuCodex
}

$knownPaths = @(
  @(
    $executablePath,
    (Join-Path $env:LOCALAPPDATA 'Programs\Codex\Codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'Codex\Codex.exe')
  ) |
    Where-Object {
      $_ -and
      $_ -notmatch '\\WindowsApps\\' -and
      (Test-Path -LiteralPath $_)
    } |
    Select-Object -Unique
)

if (-not $launched -and $knownPaths.Count -gt 0) {
  try {
    Start-Process -FilePath $knownPaths[0]
    $launched = $true
  } catch {
    throw ('Codex was found but Windows refused to launch it: ' + $_.Exception.Message)
  }
}

if (-not $launched) {
  throw 'Codex is not running and its Windows installation could not be found.'
}

if (-not (Wait-ForCodexStart $packagedCodex)) {
  throw 'Windows accepted the launch request, but Codex did not start within 10 seconds.'
}
`.trim();

function windowsRestartScript(mode) {
  return `$restartMode = '${mode}'\n${WINDOWS_RESTART_SCRIPT}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const MAC_CODEX_MAIN_PROCESS_PATTERN = "(ChatGPT|Codex)\\.app/Contents/MacOS/(ChatGPT|Codex)";

async function getMacCodexPids(run) {
  try {
    const result = await run("pgrep", ["-f", MAC_CODEX_MAIN_PROCESS_PATTERN]);
    return String(result?.stdout ?? "")
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function macPidIsRunning(run, pid) {
  try {
    await run("kill", ["-0", String(pid)]);
    return true;
  } catch {
    return false;
  }
}

async function waitForMacPidsToExit({
  pids,
  timeoutMs,
  run,
  pause,
  pollMs = 120,
}) {
  if (pids.length === 0) return true;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const states = await Promise.all(pids.map((pid) => macPidIsRunning(run, pid)));
    if (states.every((running) => !running)) return true;
    if (attempt < attempts - 1) await pause(pollMs);
  }
  return false;
}

async function signalRunningMacPids(run, pids, signal) {
  await Promise.all(pids.map(async (pid) => {
    if (await macPidIsRunning(run, pid)) {
      await run("kill", [signal, String(pid)]).catch(() => undefined);
    }
  }));
}

async function requestMacCodexQuit(run, pid) {
  const focusScript = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  await run("osascript", [
    "-e",
    focusScript,
    "-e",
    'tell application "System Events" to keystroke "q" using command down',
  ]).catch(() => undefined);
}

async function clickMacCodexQuitConfirmation(run, pid) {
  const clickScript = `
tell application "System Events"
  tell (first process whose unix id is ${pid})
    repeat with targetWindow in windows
      try
        click button "Quit" of targetWindow
        return true
      end try
      try
        click button "Quit" of sheet 1 of targetWindow
        return true
      end try
    end repeat
  end tell
end tell
return false
`.trim();
  await run("osascript", ["-e", clickScript]).catch(() => undefined);
}

export async function restartCodex({
  platform = process.platform,
  run = execFileAsync,
  pause = delay,
  beforeStop,
  afterStop,
  beforeLaunch,
} = {}) {
  if (platform === "darwin") {
    const pids = await getMacCodexPids(run);
    await beforeStop?.();
    await Promise.all(pids.map((pid) => requestMacCodexQuit(run, pid)));
    let exited = await waitForMacPidsToExit({
      pids,
      timeoutMs: 360,
      run,
      pause,
    });

    // Codex can hold Cmd+Q behind a running-task confirmation. Accept that
    // prompt automatically first so Codex can perform its normal shutdown.
    if (!exited) {
      await Promise.all(pids.map((pid) => clickMacCodexQuitConfirmation(run, pid)));
      exited = await waitForMacPidsToExit({
        pids,
        timeoutMs: 720,
        run,
        pause,
      });
    }

    // Match Cockpit's fallback when the confirmation is unavailable or cannot
    // be automated: SIGTERM the exact old PIDs, then verify they have exited.
    if (!exited) {
      await signalRunningMacPids(run, pids, "-15");
      exited = await waitForMacPidsToExit({
        pids,
        timeoutMs: 2_500,
        run,
        pause,
      });
    }
    if (!exited) {
      await signalRunningMacPids(run, pids, "-9");
      exited = await waitForMacPidsToExit({
        pids,
        timeoutMs: 1_500,
        run,
        pause,
      });
    }
    if (!exited) throw new Error("Could not close the previous Codex process.");
    await afterStop?.();

    let beforeLaunchError = null;
    try {
      await beforeLaunch?.();
    } catch (error) {
      beforeLaunchError = error;
    }
    await run("open", ["-a", "Codex"]);
    const startAttempts = Math.max(1, Math.ceil(8_000 / 120));
    for (let attempt = 0; attempt < startAttempts; attempt += 1) {
      if ((await getMacCodexPids(run)).length > 0) {
        if (beforeLaunchError) throw beforeLaunchError;
        return;
      }
      if (attempt < startAttempts - 1) await pause(120);
    }
    throw new Error("macOS accepted the launch request, but Codex did not start.");
  }

  if (platform === "win32") {
    try {
      await beforeStop?.();
      await run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsRestartScript("stop"),
      ], { windowsHide: true, timeout: 20_000 });
      await afterStop?.();
      let beforeLaunchError = null;
      try {
        await beforeLaunch?.();
      } catch (error) {
        beforeLaunchError = error;
      }
      await pause(400);
      await run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsRestartScript("start"),
      ], { windowsHide: true, timeout: 20_000 });
      if (beforeLaunchError) throw beforeLaunchError;
    } catch (error) {
      const details = error?.stderr?.trim() || error?.message || String(error);
      throw new Error(`Could not restart Codex on Windows: ${details}`);
    }
    return;
  }

  throw new Error(`Restarting Codex is not supported on ${platform}.`);
}
