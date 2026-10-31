@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-WINDOWS.ps1" -Mode Installer
if errorlevel 1 (
  echo.
  echo ERROR: build failed. Review the error above.
  pause
  exit /b 1
)
pause
