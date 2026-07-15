# install-log-watcher.ps1 - Register a logon task that opens a terminal tailing
# the Normanton Nexus (sql2005-bridge) service log. Run as Administrator.
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$taskName = 'NormantonNexusLog'
$script   = (Resolve-Path "$PSScriptRoot\watch-log.ps1").Path

# Prefer Windows Terminal (wt.exe) for a nicer window; fall back to powershell.exe
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    $exe  = $wt.Source
    $args = "powershell.exe -NoExit -ExecutionPolicy Bypass -File `"$script`""
} else {
    $exe  = 'powershell.exe'
    $args = "-NoExit -ExecutionPolicy Bypass -File `"$script`""
}

$action   = New-ScheduledTaskAction -Execute $exe -Argument $args
$trigger  = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Task '$taskName' registered." -ForegroundColor Green
Write-Host "A log window will open automatically at next logon."
Write-Host ""
Write-Host "To open it now: Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor DarkGray
