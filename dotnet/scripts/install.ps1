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
#
# Confirmed for real: hardcoding "$env:windir\System32\inetsrv\aspnetcorev2.dll"
# as the only place to look is wrong even on a genuinely correct install - a
# real machine with "Microsoft ASP.NET Core Module V2" showing in
# Get-Package (the Hosting Bundle installed after IIS, exactly as this
# script's own ordering above ensures) still failed this Test-Path. IIS's own
# applicationHost.config globalModules entry is the actual source of truth
# for where the module loads from - not a guessed path - so read that
# instead, falling back to the two real install locations Microsoft's
# installer has used across versions only if the config entry itself is
# missing (the one case that genuinely does mean "not installed").
$ancmModule = $null
try {
    [xml]$appHostConfig = Get-Content "$env:windir\System32\inetsrv\config\applicationHost.config" -Raw
    $ancmModule = $appHostConfig.configuration.'system.webServer'.globalModules.add |
        Where-Object { $_.name -eq 'AspNetCoreModuleV2' } | Select-Object -First 1
} catch {
    Write-Host "Could not read applicationHost.config directly ($($_.Exception.Message)) - falling back to known install paths." -ForegroundColor Yellow
}

$ancmPath = $null
if ($ancmModule -and $ancmModule.image) {
    $candidate = [System.Environment]::ExpandEnvironmentVariables($ancmModule.image)
    if (Test-Path $candidate) { $ancmPath = $candidate }
}
if (-not $ancmPath) {
    $fallbackCandidates = @(
        "$env:windir\System32\inetsrv\aspnetcorev2.dll",
        "$env:ProgramFiles\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll"
    )
    $ancmPath = $fallbackCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $ancmPath) {
    Write-Host ""
    Write-Host "*** ASP.NET Core Module v2 is not installed ***" -ForegroundColor Red
    Write-Host "IIS is present, but the .NET Hosting Bundle (which installs" -ForegroundColor Red
    Write-Host "AspNetCoreModuleV2) is not. Download and run the ASP.NET Core Runtime" -ForegroundColor Red
    Write-Host "Hosting Bundle installer for .NET 10 from https://dotnet.microsoft.com/,"  -ForegroundColor Red
    Write-Host "then re-run this script (a fresh 'iisreset' may be needed for IIS to" -ForegroundColor Red
    Write-Host "notice the newly registered module)." -ForegroundColor Red
    throw "ASP.NET Core Module v2 (AspNetCoreModuleV2) is not registered in IIS's applicationHost.config, and aspnetcorev2.dll wasn't found under either of its known install locations."
}
Write-Host "ASP.NET Core Module v2 found: $ancmPath" -ForegroundColor Green

$siteName    = 'NormantonNexus'
$appPoolName = 'NormantonNexus'
$publishDir  = (Resolve-Path "$PSScriptRoot\..\publish").Path
# Matches server.js's own real bindings exactly (443 HTTPS serves the app,
# 80 HTTP does nothing but redirect to it) — see Program.cs's
# UseHttpsRedirection wiring, which is what actually performs that redirect
# once both bindings exist on this site.
$httpPort  = 80
$httpsPort = 443

# ---- Machine environment variables ------------------------------------------
# ASPNETCORE_ENVIRONMENT has to be an env var - it's what WebApplication.
# CreateBuilder(args) reads to pick which appsettings.{Environment}.json
# layers on top of appsettings.json. CONFIRMED FOR REAL that a machine-level
# value like this one is NOT sufficient on its own: WAS (Windows Process
# Activation Service) caches its own environment block from whenever WAS
# itself last started, and hands that cached block to every worker process
# it spawns from then on - a value set (or changed) here while WAS is
# already running is invisible to new worker processes until a full
# `iisreset` or machine reboot, not just an app-pool recycle. NormantonNexus/
# web.config now sets ASPNETCORE_ENVIRONMENT directly in its own
# <aspNetCore><environmentVariables> block instead (see that file's own
# comment) - ANCM reads that straight from web.config at process-launch
# time, completely bypassing WAS's cached environment, so a plain app-pool
# restart (what deploy.ps1 already does) is enough to pick up a change
# there. This machine-level var is set below anyway as a harmless fallback
# (e.g. for `dotnet <dll>` run directly outside IIS), but web.config's own
# setting is what this app actually depends on in production.
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
# recycling.periodicRestart.schedule is a COLLECTION property (a list of
# scheduled restart times), not a scalar - confirmed for real that
# Set-ItemProperty -Value @() throws "Object reference not set to an
# instance of an object" against it (a documented WebAdministration
# provider gotcha: Set-ItemProperty's collection handling is broken for
# this property). Clear-ItemProperty is the correct way to empty a
# collection-type IIS config property through this provider.
Clear-ItemProperty "IIS:\AppPools\$appPoolName" -Name recycling.periodicRestart.schedule
Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.idleTimeout -Value '00:00:00'

