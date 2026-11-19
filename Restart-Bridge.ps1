# Restart the Transfert HQ bridge in the identity it is already running in: same state root, same port, same owner
# mode. The running bridge publishes that in .hq-boot.json next to this script; without that file the live-checkout
# defaults apply (state root = this folder, port 8765, no owner flag) -- which is what the logon task and the
# double-click .bat produce. Two sessions restarting at once is refused by a machine-wide mutex.
#
# Targets come from the port listener, the published pid and bridge.pid, and a process is stopped only when it is a
# Python host whose command line really runs iphone_bridge.py. Shells, editors and agents that merely mention the
# filename are left alone.
param(
    [int]$Port = 0,
    [string]$StateRoot = '',
    [switch]$ProductionOwner,
    [switch]$Plan
)
# PowerShell variable names are case-insensitive: $stateRoot and $StateRoot are the same variable, so the parameter
# has to be captured before the internal value is computed, or -StateRoot silently reads as empty.
$explicitRoot = $StateRoot
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bootFactsPath = Join-Path $root '.hq-boot.json'
$pythonHosts = @('python.exe', 'pythonw.exe', 'py.exe')

function Get-BridgePortOwners {
    $owners = @()
    try {
        $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess)
    } catch {
        $owners = @(netstat -ano |
            Select-String -Pattern (':{0}\s' -f $Port) |
            Select-String -Pattern 'LISTENING' |
            ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } |
            Where-Object { $_ -match '^\d+$' })
    }
    @($owners | Where-Object { [int]$_ -gt 0 } | Select-Object -Unique)
}

function Test-BridgeHost {
    param($Proc)
    if (-not $Proc) { return $false }
    if ($pythonHosts -notcontains $Proc.Name) { return $false }
    if (-not $Proc.CommandLine) { return $false }
    if ($Proc.CommandLine -notlike '*iphone_bridge.py*') { return $false }
    return $true
}

function Get-BridgeTargets {
    $ids = New-Object System.Collections.Generic.List[int]
    foreach ($owner in (Get-BridgePortOwners)) { $ids.Add([int]$owner) }
    foreach ($candidate in @($publishedPid, $recordedPid)) {
        if ("$candidate" -match '^\d+$') { $ids.Add([int]$candidate) }
    }
    $targets = New-Object System.Collections.Generic.List[object]
    foreach ($id in ($ids | Select-Object -Unique)) {
        if ($id -eq $PID) { continue }
        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=$id") -ErrorAction SilentlyContinue
        if (Test-BridgeHost -Proc $proc) { $targets.Add($proc) }
    }
    @($targets | Sort-Object ProcessId -Unique)
}

