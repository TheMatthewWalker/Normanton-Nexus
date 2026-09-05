# start.ps1 - Start the NormantonNexus IIS application pool + site.
$ErrorActionPreference = 'Stop'

# See install.ps1's comment: WebAdministration's IIS:\ PSDrive isn't created
# when loaded through PowerShell 7+'s Windows PowerShell Compatibility layer.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

Import-Module WebAdministration

$appPoolName = 'NormantonNexus'
$siteName    = 'NormantonNexus'

Write-Host "Starting app pool '$appPoolName'..."
Start-WebAppPool -Name $appPoolName
Start-Website -Name $siteName

Start-Sleep -Seconds 2
$state = (Get-WebAppPoolState -Name $appPoolName).Value

Write-Host "State : $state" -ForegroundColor $(if ($state -eq 'Started') { 'Green' } else { 'Yellow' })
