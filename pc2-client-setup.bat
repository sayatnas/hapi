@echo off
setlocal EnableDelayedExpansion

echo.
echo ==========================================
echo  HAPI PC2 Client Setup
echo  Connecting to PC1 (Sayat's machine)
echo  Hub: http://100.122.141.75:3006
echo ==========================================
echo.

REM ----------------------------------------
REM Hardcoded PC1 settings
REM ----------------------------------------
set "HUB_URL=http://100.122.141.75:3006"
set "CLI_TOKEN=12345"

REM Set env vars so hapi.exe uses these regardless of settings file
set "HAPI_API_URL=http://100.122.141.75:3006"
set "CLI_API_TOKEN=12345"
set "HAPI_HTTP_URL=http://100.122.141.75:8989/hapi.exe"
set "HAPI_NET_PATH=\\100.122.141.75\K$\BENCH\Proto\hapi-dev\cli\dist-exe\bun-windows-x64\hapi.exe"
set "HAPI_DEST=%USERPROFILE%\.hapi\hapi.exe"

REM ----------------------------------------
REM Step 1: Get hapi.exe
REM ----------------------------------------
if exist "%HAPI_DEST%" (
    echo [INFO] hapi.exe already found at %HAPI_DEST% - skipping copy.
    goto :write_settings
)

if not exist "%USERPROFILE%\.hapi" mkdir "%USERPROFILE%\.hapi"

REM Try 1: download via HTTP (run pc1-serve-hapi.bat on PC1 first)
echo [INFO] Trying HTTP download from PC1...
curl -L --max-time 30 -o "%HAPI_DEST%" "%HAPI_HTTP_URL%" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [SUCCESS] Downloaded hapi.exe via HTTP.
    goto :write_settings
)

REM Try 2: admin share
echo [INFO] HTTP not available, trying network share...
copy /Y "%HAPI_NET_PATH%" "%HAPI_DEST%" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [SUCCESS] Copied hapi.exe via network share.
    goto :write_settings
)

echo.
echo [ACTION NEEDED] Could not get hapi.exe automatically.
echo.
echo EASIEST: On PC1, run pc1-serve-hapi.bat - it starts a 1-minute
echo          HTTP server. Then re-run this script on PC2.
echo.
echo MANUAL:  Copy hapi.exe from PC1 to this PC manually, then place at:
echo          %HAPI_DEST%
echo          (Source on PC1: K:\BENCH\Proto\hapi-dev\cli\dist-exe\bun-windows-x64\hapi.exe)
echo.
pause & exit /b 1

REM ----------------------------------------
REM Step 2: Write ~/.hapi/settings.json
REM ----------------------------------------
:write_settings
echo.
echo [INFO] Writing settings to %USERPROFILE%\.hapi\settings.json ...

(
echo {
echo   "apiUrl": "%HUB_URL%",
echo   "cliApiToken": "%CLI_TOKEN%"
echo }
) > "%USERPROFILE%\.hapi\settings.json"

echo [SUCCESS] Settings written.
echo.

REM ----------------------------------------
REM Step 3: Show connection info
REM ----------------------------------------
echo [INFO] Connection config:
"%HAPI_DEST%" auth status

REM ----------------------------------------
REM Step 4: Start runner
REM ----------------------------------------
echo.
echo [INFO] Starting HAPI runner...
"%HAPI_DEST%" runner start
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Runner failed to start. See output above.
    pause & exit /b 1
)

echo.
echo ==========================================
echo  SUCCESS! This PC is now connected to
echo  PC1's HAPI hub at %HUB_URL%
echo  Open PC1's web UI to see sessions
echo  from both machines.
echo ==========================================
echo.
pause
endlocal
