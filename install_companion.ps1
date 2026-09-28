# Install the Transfert HQ Companion on a trusted Windows PC.
# Outbound only: no firewall port, no inbound listener, no self-update.
#
# ACL (allowlist DACL, fail closed). Principals are SIDs only, so a French
# Windows install never depends on a localized account name.
#   S-1-5-18       (local system)            FullControl
#   S-1-5-32-544   (builtin administrators)  FullControl
#   <installing identity, WindowsIdentity SID> Modify (the companion runs as it)
# Applied to the install directory, work, agent_config.json, the copied code
# and every other object already in the tree (work children, __pycache__).
# Each DACL is protected (no inheritance) and replaced as a whole, so an old
# explicit grant (Users, Everyone, Authenticated Users, a deny, ...) is gone.
# Directories carry the three entries as inheritable (OI)(CI).
# Then every object is read back and checked by SID: protected, owner and
# every entry within the allowlist, rights within bounds, all three present.
# A reparse point anywhere in the tree, a failed ACL write, or a failed
# check aborts the install before the scheduled task is registered.
#
# Scheduled task "TransfertHQ Companion":
#   Trigger: at logon of the installing user (not before that user signs in).
#   Hidden: false (visible in Task Scheduler).
#   Action: py -3 <companion_agent.py> --config <agent_config.json>
#   WorkingDirectory: %ProgramData%\TransfertHQ
#   The device secret is only in the config file, never on the command line.
#   The task never enrolls and never receives an enrollment token.
#
# Enrollment (once, by hand, after this script). The token is never an
# argument: run companion_agent.py with a bare --enroll and paste the token at
# the masked prompt. Without a console, pipe it on stdin from a file readable
# only by this account, then delete the file.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install_companion.ps1 -Controller https://VIEUXPEEPEE.TAILNET.ts.net
# Tests dot-source this file (nothing runs) and call Invoke-CompanionInstall
# with an isolated -InstallRoot and a shadowed Register-ScheduledTask.
param(
    [string]$Controller = "https://VIEUXPEEPEE.TAILNET.ts.net",
    [string]$Name = $env:COMPUTERNAME,
    [string]$InstallRoot = ""
)
$ErrorActionPreference = "Stop"

$script:CompanionTaskName = "TransfertHQ Companion"
$script:CompanionFiles = @(
    "companion_agent.py",
    "companion_ops.py",
    "hq_agent_ops.py",
    "hq_agent_protocol.py",
    "hq_devices.py",
    "hq_state.py"
)
$script:SidLocalSystem = "S-1-5-18"
$script:SidBuiltinAdmins = "S-1-5-32-544"
$script:RightsFull = 0x1f01ff
$script:RightsModify = 0x1301bf

function Get-CompanionIdentitySid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-CompanionAllowlistSddl {
    param([Parameter(Mandatory = $true)][string]$UserSid, [switch]$Directory)
    $flags = ""
    if ($Directory) { $flags = "OICI" }
    return "D:P(A;$flags;0x1f01ff;;;$($script:SidLocalSystem))(A;$flags;0x1f01ff;;;$($script:SidBuiltinAdmins))(A;$flags;0x1301bf;;;$UserSid)"
}

function Get-CompanionTreeItems {
    # Every object under Root, Root included. No -Recurse and no link is
    # followed: any reparse point (symlink, junction, mount point) throws.
    param([Parameter(Mandatory = $true)][string]$Root)
    $rootItem = Get-Item -LiteralPath $Root -Force
    $reparse = [IO.FileAttributes]::ReparsePoint
    if ($rootItem.Attributes -band $reparse) {
        throw "REFUS: point de réparation $($rootItem.FullName). Installation arrêtée, tâche non enregistrée."
    }
    $out = New-Object System.Collections.Generic.List[object]
    $out.Add($rootItem)
    $queue = New-Object System.Collections.Generic.Queue[string]
    $queue.Enqueue($rootItem.FullName)
    while ($queue.Count -gt 0) {
        $dir = $queue.Dequeue()
        foreach ($child in @(Get-ChildItem -LiteralPath $dir -Force)) {
            if ($child.Attributes -band $reparse) {
                throw "REFUS: point de réparation $($child.FullName). Installation arrêtée, tâche non enregistrée."
            }
            $out.Add($child)
            if ($child.PSIsContainer) {
                $queue.Enqueue($child.FullName)
            }
        }
    }
    return $out.ToArray()
}

