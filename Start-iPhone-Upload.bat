@echo off
rem Visible-window start: useful when the hidden start failed and you want to read the error.
rem It uses the same launcher as the logon task, so the duplicate guard and the log files apply here too.
cd /d "%~dp0"
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
echo  If already running, this window exits quickly (see bridge_stdout.log).
echo ========================================
echo.
call "%~dp0start_bridge_logged.cmd"
if errorlevel 1 pause
pause
