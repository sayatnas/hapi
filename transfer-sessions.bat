@echo off
setlocal

REM HAPI Session Transfer Script for Windows
REM Copies session data from WSL to Windows
REM
REM Usage: transfer-sessions.bat
REM
REM This copies the SQLite database and session files from WSL's ~/.hapi
REM to Windows %USERPROFILE%\.hapi

set "WSL_HAPI=\\wsl$\Ubuntu\root\.hapi"
set "WIN_HAPI=%USERPROFILE%\.hapi"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Session Transfer (WSL to Windows)
echo [INFO] ==========================================
echo.
echo Source (WSL):    %WSL_HAPI%
echo Target (Windows): %WIN_HAPI%
echo.

REM Check if WSL path exists
if not exist "%WSL_HAPI%" (
    echo [ERROR] WSL HAPI directory not found at %WSL_HAPI%
    echo.
    echo Make sure:
    echo   1. WSL is running
    echo   2. HAPI was used in WSL before
    echo   3. The path is correct (check your WSL distro name)
    echo.
    echo Try: dir \\wsl$\ to see available distros
    exit /b 1
)

REM Create Windows directory if needed
if not exist "%WIN_HAPI%" (
    echo [INFO] Creating Windows HAPI directory...
    mkdir "%WIN_HAPI%"
)

REM Backup existing Windows data if any
if exist "%WIN_HAPI%\hapi.db" (
    echo [WARN] Existing Windows data found - backing up...
    set "BACKUP_DIR=%WIN_HAPI%\backup-%DATE:~-4,4%%DATE:~-10,2%%DATE:~-7,2%"
    mkdir "!BACKUP_DIR!" 2>nul
    copy "%WIN_HAPI%\hapi.db" "!BACKUP_DIR!\" >nul
    copy "%WIN_HAPI%\settings.json" "!BACKUP_DIR!\" 2>nul
    echo [INFO] Backup saved to !BACKUP_DIR!
)

echo [INFO] Copying session database...
copy /Y "%WSL_HAPI%\hapi.db" "%WIN_HAPI%\" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to copy database
    exit /b 1
)

echo [INFO] Copying settings file...
copy /Y "%WSL_HAPI%\settings.json" "%WIN_HAPI%\" 2>nul

echo [INFO] Copying API token...
copy /Y "%WSL_HAPI%\access.key" "%WIN_HAPI%\" 2>nul

echo.
echo [SUCCESS] ==========================================
echo [SUCCESS] Session data transferred successfully!
echo [SUCCESS] ==========================================
echo.
echo Your sessions from WSL are now available on Windows.
echo.
echo NOTE: Claude Code session files (.claude/projects/...) are
echo stored per-project and will work if the project paths are
echo the same between WSL and Windows.
echo.

endlocal