function Set-CompanionDacl {
    # The only ACL writer. Replaces the whole DACL (and the owner when asked).
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sddl,
        [switch]$Directory,
        [string]$OwnerSid = ""
    )
    if ($Directory) {
        $sec = New-Object System.Security.AccessControl.DirectorySecurity
        $info = New-Object System.IO.DirectoryInfo -ArgumentList $Path
    } else {
        $sec = New-Object System.Security.AccessControl.FileSecurity
        $info = New-Object System.IO.FileInfo -ArgumentList $Path
    }
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    $text = $Sddl
    if ($OwnerSid) {
        $text = "O:$OwnerSid$Sddl"
        $sections = [System.Security.AccessControl.AccessControlSections]($sections -bor [System.Security.AccessControl.AccessControlSections]::Owner)
    }
    $sec.SetSecurityDescriptorSddlForm($text, $sections)
    if ($info.PSObject.Methods.Name -contains "SetAccessControl") {
        $info.SetAccessControl($sec)
    } else {
        [System.IO.FileSystemAclExtensions]::SetAccessControl($info, $sec)
    }
}

function Set-CompanionAllowlistAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UserSid,
        [switch]$Directory
    )
    $allowed = @($script:SidLocalSystem, $script:SidBuiltinAdmins, $UserSid)
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $newOwner = ""
    if ($allowed -notcontains $owner) {
        # A foreign owner keeps an implicit right to rewrite the DACL.
        $newOwner = $UserSid
    }
    $sddl = Get-CompanionAllowlistSddl -UserSid $UserSid -Directory:$Directory
    try {
        Set-CompanionDacl -Path $Path -Sddl $sddl -Directory:$Directory -OwnerSid $newOwner
    } catch {
        throw "REFUS: ACL non appliquée sur $Path ($($_.Exception.Message)). Installation arrêtée avant la tâche planifiée."
    }
}

function Get-CompanionAclProblems {
    # Read back by SID. Empty result means the object matches the allowlist.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UserSid,
        [switch]$Directory
    )
    $problems = @()
    $acl = Get-Acl -LiteralPath $Path
    $full = @($script:SidLocalSystem, $script:SidBuiltinAdmins)
    $allowed = @($script:SidLocalSystem, $script:SidBuiltinAdmins, $UserSid)
    if (-not $acl.AreAccessRulesProtected) {
        $problems += "${Path}: héritage encore actif"
    }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -notcontains $owner) {
        $problems += "${Path}: propriétaire $owner hors liste"
    }
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    if ($Directory) {
        $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    }
    $seen = @{}
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        $sid = $rule.IdentityReference.Value
        $rights = [int]$rule.FileSystemRights
        if ($rule.IsInherited) {
            $problems += "${Path}: entrée héritée $sid"
            continue
        }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            $problems += "${Path}: entrée de refus $sid"
            continue
        }
        if ($allowed -notcontains $sid) {
            $problems += "${Path}: SID non autorisé $sid"
            continue
        }
        if ($rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
            $problems += "${Path}: héritage inattendu pour $sid"
        }
        $max = $script:RightsModify
        if ($full -contains $sid) { $max = $script:RightsFull }
        if (($rights -band (-bnot $max)) -ne 0) {
            $problems += "${Path}: droits trop larges pour $sid"
        } elseif ($rights -eq $max) {
            $seen[$sid] = $true
        }
    }
    foreach ($sid in $allowed) {
        if (-not $seen.ContainsKey($sid)) {
            $problems += "${Path}: entrée manquante pour $sid"
        }
    }
    return $problems
}

