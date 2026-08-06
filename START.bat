@echo off
REM Starts the DBL AI Automation dashboard on http://localhost:8080
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this machine.
  echo Install it from https://nodejs.org, or just open index.html directly
  echo (some browser features behave differently on a file:// page^).
  pause
  exit /b 1
)

echo Starting the dashboard on http://localhost:8080 ...
start "" http://localhost:8080
node "%~dp0scripts\serve.js" 8080

endlocal
