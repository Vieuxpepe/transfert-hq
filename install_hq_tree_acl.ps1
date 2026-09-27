# Allowlist ACL for the Transfert HQ tree (code and ordinary data).
#
# This script does not touch <StateDir>\.hq-agent-state.
# After it, run install_hq_state_acl.ps1 with the same identities.
# That second script remains the only policy for:
#   hq_agents.json       planner: no access
#   hq_agent_jobs.json   planner: no access
#   hq_planner.json      planner: Read only
#   *.tmp                planner: no access
#
# Normal tree, inheritable from StateDir:
#   NT AUTHORITY\SYSTEM        FullControl
#   BUILTIN\Administrators     FullControl
#   ControllerIdentity         Modify
#   PlannerIdentity            ReadAndExecute
# PlannerIdentity must not receive Modify, Write, or FullControl.
# No ACE is added for Everyone or for a broad Users write grant.
# No deny ACE.
#
# bridge_config.json and bridge_sessions.json break inheritance and keep
# only SYSTEM, Administrators, and ControllerIdentity. The planner gets
# neither read nor write. A missing file is a warning, not a silent success.
# File bytes are never printed.
#
# Code the controller executes inherits ReadAndExecute for the planner and
# Modify for the controller. The planner must not be able to rewrite at least:
#   iphone_bridge.py, cc_ext.py, hq_companion.py, hq_jobs.py, hq_planner.py,
#   hq_state.py, hq_agent_protocol.py, hq_agent_ops.py,
#   start_bridge_hidden.vbs, install_autostart.ps1
#
# The scheduled task TransfertBridge stays owned by ControllerIdentity
# (example VIEUXPEEPEE\autm_). This script does not create, delete, or
# re-register that task. hq-planner is not an administrator and cannot
# change the task without elevation.
#
# The walk only replaces ACLs. It does not delete data, does not rewrite
# file bytes, does not enter .git, and does not follow junctions.
#
# Example (elevated), on the bridge, before any companion enrollment:
#   powershell -ExecutionPolicy Bypass -File .\install_hq_tree_acl.ps1 `
#     -StateDir D:\Transfert `
#     -ControllerIdentity "VIEUXPEEPEE\autm_" `
#     -PlannerIdentity "VIEUXPEEPEE\hq-planner"
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 `
#     -StateDir D:\Transfert `
#     -ControllerIdentity "VIEUXPEEPEE\autm_" `
#     -PlannerIdentity "VIEUXPEEPEE\hq-planner"
# Dry-run: add -WhatIf. It still requires elevation and changes nothing.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ControllerIdentity,
    [Parameter(Mandatory = $true)]
    [string]$PlannerIdentity,
    [Parameter(Mandatory = $true)]
    [string]$StateDir
)
$ErrorActionPreference = "Stop"

function ConvertTo-IdentityKey([string]$Name) {
    return $Name.Trim().ToLowerInvariant()
}

$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object Security.Principal.WindowsPrincipal($current)
if (-not $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "REFUS: élévation requise pour installer l'ACL de l'arbre."
}

$controllerKey = ConvertTo-IdentityKey $ControllerIdentity
$plannerKey = ConvertTo-IdentityKey $PlannerIdentity
if (-not $controllerKey -or -not $plannerKey) {
    throw "REFUS: ControllerIdentity et PlannerIdentity sont obligatoires."
}
if ($controllerKey -eq $plannerKey) {
    throw "REFUS: ControllerIdentity et PlannerIdentity sont identiques. ACL non appliquée."
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
    throw "REFUS: PlannerIdentity est Administrator ou SYSTEM. ACL non appliquée."
}
Write-Warning "SEPARATION OS NON GARANTIE si PlannerIdentity est membre du groupe Administrateurs. Ce script ne peut pas exclure cette appartenance de façon certaine."

if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) {
    throw "REFUS: StateDir introuvable: $StateDir"
}

$privateState = Join-Path $StateDir ".hq-agent-state"
Write-Host "Cible: $StateDir"
Write-Host "Contrôleur: $ControllerIdentity"
Write-Host "Planificateur: $PlannerIdentity"
Write-Host "Etat privé délégué (non modifié ici): $privateState -> install_hq_state_acl.ps1"
Write-Host "Tâche TransfertBridge: principal laissé à ControllerIdentity. Ce script ne la modifie pas."

$inheritChildren = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$noInherit = [System.Security.AccessControl.InheritanceFlags]::None
$propagate = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
# Write-capable bits only. Modify and FullControl are composite values that
# include ReadAndExecute, so they must not be OR-ed into this mask: a band
# test would then treat a planner ReadAndExecute ACE as write.
$writeBits = (
    [System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)

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

function Test-IsPlanner([string]$Identity) {
    $key = ConvertTo-IdentityKey $Identity
    $account = ($Identity.Trim() -split "\\")[-1].ToLowerInvariant()
    return ($key -eq $plannerKey -or $account -eq $plannerAccount)
}

function Test-PlannerCanWrite($Acl) {
    foreach ($rule in @($Acl.Access)) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        if (-not (Test-IsPlanner $rule.IdentityReference.Value)) {
            continue
        }
        if (($rule.FileSystemRights -band $writeBits) -ne 0) {
            return $true
        }
    }
    return $false
}

