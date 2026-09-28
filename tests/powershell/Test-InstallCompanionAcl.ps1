# F2 acceptance test on real NTFS (Windows only, any locale; SIDs only).
# Isolated: a temp tree under %TEMP%, never %ProgramData%\TransfertHQ.
# Register-CompanionTask is shadowed at the installer's own seam, so no task is created;
# the task name used is unique and is checked to be absent afterwards.
# No elevation needed (the test owns its temp tree).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\powershell\Test-InstallCompanionAcl.ps1
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { Write-Output "RESULT: SKIP (Windows seulement)"; exit 0 }
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $repo "install_companion.ps1")

$script:Failures = 0
$script:Registered = New-Object System.Collections.Generic.List[object]
$SidUsers = "S-1-5-32-545"
$SidEveryone = "S-1-1-0"
$SidAuthUsers = "S-1-5-11"
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @("S-1-5-18", "S-1-5-32-544", $me)
$taskName = "TransfertHQ Companion TEST " + [guid]::NewGuid().ToString("N")
Write-Output "Culture: $((Get-Culture).Name) / UI: $((Get-UICulture).Name)"

function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output "PASS $Message" } else { Write-Output "FAIL $Message"; $script:Failures++ }
}

function Register-ScheduledTask {
    # Shadow: capture only. The real cmdlet is never reached from this test.
    param($TaskName, $Action, $Trigger, $Settings, [switch]$Force, $Description)
    $script:Registered.Add([pscustomobject]@{ TaskName = $TaskName; Execute = [string]$Action.Execute; Arguments = [string]$Action.Arguments; WorkingDirectory = [string]$Action.WorkingDirectory })
}

function Register-CompanionTask {
    # Intercept before ScheduledTasks cmdlets are invoked: module autoload can
    # replace a Register-ScheduledTask function mock on Windows PowerShell.
    param([string]$Dest, [string]$ScriptPath, [string]$ConfigPath, [string]$TaskName)
    $script:Registered.Add([pscustomobject]@{ TaskName = $TaskName; Execute = "py.exe"; Arguments = (Get-CompanionTaskArgument -ScriptPath $ScriptPath -ConfigPath $ConfigPath); WorkingDirectory = $Dest })
}

function Get-TestAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    if ($item.PSIsContainer) { return New-Object System.Security.AccessControl.DirectorySecurity($item.FullName, $sections) }
    return New-Object System.Security.AccessControl.FileSecurity($item.FullName, $sections)
}

function Set-TestAcl([string]$Path, $Acl) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSObject.Methods.Name -contains "SetAccessControl") { $item.SetAccessControl($Acl) }
    else { [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $Acl) }
}

function Add-DirtyAce([string]$Path, [string]$Sid, [string]$Rights, [string]$Type = "Allow") {
    $acl = Get-TestAcl $Path
    $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    if ($isDir) { $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit" }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        (New-Object System.Security.Principal.SecurityIdentifier($Sid)),
        [System.Security.AccessControl.FileSystemRights]$Rights, $inherit,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]$Type)
    $acl.AddAccessRule($rule)
    Set-TestAcl $Path $acl
}

function New-DirtyTree {
    $base = Join-Path $env:TEMP ("hq-f2-" + [guid]::NewGuid().ToString("N"))
    $dest = Join-Path $base "TransfertHQ"
    New-Item -ItemType Directory -Path (Join-Path $dest "work\sub") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dest "work\child.txt") -Value "child"
    Set-Content -LiteralPath (Join-Path $dest "work\sub\deep.txt") -Value "deep"
    Set-Content -LiteralPath (Join-Path $dest "companion_agent.py") -Value "# old copy"
    Set-Content -LiteralPath (Join-Path $dest "hq_state.py") -Value "# old copy"
    Set-Content -LiteralPath (Join-Path $dest "agent_config.json") -Value '{"controller_url": "https://example.invalid", "device_id": "", "device_secret": ""}'
    Add-DirtyAce $dest $SidUsers "Modify"
    Add-DirtyAce $dest $SidEveryone "ReadAndExecute"
    Add-DirtyAce (Join-Path $dest "work") $SidEveryone "Modify"
    Add-DirtyAce (Join-Path $dest "agent_config.json") $SidEveryone "FullControl"
    Add-DirtyAce (Join-Path $dest "agent_config.json") $SidUsers "Read"
    Add-DirtyAce (Join-Path $dest "companion_agent.py") $SidUsers "Modify"
    Add-DirtyAce (Join-Path $dest "hq_state.py") $SidEveryone "Write"
    Add-DirtyAce (Join-Path $dest "work\child.txt") $SidEveryone "Modify"
    Add-DirtyAce (Join-Path $dest "work\sub\deep.txt") $SidAuthUsers "Read" "Deny"
    return $dest
}

