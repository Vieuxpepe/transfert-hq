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
function Assert-OutsideLive([string]$PathValue, [string]$Label) {
    $full = [System.IO.Path]::GetFullPath($PathValue)
    if ($full.Equals($live, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($live + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must not be the live C:\Transfert workspace"
    }
}
if ($Port -eq 8765 -or $Port -eq 8766) {
    throw "A side-by-side release must not bind 8765 or 8766"
}
Assert-OutsideLive $ReleaseDir 'ReleaseDir'
Assert-OutsideLive $StateRoot 'StateRoot'
$bridge = Join-Path $ReleaseDir 'iphone_bridge.py'
$config = Join-Path $StateRoot 'bridge_config.json'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) { throw "Release bridge is missing" }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "State root has no bridge_config.json" }
if ($ValidateOnly) {
    Write-Host "Release layout is valid"
    exit 0
}
$env:HQ_STATE_ROOT = [System.IO.Path]::GetFullPath($StateRoot)
$env:HQ_PORT = "$Port"
& py.exe -3 $bridge
