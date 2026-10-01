# Restart the Transfert HQ bridge: stop every running copy, start a fresh hidden one, check it answers.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

Write-Host "Looking for a running bridge..."
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*iphone_bridge.py*' }
if ($procs) {
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
    $new = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*iphone_bridge.py*' }
    Write-Host ("OK: the bridge is answering on port {0} (PID {1})." -f $port, (($new | Select-Object -First 1).ProcessId))
} else {
    Write-Host "PROBLEM: nothing is answering on port $port after 20 s. Try Start-iPhone-Upload.bat to see the error in a window." -ForegroundColor Red
}
