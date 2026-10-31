@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-WINDOWS.ps1" -Mode Dev
if errorlevel 1 pause
