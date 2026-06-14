@echo off
title Local AI Image Generator
cd /d "%~dp0"

set APP=%~dp0app
set NODE=%APP%\tools\node-win\node.exe
set NPM=%APP%\tools\node-win\npm.cmd
set DIST=%APP%\dist\index.html
set SETUP=%~dp0scripts\setup.ps1
set CUDA_BACKEND=%APP%\backend\win\cuda\sd-cuda.exe
set VULKAN_BACKEND=%APP%\backend\win\vulkan\sd-vulkan.exe
set SERVE=%~dp0scripts\serve.cjs
if "%FRONTEND_PORT%"=="" set FRONTEND_PORT=1420
set SETUP_REASON=
set SETUP_MODE=Repair

:: ── First-time setup check ────────────────────────────────────────────────────
if not exist "%APP%\tools\node-win" set SETUP_MODE=First-Time Setup
if not exist "%NODE%" (
    set SETUP_REASON=Portable Node.js is missing.
    goto :run_setup
)
if not exist "%NPM%" (
    set SETUP_REASON=Portable npm is missing.
    goto :run_setup
)
if not exist "%DIST%" (
    set SETUP_REASON=Frontend build is missing.
    goto :run_setup
)
if exist "%CUDA_BACKEND%" goto :launch
if exist "%VULKAN_BACKEND%" goto :launch
set SETUP_REASON=No backend binary is installed.
goto :run_setup

:run_setup
echo.
echo  ============================================================
echo   LOCAL AI IMAGE GENERATOR  ^|  %SETUP_MODE%
echo  ============================================================
echo.
if "%SETUP_MODE%"=="First-Time Setup" (
    echo  This looks like your first run. Setting up automatically...
) else (
    echo  Local AI Image Generator needs a quick repair before launch.
)
if not "%SETUP_REASON%"=="" echo  Reason: %SETUP_REASON%
echo  Models are not downloaded during setup. Download or import them in the app.
echo.
echo  Press any key to continue, or Ctrl+C to cancel.
pause >nul

:: Clear old frontend server process before setup so app/tools/node-win can be replaced
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%FRONTEND_PORT% "') do taskkill /f /pid %%a >nul 2>nul

powershell -ExecutionPolicy Bypass -File "%SETUP%"
if errorlevel 1 (
    echo.
    echo  [ERROR] Setup failed. Please check the output above.
    pause
    exit /b 1
)

:: After setup, continue to launch
goto :launch

:: ── Launch ────────────────────────────────────────────────────────────────────
:launch
cls
echo.
echo  ============================================================
echo   LOCAL AI IMAGE GENERATOR  ^|  Launching...
echo  ============================================================
echo.

:: Clear only the frontend port. The backend auto-selects a free port.
echo  Clearing frontend port %FRONTEND_PORT%...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%FRONTEND_PORT% "') do taskkill /f /pid %%a >nul 2>nul

:: Start frontend server + backend manager (serve.cjs manages sd-vulkan.exe)
echo  Starting Local AI Image Generator...
start "SD-Server" /min "%NODE%" "%SERVE%"

:: Wait for server to bind
timeout /t 2 >nul

:: Open browser
echo  Opening browser at http://localhost:%FRONTEND_PORT%
start http://localhost:%FRONTEND_PORT%

echo.
echo  ============================================================
echo   Running!
echo   Web UI:     http://localhost:%FRONTEND_PORT%
echo   GPU API:    Auto-selected by the app (starts at 8080)
echo.
echo   Close this window to stop all services.
echo  ============================================================
echo.
pause >nul

:: Cleanup on exit
echo  Shutting down...
taskkill /fi "WINDOWTITLE eq SD-Server*" /f >nul 2>nul
echo  Done. Goodbye!
