@echo off
setlocal

REM HAPI Development Stop Script for Windows
REM Stops both server and runner

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HAPI_EXE=%SCRIPT_DIR%\cli\dist-exe\bun-windows-x64\hapi.exe"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Development Stop Script (Windows)
echo [INFO] ==========================================
echo.

REM Stop runner
echo [INFO] Stopping hapi-dev runner...
"%HAPI_EXE%" runner stop 2>nul
echo [SUCCESS] Runner stopped

REM Stop server (kill all hapi.exe processes)
echo [INFO] Stopping hapi-dev server...
taskkill /F /IM hapi.exe 2>nul
echo [SUCCESS] Server stopped

REM Also kill any claude processes spawned by hapi
echo [INFO] Stopping any Claude processes...
taskkill /F /IM claude.exe 2>nul

echo.
echo [SUCCESS] All HAPI processes stopped.
echo.

endlocal
