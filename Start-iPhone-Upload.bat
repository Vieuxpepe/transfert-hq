@echo off
cd /d C:\Transfert
echo.
echo ========================================
echo  Transfert Bridge v3
echo ========================================
echo.
for /f "tokens=*" %%i in ('tailscale ip -4 2^>nul') do set TSIP=%%i
echo  LAN:       http://192.168.2.152:8765/
if defined TSIP (
  echo  Tailscale: http://%TSIP%:8765/
) else (
  echo  Tailscale: not installed — winget install Tailscale.Tailscale
)
echo  PIN: see bridge_config.json
echo  Folders: Inbox / Uni / Print
echo.
echo  If already running, this window will exit quickly.
echo ========================================
echo.
py -3 C:\Transfert\iphone_bridge.py
if errorlevel 1 pause
pause
