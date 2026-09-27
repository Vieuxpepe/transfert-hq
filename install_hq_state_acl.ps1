# Allowlist ACL and owner for the private companion state directory.
#
# State lives in <StateDir>\.hq-agent-state\ so atomic writes
# (hq_agents.json.tmp, then os.replace) inherit this directory instead of
# the HQ root. Artifacts stay in Inbox\AgentArtifacts and are not moved.
#
# Owner of the directory and of every existing file inside it is
# BUILTIN\Administrators (S-1-5-32-544). Everyone (S-1-1-0) is not a valid
# owner after this script. PlannerIdentity is never the owner. A later
# *.tmp created by the controller may be owned by that account; the planner
# is still not the owner, and the file inherits this directory DACL.
#
# Directory (inheritance enabled for children):
#   NT AUTHORITY\SYSTEM          FullControl   ContainerInherit, ObjectInherit
#   BUILTIN\Administrators       FullControl   ContainerInherit, ObjectInherit
#   ControllerIdentity           Modify        ContainerInherit, ObjectInherit
#   PlannerIdentity              Traverse only InheritanceFlags.None
#                                (not inheritable: no child-file read)
#
# hq_planner.json, when it already exists, also gets an explicit
# PlannerIdentity Read ACE. That ACE is not inheritable and is not a write.
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
# No deny ACEs. A reparse point is reported and the script stops before
# any owner or ACL write. -WhatIf writes nothing.
#
# Example (elevated), after HQ has created the directory once:
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 -WhatIf `
#     -StateDir D:\Transfert `
#     -ControllerIdentity "VIEUXPEEPEE\autm_" `
#     -PlannerIdentity "VIEUXPEEPEE\hq-planner"
#
# Then verify on Windows with Get-Acl before any second-PC enrollment.
# See README.txt, "Vérification Windows des ACL".
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ControllerIdentity,
    [Parameter(Mandatory = $true)]
    [string]$PlannerIdentity,
    [string]$StateDir = (Get-Location).Path
)
$ErrorActionPreference = "Stop"
$script:AclCmdlet = $PSCmdlet

function ConvertTo-IdentityKey([string]$Name) {
    return $Name.Trim().ToLowerInvariant()
}

$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object Security.Principal.WindowsPrincipal($current)
if (-not $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "REFUS: élévation requise pour durcir l'état privé."
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

$trustedOwner = New-Object System.Security.Principal.NTAccount("BUILTIN", "Administrators")
$administratorsSid = "S-1-5-32-544"
$everyoneSid = "S-1-1-0"
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

function Save-SecurityDescriptor([string]$Path, $Acl, [string]$Reason) {
    Write-Host "PRÉVU propriétaire=BUILTIN\Administrators $Reason :: $Path"
    if ($WhatIfPreference) {
        return
    }
    if (-not $script:AclCmdlet.ShouldProcess($Path, $Reason)) {
        return
    }
    Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Clear-ExplicitRules($Acl) {
    foreach ($existing in @($Acl.Access)) {
        if (-not $existing.IsInherited) {
            [void]$Acl.RemoveAccessRule($existing)
        }
    }
}

function Find-PrivateReparse([string]$Dir) {
    $found = New-Object System.Collections.Generic.List[string]
    $rootItem = Get-Item -LiteralPath $Dir -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $found.Add($rootItem.FullName)
        return $found
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            $found.Add($item.FullName)
            continue
        }
        if ($item.PSIsContainer) {
            foreach ($nested in @(Find-PrivateReparse $item.FullName)) {
                $found.Add($nested)
            }
        }
    }
    return $found
}

function Assert-AdministratorsOwner([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -eq $everyoneSid) {
        throw "REFUS: propriétaire Everyone conservé: $Path"
    }
    if ($owner.Value -ne $administratorsSid) {
        throw "REFUS: propriétaire autre que BUILTIN\Administrators: $Path"
    }
}