# What identity are we restoring? The running bridge publishes it; a stale file is ignored by the pid check below.
$portGiven = $Port -gt 0
$facts = $null
if (Test-Path -LiteralPath $bootFactsPath) {
    try { $facts = Get-Content -LiteralPath $bootFactsPath -Raw | ConvertFrom-Json } catch { $facts = $null }
}
if (-not $portGiven) {
    $Port = $(if ($facts -and $facts.port) { [int]$facts.port } else { 8765 })
}
# The published identity only describes its own port; a side-by-side release on another port must say where it lives.
$useFacts = $facts -and ([int]$facts.port -eq $Port)
$stateRoot = ''
if ($useFacts -and $facts.state_root) { $stateRoot = [string]$facts.state_root }
$ownerMode = [bool]($useFacts -and $facts.production_owner)
if ($explicitRoot) { $stateRoot = $explicitRoot }
if ($ProductionOwner) { $ownerMode = $true }
# The live checkout has no explicit state root: passing its own folder would make the new bridge look like a
# side-by-side release, take the state lock, and refuse to bind 8765 at all.
if ($stateRoot) {
    $normalisedRoot = [System.IO.Path]::GetFullPath($stateRoot).TrimEnd('\')
    if ($normalisedRoot -ieq [System.IO.Path]::GetFullPath($root).TrimEnd('\')) { $stateRoot = '' }
}
if (-not $stateRoot) {
    if ($ProductionOwner) {
        Write-Host "PROBLEM: -ProductionOwner needs a -StateRoot other than this folder." -ForegroundColor Red
        exit 1
    }
    $ownerMode = $false
}
if (-not $stateRoot -and $Port -ne 8765) {
    Write-Host ("PROBLEM: port {0} is not the live port and no -StateRoot was given." -f $Port) -ForegroundColor Red
    Write-Host "  A side-by-side release must name its own state root: -Port 8799 -StateRoot C:\hq-state\live"
    exit 1
}
if ($stateRoot -and -not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
    Write-Host ("PROBLEM: state root {0} does not exist." -f $stateRoot) -ForegroundColor Red
    exit 1
}
$publishedPid = $(if ($useFacts -and $facts.pid) { [int]$facts.pid } else { $null })
$pidFile = $(if ($stateRoot) { Join-Path $stateRoot 'bridge.pid' } else { Join-Path $root 'bridge.pid' })
$recordedPid = $null
if (Test-Path -LiteralPath $pidFile) {
    $recordedPid = "$(Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
}

$vbs = Join-Path $root 'start_bridge_hidden.vbs'
if (-not (Test-Path -LiteralPath $vbs -PathType Leaf)) {
    Write-Host "PROBLEM: $vbs is missing; nothing can be started." -ForegroundColor Red
    exit 1
}

$targets = @(Get-BridgeTargets)

if ($Plan) {
    Write-Host 'Plan: nothing was stopped and nothing was started.'
    Write-Host ("  port        : {0}" -f $Port)
    Write-Host ("  state root  : {0}" -f $(if ($stateRoot) { $stateRoot } else { "$root (live checkout default)" }))
    Write-Host ("  owner mode  : {0}" -f $ownerMode)
    $bootLine = if ($facts) {
        $id = if ($facts.instance_id) { ", instance_id $($facts.instance_id)" } else { '' }
        "pid $($facts.pid), started $(([DateTimeOffset]::FromUnixTimeSeconds([int64]$facts.started)).LocalDateTime)$id"
    } else { 'missing (defaults will be used)' }
    Write-Host ("  boot facts  : {0}" -f $bootLine)
    Write-Host ("  targets     : {0}" -f $(if ($targets.Count) { ($targets | ForEach-Object { "{0}({1})" -f $_.ProcessId, $_.Name }) -join ', ' } else { 'none' }))
    exit 0
}

# One restart at a time. Two sessions restarting at once kill each other's fresh bridge: the loser of the bind race
# exits and the browser sees ECONNREFUSED in between. A holder that dies mid-restart leaves the mutex abandoned,
# which the next run takes over instead of blocking forever.
$restartMutexName = 'Global\TransfertBridgeRestart'
$restartMutex = [System.Threading.Mutex]::new($false, $restartMutexName)
$restartHeld = $false
try {
    $restartHeld = $restartMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $restartHeld = $true
}
if (-not $restartHeld) {
    Write-Host ("Another restart is already in flight (mutex {0}). Nothing was stopped and nothing was started; retry in a few seconds." -f $restartMutexName) -ForegroundColor Yellow
    exit 2
}

try {

Write-Host ("Looking for the real bridge (port {0}, .hq-boot.json, bridge.pid)..." -f $Port)
if ($targets.Count -gt 0) {
    foreach ($p in $targets) {
        Write-Host ("  stopping PID {0} ({1})" -f $p.ProcessId, $p.Name)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host "  none running."
}

# Hand the identity to the launcher: the VBS inherits this environment, so the new process comes back on the same
# state root instead of silently switching to the default one.
# HQ_LAUNCH_* is the only identity channel the launcher reads; the plain HQ_* variables are cleared so a stale value
# in this shell cannot leak into the new bridge.
Remove-Item Env:HQ_PORT, Env:HQ_STATE_ROOT, Env:HQ_PRODUCTION_OWNER -ErrorAction SilentlyContinue
$env:HQ_LAUNCH_PORT = "$Port"
if ($stateRoot) { $env:HQ_LAUNCH_STATE_ROOT = $stateRoot } else { Remove-Item Env:HQ_LAUNCH_STATE_ROOT -ErrorAction SilentlyContinue }
if ($ownerMode) { $env:HQ_LAUNCH_OWNER = '1' } else { Remove-Item Env:HQ_LAUNCH_OWNER -ErrorAction SilentlyContinue }

Write-Host ("Starting the bridge (hidden) for {0}..." -f $(if ($stateRoot) { $stateRoot } else { 'this folder' }))
Start-Process -FilePath "wscript.exe" -ArgumentList ('"{0}"' -f $vbs)

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port); $c.Close(); $ok = $true; break
    } catch { }
}
if ($ok) {
    $owners = @(Get-BridgePortOwners)
    Write-Host ("OK: the bridge is answering on port {0} (PID {1})." -f $Port, ($owners -join ', '))
    if ($owners.Count -ne 1) {
        Write-Host ("WARNING: {0} listeners own port {1}." -f $owners.Count, $Port) -ForegroundColor Yellow
    }
    if ($Port -eq 8765 -and (Test-Path -LiteralPath $bootFactsPath)) {
        try {
                $now = Get-Content -LiteralPath $bootFactsPath -Raw | ConvertFrom-Json
                if ($stateRoot -and "$($now.state_root)" -ne $stateRoot) {
                    Write-Host ("WARNING: the new bridge reports state root {0}, not {1}." -f $now.state_root, $stateRoot) -ForegroundColor Yellow
                }
            } catch { }
        }
    } else {
        Write-Host "PROBLEM: nothing is answering on port $Port after 20 s. Try Start-iPhone-Upload.bat to see the error in a window." -ForegroundColor Red
    }

} finally {
    if ($restartHeld) {
        try { $restartMutex.ReleaseMutex() } catch { }
    }
    try { $restartMutex.Dispose() } catch { }
}