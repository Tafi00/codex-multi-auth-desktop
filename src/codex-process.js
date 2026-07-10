import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_RESTART_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

$codexProcesses = @(Get-Process -Name 'Codex' -ErrorAction SilentlyContinue)
$executablePath = $codexProcesses |
  ForEach-Object {
    try { $_.Path } catch { $null }
  } |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if ($codexProcesses.Count -gt 0) {
  $codexProcesses | Stop-Process -Force
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $remaining = @(Get-Process -Name 'Codex' -ErrorAction SilentlyContinue)
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

  if ($remaining.Count -gt 0) {
    throw 'Codex did not close within 10 seconds.'
  }
}

Start-Sleep -Milliseconds 500

$startApp = Get-StartApps |
  Where-Object { $_.Name -match '^(OpenAI\s+)?Codex$' } |
  Select-Object -First 1

if ($startApp) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $startApp.AppID)
  exit 0
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

if ($knownPaths.Count -gt 0) {
  try {
    Start-Process -FilePath $knownPaths[0]
    exit 0
  } catch {
    throw ('Codex was found but Windows refused to launch it: ' + $_.Exception.Message)
  }
}

throw 'Codex is not running and its Windows installation could not be found.'
`.trim();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function restartCodex({
  platform = process.platform,
  run = execFileAsync,
  pause = delay,
} = {}) {
  if (platform === "darwin") {
    await run("osascript", ["-e", 'tell application "Codex" to quit']).catch(() => undefined);
    await pause(700);
    await run("open", ["-a", "Codex"]);
    return;
  }

  if (platform === "win32") {
    try {
      await run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_RESTART_SCRIPT,
      ], { windowsHide: true, timeout: 20_000 });
    } catch (error) {
      const details = error?.stderr?.trim() || error?.message || String(error);
      throw new Error(`Could not restart Codex on Windows: ${details}`);
    }
    return;
  }

  throw new Error(`Restarting Codex is not supported on ${platform}.`);
}
