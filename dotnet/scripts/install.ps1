# install.ps1 - Register NormantonNexus as an IIS site + application pool.
#
# ASP.NET Core Module v2 (in-process hosting) — a deliberate departure from
# how the Node app is hosted today (a genuine Windows Service via
# node-windows/WinSW), per explicit user preference; see dotnet/CLAUDE.md's
# "Hosting" section for the full rationale. This mirrors the sibling
# SapServer repo's own install.ps1 pattern (scripts/install.ps1 there) —
# same IIS/ApplicationPoolIdentity gotchas apply here for the same
# fundamental reason (both are IIS-hosted .NET apps), even though the two
# stay separate deployed apps on separate app pools/sites.
#
# Run as Administrator. IIS + its PowerShell management tools (and
# Application Initialization, further down) are installed automatically if
# missing.
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

# WebAdministration's IIS:\ PSDrive isn't created when the module loads
# through PowerShell 7+'s Windows PowerShell Compatibility layer — only
# cmdlets/functions are proxied there, not PSProvider drives. Re-launch
# under real Windows PowerShell 5.1, where WebAdministration's provider
# loads natively. Identical gotcha to SapServer's own install.ps1.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

# Installs one or more Windows features/roles needed for IIS, trying the
# Server cmdlet first and falling back to the client cmdlet — the two are
# mutually exclusive depending on Windows SKU. Same helper SapServer's
# install.ps1 uses, duplicated here rather than shared across repos (the two
# apps are deliberately independent deployments — see the migration plan's
# "app boundary" decision).
function Install-IISFeature {
    param(
        [string[]] $ServerFeatureNames,
        [string[]] $ClientFeatureNames,
        [string]   $DisplayName
    )

    Write-Host "Installing $DisplayName..."
    try {
        $result = Install-WindowsFeature -Name $ServerFeatureNames -ErrorAction Stop
        $restartNeeded = $result.RestartNeeded -ne 'No'
    } catch {
        try {
            $restartNeeded = $false
            foreach ($feature in $ClientFeatureNames) {
                $r = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart -ErrorAction Stop
                if ($r.RestartNeeded) { $restartNeeded = $true }
            }
        } catch {
            Write-Host "Could not automatically install $DisplayName - $($_.Exception.Message)" -ForegroundColor Red
            return $false
        }
    }

    if ($restartNeeded) {
        Write-Host "$DisplayName installed - a restart is needed before it's fully active." -ForegroundColor Yellow
    } else {
        Write-Host "$DisplayName installed." -ForegroundColor Green
    }
    return $true
}

