@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"

echo.
echo ==========================================
echo  PC1: Serving hapi.exe for PC2 download
echo  URL: http://100.122.141.75:8989/hapi.exe
echo  Keep this window open while PC2 downloads
echo  Press Ctrl+C when done
echo ==========================================
echo.

"%BUN_EXE%" run "%SCRIPT_DIR%pc1-serve-hapi.js"

echo.
echo [INFO] Server stopped.
pause
endlocal
