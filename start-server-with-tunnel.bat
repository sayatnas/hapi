@echo off
setlocal

REM Start HAPI server with tunnel enabled on port 3007
set "HAPI_LISTEN_PORT=3007"
set "HAPI_LISTEN_HOST=0.0.0.0"
set "HAPI_EXE=%~dp0cli\dist-exe\bun-windows-x64\hapi.exe"
set "PROJECT_DIR=K:\BENCH\PROJECTS\BoundMore"

echo Starting HAPI server with tunnel...
echo Port: %HAPI_LISTEN_PORT%
echo Host: %HAPI_LISTEN_HOST%
echo Project: %PROJECT_DIR%
echo.
echo The server will display a public URL and QR code for remote access.
echo.

cd /d "%PROJECT_DIR%"
"%HAPI_EXE%" server --relay