function Get-AllPaths([string]$Root) {
    $out = @((Get-Item -LiteralPath $Root -Force).FullName)
    $out += @(Get-ChildItem -LiteralPath $Root -Force -Recurse | ForEach-Object { $_.FullName })
    return $out
}

function Get-SddlMap([string]$Root) {
    $map = @{}
    foreach ($p in Get-AllPaths $Root) { $map[$p] = (Get-Acl -LiteralPath $p).Sddl }
    return $map
}

function Invoke-Install([string]$Dest) {
    try {
        $out = Invoke-CompanionInstall -Controller "https://example.invalid" -Name "TEST" -InstallRoot $Dest -SourceDir $repo -TaskName $taskName 6>&1 | Out-String
        return @{ Error = $null; Output = $out }
    } catch {
        return @{ Error = $_.Exception.Message; Output = "" }
    }
}

$cleanup = New-Object System.Collections.Generic.List[string]
$realSetDacl = ${function:Set-CompanionDacl}
try {
    # 1. Dirty destination: Users / Everyone / deny ACEs must all be gone.
    $dest = New-DirtyTree; $cleanup.Add((Split-Path $dest -Parent))
    $dirty = Get-SddlMap $dest
    Assert-True (($dirty.Values -join "") -match "S-1-1-0|WD") "préparation: ACE Everyone présente avant"
    $cfgBefore = [IO.File]::ReadAllBytes((Join-Path $dest "agent_config.json"))
    $run = Invoke-Install $dest
    Assert-True ($null -eq $run.Error) "installation sur destination sale ($($run.Error))"
    foreach ($p in Get-AllPaths $dest) {
        $acl = Get-Acl -LiteralPath $p
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $sids = @($rules | ForEach-Object { $_.IdentityReference.Value })
        Assert-True $acl.AreAccessRulesProtected "héritage retiré: $p"
        Assert-True (-not ($sids -contains $SidUsers)) "S-1-5-32-545 absent: $p"
        Assert-True (-not ($sids -contains $SidEveryone)) "S-1-1-0 absent: $p"
        Assert-True (-not ($sids -contains $SidAuthUsers)) "S-1-5-11 absent: $p"
        Assert-True (@($sids | Where-Object { $allowed -notcontains $_ }).Count -eq 0) "seulement SYSTEM/Administrateurs/installateur par SID: $p"
        Assert-True (@($rules | Where-Object { $_.AccessControlType -ne "Allow" -or $_.IsInherited }).Count -eq 0) "aucune entrée refus/héritée: $p"
        foreach ($sid in $allowed) { Assert-True ($sids -contains $sid) "présent $sid : $p" }
        $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        Assert-True ($allowed -contains $owner) "propriétaire dans la liste ($owner): $p"
        $isDir = (Get-Item -LiteralPath $p -Force).PSIsContainer
        Assert-True (@(Get-CompanionAclProblems -Path $p -UserSid $me -Directory:$isDir).Count -eq 0) "contrôle du script vide: $p"
    }
    $cfgAfter = [IO.File]::ReadAllBytes((Join-Path $dest "agent_config.json"))
    Assert-True ([Convert]::ToBase64String($cfgBefore) -eq [Convert]::ToBase64String($cfgAfter)) "octets de la config inchangés"
    Assert-True ($script:Registered.Count -eq 1) "une tâche simulée, après vérification"
    $want = "-3 `"$(Join-Path $dest 'companion_agent.py')`" --config `"$(Join-Path $dest 'agent_config.json')`""
    Assert-True ($script:Registered[0].Arguments -eq $want) "action = script + --config ($($script:Registered[0].Arguments))"
    Assert-True ($script:Registered[0].Execute -eq "py.exe") "exécutable py.exe"
    Assert-True ($script:Registered[0].WorkingDirectory -eq $dest) "WorkingDirectory"
    Assert-True ($script:Registered[0].Arguments -notmatch "(?i)enroll|jeton|token|secret") "aucun jeton dans l'action"
    Assert-True ($run.Output -match "--enroll`"?\s*$" -or $run.Output -match "--enroll\r?\n") "instruction: --enroll sans valeur"
    Assert-True ($run.Output -notmatch "--enroll\s+[A-Za-z0-9_\-]{8,}") "instruction: aucun jeton affiché"

    # 2. Injected ACL write failure (config): refused, no task.
    $script:Registered.Clear()
    $dest = New-DirtyTree; $cleanup.Add((Split-Path $dest -Parent))
    function Set-CompanionDacl {
        param([string]$Path, [string]$Sddl, [switch]$Directory, [string]$OwnerSid = "")
        if ($Path.EndsWith("agent_config.json")) { throw "échec injecté" }
        & $realSetDacl -Path $Path -Sddl $Sddl -Directory:$Directory -OwnerSid $OwnerSid
    }
    $run = Invoke-Install $dest
    Assert-True ($run.Error -match "REFUS") "échec ACL injecté: refus"
    Assert-True ($script:Registered.Count -eq 0) "échec ACL injecté: aucune tâche"

    # 3. ACL writer silently does nothing: the SID check must refuse.
    $script:Registered.Clear()
    $dest = New-DirtyTree; $cleanup.Add((Split-Path $dest -Parent))
    function Set-CompanionDacl { param([string]$Path, [string]$Sddl, [switch]$Directory, [string]$OwnerSid = "") }
    $run = Invoke-Install $dest
    Assert-True ($run.Error -match "ACL non conforme") "écriture ACL sans effet: la vérification refuse"
    Assert-True ($run.Error -match "S-1-1-0|S-1-5-32-545") "la vérification nomme le SID fautif"
    Assert-True ($script:Registered.Count -eq 0) "écriture ACL sans effet: aucune tâche"
    Set-Item -Path function:Set-CompanionDacl -Value $realSetDacl

    # 4. Junction in work: refused before any ACL write.
    $script:Registered.Clear()
    $dest = New-DirtyTree; $cleanup.Add((Split-Path $dest -Parent))
    $outside = Join-Path (Split-Path $dest -Parent) "outside"
    New-Item -ItemType Directory -Path $outside | Out-Null
    & cmd.exe /c mklink /J "$(Join-Path $dest 'work\jn')" "$outside" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $before = Get-SddlMap $dest
        $run = Invoke-Install $dest
        Assert-True ($run.Error -match "point de r") "jonction: refus"
        Assert-True ($script:Registered.Count -eq 0) "jonction: aucune tâche"
        Assert-True ((Get-Acl -LiteralPath $dest).Sddl -eq $before[$dest]) "jonction: DACL du répertoire inchangée"
        cmd.exe /c rmdir "$(Join-Path $dest 'work\jn')" | Out-Null
    } else {
        Write-Output "SKIP jonction: mklink /J indisponible"
    }

    Assert-True ($null -eq (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) "aucune tâche réelle enregistrée"
} finally {
    foreach ($dir in $cleanup) {
        if ($dir -and (Test-Path -LiteralPath $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
if ($script:Failures -gt 0) { Write-Output "RESULT: FAIL ($($script:Failures))"; exit 1 }
Write-Output "RESULT: PASS"
exit 0
