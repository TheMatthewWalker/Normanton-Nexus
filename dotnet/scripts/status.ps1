# status.ps1 - Show the current state of the NormantonNexus IIS app pool/site and recent logs.

# See install.ps1's comment: WebAdministration's IIS:\ PSDrive isn't created
# when loaded through PowerShell 7+'s Windows PowerShell Compatibility layer.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

Import-Module WebAdministration

$appPoolName = 'NormantonNexus'
$siteName    = 'NormantonNexus'

if (-not (Test-Path "IIS:\AppPools\$appPoolName")) {
    Write-Host "App pool '$appPoolName' is NOT registered." -ForegroundColor Red
    exit 0
}

$poolState = (Get-WebAppPoolState -Name $appPoolName).Value
$site      = Get-Website -Name $siteName -ErrorAction SilentlyContinue

$colour = switch ($poolState) {
    'Started' { 'Green'  }
    'Stopped' { 'Red'    }
    default   { 'Yellow' }
}

Write-Host "App pool : $appPoolName"        -ForegroundColor Cyan
Write-Host "State    : $poolState"          -ForegroundColor $colour
if ($site) {
    Write-Host "Site     : $($site.Name) (state: $($site.State))"
    Write-Host "Bindings : $($site.Bindings.Collection -join ', ')"
}

# ASP.NET Core Module v2's own stdout log (this app's web.config sets
# stdoutLogEnabled=true) - captures ANCM-level startup diagnostics from
# BEFORE this app's own managed request pipeline is up, distinct from
# anything the app itself would ever log. Named stdout_<timestamp>_<pid>.log,
# a new file per worker-process start (not a daily rolling file the way
# SapServer's Serilog sink is), so "most recently written" is what to tail.
$logDir  = "$PSScriptRoot\..\publish\logs"
$logFile = Get-ChildItem $logDir -Filter "stdout*.log" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending |
           Select-Object -First 1

if ($logFile) {
    Write-Host ""
    Write-Host "--- Recent ANCM stdout log ($($logFile.Name)) ---" -ForegroundColor Cyan
    Get-Content $logFile.FullName -Tail 20
} else {
    Write-Host ""
    Write-Host "No ANCM stdout log files found in $logDir (normal if the app has never" -ForegroundColor Yellow
    Write-Host "logged anything to stdout since its last start - .NET's default console" -ForegroundColor Yellow
    Write-Host "logging provider only writes on request activity/errors, not on every" -ForegroundColor Yellow
    Write-Host "successful request)." -ForegroundColor Yellow
}
