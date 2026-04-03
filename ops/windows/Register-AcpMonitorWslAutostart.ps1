[CmdletBinding()]
param(
  [string]$TaskName = 'ACP-Monitor-WSL-Autostart',
  [string]$DistroName = 'Ubuntu'
)

$ErrorActionPreference = 'Stop'

$wslPath = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (-not (Test-Path $wslPath)) {
  throw "Unable to find wsl.exe at $wslPath"
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $wslPath -Argument "-d $DistroName --exec /bin/true"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Starts the Ubuntu WSL distro at logon so ACP Monitor systemd services start automatically.' `
  -Force | Out-Null

Write-Host "Registered task '$TaskName' for user '$currentUser'."
Write-Host 'It will launch WSL at logon, which in turn starts enabled systemd services such as acp-monitor.'