function Invoke-CompanionInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Controller,
        [string]$Name = $env:COMPUTERNAME,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [string]$TaskName = $script:CompanionTaskName
    )
    if ($Controller -notmatch "^https://") {
        throw "Le contrôleur doit être en HTTPS (Tailscale Serve). Pas de port public."
    }
    $Dest = [IO.Path]::GetFullPath($InstallRoot)
    $Work = Join-Path $Dest "work"
    $ConfigPath = Join-Path $Dest "agent_config.json"
    $ScriptPath = Join-Path $Dest "companion_agent.py"
    $userSid = Get-CompanionIdentitySid

    # 1. Refuse a reparse point before any write; lock the directory first.
    if (Test-Path -LiteralPath $Dest) {
        $null = Get-CompanionTreeItems -Root $Dest
    } else {
        New-Item -ItemType Directory -Path $Dest | Out-Null
    }
    Set-CompanionAllowlistAcl -Path $Dest -UserSid $userSid -Directory
    if (-not (Test-Path -LiteralPath $Work)) {
        New-Item -ItemType Directory -Path $Work | Out-Null
    }

    # 2. Code: remove the old name, then copy (never write through an old file).
    foreach ($file in $script:CompanionFiles) {
        $target = Join-Path $Dest $file
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force
        }
        Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination $target
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
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

    # 3. Allowlist on every object, then verify every object by SID.
    foreach ($item in @(Get-CompanionTreeItems -Root $Dest)) {
        Set-CompanionAllowlistAcl -Path $item.FullName -UserSid $userSid -Directory:([bool]$item.PSIsContainer)
    }
    $problems = @()
    $checked = @{}
    foreach ($item in @(Get-CompanionTreeItems -Root $Dest)) {
        $checked[$item.FullName] = $true
        $problems += @(Get-CompanionAclProblems -Path $item.FullName -UserSid $userSid -Directory:([bool]$item.PSIsContainer))
    }
    $required = @($Dest, $Work, $ConfigPath) + @($script:CompanionFiles | ForEach-Object { Join-Path $Dest $_ })
    foreach ($path in $required) {
        if (-not $checked.ContainsKey($path)) {
            $problems += "${path}: absent après installation"
        }
    }
    if ($problems.Count -gt 0) {
        throw ("REFUS: ACL non conforme, tâche planifiée non enregistrée.`n" + ($problems -join "`n"))
    }

    # 4. Only now: the task, script plus --config.
    Register-CompanionTask -Dest $Dest -ScriptPath $ScriptPath -ConfigPath $ConfigPath -TaskName $TaskName

    Write-Host "Companion copié dans $Dest"
    Write-Host "ACL vérifiée par SID : S-1-5-18 et S-1-5-32-544 contrôle total, $userSid modification, héritage retiré, aucune autre entrée."
    Write-Host "Tâche: $TaskName, visible, au logon de $env:USERNAME, dossier $Dest, argument --config seulement."
    Write-Host "1. Sur Vieuxpeepee : Centre agents → Créer un jeton"
    Write-Host "2. py -3 `"$ScriptPath`" --config `"$ConfigPath`" --controller $Controller --name `"$Name`" --workspace `"$Work`" --enroll"
    Write-Host "   Coller le jeton à l'invite (saisie masquée). Ne jamais l'écrire sur la ligne de commande."
    Write-Host "3. Ensuite la tâche planifiée interroge le pont (pas de port entrant)."
    Write-Host "Le terminal interactif et l'auto-mise à jour ne sont pas installés."
}

# The task is defined last: nothing below this point touches the config.
function Register-CompanionTask {
    param(
        [Parameter(Mandatory = $true)][string]$Dest,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [string]$TaskName = $script:CompanionTaskName
    )
    $TaskArg = Get-CompanionTaskArgument -ScriptPath $ScriptPath -ConfigPath $ConfigPath
    $Action = New-ScheduledTaskAction -Execute "py.exe" -Argument $TaskArg -WorkingDirectory $Dest
    $Trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden:$false
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force -Description "Transfert HQ companion. Config path only; secret stays in agent_config.json. Runs at logon of the installing user." | Out-Null
}

function Get-CompanionTaskArgument {
    param([Parameter(Mandatory = $true)][string]$ScriptPath, [Parameter(Mandatory = $true)][string]$ConfigPath)
    return "-3 `"$ScriptPath`" --config `"$ConfigPath`""
}

if ($MyInvocation.InvocationName -eq ".") {
    return
}
if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:ProgramData "TransfertHQ"
}
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Invoke-CompanionInstall -Controller $Controller -Name $Name -InstallRoot $InstallRoot -SourceDir $Here
