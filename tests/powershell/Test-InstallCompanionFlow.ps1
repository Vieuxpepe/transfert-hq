# F2 ordering test for install_companion.ps1 with every ACL and task seam
# mocked. Cross-platform (pwsh on Linux or Windows PowerShell). It never
# changes a real DACL and never registers a real scheduled task:
# Register-ScheduledTask and Register-CompanionTask are shadowed.
#   pwsh -NoProfile -File tests/powershell/Test-InstallCompanionFlow.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\powershell\Test-InstallCompanionFlow.ps1
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installer = Join-Path $repo "install_companion.ps1"
. $installer

$script:Failures = 0
$script:Events = New-Object System.Collections.Generic.List[string]
$script:Registered = New-Object System.Collections.Generic.List[object]
$script:FailAclOn = ""
$script:ProblemOn = ""

function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output "PASS $Message" } else { Write-Output "FAIL $Message"; $script:Failures++ }
}

# Seams (the installer resolves these by name at call time).
function Get-CompanionIdentitySid { return "S-1-5-21-1000-1000-1000-1001" }
function Set-CompanionAllowlistAcl {
    param([string]$Path, [string]$UserSid, [switch]$Directory)
    $script:Events.Add("acl:$Path")
    if ($script:FailAclOn -and $Path.EndsWith($script:FailAclOn)) {
        throw "REFUS: ACL non appliquée sur $Path (injecté). Installation arrêtée avant la tâche planifiée."
    }
}
function Get-CompanionAclProblems {
    param([string]$Path, [string]$UserSid, [switch]$Directory)
    $script:Events.Add("check:$Path")
    if ($script:ProblemOn -and $Path.EndsWith($script:ProblemOn)) { return @("${Path}: SID non autorisé S-1-1-0") }
    return @()
}
function Register-ScheduledTask {
    # Shadow of the real cmdlet: records, never registers.
    param($TaskName, $Action, $Trigger, $Settings, [switch]$Force, $Description)
    $script:Events.Add("register")
    $script:Registered.Add([pscustomobject]@{ TaskName = $TaskName; Arguments = [string]$Action.Arguments; Execute = [string]$Action.Execute; WorkingDirectory = [string]$Action.WorkingDirectory })
}
$haveTaskCmdlets = [bool](Get-Command New-ScheduledTaskAction -ErrorAction SilentlyContinue)
if (-not $haveTaskCmdlets) {
    function Register-CompanionTask {
        param([string]$Dest, [string]$ScriptPath, [string]$ConfigPath, [string]$TaskName)
        $script:Events.Add("register")
        $script:Registered.Add([pscustomobject]@{ TaskName = $TaskName; Arguments = (Get-CompanionTaskArgument -ScriptPath $ScriptPath -ConfigPath $ConfigPath); Execute = "py.exe"; WorkingDirectory = $Dest })
    }
}

function New-Scenario {
    $script:Events.Clear()
    $script:Registered.Clear()
    $script:FailAclOn = ""
    $script:ProblemOn = ""
    $base = Join-Path ([IO.Path]::GetTempPath()) ("hq-flow-" + [guid]::NewGuid().ToString("N"))
    $dest = Join-Path $base "TransfertHQ"
    New-Item -ItemType Directory -Path (Join-Path $dest "work/sub") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dest "work/sub/child.txt") -Value "child"
    Set-Content -LiteralPath (Join-Path $dest "companion_agent.py") -Value "# old copy"
    Set-Content -LiteralPath (Join-Path $dest "agent_config.json") -Value '{"controller_url": "https://example.invalid", "device_id": "", "device_secret": ""}'
    return $dest
}

function Invoke-Scenario([string]$Dest) {
    try {
        Invoke-CompanionInstall -Controller "https://example.invalid" -Name "TEST" -InstallRoot $Dest -SourceDir $repo -TaskName "TransfertHQ Companion TEST" 6>$null
        return $null
    } catch {
        return $_.Exception.Message
    }
}

