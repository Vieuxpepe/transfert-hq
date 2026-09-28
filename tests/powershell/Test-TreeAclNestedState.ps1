# F5 acceptance test on real NTFS (Windows only, elevated, any locale).
# Isolated: builds a throwaway StateDir under %TEMP%; C:\Transfert is never
# touched. TransfertBridge is only read by the tree script (Get-ScheduledTask).
# PlannerIdentity must be an existing, distinct, non-administrator account
# (example: VIEUXPEEPEE\hq-planner). ControllerIdentity defaults to the
# current user. Accounts are not created by this test.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\powershell\Test-TreeAclNestedState.ps1 -PlannerIdentity "VIEUXPEEPEE\hq-planner"
param(
    [string]$ControllerIdentity = "",
    [string]$PlannerIdentity = $env:HQ_TEST_PLANNER_IDENTITY
)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { Write-Output "RESULT: SKIP (Windows seulement)"; exit 0 }
if (-not $ControllerIdentity) { $ControllerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
if (-not $PlannerIdentity) { Write-Output "RESULT: FAIL (PlannerIdentity requis: -PlannerIdentity ou HQ_TEST_PLANNER_IDENTITY)"; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output "RESULT: FAIL (lancer en PowerShell élevé)"; exit 1
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$treeScript = Join-Path $repo "install_hq_tree_acl.ps1"
$script:Failures = 0
$SidEveryone = "S-1-1-0"
$SidUsers = "S-1-5-32-545"
Write-Output "Culture: $((Get-Culture).Name) / UI: $((Get-UICulture).Name)"

function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output "PASS $Message" } else { Write-Output "FAIL $Message"; $script:Failures++ }
}

