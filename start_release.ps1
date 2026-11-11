# Start one selected release against an existing state directory.
# This does not register or change Task Scheduler task TransfertBridge.
param(
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [Parameter(Mandatory = $true)][int]$Port,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$live = [System.IO.Path]::GetFullPath('C:\Transfert')
$productionPorts = @(8765, 8766)

function Assert-OutsideLive([string]$PathValue, [string]$Label) {
    if (-not [System.IO.Path]::IsPathRooted($PathValue)) {
        throw "$Label must be an absolute path"
    }
    $full = [System.IO.Path]::GetFullPath($PathValue)
    if ($full.Equals($live, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($live + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must not be the live C:\Transfert workspace"
    }
    return $full
}

function Test-ReparsePoint([string]$Literal) {
    if (-not (Test-Path -LiteralPath $Literal)) { return $false }
    $item = Get-Item -LiteralPath $Literal -Force
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Assert-RealDirectory([string]$Full, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Full -PathType Container)) {
        throw "$Label must be an existing directory"
    }
    if (Test-ReparsePoint $Full) {
        throw "$Label must not be a link or junction"
    }
}

function Test-Nested([string]$Inner, [string]$Outer) {
    $left = $Inner.TrimEnd('\')
    $right = $Outer.TrimEnd('\')
    return $left.Equals($right, [StringComparison]::OrdinalIgnoreCase) -or $left.StartsWith($right + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-ReleasePlannerDefault([string]$FullRelease) {
    $source = Join-Path $FullRelease 'hq_planner.py'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release planner module is missing"
    }
    foreach ($line in [System.IO.File]::ReadLines($source)) {
        if ($line -match '^\s*DEFAULT_PORT\s*=\s*(\d+)\s*(?:#.*)?$') {
            return [int]$Matches[1]
        }
    }
    throw "Release planner module does not declare DEFAULT_PORT"
}

function Get-ConfiguredPlannerPort([string]$ConfigPath, [int]$Fallback) {
    $raw = [System.IO.File]::ReadAllText($ConfigPath)
    $config = $raw | ConvertFrom-Json
    $value = $config.planner_port
    if ($null -eq $value -or "$value" -eq '') { return $Fallback }
    $parsed = 0
    if (-not [int]::TryParse("$value", [ref]$parsed)) {
        throw "planner_port must be an integer"
    }
    if ($parsed -lt 1024 -or $parsed -gt 65535) {
        throw "planner_port is outside 1024-65535"
    }
    return $parsed
}

$releaseFull = Assert-OutsideLive $ReleaseDir 'ReleaseDir'
$stateFull = Assert-OutsideLive $StateRoot 'StateRoot'
Assert-RealDirectory $releaseFull 'ReleaseDir'
Assert-RealDirectory $stateFull 'StateRoot'
if (Test-Nested $stateFull $releaseFull -or Test-Nested $releaseFull $stateFull) {
    throw "Release directory and state root must not contain each other"
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw "HTTP port is outside 1024-65535" }
if ($productionPorts -contains $Port) { throw "A side-by-side release must not bind 8765 or 8766" }

$bridge = Join-Path $releaseFull 'iphone_bridge.py'
$assets = Join-Path $releaseFull 'assets'
$config = Join-Path $stateFull 'bridge_config.json'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf) -or (Test-ReparsePoint $bridge)) {
    throw "Release bridge is missing or is a link"
}
if (-not (Test-Path -LiteralPath $assets -PathType Container) -or (Test-ReparsePoint $assets)) {
    throw "Release assets are missing or are a link"
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or (Test-ReparsePoint $config)) {
    throw "State root has no bridge_config.json"
}

$planner = Get-ConfiguredPlannerPort $config (Get-ReleasePlannerDefault $releaseFull)
if ($productionPorts -contains $planner) { throw "A side-by-side release must not bind planner port 8765 or 8766" }
if ($planner -eq $Port) { throw "Bridge port and planner port must be different" }

$lock = Join-Path $stateFull 'bridge.lock'
if (Test-Path -LiteralPath $lock) {
    if (Test-ReparsePoint $lock) { throw "bridge.lock must not be a link" }
    $owned = $env:HQ_LOCK_PROBE
    $env:HQ_LOCK_PROBE = $lock
    $probe = "import msvcrt,os; p=os.environ['HQ_LOCK_PROBE']; h=open(p,'r+b'); h.seek(0)`ntry:`n msvcrt.locking(h.fileno(), msvcrt.LK_NBLCK, 1); msvcrt.locking(h.fileno(), msvcrt.LK_UNLCK, 1); print('free')`nexcept OSError:`n print('owned')`nfinally:`n h.close()"
    $answer = & py.exe -3 -c $probe
    $env:HQ_LOCK_PROBE = $owned
    if ("$answer".Trim() -eq 'owned') {
        throw "State root is already owned by another bridge"
    }
}

if ($ValidateOnly) {
    Write-Host "Release layout is valid"
    exit 0
}
$env:HQ_STATE_ROOT = $stateFull
$env:HQ_PORT = "$Port"
# Stay attached to this Python process. A native failure must not be swallowed
# as success, and it must not be turned into a PowerShell error that hides the
# real exit code.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
& py.exe -3 $bridge
if ($null -eq $LASTEXITCODE) { exit 1 }
exit $LASTEXITCODE
