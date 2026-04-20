[CmdletBinding()]
param(
  [string]$ShortcutName = 'ACP Monitor Dashboard',
  [string]$DistroName = 'Ubuntu',
  [Parameter(Mandatory = $true)]
  [string]$LinuxProjectPath,
  [string]$DesktopPath = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'

$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powerShellPath)) {
  throw "Unable to find powershell.exe at $powerShellPath"
}

if (-not (Test-Path $DesktopPath)) {
  throw "Desktop path was not found: $DesktopPath"
}

$launcherScriptPath = Join-Path $PSScriptRoot 'Start-AcpMonitorDashboard.ps1'
$sourceIconPath = Join-Path $PSScriptRoot '..\..\assets\icons\windows\acp-monitor-shortcut.ico'
$shortcutPath = Join-Path $DesktopPath "$ShortcutName.lnk"
$iconInstallDir = Join-Path $env:LOCALAPPDATA 'ACP Monitor'
$installedIconPath = Join-Path $iconInstallDir 'acp-monitor-shortcut.ico'

function Quote-Argument {
  param([string]$Value)

  return '"' + $Value + '"'
}

$arguments = @(
  '-NoProfile'
  '-WindowStyle'
  'Hidden'
  '-ExecutionPolicy'
  'Bypass'
  '-File'
  (Quote-Argument $launcherScriptPath)
  '-DistroName'
  (Quote-Argument $DistroName)
  '-LinuxProjectPath'
  (Quote-Argument $LinuxProjectPath)
) -join ' '

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)

New-Item -ItemType Directory -Force -Path $iconInstallDir | Out-Null

if (Test-Path $sourceIconPath) {
  Copy-Item -Path $sourceIconPath -Destination $installedIconPath -Force
}

$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $DesktopPath
$shortcut.IconLocation = if (Test-Path $installedIconPath) { $installedIconPath } else { "$env:SystemRoot\System32\SHELL32.dll,220" }
$shortcut.Description = 'Starts ACP Monitor inside WSL and opens the dashboard.'
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"
Write-Host "Installed icon: $installedIconPath"
Write-Host "Target distro: $DistroName"
Write-Host "Linux project path: $LinuxProjectPath"