function Add-PermissiveAce([string]$Path, [string]$Sid, [string]$Rights, [switch]$Protect) {
    $item = Get-Item -LiteralPath $Path -Force
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    if ($item.PSIsContainer) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity($item.FullName, $sections)
        $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity($item.FullName, $sections)
        $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    if ($Protect) { $acl.SetAccessRuleProtection($true, $true) }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        (New-Object System.Security.Principal.SecurityIdentifier($Sid)), [System.Security.AccessControl.FileSystemRights]$Rights,
        $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))
    if ($item.PSObject.Methods.Name -contains "SetAccessControl") { $item.SetAccessControl($acl) }
    else { [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
}

function Get-Snapshot([string]$Root) {
    # SDDL (owner + DACL), size, hash and write time of every object.
    $map = @{}
    $items = @(Get-Item -LiteralPath $Root -Force) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
    foreach ($item in $items) {
        $sd = (Get-Acl -LiteralPath $item.FullName).Sddl
        $hash = ""
        if (-not $item.PSIsContainer) { $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
        $map[$item.FullName] = "$sd|$hash|$($item.LastWriteTimeUtc.Ticks)"
    }
    return $map
}

$base = Join-Path $env:TEMP ("hq-f5-" + [guid]::NewGuid().ToString("N"))
$state = Join-Path $base "Transfert"
try {
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    foreach ($name in @("hqctl.py", "iphone_bridge.py", "hq_state.py")) { Set-Content -LiteralPath (Join-Path $state $name) -Value "# test" }
    Set-Content -LiteralPath (Join-Path $state "bridge_config.json") -Value "{}"
    $rootPrivate = Join-Path $state ".hq-agent-state"
    New-Item -ItemType Directory -Path $rootPrivate | Out-Null
    Set-Content -LiteralPath (Join-Path $rootPrivate "hq_agents.json") -Value "{}"
    # The delegated state directory is protected by install_hq_state_acl.ps1
    # in production. Without a protected DACL, changing the parent's inheritable
    # ACEs changes this directory's effective SDDL even when it is skipped.
    $privateAcl = Get-Acl -LiteralPath $rootPrivate
    $privateAcl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $rootPrivate -AclObject $privateAcl
    $nestedA = Join-Path $state "Inbox\.hq-agent-state"
    $nestedB = Join-Path $state "deep\x\.HQ-AGENT-STATE"
    New-Item -ItemType Directory -Path $nestedA, $nestedB -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $nestedA "planted.json") -Value "{}"
    Add-PermissiveAce $nestedA $SidEveryone "FullControl" -Protect
    Add-PermissiveAce $nestedB $SidUsers "Modify"
    Add-PermissiveAce (Join-Path $nestedA "planted.json") $SidEveryone "FullControl"
    $rootPrivateBefore = (Get-Acl -LiteralPath $rootPrivate).Sddl

    # 1. -WhatIf: no owner, ACL, or byte change anywhere.
    $before = Get-Snapshot $state
    $whatif = & $treeScript -WhatIf -StateDir $state -ControllerIdentity $ControllerIdentity -PlannerIdentity $PlannerIdentity *>&1 | Out-String
    $after = Get-Snapshot $state
    $changed = @($before.Keys | Where-Object { $before[$_] -ne $after[$_] })
    Assert-True ($before.Count -eq $after.Count) "WhatIf: aucun objet créé ou supprimé"
    Assert-True ($changed.Count -eq 0) "WhatIf: propriétaire, DACL, octets et dates inchangés ($($changed -join ', '))"
    Assert-True ($whatif -match "PR.{1,2}VU") "WhatIf: lignes PRÉVU affichées"
    Assert-True ($whatif -match [regex]::Escape($nestedA)) "WhatIf: le .hq-agent-state imbriqué est prévu dans la politique d'arbre"

    # 2. Real run on the isolated tree.
    $out = & $treeScript -StateDir $state -ControllerIdentity $ControllerIdentity -PlannerIdentity $PlannerIdentity -Confirm:$false *>&1 | Out-String
    Assert-True ($out -match "ACL d'arbre pr") "arbre durci sans erreur"
    Assert-True ($out -notmatch ("Ignor.{1,40}" + [regex]::Escape($nestedA))) "imbriqué non délégué"
    foreach ($p in @($nestedA, $nestedB, (Join-Path $nestedA "planted.json"))) {
        $acl = Get-Acl -LiteralPath $p
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $sids = @($rules | ForEach-Object { $_.IdentityReference.Value })
        Assert-True (-not $acl.AreAccessRulesProtected) "héritage de l'arbre rétabli: $p"
        Assert-True (@($rules | Where-Object { -not $_.IsInherited }).Count -eq 0) "aucune ACE explicite: $p"
        Assert-True (-not ($sids -contains $SidEveryone)) "S-1-1-0 absent: $p"
        Assert-True (-not ($sids -contains $SidUsers)) "S-1-5-32-545 absent: $p"
        Assert-True ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq "S-1-5-32-544") "propriétaire S-1-5-32-544: $p"
    }
    Assert-True ((Get-Acl -LiteralPath $rootPrivate).Sddl -eq $rootPrivateBefore) "<StateDir>\.hq-agent-state seul délégué: inchangé"
} catch {
    Write-Output "FAIL exception: $($_.Exception.Message)"
    $script:Failures++
} finally {
    if (Test-Path -LiteralPath $base) {
        $resolvedBase = [IO.Path]::GetFullPath($base)
        $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
        if (-not $resolvedBase.StartsWith(($resolvedTemp + '\hq-f5-'), [StringComparison]::OrdinalIgnoreCase)) {
            throw "REFUS: dossier de test hors TEMP"
        }
        $baseItem = Get-Item -LiteralPath $resolvedBase -Force
        if ($baseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "REFUS: dossier de test est un point de réparation"
        }
        Remove-Item -LiteralPath $resolvedBase -Recurse -Force -ErrorAction Stop
    }
}
if ($script:Failures -gt 0) { Write-Output "RESULT: FAIL ($($script:Failures))"; exit 1 }
Write-Output "RESULT: PASS"
exit 0
