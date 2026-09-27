# Protect controller state from another Windows identity.
#
# Default ACL on each existing state file (inheritance removed):
#   NT AUTHORITY\SYSTEM:F
#   BUILTIN\Administrators:F
#
# -PlannerIdentity DENIES read to that account (for example a dedicated
# planner user). This does nothing useful when the planner is the same
# account as the controller, and an Administrators member can take ownership.
# Software approval separation requires a different OS identity plus this deny.
#
# Usage (on the controller, elevated):
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 -StateDir C:\TransfertHQ -PlannerIdentity "TAILNET\planner"
param(
    [string]$StateDir = (Get-Location).Path,
    [string]$PlannerIdentity = ""
)
$ErrorActionPreference = "Stop"
$Names = @("hq_agents.json", "hq_agent_jobs.json", "hq_planner.json")
foreach ($name in $Names) {
    $path = Join-Path $StateDir $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Absent, ignoré: $path"
        continue
    }
    icacls $path /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
    if ($PlannerIdentity) {
        icacls $path /deny "${PlannerIdentity}:(R)" | Out-Null
        Write-Host "Lecture refusée à ${PlannerIdentity}: $path"
    } else {
        Write-Host "ACL resserrée (SYSTEM, Administrators): $path"
    }
}
Write-Host "Sans -PlannerIdentity, un planificateur du même compte peut encore lire hq_agents.json."
