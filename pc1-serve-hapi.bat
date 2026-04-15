@echo off
setlocal

set "HAPI_EXE=K:\BENCH\Proto\hapi-dev\cli\dist-exe\bun-windows-x64\hapi.exe"
set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
set "PORT=8989"

echo.
echo ==========================================
echo  PC1: Serving hapi.exe for PC2 download
echo  URL: http://100.122.141.75:%PORT%/hapi.exe
echo  Keep this window open while PC2 downloads
echo  Press Ctrl+C when done
echo ==========================================
echo.

"%BUN_EXE%" run --bun -e "const f='%HAPI_EXE:\=\\%'; const s=Bun.serve({port:%PORT%,fetch(r){console.log('[GET] '+r.url);return new Response(Bun.file(f),{headers:{'Content-Disposition':'attachment; filename=\"hapi.exe\"'}});}}); console.log('Serving hapi.exe on port %PORT%...');"

endlocal