$private = Join-Path $StateDir ".hq-agent-state"
if (Test-Path -LiteralPath $private) {
    $reparsePoints = @(Find-PrivateReparse $private)
    if ($reparsePoints.Count -gt 0) {
        foreach ($reparsePath in $reparsePoints) {
            Write-Host "REFUS point de réparation (cible non suivie): $reparsePath"
        }
        throw "REFUS: point de réparation. Propriétaire et ACL non appliqués. Etat privé non durci."
    }
} else {
    Write-Host "PRÉVU créer répertoire: $private"
    if ($WhatIfPreference) {
        Write-Host "WhatIf: répertoire absent, propriétaire et ACL non écrits."
        return
    }
    if (-not $script:AclCmdlet.ShouldProcess($private, "créer le répertoire privé")) {
        return
    }
    New-Item -ItemType Directory -Path $private | Out-Null
}

$dirAcl = Get-Acl -LiteralPath $private
# Drop HQ-root Users/Everyone inheritance. Do not copy those ACEs.
$dirAcl.SetOwner($trustedOwner)
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
Save-SecurityDescriptor $private $dirAcl "DACL répertoire privé, traverse planificateur non héritable"
Write-Host "Répertoire privé: $private"

# controller files: inherit directory ACL, no planner grant
foreach ($name in @("hq_agents.json", "hq_agent_jobs.json")) {
    $path = Join-Path $private $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Pas encore créé (héritera du répertoire): $path"
        continue
    }
    $acl = Get-Acl -LiteralPath $path
    $acl.SetOwner($trustedOwner)
    $acl.SetAccessRuleProtection($false, $false)
    Clear-ExplicitRules $acl
    Save-SecurityDescriptor $path $acl "héritage contrôleur seulement"
    Write-Host "Héritage contrôleur seulement: $path"
}

# planner token: explicit Read only
$tokenPath = Join-Path $private "hq_planner.json"
if (Test-Path -LiteralPath $tokenPath) {
    $tokenAcl = Get-Acl -LiteralPath $tokenPath
    $tokenAcl.SetOwner($trustedOwner)
    $tokenAcl.SetAccessRuleProtection($false, $false)
    Clear-ExplicitRules $tokenAcl
    Add-AllowRule $tokenAcl $PlannerIdentity.Trim() "Read" $noInherit
    Save-SecurityDescriptor $tokenPath $tokenAcl "lecture seule planificateur"
    Write-Host "Lecture seule planificateur: $tokenPath"
} else {
    Write-Warning "hq_planner.json absent. Relancer ce script après le premier démarrage du pont, sinon le planificateur n'a pas de lecture explicite."
}

foreach ($item in @(Get-ChildItem -LiteralPath $private -Force -ErrorAction Stop)) {
    if ($item.Name -eq "hq_agents.json" -or $item.Name -eq "hq_agent_jobs.json" -or $item.Name -eq "hq_planner.json") {
        continue
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "REFUS: point de réparation. Etat privé non durci: $($item.FullName)"
    }
    $extra = Get-Acl -LiteralPath $item.FullName
    $extra.SetOwner($trustedOwner)
    $extra.SetAccessRuleProtection($false, $false)
    Clear-ExplicitRules $extra
    Save-SecurityDescriptor $item.FullName $extra "héritage du répertoire privé"
}

if ($WhatIfPreference) {
    Write-Host "WhatIf: propriétaire, ACL et octets inchangés."
    return
}
Assert-AdministratorsOwner $private
foreach ($item in @(Get-ChildItem -LiteralPath $private -Force -ErrorAction Stop)) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "REFUS: point de réparation. Etat privé non durci: $($item.FullName)"
    }
    Assert-AdministratorsOwner $item.FullName
}
Write-Host "ACL de répertoire posée. Propriétaire BUILTIN\Administrators. Contrôleur: $ControllerIdentity. Planificateur (lecture de .hq-agent-state\hq_planner.json): $PlannerIdentity."
