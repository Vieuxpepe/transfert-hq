# Allowlist ACL for the private companion state directory.
#
# State lives in <StateDir>\.hq-agent-state\ so atomic writes
# (hq_agents.json.tmp, then os.replace) inherit this directory instead of
# the HQ root. Artifacts stay in Inbox\AgentArtifacts and are not moved.
#
# Directory (inheritance enabled for children):
#   NT AUTHORITY\SYSTEM          FullControl   ContainerInherit, ObjectInherit
#   BUILTIN\Administrators       FullControl   ContainerInherit, ObjectInherit
#   ControllerIdentity           Modify        ContainerInherit, ObjectInherit
#   PlannerIdentity              Traverse only InheritanceFlags.None
#                                (not inheritable: no child-file read)
#
# hq_planner.json, when it already exists, also gets an explicit
# PlannerIdentity Read ACE. That ACE is not inheritable and is not Modify.
# hq_agents.json and hq_agent_jobs.json get no planner grant. A later
# *.tmp file inherits only the directory ACEs, so the planner cannot read it.
#
# The token file is created once. This script does not rotate it. If
# hq_planner.json is absent, re-run the script after the first controller
# start so the explicit Read ACE exists. Replacing that file later would
# drop the explicit ACE; normal HQ writes do not replace it.
#
# Intended identities: two different non-admin accounts.
#   ControllerIdentity  runs iphone_bridge.py
#   PlannerIdentity     runs hqctl, which reads
#                       <StateDir>\.hq-agent-state\hq_planner.json
#
# Abort when the identities match, or when the planner is Administrator
# or SYSTEM. Administrators group membership still defeats the split.
# No deny ACEs.
#
# Example (elevated), after HQ has created the directory once:
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 `
#     -StateDir C:\TransfertHQ `
#     -ControllerIdentity "TAILNET\hq-controller" `
#     -PlannerIdentity "TAILNET\hq-planner"
#
# Then verify on Windows with Get-Acl before any second-PC enrollment.
# See README.txt, "Vérification Windows des ACL".
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

$inheritChildren = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$noInherit = [System.Security.AccessControl.InheritanceFlags]::None
$propagate = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow

function Add-AllowRule($Acl, [string]$Identity, $Rights, $Inheritance) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $Identity,
        $Rights,
        $Inheritance,
        $propagate,
        $allow
    )
    $Acl.AddAccessRule($rule)
}

function Clear-ExplicitRules($Acl) {
    foreach ($existing in @($Acl.Access)) {
        if (-not $existing.IsInherited) {
            [void]$Acl.RemoveAccessRule($existing)
        }
    }
}

$private = Join-Path $StateDir ".hq-agent-state"
if (-not (Test-Path -LiteralPath $private)) {
    New-Item -ItemType Directory -Path $private | Out-Null
}

$dirAcl = Get-Acl -LiteralPath $private
# Drop HQ-root Users/Everyone inheritance. Do not copy those ACEs.
$dirAcl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($dirAcl.Access)) {
    [void]$dirAcl.RemoveAccessRule($existing)
}
Add-AllowRule $dirAcl "NT AUTHORITY\SYSTEM" "FullControl" $inheritChildren
Add-AllowRule $dirAcl "BUILTIN\Administrators" "FullControl" $inheritChildren
Add-AllowRule $dirAcl $ControllerIdentity.Trim() "Modify" $inheritChildren
# Traverse only. InheritanceFlags.None: PlannerIdentity must not inherit child-file read.
# *.tmp siblings created by write_json_atomic inherit the directory ACL above, not this ACE.
$plannerTraverse = (
    [System.Security.AccessControl.FileSystemRights]::Traverse -bor
    [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
)
Add-AllowRule $dirAcl $PlannerIdentity.Trim() $plannerTraverse $noInherit
Set-Acl -LiteralPath $private -AclObject $dirAcl
Write-Host "Répertoire privé: $private"

# controller files: inherit directory ACL, no planner grant
foreach ($name in @("hq_agents.json", "hq_agent_jobs.json")) {
    $path = Join-Path $private $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Pas encore créé (héritera du répertoire): $path"
        continue
    }
    $acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($false, $false)
    Clear-ExplicitRules $acl
    Set-Acl -LiteralPath $path -AclObject $acl
    Write-Host "Héritage contrôleur seulement: $path"
}

# planner token: explicit Read only
$tokenPath = Join-Path $private "hq_planner.json"
if (Test-Path -LiteralPath $tokenPath) {
    $tokenAcl = Get-Acl -LiteralPath $tokenPath
    $tokenAcl.SetAccessRuleProtection($false, $false)
    Clear-ExplicitRules $tokenAcl
    Add-AllowRule $tokenAcl $PlannerIdentity.Trim() "Read" $noInherit
    Set-Acl -LiteralPath $tokenPath -AclObject $tokenAcl
    Write-Host "Lecture seule planificateur: $tokenPath"
} else {
    Write-Warning "hq_planner.json absent. Relancer ce script après le premier démarrage du pont, sinon le planificateur n'a pas de lecture explicite."
}
Write-Host "ACL de répertoire posée. Contrôleur: $ControllerIdentity. Planificateur (lecture de .hq-agent-state\hq_planner.json): $PlannerIdentity."