# ---- Site ---------------------------------------------------------------
Write-Host "Creating site '$siteName' (physical path: $publishDir, port: $httpPort)..."
if (Get-Website -Name $siteName -ErrorAction SilentlyContinue) {
    Write-Host "Site already exists - leaving its bindings as-is." -ForegroundColor DarkGray
} else {
    # New-Website's own -Port only takes one binding at a time - the :443
    # binding is added separately just below.
    New-Website -Name $siteName -PhysicalPath $publishDir -ApplicationPool $appPoolName -Port $httpPort | Out-Null
}

# ---- :443 https binding (no certificate attached yet) -----------------
# The binding itself is created now - production is meant to be HTTPS-only
# (see Program.cs's UseHttpsRedirection) and there's no reason to wait on a
# certificate to at least get IIS listening on the port. Http.sys will
# accept the binding with no certificate bound; it just can't complete a TLS
# handshake on it until one is attached - a curl/browser hit against :443
# will fail at the TLS layer (connection reset / "no certificate configured
# for this port") rather than getting a real response, which is expected and
# harmless until the certificate step below is done.
if (-not (Get-WebBinding -Name $siteName -Protocol https -Port $httpsPort -ErrorAction SilentlyContinue)) {
    Write-Host "Adding https binding on port $httpsPort (no certificate attached yet)..."
    New-WebBinding -Name $siteName -Protocol https -Port $httpsPort -IPAddress '*' -SslFlags 0 | Out-Null
} else {
    Write-Host "https binding on port $httpsPort already exists - leaving it as-is." -ForegroundColor DarkGray
}

# ---- SSL certificate --------------------------------------------------
# Deliberately still a manual step, same posture as the sibling SapServer
# repo's own install.ps1 - a wrong or self-signed cert attached here would be
# actively worse than no certificate at all, and this script has no way to
# confirm which real certificate is the right one for this site. The Node
# app's own certs\cert.pem/certs\key.pem are the same underlying certificate
# this binding needs, just in the wrong format for IIS (which needs it in
# the Windows certificate store, not raw PEM files on disk).
Write-Host ""
Write-Host "*** Reminder: no certificate is attached to the :$httpsPort binding yet ***" -ForegroundColor Yellow
Write-Host "The site won't actually serve HTTPS until you:" -ForegroundColor Yellow
Write-Host "  1. Get the certificate into the Windows certificate store (Cert:\LocalMachine\My)." -ForegroundColor Yellow
Write-Host "     If you only have certs\cert.pem + certs\key.pem (the Node app's own files)," -ForegroundColor Yellow
Write-Host "     combine them into a .pfx first, e.g.:" -ForegroundColor Yellow
Write-Host "       openssl pkcs12 -export -out normanton-nexus.pfx -inkey certs\key.pem -in certs\cert.pem" -ForegroundColor Yellow
Write-Host "     then: Import-PfxCertificate -FilePath normanton-nexus.pfx -CertStoreLocation Cert:\LocalMachine\My" -ForegroundColor Yellow
Write-Host "  2. Assign it to the existing :$httpsPort binding, e.g.:" -ForegroundColor Yellow
Write-Host "       `$thumbprint = (Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -like '*normanton*').Thumbprint" -ForegroundColor Yellow
Write-Host "       (Get-WebBinding -Name '$siteName' -Protocol https -Port $httpsPort).AddSslCertificate(`$thumbprint, 'My')" -ForegroundColor Yellow
Write-Host "Until then, plain HTTP on port $httpPort still works for /health (see Program.cs's" -ForegroundColor Yellow
Write-Host "UseHttpsRedirection exemption) but every other request will redirect to a :$httpsPort" -ForegroundColor Yellow
Write-Host "that can't complete a TLS handshake yet." -ForegroundColor Yellow

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
Write-Host "Site registered on http://localhost:$httpPort (see the SSL certificate step" -ForegroundColor Yellow
Write-Host "above if the :$httpsPort https binding still needs a real certificate attached)." -ForegroundColor Yellow
Write-Host ""
Write-Host "Run 'deploy.ps1' to publish the app into $publishDir and start the site." -ForegroundColor Green
