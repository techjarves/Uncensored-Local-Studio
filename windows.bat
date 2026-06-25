@echo off
title Uncensored AI Studio
cd /d "%~dp0"

set APP=%~dp0app
set NODE=%APP%\tools\node-win\node.exe
set NPM=%APP%\tools\node-win\npm.cmd
set DIST=%APP%\dist\index.html
set SETUP=%~dp0scripts\setup\setup.ps1
set CUDA_BACKEND=%APP%\backend\win\cuda\sd-cuda.exe
set VULKAN_BACKEND=%APP%\backend\win\vulkan\sd-vulkan.exe
set LLM_CUDA_BACKEND=%APP%\llm-backend\win\cuda\llama-server.exe
set LLM_HIP_BACKEND=%APP%\llm-backend\win\hip\llama-server.exe
set LLM_VULKAN_BACKEND=%APP%\llm-backend\win\vulkan\llama-server.exe
set LLM_SYCL_BACKEND=%APP%\llm-backend\win\sycl\llama-server.exe
set LLM_CPU_BACKEND=%APP%\llm-backend\win\cpu\llama-server.exe
set SPEECH_BACKEND=%APP%\speech-backend\win\cpu\whisper-cli.exe
set TTS_RUNTIME=%APP%\tts-runtime\node_modules\kokoro-js
set SERVE=%~dp0scripts\server\serve.cjs
if "%FRONTEND_PORT%"=="" set FRONTEND_PORT=1420
if "%LLM_PORT%"=="" set LLM_PORT=10086
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
if not exist "%LLM_CUDA_BACKEND%" if not exist "%LLM_HIP_BACKEND%" if not exist "%LLM_VULKAN_BACKEND%" if not exist "%LLM_SYCL_BACKEND%" if not exist "%LLM_CPU_BACKEND%" (
    set SETUP_REASON=llama.cpp text backend is missing.
    goto :run_setup
)
if not exist "%SPEECH_BACKEND%" (
    set SETUP_REASON=whisper.cpp speech backend is missing.
    goto :run_setup
)
if not exist "%TTS_RUNTIME%" (
    set SETUP_REASON=Kokoro text-to-speech runtime is missing.
    goto :run_setup
)
if exist "%CUDA_BACKEND%" goto :launch
if exist "%VULKAN_BACKEND%" goto :launch
set SETUP_REASON=No backend binary is installed.
goto :run_setup

:run_setup
echo.
echo  ============================================================
echo   UNCENSORED AI STUDIO      ^|  %SETUP_MODE%
echo  ============================================================
echo.
if "%SETUP_MODE%"=="First-Time Setup" (
    echo  This looks like your first run. Setting up automatically...
) else (
    echo  Uncensored AI Studio needs a quick repair before launch.
)
if not "%SETUP_REASON%"=="" echo  Reason: %SETUP_REASON%
echo  Models are not downloaded during setup. Download or import them in the app.
echo.
echo  Press any key to continue, or Ctrl+C to cancel.
pause >nul

:: Clear old frontend and backend server processes before setup so app/tools/node-win can be replaced
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%FRONTEND_PORT% "') do taskkill /f /pid %%a >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8080 "') do taskkill /f /pid %%a >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%LLM_PORT% "') do taskkill /f /pid %%a >nul 2>nul

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
echo.
echo  ============================================================
echo   UNCENSORED AI STUDIO      ^|  Launching...
echo  ============================================================
echo.

:: Clear frontend and backend ports to prevent address conflicts.
echo  Clearing frontend port %FRONTEND_PORT%, backend port 8080, and text port %LLM_PORT%...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%FRONTEND_PORT% "') do taskkill /f /pid %%a >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8080 "') do taskkill /f /pid %%a >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%LLM_PORT% "') do taskkill /f /pid %%a >nul 2>nul

:: Start frontend server + backend manager (serve.cjs manages sd-vulkan.exe)
echo  Starting Uncensored AI Studio...
echo  Opening browser at http://localhost:%FRONTEND_PORT%...
start /b cmd /c "timeout /t 2 >nul && start http://localhost:%FRONTEND_PORT%"

echo.
echo  ============================================================
echo   Running!
echo   Web UI:     http://localhost:%FRONTEND_PORT%
echo   GPU API:    Auto-selected by the app (starts at 8080)
echo   Text API:   Starts when a GGUF model is loaded (port %LLM_PORT%)
echo   Speech:     Managed locally by the app
echo   TTS:        Managed locally by the app
echo.
echo   Press Ctrl+C in this window to stop all services.
echo  ============================================================
echo.

"%NODE%" "%SERVE%"
