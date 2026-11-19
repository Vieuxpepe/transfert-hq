@echo off
rem Transfert HQ - starts the bridge with its console output kept in files, so a crash leaves a traceback instead of
rem vanishing into a hidden window. Called by start_bridge_hidden.vbs (and therefore by Restart-Bridge.ps1 and the
rem logon task). The identity arrives as HQ_LAUNCH_PORT / HQ_LAUNCH_STATE_ROOT / HQ_LAUNCH_OWNER from
rem Restart-Bridge.ps1, and is empty for the live-checkout defaults.
cd /d "%~dp0"

set "MAX_LOG=5242880"
rem Identity comes from an explicit launch intent only. A stray HQ_STATE_ROOT / HQ_PRODUCTION_OWNER in whatever
rem shell or shortcut started this file used to change where the bridge writes, or make it look like a side-by-side
rem release and refuse to bind 8765 at all. Restart-Bridge.ps1 is the only caller that sets these two variables.
set "HQ_PORT=%HQ_LAUNCH_PORT%"
if not defined HQ_PORT set "HQ_PORT=8765"
set "HQ_STATE_ROOT=%HQ_LAUNCH_STATE_ROOT%"
set "HQ_PRODUCTION_OWNER="
if defined HQ_LAUNCH_OWNER set "HQ_PRODUCTION_OWNER=1"
set "WANT_PORT=%HQ_PORT%"
rem Each instance logs to its own files. A second bridge on another port cannot append to the live log - the live
rem launcher keeps it open for the whole run - and the silent "file in use" used to hide its entire startup.
set "LOG_STDOUT=%~dp0bridge_stdout.log"
set "LOG_STDERR=%~dp0bridge_stderr.log"
if not "%WANT_PORT%"=="8765" (
    set "LOG_STDOUT=%~dp0bridge_stdout-%WANT_PORT%.log"
    set "LOG_STDERR=%~dp0bridge_stderr-%WANT_PORT%.log"
)

rem The bridge runs for days: keep both logs bounded.
for %%F in ("%LOG_STDOUT%") do if exist "%%F" if %%~zF GTR %MAX_LOG% move /y "%%F" "%LOG_STDOUT%.1" >nul
for %%F in ("%LOG_STDERR%") do if exist "%%F" if %%~zF GTR %MAX_LOG% move /y "%%F" "%LOG_STDERR%.1" >nul

rem One bridge per port. Restart-Bridge.ps1 stops the old bridge and waits two seconds before calling this, so a
rem listener still here means someone started a second copy by hand: refuse instead of racing for the port.
rem Windows answers, not the text of netstat: exit code 0 means a listener exists, 1 means the port is free.
powershell -NoProfile -Command "exit [int](-not (Get-NetTCPConnection -LocalPort %WANT_PORT% -State Listen -ErrorAction SilentlyContinue))" >nul 2>&1
if not errorlevel 1 (
    echo [bridge] a bridge already listens on %WANT_PORT% - not starting a second copy.
    echo ===== skipped, a bridge already listens %DATE% %TIME% ===== >> "%~dp0bridge_launcher.log"
    exit /b 0
)

echo. >> "%LOG_STDOUT%"
echo ===== boot %DATE% %TIME% ===== >> "%LOG_STDOUT%"
set "IDENT_STATE=%HQ_STATE_ROOT%"
if not defined IDENT_STATE set "IDENT_STATE=%CD%"
set "IDENT_OWNER=0"
if defined HQ_PRODUCTION_OWNER set "IDENT_OWNER=%HQ_PRODUCTION_OWNER%"
echo ===== identity port=%WANT_PORT% state=%IDENT_STATE% owner=%IDENT_OWNER% ===== >> "%LOG_STDOUT%"
echo ===== start port=%WANT_PORT% state=%IDENT_STATE% owner=%IDENT_OWNER% %DATE% %TIME% ===== >> "%~dp0bridge_launcher.log"

"C:\Windows\py.exe" -3 "%~dp0iphone_bridge.py" >> "%LOG_STDOUT%" 2>> "%LOG_STDERR%"

echo ===== exit %DATE% %TIME% code %ERRORLEVEL% ===== >> "%LOG_STDOUT%"