@echo off
setlocal EnableDelayedExpansion

REM HAPI Development Restart Script for Windows
REM Stops server/runner and restarts both (no rebuild)
REM
REM Usage: dev-restart.bat [project_dir]
REM   project_dir: Optional. Directory to run server from (default: K:\BENCH\PROJECTS\BoundMore)

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HAPI_EXE=%SCRIPT_DIR%\cli\dist-exe\bun-windows-x64\hapi.exe"
set "PROJECT_DIR=%~1"
if "%PROJECT_DIR%"=="" set "PROJECT_DIR=K:\BENCH\PROJECTS\BoundMore"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Development Restart Script (Windows)
echo [INFO] Project dir: %PROJECT_DIR%
echo [INFO] ==========================================
echo.

REM Step 1: Stop runner
echo [INFO] Stopping hapi-dev runner...
"%HAPI_EXE%" runner stop 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [SUCCESS] Runner stopped
) else (
    echo [WARN] Runner was not running or failed to stop
)

REM Step 2: Stop server (kill any existing hapi server processes)
echo [INFO] Stopping hapi-dev server...
taskkill /F /IM hapi.exe 2>nul
timeout /t 1 /nobreak >nul
echo [SUCCESS] Server stopped

REM Step 3: Start server in background
echo [INFO] Starting hapi-dev server from %PROJECT_DIR%...

set "SERVER_LOG=%TEMP%\hapi-server-%RANDOM%.log"

REM Start server in a new window
cd /d "%PROJECT_DIR%"
set "HAPI_LISTEN_HOST=0.0.0.0"
start "HAPI Server" cmd /c ""%HAPI_EXE%" server 2>&1 | tee "%SERVER_LOG%""

REM Wait for server to start
echo [INFO] Waiting for server to start...
timeout /t 3 /nobreak >nul
echo [SUCCESS] Server started in separate window

REM Step 4: Start runner
echo [INFO] Starting hapi-dev runner...
"%HAPI_EXE%" runner start
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Runner failed to start
    exit /b 1
)
echo [SUCCESS] Runner started

echo.
echo [SUCCESS] ==========================================
echo [SUCCESS] HAPI dev environment is ready!
echo [SUCCESS] Server running in separate window
echo [SUCCESS] Server log: %SERVER_LOG%
echo [SUCCESS] ==========================================
echo.
echo Press Ctrl+C in the server window to stop the server.
echo Run "dev-stop.bat" to stop everything.

endlocal
