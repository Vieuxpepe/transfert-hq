@echo off
rem Transfert HQ - starts the bridge with its console output kept in files, so a crash leaves a traceback instead of
rem vanishing into a hidden window. Called by start_bridge_hidden.vbs (and therefore by Restart-Bridge.ps1).
cd /d "%~dp0"

set "LOG_STDOUT=%~dp0bridge_stdout.log"
set "LOG_STDERR=%~dp0bridge_stderr.log"

echo. >> "%LOG_STDOUT%"
echo ===== boot %DATE% %TIME% ===== >> "%LOG_STDOUT%"

"C:\Windows\py.exe" -3 "%~dp0iphone_bridge.py" >> "%LOG_STDOUT%" 2>> "%LOG_STDERR%"

echo ===== exit %DATE% %TIME% code %ERRORLEVEL% ===== >> "%LOG_STDOUT%"
