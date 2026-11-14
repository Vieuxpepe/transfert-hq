# Restart the Transfert HQ bridge: stop only the real bridge, start a fresh hidden one, check it answers.
# Targets come from the port listener and bridge.pid, and a process is stopped only when it is a Python
# host whose command line really runs iphone_bridge.py. Shells, editors and agents that merely mention
# the filename are left alone.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765
$pidFile = Join-Path $root 'bridge.pid'
$pythonHosts = @('python.exe', 'pythonw.exe', 'py.exe')

function Get-BridgePortOwners {
    $owners = @()
    try {
        $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess)
    } catch {
        $owners = @(netstat -ano |
            Select-String -Pattern (':{0}\s' -f $port) |
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
    if (Test-Path $pidFile) {
        $recorded = "$(Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
        if ($recorded -match '^\d+$') { $ids.Add([int]$recorded) }
    }
    $targets = New-Object System.Collections.Generic.List[object]
    foreach ($id in ($ids | Select-Object -Unique)) {
        if ($id -eq $PID) { continue }
        $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=$id") -ErrorAction SilentlyContinue
        if (Test-BridgeHost -Proc $proc) { $targets.Add($proc) }
    }
    @($targets | Sort-Object ProcessId -Unique)
}

Write-Host "Looking for the real bridge (port $port listener, bridge.pid)..."
$procs = @(Get-BridgeTargets)
if ($procs.Count -gt 0) {
    foreach ($p in $procs) {
        Write-Host ("  stopping PID {0} ({1})" -f $p.ProcessId, $p.Name)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host "  none running."
}

Write-Host "Starting the bridge (hidden)..."
Start-Process -FilePath "wscript.exe" -ArgumentList ('"{0}"' -f (Join-Path $root 'start_bridge_hidden.vbs'))

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port); $c.Close(); $ok = $true; break
    } catch { }
}
if ($ok) {
    $owners = @(Get-BridgePortOwners)
    Write-Host ("OK: the bridge is answering on port {0} (PID {1})." -f $port, ($owners -join ', '))
    if ($owners.Count -ne 1) {
        Write-Host ("WARNING: {0} listeners own port {1}." -f $owners.Count, $port) -ForegroundColor Yellow
    }
} else {
    Write-Host "PROBLEM: nothing is answering on port $port after 20 s. Try Start-iPhone-Upload.bat to see the error in a window." -ForegroundColor Red
}
