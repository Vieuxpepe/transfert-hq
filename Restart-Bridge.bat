@echo off
rem Double-click to restart the Transfert HQ bridge (stops the old one, starts a new hidden one).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Bridge.ps1"
echo.
pause
