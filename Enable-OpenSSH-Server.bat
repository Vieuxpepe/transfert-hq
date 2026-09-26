@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================
echo  Transfert HQ - Enable OpenSSH Server
echo ========================================
echo.
echo  This lets Command Center read disk space
echo  on THIS PC over Tailscale (100.x).
echo.
echo  Needs Administrator once.
echo ========================================
echo.

:: Re-launch elevated if needed
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo [1/4] Installing OpenSSH Server (Windows capability)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'; " ^
  "if (-not $cap) { Write-Host 'OpenSSH.Server capability not found.' -ForegroundColor Red; exit 1 }; " ^
  "if ($cap.State -ne 'Installed') { " ^
  "  Add-WindowsCapability -Online -Name $cap.Name | Out-Null; " ^
  "  Write-Host 'Installed:' $cap.Name -ForegroundColor Green " ^
  "} else { Write-Host 'Already installed:' $cap.Name -ForegroundColor Green }"
if errorlevel 1 (
  echo FAILED: could not install OpenSSH Server.
  pause
  exit /b 1
)

echo [2/4] Starting sshd and setting Automatic startup...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Service sshd -ErrorAction Stop; " ^
  "Set-Service -Name sshd -StartupType Automatic; " ^
  "Get-Service sshd | Format-List Name,Status,StartType"
if errorlevel 1 (
  echo FAILED: could not start sshd service.
  pause
  exit /b 1
)

echo [3/4] Firewall: OpenSSH only from Tailscale (100.64.0.0/10)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$name='OpenSSH-Server-In-TCP'; " ^
  "$rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue; " ^
  "if (-not $rule) { " ^
  "  New-NetFirewallRule -Name $name -DisplayName 'OpenSSH SSH Server (Tailscale only)' " ^
  "    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 " ^
  "    -RemoteAddress 100.64.0.0/10 | Out-Null; " ^
  "  Write-Host 'Firewall rule created (Tailscale CGNAT only).' -ForegroundColor Green " ^
  "} else { " ^
  "  Set-NetFirewallRule -Name $name -Enabled True -Action Allow -ErrorAction SilentlyContinue; " ^
  "  Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule | Set-NetFirewallAddressFilter -RemoteAddress 100.64.0.0/10; " ^
  "  Write-Host 'Firewall rule scoped to 100.64.0.0/10.' -ForegroundColor Green " ^
  "}; " ^
  "$cfg = Join-Path $env:ProgramData 'ssh\\sshd_config'; " ^
  "if (Test-Path $cfg) { " ^
  "  $c = Get-Content -LiteralPath $cfg; " ^
  "  $c = $c | Where-Object { $_ -notmatch '^\\s*PasswordAuthentication\\s+' }; " ^
  "  $c += 'PasswordAuthentication no'; " ^
  "  if (-not ($c | Where-Object { $_ -match '^\\s*PubkeyAuthentication\\s+' })) { $c += 'PubkeyAuthentication yes' }; " ^
  "  Set-Content -LiteralPath $cfg -Value $c -Encoding ascii; " ^
  "  Restart-Service sshd -ErrorAction SilentlyContinue; " ^
  "  Write-Host 'sshd: PasswordAuthentication no' -ForegroundColor Green " ^
  "}"

echo [4/4] Quick check...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$u = $env:USERNAME; " ^
  "$ts = & 'C:\Program Files\Tailscale\tailscale.exe' ip -4 2>$null; " ^
  "if (-not $ts) { $ts = '(Tailscale not connected)' }; " ^
  "Write-Host ''; " ^
  "Write-Host 'User on this PC :' $u; " ^
  "Write-Host 'Tailscale IP    :' $ts; " ^
  "Write-Host 'SSH port        : 22'; " ^
  "Write-Host ''; " ^
  "Write-Host 'On HQ PC, set ssh_user in bridge_config.json to:' $u -ForegroundColor Cyan"

echo.
echo ========================================
echo  DONE - OpenSSH Server is ready
echo ========================================
echo.
echo  NEXT (required for disk bars):
echo   1. Copy from HQ Transfert folder to THIS PC:
echo        Authorize-HQ-SSH-Key.bat
echo        hq_ssh.pub
echo   2. Run Authorize-HQ-SSH-Key.bat as Administrator
echo   3. On HQ, ssh_user in bridge_config.json = this username
echo.
echo  Keep Tailscale connected on this machine.
echo ========================================
echo.
pause
endlocal