try {
    Import-Module WebAdministration -ErrorAction Stop
} catch {
    Write-Host ""
    Write-Host "IIS's PowerShell management tools aren't installed on this machine - installing now..." -ForegroundColor Yellow
    # ASP.NET Core hosting only needs the ASP.NET Core Module (installed
    # separately via the .NET Hosting Bundle, NOT a Windows feature) -
    # Web-Asp-Net45 (SapServer's own feature list) is irrelevant here since
    # this app never touches System.Web/.NET Framework. IIS-NetFxExtensibility45/
    # IIS-ASPNET45 are dropped from the client feature list for the same reason.
    $installed = Install-IISFeature `
        -ServerFeatureNames @('Web-Server', 'Web-Scripting-Tools') `
        -ClientFeatureNames @('IIS-WebServerRole', 'IIS-WebServer', 'IIS-CommonHttpFeatures', 'IIS-HttpErrors', 'IIS-ApplicationDevelopment', 'IIS-ISAPIExtensions', 'IIS-ISAPIFilter', 'IIS-ManagementConsole', 'IIS-ManagementScriptingTools') `
        -DisplayName 'IIS + management tools'

    if (-not $installed) {
        throw "IIS's PowerShell management tools could not be installed automatically - install manually (see this script's header comment) and re-run."
    }

    try {
        Import-Module WebAdministration -ErrorAction Stop
    } catch {
        Write-Host ""
        Write-Host "IIS was just installed, but WebAdministration still isn't available - a" -ForegroundColor Red
        Write-Host "restart is likely required before its PowerShell module registers. Reboot" -ForegroundColor Red
        Write-Host "this machine and re-run this script." -ForegroundColor Red
        Write-Host ""
        throw
    }
}

# ---- .NET Hosting Bundle sanity check ---------------------------------------
# Unlike SapServer (plain OWIN/System.Web, which IIS can host natively once
# IIS itself is installed), ASP.NET Core Module v2 (AspNetCoreModuleV2) is a
# separate install - the .NET Hosting Bundle - not a Windows feature
# Install-IISFeature above can pull in. Its absence produces a confusing
# 500.19/502.5 from IIS with no managed exception anywhere (the same
# "instant failure, no log line" symptom class as every ApplicationPoolIdentity
# gotcha documented in SapServer's CLAUDE.md, but from a completely different,
# IIS-Core-Module-specific cause), so check for it explicitly and fail loudly
# rather than let install.ps1 report success and leave that surprise for
# deploy.ps1's warm-up request to hit instead.
$ancmPath = "$env:windir\System32\inetsrv\aspnetcorev2.dll"
if (-not (Test-Path $ancmPath)) {
    Write-Host ""
    Write-Host "*** ASP.NET Core Module v2 is not installed ***" -ForegroundColor Red
    Write-Host "IIS is present, but the .NET Hosting Bundle (which installs" -ForegroundColor Red
    Write-Host "AspNetCoreModuleV2) is not. Download and run the ASP.NET Core Runtime" -ForegroundColor Red
    Write-Host "Hosting Bundle installer for .NET 10 from https://dotnet.microsoft.com/,"  -ForegroundColor Red
    Write-Host "then re-run this script (a fresh 'iisreset' may be needed for IIS to" -ForegroundColor Red
    Write-Host "notice the newly registered module)." -ForegroundColor Red
    throw "ASP.NET Core Module v2 (aspnetcorev2.dll) not found under $env:windir\System32\inetsrv."
}

$siteName    = 'NormantonNexus'
$appPoolName = 'NormantonNexus'
$publishDir  = (Resolve-Path "$PSScriptRoot\..\publish").Path
$port        = 7300

# ---- Machine environment variables ------------------------------------------
# ASPNETCORE_ENVIRONMENT has to be an env var - it's what WebApplication.
# CreateBuilder(args) reads to pick which appsettings.{Environment}.json
# layers on top of appsettings.json, same fundamental mechanism (and same
# "a plain app pool recycle does NOT pick this up" caveat) as SapServer's
# own ASPNETCORE_ENVIRONMENT note - new worker processes get their
# environment block from WAS's own cached copy from when WAS itself last
# started, not a live read on every recycle. A changed value here needs a
# full `iisreset` or a machine reboot before a new worker actually sees it.
Write-Host "Setting environment variables..."
[System.Environment]::SetEnvironmentVariable('ASPNETCORE_ENVIRONMENT', 'Production', 'Machine')

# ---- Secrets ------------------------------------------------------------------
# Deliberately NOT prompted for here / set as env vars - ConnectionStrings
# (Nexus/NexusOperations/NexusArchive), SapCredentials:EncryptionKeyHex,
# SapServer:JwtSecret, and Logistics:ExportRoot all live directly in
# appsettings.Production.json instead, same convention SapServer's own
# install.ps1 uses for its equivalents. That file is already .gitignore'd.
Write-Host ""
Write-Host "Reminder: before starting the site, fill in appsettings.Production.json:" -ForegroundColor Yellow
Write-Host "  - ConnectionStrings:Nexus / NexusOperations / NexusArchive"             -ForegroundColor Yellow
Write-Host "  - SapCredentials:EncryptionKeyHex (MUST match the Node app's own"       -ForegroundColor Yellow
Write-Host "    SAP_CRED_ENCRYPTION_KEY env var exactly)"                             -ForegroundColor Yellow
Write-Host "  - SapServer:JwtSecret (MUST match SapServer's own Auth:JwtSecret)"       -ForegroundColor Yellow
Write-Host "  - Logistics:ExportRoot - a real absolute path OUTSIDE this site's own"   -ForegroundColor Yellow
Write-Host "    publish folder (a redeploy replaces publish\ contents; exported"       -ForegroundColor Yellow
Write-Host "    customer-invoice files must live somewhere a republish can't touch)"   -ForegroundColor Yellow

# ---- Application pool -------------------------------------------------------
Write-Host ""
Write-Host "Creating application pool '$appPoolName'..."
if (Test-Path "IIS:\AppPools\$appPoolName") {
    Write-Host "App pool already exists - leaving its settings as-is." -ForegroundColor DarkGray
} else {
    New-WebAppPool -Name $appPoolName | Out-Null
}
# "No Managed Code" - ASP.NET Core's in-process hosting model (this app's
# web.config sets hostingModel="inprocess") runs entirely inside
# AspNetCoreModuleV2 and its own separately-hosted CLR, NOT the app pool's
# managed runtime the way classic System.Web/OWIN apps (SapServer included)
# use it - leaving this at v4.0 wouldn't break anything today, but it's
# actively misleading (there is no managed code for that runtime to host)
# and is Microsoft's own documented recommendation for ANCM in-process sites.
Set-ItemProperty "IIS:\AppPools\$appPoolName" managedRuntimeVersion ''
Set-ItemProperty "IIS:\AppPools\$appPoolName" managedPipelineMode 'Integrated'
Set-ItemProperty "IIS:\AppPools\$appPoolName" enable32BitAppOnWin64 $false
# loadUserProfile defaults to $true, but ApplicationPoolIdentity (a virtual
# account with no real Windows user profile) can't satisfy that on every
# machine - identical gotcha to SapServer's own install.ps1, same fix.
Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.loadUserProfile -Value $false

# ---- App-pool recycling vs. in-flight Quartz.NET jobs -----------------------
# Flagged as an open, undecided risk throughout Phase 10 (see dotnet/CLAUDE.md's
# "Hosting" section): IIS recycling an app pool mid-run would kill whatever
# Quartz.NET job happens to be executing at that moment, with no resumption -
# none of the 9 scheduled jobs (Services/BackgroundJobs/ScheduledJobs.cs) are
# built to safely resume a partial run. The migration plan itself named two
# options - disable recycling, or make every job resumable/idempotent. Making
# 9 separate jobs genuinely resumable is real per-job design work (some,
# like the warehouse SAP sync's reconciliation sweep, are considerably
# harder to make safely resumable than others); disabling recycling entirely
# removes the actual trigger for the failure mode instead, at the cost of a
# worker process that (by design) now never recycles on its own - acceptable
# for a low-to-moderate-traffic internal portal, matching this app's Node
# predecessor's own "restart only on a real Windows-Service restart" behavior
# (Windows Services don't self-recycle on a timer either). Decided here,
# rather than left open any longer.
Write-Host ""
Write-Host "Disabling app-pool recycling (protects in-flight Quartz.NET jobs)..."
Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name recycling.periodicRestart.time -Value '00:00:00'
Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name recycling.periodicRestart.schedule -Value @()
Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.idleTimeout -Value '00:00:00'

# ---- Site ---------------------------------------------------------------
Write-Host "Creating site '$siteName' (physical path: $publishDir, port: $port)..."
if (Get-Website -Name $siteName -ErrorAction SilentlyContinue) {
    Write-Host "Site already exists - leaving its bindings as-is." -ForegroundColor DarkGray
} else {
    New-Website -Name $siteName -PhysicalPath $publishDir -ApplicationPool $appPoolName -Port $port | Out-Null
}

# ---- File system permissions -------------------------------------------------
# ApplicationPoolIdentity ("IIS AppPool\<name>") needs explicit filesystem
# access - New-Website/New-WebAppPool don't reliably grant it on every OS/
# folder-inheritance combination. Two writable subfolders this app needs
# beyond SapServer's own logs\-only precedent:
#   - logs\    - ANCM's stdoutLogEnabled=true output (this app's web.config;
#                see that file's own comment) - the ANCM-level equivalent of
#                SapServer's Serilog-crashes-before-it-can-log gotcha.
#   - keys\    - the Data Protection key ring (Program.cs's
#                PersistKeysToFileSystem) - every session cookie this app
#                issues depends on being able to read/write these keys;
#                without them (or without a STABLE location for them).
#                every login would still work, but ALL of them would
#                silently invalidate on the next worker recycle.
$appPoolIdentity = "IIS AppPool\$appPoolName"
Write-Host ""
Write-Host "Granting '$appPoolIdentity' filesystem access..."
foreach ($sub in @('logs', 'keys')) {
    $dir = Join-Path $publishDir $sub
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}
# Read+execute on the whole site root - needed to load web.config/*.dll and
# serve static content (wwwroot\) at all.
icacls $publishDir /grant "${appPoolIdentity}:(OI)(CI)RX" /T | Out-Null
# Modify (not just write) on logs\/keys\ specifically - log-file rollover
# needs delete permission, not just write, and Data Protection periodically
# retires old keys the same way.
icacls (Join-Path $publishDir 'logs') /grant "${appPoolIdentity}:(OI)(CI)M" /T | Out-Null
icacls (Join-Path $publishDir 'keys') /grant "${appPoolIdentity}:(OI)(CI)M" /T | Out-Null

# ---- Eager startup (Application Initialization) -----------------------------
# Identical gotcha to SapServer's own install.ps1 (see its own comment for
# the full "confirmed for real" writeup) - IIS's default OnDemand start mode
# means Program.cs's DI graph / Quartz scheduler doesn't actually build
# until the first real HTTP request arrives, not when the pool starts.
Write-Host ""
Write-Host "Configuring eager startup (Application Initialization)..."
Set-ItemProperty "IIS:\AppPools\$appPoolName" startMode 'AlwaysRunning'
Set-WebConfigurationProperty -PSPath 'IIS:\' `
    -Filter "/system.applicationHost/sites/site[@name='$siteName']/application[@path='/']" `
    -Name preloadEnabled -Value $true

$appInitInstalled = $false
try {
    $appInitInstalled = (Get-WindowsFeature -Name Web-AppInit -ErrorAction Stop).InstallState -eq 'Installed'
} catch {
    try {
        $appInitInstalled = (Get-WindowsOptionalFeature -Online -FeatureName IIS-ApplicationInit -ErrorAction Stop).State -eq 'Enabled'
    } catch { }
}
if (-not $appInitInstalled) {
    Write-Host ""
    Write-Host "Application Initialization isn't installed - AlwaysRunning/preload are set," -ForegroundColor Yellow
    Write-Host "but IIS won't actually send the warm-up request without it (deploy.ps1's own" -ForegroundColor Yellow
    Write-Host "warm-up request still works either way)." -ForegroundColor Yellow
    Install-IISFeature `
        -ServerFeatureNames @('Web-AppInit') `
        -ClientFeatureNames @('IIS-ApplicationInit') `
        -DisplayName 'Application Initialization' | Out-Null
}

Write-Host ""
Write-Host "Site registered on http://localhost:$port - for HTTPS, bind a" -ForegroundColor Yellow
Write-Host "certificate via IIS Manager or New-WebBinding + netsh http add sslcert" -ForegroundColor Yellow
Write-Host "(a one-time manual step; not automated here since it needs a real cert)." -ForegroundColor Yellow
Write-Host ""
Write-Host "Run 'deploy.ps1' to publish the app into $publishDir and start the site." -ForegroundColor Green