function Test-PlannerHasReadExecute($Acl) {
    $readExec = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    foreach ($rule in @($Acl.Access)) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        if (-not (Test-IsPlanner $rule.IdentityReference.Value)) {
            continue
        }
        if (($rule.FileSystemRights -band $readExec) -eq $readExec) {
            return $true
        }
    }
    return $false
}

function Test-PlannerHasAnyAllow($Acl) {
    foreach ($rule in @($Acl.Access)) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        if (Test-IsPlanner $rule.IdentityReference.Value) {
            return $true
        }
    }
    return $false
}

$dirAcl = Get-Acl -LiteralPath $StateDir
$dirAcl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($dirAcl.Access)) {
    [void]$dirAcl.RemoveAccessRule($existing)
}
Add-AllowRule $dirAcl "NT AUTHORITY\SYSTEM" "FullControl" $inheritChildren
Add-AllowRule $dirAcl "BUILTIN\Administrators" "FullControl" $inheritChildren
Add-AllowRule $dirAcl $ControllerIdentity.Trim() "Modify" $inheritChildren
Add-AllowRule $dirAcl $PlannerIdentity.Trim() "ReadAndExecute" $inheritChildren
if (Test-PlannerCanWrite $dirAcl) {
    throw "REFUS: l'allowlist de l'arbre donnerait une écriture au planificateur."
}
if ($PSCmdlet.ShouldProcess($StateDir, "allowlist héritée (contrôleur Modify, planificateur ReadAndExecute)")) {
    Set-Acl -LiteralPath $StateDir -AclObject $dirAcl
}

function Reset-ExplicitAces([string]$Path) {
    if (-not $PSCmdlet.ShouldProcess($Path, "retrait des ACE explicites, héritage de l'arbre")) {
        return
    }
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($false, $false)
    foreach ($rule in @($acl.Access)) {
        if (-not $rule.IsInherited) {
            [void]$acl.RemoveAccessRule($rule)
        }
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$pending = New-Object System.Collections.Generic.Queue[string]
$pending.Enqueue($StateDir)
while ($pending.Count -gt 0) {
    $dir = $pending.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
        if ($item.Name -eq ".hq-agent-state") {
            Write-Host "Ignoré, délégué à install_hq_state_acl.ps1: $($item.FullName)"
            continue
        }
        if ($item.Name -eq ".git") {
            Write-Host "Ignoré, dépôt git non modifié: $($item.FullName)"
            continue
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Write-Host "Jonction ignorée: $($item.FullName)"
            continue
        }
        Reset-ExplicitAces $item.FullName
        if ($item.PSIsContainer) {
            $pending.Enqueue($item.FullName)
        }
    }
}

# sensitive files: planner excluded
foreach ($name in @("bridge_config.json", "bridge_sessions.json")) {
    $path = Join-Path $StateDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Warning "ABSENT, NON PROTÉGÉ: $path. Aucun contenu affiché. Relancer ce script quand le fichier existe."
        continue
    }
    if (-not $PSCmdlet.ShouldProcess($path, "allowlist sans lecture planificateur")) {
        continue
    }
    $acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
    }
    Add-AllowRule $acl "NT AUTHORITY\SYSTEM" "FullControl" $noInherit
    Add-AllowRule $acl "BUILTIN\Administrators" "FullControl" $noInherit
    Add-AllowRule $acl $ControllerIdentity.Trim() "Modify" $noInherit
    if (Test-PlannerHasAnyAllow $acl) {
        throw "REFUS: $name laisserait un accès au planificateur."
    }
    Set-Acl -LiteralPath $path -AclObject $acl
    Write-Host "Protégé sans accès planificateur: $path"
}

# code integrity: planner ReadAndExecute via inheritance, never Modify
$CodeFiles = @(
    "iphone_bridge.py",
    "cc_ext.py",
    "hq_companion.py",
    "hq_jobs.py",
    "hq_planner.py",
    "hq_state.py",
    "hq_agent_protocol.py",
    "hq_agent_ops.py",
    "start_bridge_hidden.vbs",
    "install_autostart.ps1"
)
if (-not $WhatIfPreference) {
    foreach ($name in $CodeFiles) {
        $path = Join-Path $StateDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Write-Warning "Fichier de code absent, aucun droit ajouté: $path"
            continue
        }
        $acl = Get-Acl -LiteralPath $path
        if (Test-PlannerCanWrite $acl) {
            throw "REFUS: $name laisserait une écriture au planificateur."
        }
        if (-not (Test-PlannerHasReadExecute $acl)) {
            throw "REFUS: $name n'accorde pas ReadAndExecute au planificateur."
        }
        Write-Host "Code lisible par le planificateur, non modifiable: $path"
    }
}

try {
    $task = Get-ScheduledTask -TaskName "TransfertBridge" -ErrorAction SilentlyContinue
} catch {
    $task = $null
}
if ($null -eq $task) {
    Write-Host "Tâche TransfertBridge absente. Ce script ne la crée pas."
} else {
    $taskUser = [string]$task.Principal.UserId
    Write-Host "Tâche TransfertBridge inchangée. Principal actuel: $taskUser"
    if ($taskUser -and ((ConvertTo-IdentityKey $taskUser) -ne $controllerKey)) {
        Write-Warning "Le principal TransfertBridge ($taskUser) n'est pas ControllerIdentity. Ce script ne le modifie pas."
    }
}
Write-Host "ACL d'arbre préparée. Enchaîner avec install_hq_state_acl.ps1 sur le même StateDir."
