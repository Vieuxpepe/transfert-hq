@echo off
rem Double-click to restart the Transfert HQ bridge (stops the old one, starts a new hidden one).
rem Arguments are forwarded: Restart-Bridge.bat -Plan shows the identity without stopping anything.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Bridge.ps1" %*
echo.
pause
