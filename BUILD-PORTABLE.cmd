@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-WINDOWS.ps1" -Mode Portable
if errorlevel 1 (
  echo.
  echo ERROR: build failed. Review the error above.
  pause
  exit /b 1
)
echo.
echo AngelTime Portable EXE is in the dist folder.
pause
