# Owner and allowlist ACL for the Transfert HQ tree.
#
# Ownership is part of the boundary. An object left owned by Everyone can
# rewrite its own DACL. Every hardened object gets owner BUILTIN\Administrators
# (S-1-5-32-544). PlannerIdentity is never an owner. Controller access is the
# explicit Modify ACE, not ownership.
#
# This script does not touch <StateDir>\.hq-agent-state, and only that path
# (compared as a full path). A directory named .hq-agent-state anywhere else
# is ordinary tree content: it takes the tree policy (explicit ACEs removed,
# inheritance restored) and is verified like any other object. The verify
# pass fails closed if any such object keeps an explicit ACE or a protected
# DACL.
# After it, run install_hq_state_acl.ps1 with the same identities.
# That second script remains the only policy for:
#   hq_agents.json       planner: no access
#   hq_agent_jobs.json   planner: no access
#   hq_planner.json      planner: Read only
#   *.tmp                planner: no access
#   owner                BUILTIN\Administrators on the directory and existing files
#
# Normal StateDir policy (children do not inherit a planner read):
#   NT AUTHORITY\SYSTEM        FullControl    inheritable
#   BUILTIN\Administrators     FullControl    inheritable
#   ControllerIdentity         Modify         inheritable
#   PlannerIdentity            Traverse only  InheritanceFlags.None
# Unknown files stay controller-private. No ACE for Everyone or Users.
# No deny ACE. PlannerIdentity never receives Modify, Write, or FullControl.
#
# Explicit planner ReadAndExecute, not inherited, only on:
#   hqctl.py
# hqctl.py imports only the standard library. It locates the token file
# itself. Invocation: py -3 -B C:\Transfert\hqctl.py
# Controller modules stay unreadable by the planner, including
#   iphone_bridge.py, cc_ext.py, hq_companion.py, hq_jobs.py, hq_planner.py,
#   hq_state.py, hq_agent_protocol.py, hq_agent_ops.py,
#   start_bridge_hidden.vbs, install_autostart.ps1
#
# bridge_config.json and bridge_sessions.json break inheritance and keep
# SYSTEM, Administrators, and ControllerIdentity only. A missing file is a
# warning. File bytes are never printed.
# Other credential-bearing names (hq_vapid.json, hq_push_subscriptions.json,
# *.pem, id_rsa*, id_ed25519*, hq_ssh, hq_ssh.ppk, agent_config.json) are
# private because planner access is not inherited. They are checked, not listed
# in order to grant anything.
#
# .git is included. Owner and DACL are normalized. Git bytes, refs, config
# text, hooks, and the index are not rewritten.
#
# A reparse point is reported by full path and the script stops before any
# owner or ACL write, and before it claims the tree is hardened. The target
# is not followed.
#
# The scheduled task TransfertBridge stays owned by ControllerIdentity
# (example VIEUXPEEPEE\autm_). This script does not create, delete, or
# re-register that task. hq-planner cannot change it without elevation.
#
# Post-apply contract for PlannerIdentity:
#   may traverse StateDir, read/execute hqctl.py,
#   read .hq-agent-state\hq_planner.json, connect to 127.0.0.1:8766
#   may not list the tree, read any other repository Python file,
#   read bridge config or sessions, read agents/jobs/vapid/keys,
#   modify controller code or .git, change a DACL by owning it,
#   alter TransfertBridge, or approve jobs
#
# Example (elevated), before any companion enrollment. -WhatIf writes nothing:
#   powershell -ExecutionPolicy Bypass -File .\install_hq_tree_acl.ps1 -WhatIf `
#     -StateDir C:\Transfert `
#     -ControllerIdentity "VIEUXPEEPEE\autm_" `
#     -PlannerIdentity "VIEUXPEEPEE\hq-planner"
#   powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 -WhatIf `
#     -StateDir C:\Transfert `
#     -ControllerIdentity "VIEUXPEEPEE\autm_" `
#     -PlannerIdentity "VIEUXPEEPEE\hq-planner"
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
$script:AclCmdlet = $PSCmdlet

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
    "administrateur",
    "administrateurs",
    "builtin\administrators",
    "builtin\administrateurs",
    "nt authority\system",
    "system",
    "localhost\administrator",
    "localhost\administrateur"
)
if ($blocked -contains $plannerKey -or $blocked -contains $plannerAccount) {
    throw "REFUS: PlannerIdentity est Administrator ou SYSTEM. ACL non appliquée."
}
Write-Warning "SEPARATION OS NON GARANTIE si PlannerIdentity est membre du groupe Administrateurs. Ce script ne peut pas exclure cette appartenance de façon certaine."

