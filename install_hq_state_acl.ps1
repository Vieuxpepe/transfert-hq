# Allowlist ACL for Transfert HQ controller state.
#
# Intended identities (two different non-admin Windows accounts):
#   ControllerIdentity  the account that runs iphone_bridge.py
#                       Modify on hq_agents.json, hq_agent_jobs.json, hq_planner.json
#   PlannerIdentity     the account that runs hqctl and reads hq_planner.json
#                       Read on hq_planner.json only
#                       no grant on hq_agents.json or hq_agent_jobs.json
#   NT AUTHORITY\SYSTEM and BUILTIN\Administrators
#                       Full control on all three files
#
# Inherited Users / Everyone access is removed. This script does not add
# deny ACEs. Missing principals are simply not granted.
#
# hqctl, run as PlannerIdentity, keeps its default of reading hq_planner.json
# (--token-file or {root}/hq_planner.json). That file is not writable by the
# planner.
#
# This is NOT an OS boundary when:
#   - ControllerIdentity and PlannerIdentity are the same account
#   - PlannerIdentity is Administrator, Administrators, or SYSTEM
#   - PlannerIdentity is a member of Administrators (this script cannot see
#     group membership; it only warns)
#   - the planner can read the state directory some other way
# The first two cases abort. Do not claim OS-level separation for the others.
#
# Example (elevated), from the bridge directory:
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 `
#     -StateDir C:\TransfertHQ `
#     -ControllerIdentity "TAILNET\hq-controller" `
#     -PlannerIdentity "TAILNET\hq-planner"
param(
    [Parameter(Mandatory = $true)]
    [string]$ControllerIdentity,
    [Parameter(Mandatory = $true)]
    [string]$PlannerIdentity,
    [string]$StateDir = (Get-Location).Path
)
$ErrorActionPreference = "Stop"

function ConvertTo-IdentityKey([string]$Name) {
    return $Name.Trim().ToLowerInvariant()
}

$controllerKey = ConvertTo-IdentityKey $ControllerIdentity
$plannerKey = ConvertTo-IdentityKey $PlannerIdentity
if (-not $controllerKey -or -not $plannerKey) {
    throw "REFUS: ControllerIdentity et PlannerIdentity sont obligatoires."
}
if ($controllerKey -eq $plannerKey) {
    throw "REFUS: ControllerIdentity et PlannerIdentity sont identiques. Pas de séparation OS. ACL non appliquée."
}
$plannerAccount = ($PlannerIdentity.Trim() -split "\\")[-1].ToLowerInvariant()
$blocked = @(
    "administrator",
    "administrators",
    "builtin\administrators",
    "nt authority\system",
    "system",
    "localhost\administrator"
)
if ($blocked -contains $plannerKey -or $blocked -contains $plannerAccount) {
    throw "REFUS: PlannerIdentity est Administrator ou SYSTEM. La séparation OS ne tient pas. ACL non appliquée."
}
Write-Warning "SEPARATION OS NON GARANTIE si PlannerIdentity est membre du groupe Administrateurs, ou s'il peut lire l'état du contrôleur par un autre chemin. Ne pas prétendre à une séparation dans ce cas."

function Add-AllowRule(
    [System.Security.AccessControl.FileSecurity]$Acl,
    [string]$Identity,
    [string]$Rights
) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $Identity,
        [System.Security.AccessControl.FileSystemRights]$Rights,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $Acl.AddAccessRule($rule)
}

# PlannerRead $false: controller state. PlannerRead $true: bearer file, read only.
$Files = @(
    @{ Name = "hq_agents.json"; PlannerRead = $false },
    @{ Name = "hq_agent_jobs.json"; PlannerRead = $false },
    @{ Name = "hq_planner.json"; PlannerRead = $true }
)

foreach ($file in $Files) {
    $path = Join-Path $StateDir $file.Name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Absent, ignoré: $path"
        continue
    }
    $acl = Get-Acl -LiteralPath $path
    # Drop inherited Users/Everyone entries. Do not copy them.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($existing)
    }
    Add-AllowRule $acl "NT AUTHORITY\SYSTEM" "FullControl"
    Add-AllowRule $acl "BUILTIN\Administrators" "FullControl"
    Add-AllowRule $acl $ControllerIdentity.Trim() "Modify"
    if ($file.PlannerRead) {
        # Read only. The planner must not rewrite its own credential file.
        Add-AllowRule $acl $PlannerIdentity.Trim() "Read"
        Write-Host "Lecture seule planificateur: $path"
    } else {
        Write-Host "Contrôleur seulement (pas de grant planificateur): $path"
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
Write-Host "ACL allowlist posée. Contrôleur: $ControllerIdentity. Planificateur (lecture de hq_planner.json): $PlannerIdentity."
