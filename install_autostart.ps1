# Install / refresh the logon autostart of the Transfert HQ bridge.
#
# One definition only: the scheduled task runs start_bridge_hidden.vbs -> start_bridge_logged.cmd -> the bridge.
# That chain logs stdout/stderr, refuses a second copy and publishes the identity the restarter needs.
#
# The VBS is a tracked file and is NEVER regenerated here. An earlier version of this installer rewrote it from an
# inline template that ran py.exe with no redirection: re-running the installer silently removed the crash log, and
# registered a task action that diverged from the one actually in use.
#
# Autostart always starts the live checkout (state root = this folder, port 8765). A side-by-side release lives
# outside this folder and is started with start_release.ps1, not at logon.
param(
    [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
$taskName = 'TransfertBridge'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'start_bridge_hidden.vbs'
$cmd = Join-Path $root 'start_bridge_logged.cmd'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Scheduled task '$taskName' removed."
    exit 0
}

foreach ($file in @($vbs, $cmd)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Missing launcher: $file"
    }
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# ExecutionTimeLimit zero: a bridge is meant to run for weeks, and the default 72h limit killed it mid-session.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Scheduled task '$taskName' installed for $env:USERNAME"
Write-Host ("  action     : wscript.exe `"{0}`"" -f $vbs)
Write-Host ("  launcher   : {0}" -f $cmd)
Write-Host ("  state root : {0} (live checkout default)" -f $root)
Write-Host ("  logs       : {0}" -f (Join-Path $root 'bridge_stdout.log'))
Write-Host "  restart    : Restart-Bridge.bat, or POST /api/pc/restart-bridge from the page"
