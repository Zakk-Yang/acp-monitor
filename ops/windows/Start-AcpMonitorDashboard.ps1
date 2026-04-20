[CmdletBinding()]
param(
  [string]$DistroName = 'Ubuntu',
  [Parameter(Mandatory = $true)]
  [string]$LinuxProjectPath,
  [int]$Port = 1234,
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'ACP-Monitor-DesktopShortcut.log'

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logPath -Value "[$timestamp] $Message"
}

function Show-LauncherError {
  param([string]$Message)

  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    'ACP Monitor',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

try {
  Write-Log 'Launcher started.'

  $wslPath = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (-not (Test-Path $wslPath)) {
    throw "Unable to find wsl.exe at $wslPath"
  }

  $output = & $wslPath `
    -d $DistroName `
    --cd $LinuxProjectPath `
    --exec /bin/bash -lc "PORT=$Port bash ops/wsl/start-acp-monitor.sh" 2>&1

  $outputText = ($output | Out-String).Trim()
  if ($outputText) {
    Write-Log $outputText
  }

  if ($LASTEXITCODE -ne 0) {
    if ($outputText) {
      throw $outputText
    }

    throw 'ACP Monitor failed to start inside WSL.'
  }

  $url = "http://localhost:$Port"

  if (-not $SkipBrowser) {
    Start-Process $url | Out-Null
    Write-Log "Opened browser at $url"
  }

  Write-Host "ACP Monitor is available at $url"
  Write-Log "Launcher finished successfully for $url"
} catch {
  $message = $_.Exception.Message
  Write-Log "Launcher failed: $message"
  Show-LauncherError "$message`n`nLog: $logPath"
  exit 1
}
