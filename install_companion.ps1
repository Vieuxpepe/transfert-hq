# Install the Transfert HQ Companion on a trusted Windows PC.
# Outbound only: no firewall port, no inbound listener, no self-update.
#
# ACL after copy (inheritance removed):
#   NT AUTHORITY\SYSTEM:(OI)(CI)(F)
#   BUILTIN\Administrators:(OI)(CI)(F)
#   <installing user>:(OI)(CI)(M)
# The companion identity keeps Modify so it can read agent_config.json.
# Broad inherited Everyone / Users access is dropped.
#
# Scheduled task "TransfertHQ Companion":
#   Trigger: at logon of the installing user (not before that user signs in).
#   Hidden: false (visible in Task Scheduler).
#   Action: py -3 <companion_agent.py> --config <agent_config.json>
#   WorkingDirectory: %ProgramData%\TransfertHQ
#   The device secret is only in the config file, never on the command line.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install_companion.ps1 -Controller https://VIEUXPEEPEE.TAILNET.ts.net
param(
    [string]$Controller = "https://VIEUXPEEPEE.TAILNET.ts.net",
    [string]$Name = $env:COMPUTERNAME
)
$ErrorActionPreference = "Stop"
if ($Controller -notmatch "^https://") {
    throw "Le contrôleur doit être en HTTPS (Tailscale Serve). Pas de port public."
}
$Dest = Join-Path $env:ProgramData "TransfertHQ"
$Work = Join-Path $Dest "work"
New-Item -ItemType Directory -Force -Path $Dest, $Work | Out-Null
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Files = @(
    "companion_agent.py",
    "companion_ops.py",
    "hq_agent_ops.py",
    "hq_agent_protocol.py",
    "hq_devices.py",
    "hq_state.py"
)
foreach ($name in $Files) {
    Copy-Item (Join-Path $Here $name) (Join-Path $Dest $name) -Force
}
$ConfigPath = Join-Path $Dest "agent_config.json"
if (-not (Test-Path $ConfigPath)) {
    $template = @{
        controller_url = $Controller
        device_id = ""
        device_secret = ""
        protocol_version = 1
        workspaces = @($Work)
        terminal_allowlist = @()
        apps = @()
        clipboard_enabled = $false
        destructive_power_enabled = $false
        poll_sec = 3
        idle_poll_sec = 15
        dev = $false
    } | ConvertTo-Json -Depth 4
    Set-Content -Path $ConfigPath -Value $template -Encoding UTF8
}

$aclUser = "$env:USERDOMAIN\$env:USERNAME"
icacls $Dest /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${aclUser}:(OI)(CI)M" | Out-Null
icacls $ConfigPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${aclUser}:M" | Out-Null

$ScriptPath = Join-Path $Dest "companion_agent.py"
$TaskArg = "-3 `"$ScriptPath`" --config `"$ConfigPath`""
$Action = New-ScheduledTaskAction -Execute "py.exe" -Argument $TaskArg -WorkingDirectory $Dest
$Trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden:$false
Register-ScheduledTask -TaskName "TransfertHQ Companion" -Action $Action -Trigger $Trigger -Settings $Settings -Force -Description "Transfert HQ companion. Config path only; secret stays in agent_config.json. Runs at logon of the installing user." | Out-Null

Write-Host "Companion copié dans $Dest"
Write-Host "ACL: SYSTEM et Administrators en contrôle total, $aclUser en modification, héritage retiré."
Write-Host "Tâche: TransfertHQ Companion, visible, au logon de $env:USERNAME, dossier $Dest."
Write-Host "1. Sur Vieuxpeepee : Centre agents → Créer un jeton"
Write-Host "2. py -3 `"$ScriptPath`" --config `"$ConfigPath`" --controller $Controller --name `"$Name`" --workspace `"$Work`" --enroll JETON"
Write-Host "3. Ensuite la tâche planifiée interroge le pont (pas de port entrant)."
Write-Host "Le terminal interactif et l'auto-mise à jour ne sont pas installés."
