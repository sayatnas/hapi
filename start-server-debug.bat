@echo off
setlocal

REM Debug script to start HAPI server
set "HAPI_LISTEN_PORT=3007"
set "HAPI_LISTEN_HOST=0.0.0.0"
set "HAPI_EXE=%~dp0cli\dist-exe\bun-windows-x64\hapi.exe"
set "PROJECT_DIR=K:\BENCH\PROJECTS\BoundMore"

echo ========================================
echo HAPI Server Debug Startup
echo ========================================
echo.
echo Configuration:
echo   Port: %HAPI_LISTEN_PORT%
echo   Host: %HAPI_LISTEN_HOST%
echo   Project: %PROJECT_DIR%
echo   Tunnel: ENABLED
echo.
echo Starting server...
echo (Window will stay open to show errors)
echo.

cd /d "%PROJECT_DIR%"
"%HAPI_EXE%" server --relay

echo.
echo ========================================
echo Server stopped or failed to start
echo ========================================
pause
