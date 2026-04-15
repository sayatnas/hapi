@echo off
setlocal EnableDelayedExpansion

REM HAPI Development Rebuild Script for Windows
REM Builds first (to temp dir), then stops server/runner, swaps exe, restarts.
REM This avoids EPERM errors from Windows file-locking the running hapi.exe.
REM
REM Usage: dev-rebuild.bat [project_dir]
REM   project_dir: Optional. Directory to run server from (default: K:\BENCH\PROJECTS\BoundMore)

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HAPI_EXE=%SCRIPT_DIR%\cli\dist-exe\bun-windows-x64\hapi.exe"
set "HAPI_EXE_TMP=%SCRIPT_DIR%\cli\dist-exe-tmp\bun-windows-x64\hapi.exe"
set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
set "PROJECT_DIR=%~1"
if "%PROJECT_DIR%"=="" set "PROJECT_DIR=K:\BENCH\PROJECTS\BoundMore"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Development Rebuild Script (Windows)
echo [INFO] Project dir: %PROJECT_DIR%
echo [INFO] ==========================================
echo.

REM ========================================
REM Phase 1: Build everything (hapi can stay running)
REM ========================================

cd /d "%SCRIPT_DIR%"

echo [INFO] Step 1/6: Downloading tunwg...
call "%BUN_EXE%" run download:tunwg
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] download:tunwg failed!
    pause
    exit /b 1
)

echo [INFO] Step 2/6: Building web assets...
call "%BUN_EXE%" run build:web
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] build:web failed!
    pause
    exit /b 1
)

echo [INFO] Step 3/6: Generating embedded web assets...
cd /d "%SCRIPT_DIR%\hub"
call "%BUN_EXE%" run generate:embedded-web-assets
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] generate:embedded-web-assets failed!
    pause
    exit /b 1
)

echo [INFO] Step 4/6: Building executable (to temp dir)...
cd /d "%SCRIPT_DIR%\cli"
call "%BUN_EXE%" run scripts/build-executable.ts --with-web-assets --outdir dist-exe-tmp
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Executable build failed!
    pause
    exit /b 1
)
echo [SUCCESS] Build completed successfully

REM ========================================
REM Phase 2: Stop old hapi, swap exe, restart
REM ========================================

echo [INFO] Step 5/6: Stopping old hapi processes...

REM Try graceful runner stop (may fail if old exe is gone, that is ok)
"%HAPI_EXE%" runner stop

REM Force kill all hapi.exe processes
taskkill /F /IM hapi.exe
timeout /t 5 /nobreak
echo [SUCCESS] Old processes stopped

REM Swap the exe using rename trick (Windows allows renaming locked files)
echo [INFO] Swapping executable...
set "HAPI_EXE_OLD=%HAPI_EXE%.old"

REM Clean up previous .old file if it exists
if exist "%HAPI_EXE_OLD%" del /F /Q "%HAPI_EXE_OLD%"

if exist "%HAPI_EXE%" (
    REM Try rename first - works on locked files where del fails
    move /Y "%HAPI_EXE%" "%HAPI_EXE_OLD%"
    if exist "%HAPI_EXE%" (
        echo [WARN] Rename failed, waiting 5s and retrying...
        timeout /t 5 /nobreak
        move /Y "%HAPI_EXE%" "%HAPI_EXE_OLD%"
    )
    if exist "%HAPI_EXE%" (
        echo [WARN] Cannot move old exe, will start from temp dir instead
        set "HAPI_EXE=%HAPI_EXE_TMP%"
        goto :start_server
    )
)
copy /Y "%HAPI_EXE_TMP%" "%HAPI_EXE%"
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Copy failed, will start from temp dir instead
    set "HAPI_EXE=%HAPI_EXE_TMP%"
    goto :start_server
)
echo [SUCCESS] Executable swapped

REM Cleanup
del /F /Q "%HAPI_EXE_OLD%"
rmdir /S /Q "%SCRIPT_DIR%\cli\dist-exe-tmp"

REM ========================================
REM Phase 3: Start server + runner
REM ========================================

:start_server
echo [INFO] Step 6/6: Starting server and runner...

set "SERVER_LOG=%TEMP%\hapi-server-%RANDOM%.log"

cd /d "%PROJECT_DIR%"
set "HAPI_LISTEN_HOST=0.0.0.0"
start "HAPI Server" cmd /c ""%HAPI_EXE%" server 2>&1 | tee "%SERVER_LOG%""

echo [INFO] Waiting for server to start...
timeout /t 3 /nobreak
echo [SUCCESS] Server started in separate window

"%HAPI_EXE%" runner start
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Runner failed to start
    pause
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
pause

endlocal