$cleanup = New-Object System.Collections.Generic.List[string]
try {
    # 1. Happy path: every object hardened and checked before one registration.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    $err = Invoke-Scenario $dest
    Assert-True ($null -eq $err) "installation nominale sans erreur ($err)"
    Assert-True ($script:Registered.Count -eq 1) "une seule tâche (simulée)"
    $reg = $script:Events.IndexOf("register")
    $lastAcl = -1; $lastCheck = -1
    for ($i = 0; $i -lt $script:Events.Count; $i++) {
        if ($script:Events[$i].StartsWith("acl:")) { $lastAcl = $i }
        if ($script:Events[$i].StartsWith("check:")) { $lastCheck = $i }
    }
    Assert-True ($lastAcl -ge 0 -and $lastAcl -lt $reg) "ACL appliquées avant la tâche"
    Assert-True ($lastCheck -ge 0 -and $lastCheck -lt $reg) "vérification SID avant la tâche"
    $full = [IO.Path]::GetFullPath($dest)
    $expected = @($full, (Join-Path $full "work"), (Join-Path $full "work/sub"), (Join-Path $full "work/sub/child.txt"), (Join-Path $full "agent_config.json")) + @($script:CompanionFiles | ForEach-Object { Join-Path $full $_ })
    foreach ($p in $expected) {
        Assert-True ($script:Events.Contains("acl:$p")) "ACL appliquée: $p"
        Assert-True ($script:Events.Contains("check:$p")) "ACL vérifiée: $p"
    }
    Assert-True ($script:Events[0] -eq "acl:$full") "le répertoire est verrouillé avant toute copie"
    foreach ($f in $script:CompanionFiles) {
        $same = (Get-FileHash -LiteralPath (Join-Path $full $f)).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $f)).Hash
        Assert-True $same "code copié à neuf: $f"
    }
    $cfg = Get-Content -Raw -LiteralPath (Join-Path $full "agent_config.json")
    Assert-True ($cfg -match "example.invalid") "configuration existante conservée"
    $arg = $script:Registered[0].Arguments
    $want = "-3 `"$(Join-Path $full 'companion_agent.py')`" --config `"$(Join-Path $full 'agent_config.json')`""
    Assert-True ($arg -eq $want) "action = script + --config seulement ($arg)"
    Assert-True ($arg -notmatch "(?i)enroll|jeton|token|secret") "aucun jeton ni secret dans l'action"
    Assert-True ($script:Registered[0].WorkingDirectory -eq $full) "WorkingDirectory = dossier d'installation"

    # 2. Injected ACL write failure on the config: no task.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    $script:FailAclOn = "agent_config.json"
    $err = Invoke-Scenario $dest
    Assert-True ($err -match "REFUS") "échec ACL injecté: installation refusée"
    Assert-True ($script:Registered.Count -eq 0 -and -not $script:Events.Contains("register")) "échec ACL injecté: aucune tâche"

    # 3. Injected ACL write failure on the directory itself: nothing copied.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    $script:FailAclOn = "TransfertHQ"
    $err = Invoke-Scenario $dest
    Assert-True ($err -match "REFUS") "échec ACL du répertoire: refus"
    Assert-True ($script:Registered.Count -eq 0) "échec ACL du répertoire: aucune tâche"
    $old = Get-Content -Raw -LiteralPath (Join-Path $dest "companion_agent.py")
    Assert-True ($old -match "old copy") "échec ACL du répertoire: aucune copie"

    # 4. Verification finds an unrelated SID: no task.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    $script:ProblemOn = "child.txt"
    $err = Invoke-Scenario $dest
    Assert-True ($err -match "ACL non conforme") "vérification SID en échec: refus"
    Assert-True ($script:Registered.Count -eq 0) "vérification SID en échec: aucune tâche"

    # 5. Reparse point in the tree: refused before any ACL write.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    $outside = Join-Path (Split-Path $dest -Parent) "outside"
    New-Item -ItemType Directory -Path $outside | Out-Null
    $linked = $true
    try {
        New-Item -ItemType SymbolicLink -Path (Join-Path $dest "work/link") -Target $outside | Out-Null
    } catch {
        $linked = $false
        Write-Output "SKIP point de réparation: lien symbolique non autorisé ici"
    }
    if ($linked) {
        $err = Invoke-Scenario $dest
        Assert-True ($err -match "point de r") "point de réparation: refus"
        Assert-True ($script:Events.Count -eq 0) "point de réparation: aucune ACL, aucune tâche"
    }

    # 6. HTTP controller refused before anything.
    $dest = New-Scenario; $cleanup.Add((Split-Path $dest -Parent))
    try {
        Invoke-CompanionInstall -Controller "http://example.invalid" -InstallRoot $dest -SourceDir $repo 6>$null
        $err = $null
    } catch { $err = $_.Exception.Message }
    Assert-True ($err -match "HTTPS" -and $script:Events.Count -eq 0) "contrôleur HTTP refusé sans écriture"
} finally {
    foreach ($dir in $cleanup) {
        if ($dir -and (Test-Path -LiteralPath $dir)) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if ($script:Failures -gt 0) {
    Write-Output "RESULT: FAIL ($($script:Failures))"
    exit 1
}
Write-Output "RESULT: PASS"
exit 0
