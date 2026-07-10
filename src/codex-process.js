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

if ($codexProcesses.Count -gt 0) {
  if (-not (Request-CodexQuit $packagedCodex)) {
    throw 'Codex is running, but its File > Exit command could not be clicked within 5 seconds.'
  }
}

# Match the macOS flow: request a normal quit, then reopen promptly rather
# than blocking on every Windows helper process to exit.
Start-Sleep -Milliseconds 700

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
