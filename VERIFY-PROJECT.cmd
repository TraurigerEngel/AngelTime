@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0VERIFY-PROJECT.ps1"
if errorlevel 1 (
  echo ERROR: SHA256 mismatch.
  pause
  exit /b 1
)
pause
