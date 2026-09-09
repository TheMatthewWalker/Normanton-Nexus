# watch-log.ps1 - Tail NormantonNexus's current ANCM stdout log.
#
# Unlike SapServer (a dedicated Serilog File sink writing one predictable
# daily-rolling filename), this app has no structured file sink of its own
# yet - what gets tailed here is ASP.NET Core Module v2's own stdout capture
# (this app's web.config sets stdoutLogEnabled=true), which is both ANCM's
# own startup diagnostics AND everything the app's default console logging
# provider writes, all interleaved into one file per worker-process start
# (stdout_<timestamp>_<pid>.log - not a daily file). install.ps1 disables
# app-pool recycling entirely (see its own comment on the Quartz.NET
# app-pool-recycle risk), so in practice this file stays "the current log"
# for as long as the worker process keeps running, not just for one day.

$publishDir = "$PSScriptRoot\..\publish"
$logDir = Join-Path $publishDir "logs"
$maxWaitSeconds = 120

$host.UI.RawUI.WindowTitle = "NormantonNexus Log"

Write-Host "NormantonNexus Log Watcher" -ForegroundColor Cyan
Write-Host "Waiting for the current stdout log file..." -ForegroundColor DarkGray

$waited = 0
$logFile = $null
while ($waited -lt $maxWaitSeconds) {
    $logFile = Get-ChildItem $logDir -Filter "stdout*.log" -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending |
               Select-Object -First 1
    if ($logFile) { break }
    Start-Sleep -Seconds 2
    $waited += 2
}

if (-not $logFile) {
    Write-Host "No stdout log file found under $logDir after ${maxWaitSeconds}s." -ForegroundColor Yellow
    Write-Host "Server may not have started yet. Press any key to exit." -ForegroundColor DarkGray
    $null = $host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host "Tailing: $($logFile.FullName)" -ForegroundColor Green
Write-Host ("-" * 80)
Get-Content $logFile.FullName -Wait -Tail 50
