# watch-log.ps1 - Tail the Normanton Nexus (sql2005-bridge) service logs.
# Opens in a visible terminal window at logon via the NormantonNexusLog scheduled task.

$daemonDir = "$PSScriptRoot\..\daemon"
$outLog    = Join-Path $daemonDir 'normantonnexus.out.log'
$errLog    = Join-Path $daemonDir 'normantonnexus.err.log'

$host.UI.RawUI.WindowTitle = "Normanton Nexus Log"

Write-Host "Normanton Nexus Log Watcher" -ForegroundColor Cyan
Write-Host ("-" * 80)

# Show the last few lines of the error log upfront so issues are visible immediately
if (Test-Path $errLog) {
    $recentErrors = Get-Content $errLog -Tail 5 | Where-Object { $_ -ne '' }
    if ($recentErrors) {
        Write-Host "Recent errors (normantonnexus.err.log):" -ForegroundColor Yellow
        $recentErrors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host ("-" * 80)
    }
}

Write-Host "Tailing: $outLog" -ForegroundColor Green
Write-Host "(Errors go to: $errLog)" -ForegroundColor DarkGray
Write-Host ("-" * 80)

Get-Content $outLog -Wait -Tail 50
