# deploy.ps1 - Stop the app pool, rebuild, publish, and restart it.
# Run as Administrator.
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

# See install.ps1's comment: WebAdministration's IIS:\ PSDrive isn't created
# when loaded through PowerShell 7+'s Windows PowerShell Compatibility layer.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

Import-Module WebAdministration

$appPoolName = 'NormantonNexus'
$projectRoot = "$PSScriptRoot\.."
$publishDir  = "$projectRoot\publish"
$healthUrl   = 'http://localhost:7300/health'

# ---- Stop if running -------------------------------------------------------
$poolExists = Test-Path "IIS:\AppPools\$appPoolName"
if ($poolExists -and (Get-WebAppPoolState -Name $appPoolName).Value -eq 'Started') {
    Write-Host "Stopping app pool..."
    Stop-WebAppPool -Name $appPoolName
    Start-Sleep -Seconds 2
}

# ---- Publish ---------------------------------------------------------------
# Microsoft.NET.Sdk.Web already produces a correct IIS-ready publish layout
# (web.config with the ANCM <aspNetCore> handler, appsettings copied to the
# publish root) - no SapServer-style bin\-relocation MSBuild target needed
# (confirmed via a real local `dotnet publish` during Phase 0 - see
# dotnet/CLAUDE.md's "Build & Test" section). NormantonNexus/web.config is a
# committed template (stdoutLogEnabled=true) that dotnet publish transforms
# in place rather than overwriting from scratch - see that file's own
# comment.
Write-Host "Publishing..."
dotnet publish "$projectRoot\NormantonNexus\NormantonNexus.csproj" -c Release -o "$publishDir"
if ($LASTEXITCODE -ne 0) { Write-Error "dotnet publish failed."; exit 1 }

# ---- Start -----------------------------------------------------------------
if ($poolExists) {
    Write-Host "Starting app pool..."
    Start-WebAppPool -Name $appPoolName
    Start-Sleep -Seconds 2
    $newState = (Get-WebAppPoolState -Name $appPoolName).Value
    Write-Host "State: $newState" -ForegroundColor $(if ($newState -eq 'Started') { 'Green' } else { 'Yellow' })

    # ---- Warm-up ------------------------------------------------------------
    # Same OnDemand-start-mode gotcha as SapServer's own deploy.ps1 - the pool
    # being "Started" only means the worker process shell is up; Program.cs's
    # DI graph and Quartz scheduler don't actually build until the first real
    # HTTP request arrives. install.ps1's AlwaysRunning/preloadEnabled +
    # Application Initialization make IIS send that request itself where the
    # module is installed, but this sends one directly regardless, so the app
    # is confirmed up before you go looking for it. /health is unauthenticated,
    # so no session cookie/bearer token is needed here.
    Write-Host "Warming up (GET $healthUrl)..."
    $warmedUp = $false
    for ($i = 0; $i -lt 5 -and -not $warmedUp; $i++) {
        Start-Sleep -Seconds 2
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
            # /health returns a bare { status, timestampUtc } object, not the
            # {success,data,error} envelope every other endpoint uses (see
            # Program.cs's MapGet("/health", ...) — no ApiResponse<T> wrapper,
            # deliberately, since it exists purely as an external liveness
            # probe with no auth/DB dependency).
            Write-Host "App responded: $($response.status)" -ForegroundColor Green
            $warmedUp = $true
        } catch {
            Write-Host "  not up yet ($($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }
    if (-not $warmedUp) {
        Write-Host "App didn't respond to warm-up after 10s - check publish\logs\ (both the" -ForegroundColor Yellow
        Write-Host "ANCM stdout log and any managed startup exception) or Event Viewer." -ForegroundColor Yellow
    }
} else {
    Write-Host "App pool not registered - run 'install.ps1' first." -ForegroundColor Yellow
}