if (-not (Test-Path -LiteralPath $StateDir -PathType Container)) {
    throw "REFUS: StateDir introuvable: $StateDir"
}
$StateDir = [System.IO.Path]::GetFullPath($StateDir)

# Well-known SIDs, translated on this machine. French Windows maps
# S-1-5-32-544 to BUILTIN\Administrateurs, not the English display name.
$administratorsSid = "S-1-5-32-544"
$systemSid = "S-1-5-18"
$everyoneSid = "S-1-1-0"
function Resolve-SidAccount([string]$SidValue) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($SidValue)
    return $sid.Translate([System.Security.Principal.NTAccount])
}
$trustedOwner = Resolve-SidAccount $administratorsSid
$systemAccount = Resolve-SidAccount $systemSid
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
$plannerTraverse = (
    [System.Security.AccessControl.FileSystemRights]::Traverse -bor
    [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor
    [System.Security.AccessControl.FileSystemRights]::Synchronize
)
# hqctl.py is stdlib-only. No other repository Python file is a planner client.
$PlannerClientFiles = @("hqctl.py")
$PrivateRootFiles = @("bridge_config.json", "bridge_sessions.json")
$ControllerCode = @(
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

function Add-AllowRule($Acl, $Identity, $Rights, $Inheritance) {
    if ($Identity -is [string]) {
        $idRef = New-Object System.Security.Principal.NTAccount($Identity)
    } else {
        $idRef = $Identity
    }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $idRef,
        [System.Security.AccessControl.FileSystemRights]$Rights,
        $Inheritance,
        $propagate,
        $allow
    )
    $Acl.AddAccessRule($rule)
}

function Save-SecurityDescriptor([string]$Path, [string]$Kind, [string]$Reason) {
    Write-Host "PRÉVU propriétaire=$($trustedOwner.Value) ($administratorsSid) $Reason :: $Path"
    if ($WhatIfPreference) {
        return
    }
    if (-not $script:AclCmdlet.ShouldProcess($Path, $Reason)) {
        return
    }
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetOwner($trustedOwner)
    switch ($Kind) {
        "DirectoryRoot" {
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($existing in @($acl.Access)) {
                [void]$acl.RemoveAccessRule($existing)
            }
            Add-AllowRule $acl $systemAccount "FullControl" $inheritChildren
            Add-AllowRule $acl $trustedOwner "FullControl" $inheritChildren
            Add-AllowRule $acl $ControllerIdentity.Trim() "Modify" $inheritChildren
            # planner traverse: StateDir only, not inherited by children
            Add-AllowRule $acl $PlannerIdentity.Trim() $plannerTraverse $noInherit
            if (Test-PlannerCanWrite $acl) {
                throw "REFUS: l'allowlist de l'arbre donnerait une écriture au planificateur."
            }
            if (Test-PlannerHasReadExecute $acl) {
                throw "REFUS: l'allowlist de l'arbre donnerait ReadAndExecute au planificateur."
            }
            $listBit = [System.Security.AccessControl.FileSystemRights]::ListDirectory
            foreach ($rule in @($acl.Access)) {
                if ((Test-IsPlanner $rule.IdentityReference.Value) -and (($rule.FileSystemRights -band $listBit) -ne 0)) {
                    throw "REFUS: l'allowlist de l'arbre laisserait lister le répertoire."
                }
            }
        }
        "Inherit" {
            $acl.SetAccessRuleProtection($false, $false)
            Remove-ExplicitRules $acl
        }
        "PrivateFile" {
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($rule in @($acl.Access)) {
                [void]$acl.RemoveAccessRule($rule)
            }
            Add-AllowRule $acl $systemAccount "FullControl" $noInherit
            Add-AllowRule $acl $trustedOwner "FullControl" $noInherit
            Add-AllowRule $acl $ControllerIdentity.Trim() "Modify" $noInherit
            if (Test-PlannerHasAnyAllow $acl) {
                throw "REFUS: $Path laisserait un accès au planificateur."
            }
        }
        "ClientFile" {
            $acl.SetAccessRuleProtection($false, $false)
            Remove-ExplicitRules $acl
            Add-AllowRule $acl $PlannerIdentity.Trim() "ReadAndExecute" $noInherit
        }
        default {
            throw "REFUS: type d'ACL inconnu: $Kind"
        }
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
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

function Test-CredentialFileName([string]$Name) {
    $leaf = $Name.ToLowerInvariant()
    if ($leaf -in @(
            "bridge_config.json",
            "bridge_sessions.json",
            "hq_vapid.json",
            "hq_push_subscriptions.json",
            "hq_ssh",
            "hq_ssh.ppk",
            "agent_config.json"
        )) {
        return $true
    }
    if ($leaf.EndsWith(".pem")) { return $true }
    if ($leaf.StartsWith("id_rsa")) { return $true }
    if ($leaf.StartsWith("id_ed25519")) { return $true }
    return $false
}

function Test-DelegatedStateDir($Item) {
    # True only for <StateDir>\.hq-agent-state itself, never for a nested
    # directory that happens to carry the same name.
    if (-not $Item.PSIsContainer) {
        return $false
    }
    $full = [System.IO.Path]::GetFullPath([string]$Item.FullName).TrimEnd([char[]]@('\', '/'))
    return [string]::Equals($full, $script:PrivateStateFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-ReparsePoints([string]$Root) {
    $found = New-Object System.Collections.Generic.List[string]
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $found.Add($rootItem.FullName)
        return $found
    }
    $pending = New-Object System.Collections.Generic.Queue[string]
    $pending.Enqueue($Root)
    while ($pending.Count -gt 0) {
        $dir = $pending.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $found.Add($item.FullName)
                continue
            }
            if (Test-DelegatedStateDir $item) {
                continue
            }
            if ($item.PSIsContainer) {
                $pending.Enqueue($item.FullName)
            }
        }
    }
    return $found
}

function Remove-ExplicitRules($Acl) {
    foreach ($rule in @($Acl.Access)) {
        if (-not $rule.IsInherited) {
            [void]$Acl.RemoveAccessRule($rule)
        }
    }
}

function Assert-AdministratorsOwner([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner.Value -eq $everyoneSid) {
        throw "REFUS: propriétaire Everyone conservé: $Path"
    }
    if ($owner.Value -ne $administratorsSid) {
        throw "REFUS: propriétaire autre que BUILTIN\Administrators ($($owner.Value)): $Path"
    }
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        $id = [string]$rule.IdentityReference.Value
        if ($id -eq $everyoneSid -or (ConvertTo-IdentityKey $id) -eq "everyone") {
            throw "REFUS: ACE Everyone encore présent: $Path"
        }
    }
    return $acl
}

$privateState = Join-Path $StateDir ".hq-agent-state"
$script:PrivateStateFull = [System.IO.Path]::GetFullPath($privateState).TrimEnd([char[]]@('\', '/'))
Write-Host "Cible: $StateDir"
Write-Host "Contrôleur: $ControllerIdentity"
Write-Host "Planificateur: $PlannerIdentity"
Write-Host "Propriétaire visé: $($trustedOwner.Value) ($administratorsSid)"
Write-Host "PRÉVU DACL racine: SYSTEM FullControl héritable; Administrators FullControl héritable; $ControllerIdentity Modify héritable; $PlannerIdentity traverse non héritable"
Write-Host "PRÉVU client planificateur: $($PlannerClientFiles -join ', ') ReadAndExecute non héritable"
Write-Host "PRÉVU fichiers sensibles: bridge_config.json, bridge_sessions.json, sans accès planificateur"
Write-Host "PRÉVU .git inclus (propriétaire et ACL). Octets, refs, config, hooks et index non modifiés."
Write-Host "Etat privé délégué (non modifié ici): $privateState -> install_hq_state_acl.ps1"
Write-Host "Tâche TransfertBridge: principal laissé à ControllerIdentity. Ce script ne la modifie pas."

# apply: reparse points abort before any owner or ACL write
$reparsePoints = @(Find-ReparsePoints $StateDir)
if ($reparsePoints.Count -gt 0) {
    foreach ($reparsePath in $reparsePoints) {
        Write-Host "REFUS point de réparation (cible non suivie): $reparsePath"
    }
    throw "REFUS: point de réparation. Propriétaire et ACL non appliqués. Arbre non durci."
}

Save-SecurityDescriptor $StateDir "DirectoryRoot" "DACL racine: traverse planificateur non héritable, contrôleur Modify héritable"

$pending = New-Object System.Collections.Generic.Queue[string]
$pending.Enqueue($StateDir)
while ($pending.Count -gt 0) {
    $dir = $pending.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "REFUS: point de réparation apparu pendant le parcours. Arbre non durci: $($item.FullName)"
        }
        if (Test-DelegatedStateDir $item) {
            Write-Host "Ignoré, délégué à install_hq_state_acl.ps1: $($item.FullName)"
            continue
        }
        $atRoot = ($dir -eq $StateDir)
        if ($atRoot -and ($PrivateRootFiles -contains $item.Name)) {
            continue
        }
        if ($atRoot -and ($PlannerClientFiles -contains $item.Name)) {
            continue
        }
        Save-SecurityDescriptor $item.FullName "Inherit" "héritage de l'arbre, sans lecture planificateur"
        if ($item.PSIsContainer) {
            $pending.Enqueue($item.FullName)
        }
    }
}

# sensitive files: planner excluded
# bridge_config.json and bridge_sessions.json, one write, no planner ACE
foreach ($name in $PrivateRootFiles) {
    $path = Join-Path $StateDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Warning "ABSENT, NON PROTÉGÉ: $path. Aucun contenu affiché. Relancer ce script quand le fichier existe."
        continue
    }
    Save-SecurityDescriptor $path "PrivateFile" "allowlist sans lecture planificateur"
}

# planner client files: explicit ReadAndExecute
# hqctl.py only
foreach ($name in $PlannerClientFiles) {
    $path = Join-Path $StateDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Warning "ABSENT, client planificateur non accordé: $path"
        continue
    }
    Save-SecurityDescriptor $path "ClientFile" "ReadAndExecute explicite planificateur, non héritable"
}

# code integrity: planner cannot read controller modules
if (-not $WhatIfPreference) {
    foreach ($name in $ControllerCode) {
        $path = Join-Path $StateDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            Write-Warning "Fichier de code absent, aucun droit ajouté: $path"
            continue
        }
        $acl = Assert-AdministratorsOwner $path
        if (Test-PlannerHasAnyAllow $acl -or (Test-PlannerCanWrite $acl)) {
            throw "REFUS: $name laisserait un accès au planificateur."
        }
        Write-Host "Code contrôleur illisible pour le planificateur: $path"
    }
    foreach ($name in $PlannerClientFiles) {
        $path = Join-Path $StateDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        $acl = Assert-AdministratorsOwner $path
        if (Test-PlannerCanWrite $acl) {
            throw "REFUS: $name laisserait une écriture au planificateur."
        }
        if (-not (Test-PlannerHasReadExecute $acl)) {
            throw "REFUS: $name n'accorde pas ReadAndExecute au planificateur."
        }
    }
    $rootAcl = Assert-AdministratorsOwner $StateDir
    if (Test-PlannerHasReadExecute $rootAcl) {
        throw "REFUS: StateDir accorde encore ReadAndExecute au planificateur."
    }
    $check = New-Object System.Collections.Generic.Queue[string]
    $check.Enqueue($StateDir)
    while ($check.Count -gt 0) {
        $dir = $check.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "REFUS: point de réparation après écriture. Arbre non durci: $($item.FullName)"
            }
            if (Test-DelegatedStateDir $item) {
                continue
            }
            $atRoot = ($dir -eq $StateDir)
            if ($atRoot -and ($PlannerClientFiles -contains $item.Name)) {
                if ($item.PSIsContainer) { $check.Enqueue($item.FullName) }
                continue
            }
            $acl = Assert-AdministratorsOwner $item.FullName
            $treePolicy = -not ($atRoot -and ($PrivateRootFiles -contains $item.Name))
            if ($treePolicy) {
                # Tree policy means inherited ACEs only (nested .hq-agent-state included).
                if ($acl.AreAccessRulesProtected) {
                    throw "REFUS: héritage coupé hors liste. Arbre non durci: $($item.FullName)"
                }
                foreach ($rule in @($acl.Access)) {
                    if (-not $rule.IsInherited) {
                        throw "REFUS: ACE explicite conservée. Arbre non durci: $($item.FullName)"
                    }
                }
            }
            if (Test-PlannerHasAnyAllow $acl) {
                if (Test-CredentialFileName $item.Name) {
                    throw "REFUS: fichier d'identifiants lisible par le planificateur: $($item.FullName)"
                }
                throw "REFUS: accès planificateur hors liste client: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $check.Enqueue($item.FullName)
            }
        }
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

if ($WhatIfPreference) {
    Write-Host "WhatIf: propriétaire, ACL et octets inchangés."
    return
}
Write-Host "ACL d'arbre préparée. Propriétaire BUILTIN\Administrators. Enchaîner avec install_hq_state_acl.ps1 sur le même StateDir."
