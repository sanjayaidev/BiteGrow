@echo off
cd /d "%~dp0"
title Promo site server
echo Folder: %CD%
node -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is not installed or not on PATH.
  echo     Install the LTS version from https://nodejs.org , then close and reopen this.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node %%v
if not exist "node_modules\express" (
  echo Installing dependencies, first run only...
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo [!] npm install failed - see the messages above. Check your internet connection.
    pause
    exit /b 1
  )
)
if not exist "server.js" (
  echo [!] server.js not found here. Extract the whole zip first, do not run from inside the zip.
  pause
  exit /b 1
)
node server.js
echo.
echo [!] Server stopped. If there is an error above, copy it.
pause
