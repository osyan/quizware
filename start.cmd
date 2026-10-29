@echo off
rem QuizWare local launcher for Windows (no admin install needed).
rem Uses the portable Node.js copy in %USERPROFILE%\tools\node if present,
rem otherwise falls back to Node.js from PATH.

setlocal
set "NODE_DIR=%USERPROFILE%\tools\node"

if exist "%NODE_DIR%\node.exe" (
  set "PATH=%NODE_DIR%;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo QuizWare is starting. Open http://localhost:4000 in your browser.
echo Press Ctrl+C to stop the server.
echo.
call npm start
pause
