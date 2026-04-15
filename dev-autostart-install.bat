@echo off
setlocal EnableDelayedExpansion

REM HAPI Dev Auto-Start Installer for Windows
REM Registers a Task Scheduler task to run dev-restart.bat at user logon
REM
REM Usage: dev-autostart-install.bat [project_dir]
REM   project_dir: Optional. Passed through to dev-restart.bat

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "TASK_NAME=HAPI-Dev-AutoStart"
set "RESTART_BAT=%SCRIPT_DIR%\dev-restart.bat"
set "PROJECT_DIR=%~1"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Dev Auto-Start Installer
echo [INFO] ==========================================
echo.

REM Check if task already exists
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [WARN] Task "%TASK_NAME%" already exists. Removing old task...
    schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
)

REM Build the command arguments
if "%PROJECT_DIR%"=="" (
    set "TASK_ARGS=/c ""%RESTART_BAT%"""
) else (
    set "TASK_ARGS=/c ""%RESTART_BAT%" "%PROJECT_DIR%"""
)

REM Create a scheduled task that runs at logon
REM /SC ONLOGON  - trigger on any user logon
REM /RL HIGHEST  - run with highest privileges
REM /DELAY 0000:15 - 15 second delay after logon to let system settle
schtasks /Create /TN "%TASK_NAME%" /TR "cmd.exe %TASK_ARGS%" /SC ONLOGON /RL HIGHEST /DELAY 0000:15 /F

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Failed to create scheduled task.
    echo [ERROR] Try running this script as Administrator.
    echo.
    exit /b 1
)

echo.
echo [SUCCESS] ==========================================
echo [SUCCESS] HAPI Dev auto-start installed!
echo [SUCCESS] Task name: %TASK_NAME%
echo [SUCCESS] Trigger: At user logon (15s delay)
echo [SUCCESS] Script: %RESTART_BAT%
if not "%PROJECT_DIR%"=="" echo [SUCCESS] Project: %PROJECT_DIR%
echo [SUCCESS] ==========================================
echo.
echo To remove auto-start, run: dev-autostart-remove.bat
echo To view the task: schtasks /Query /TN "%TASK_NAME%" /V
echo.

endlocal
