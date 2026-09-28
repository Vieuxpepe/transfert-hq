# Remove the Transfert HQ Companion scheduled task.
# Secrets and work files stay unless -DeleteData is passed.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\uninstall_companion.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall_companion.ps1 -DeleteData
param(
    [switch]$DeleteData
)
$ErrorActionPreference = "Stop"
$TaskName = "TransfertHQ Companion"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Tâche retirée (si elle existait): $TaskName"
$Dest = Join-Path $env:ProgramData "TransfertHQ"
if ($DeleteData) {
    if (Test-Path $Dest) {
        Remove-Item -LiteralPath $Dest -Recurse -Force
        Write-Host "Données supprimées: $Dest"
    }
} else {
    Write-Host "Secrets et dossiers conservés dans $Dest. Relancer avec -DeleteData pour tout effacer."
}
