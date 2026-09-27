# Install the Transfert HQ Companion on a trusted Windows PC.
# Outbound only: no firewall port, no inbound listener, no self-update.
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
Write-Host "Companion copié dans $Dest"
Write-Host "1. Sur Vieuxpeepee : Centre agents → Créer un jeton"
Write-Host "2. py -3 `"$Dest\companion_agent.py`" --config `"$ConfigPath`" --controller $Controller --name `"$Name`" --workspace `"$Work`" --enroll JETON"
Write-Host "3. Ensuite, sans --enroll, le même script interroge le pont (pas de port entrant)."
Write-Host "Le terminal interactif et l'auto-mise à jour ne sont pas installés."
