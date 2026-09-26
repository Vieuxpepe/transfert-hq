@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================
echo  Transfert HQ - Authorize SSH key
echo ========================================
echo.
echo  Installs hq_ssh.pub so Command Center
echo  can read THIS PC's disk over Tailscale.
echo.
echo  Run on the remote PC (e.g. vieuxpeepee-1)
echo  AFTER Enable-OpenSSH-Server.bat
echo  Needs Administrator.
echo ========================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%~dp0hq_ssh.pub" (
  echo ERROR: hq_ssh.pub not found next to this .bat
  echo Copy both files from the HQ Transfert folder:
  echo   - Authorize-HQ-SSH-Key.bat
  echo   - hq_ssh.pub
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; " ^
  "$pub = Get-Content -Raw '%~dp0hq_ssh.pub'; " ^
  "$pub = ($pub -split \"`n\" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^#' } | Select-Object -First 1); " ^
  "if (-not $pub -or $pub -notmatch '^ssh-') { Write-Host 'Invalid hq_ssh.pub' -ForegroundColor Red; exit 1 }; " ^
  "$userDir = Join-Path $env:USERPROFILE '.ssh'; " ^
  "New-Item -ItemType Directory -Force -Path $userDir | Out-Null; " ^
  "$userAuth = Join-Path $userDir 'authorized_keys'; " ^
  "$existing = if (Test-Path $userAuth) { Get-Content $userAuth -ErrorAction SilentlyContinue } else { @() }; " ^
  "if ($existing -notcontains $pub) { Add-Content -Path $userAuth -Value $pub -Encoding ascii; Write-Host 'Added to' $userAuth -ForegroundColor Green } else { Write-Host 'Already in' $userAuth -ForegroundColor Green }; " ^
  "# Windows OpenSSH: Administrators must use administrators_authorized_keys" ^
  "$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); " ^
  "if ($isAdmin) { " ^
  "  $prog = Join-Path $env:PROGRAMDATA 'ssh'; " ^
  "  New-Item -ItemType Directory -Force -Path $prog | Out-Null; " ^
  "  $adminAuth = Join-Path $prog 'administrators_authorized_keys'; " ^
  "  $aexist = if (Test-Path $adminAuth) { Get-Content $adminAuth -ErrorAction SilentlyContinue } else { @() }; " ^
  "  if ($aexist -notcontains $pub) { Add-Content -Path $adminAuth -Value $pub -Encoding ascii; Write-Host 'Added to' $adminAuth -ForegroundColor Green } else { Write-Host 'Already in' $adminAuth -ForegroundColor Green }; " ^
  "  icacls $adminAuth /inheritance:r | Out-Null; " ^
  "  icacls $adminAuth /grant 'SYSTEM:(F)' | Out-Null; " ^
  "  icacls $adminAuth /grant 'Administrators:(F)' | Out-Null; " ^
  "  Write-Host 'Fixed ACL on administrators_authorized_keys' -ForegroundColor Green; " ^
  "} ; " ^
  "Restart-Service sshd -ErrorAction SilentlyContinue; " ^
  "Write-Host ''; Write-Host 'User:' $env:USERNAME; " ^
  "$ts = & 'C:\Program Files\Tailscale\tailscale.exe' ip -4 2>$null; " ^
  "if ($ts) { Write-Host 'Tailscale IP:' $ts } ; " ^
  "Write-Host ''; Write-Host 'DONE. On HQ, ssh_user should be:' $env:USERNAME -ForegroundColor Cyan"

if errorlevel 1 (
  echo FAILED.
  pause
  exit /b 1
)

echo.
echo ========================================
echo  Key installed - wait ~2 min on HQ
echo  for disk bars, or refresh Command Center.
echo ========================================
echo.
pause
endlocal
