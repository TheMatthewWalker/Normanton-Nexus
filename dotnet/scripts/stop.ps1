# stop.ps1 - Stop the NormantonNexus IIS application pool.
$ErrorActionPreference = 'Stop'

# See install.ps1's comment: WebAdministration's IIS:\ PSDrive isn't created
# when loaded through PowerShell 7+'s Windows PowerShell Compatibility layer.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

Import-Module WebAdministration

$appPoolName = 'NormantonNexus'

if (-not (Test-Path "IIS:\AppPools\$appPoolName")) {
    Write-Host "App pool '$appPoolName' is not registered." -ForegroundColor Yellow
    exit 0
}

$state = (Get-WebAppPoolState -Name $appPoolName).Value
if ($state -ne 'Started') {
    Write-Host "App pool '$appPoolName' is not running (state: $state)." -ForegroundColor Yellow
    exit 0
}

Write-Host "Stopping '$appPoolName'..."
Stop-WebAppPool -Name $appPoolName
Write-Host "Stopped." -ForegroundColor Green
