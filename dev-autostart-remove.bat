@echo off
setlocal

REM HAPI Dev Auto-Start Remover for Windows
REM Removes the Task Scheduler task created by dev-autostart-install.bat

set "TASK_NAME=HAPI-Dev-AutoStart"

echo.
echo [INFO] ==========================================
echo [INFO] HAPI Dev Auto-Start Remover
echo [INFO] ==========================================
echo.

REM Check if task exists
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Task "%TASK_NAME%" does not exist. Nothing to remove.
    echo.
    exit /b 0
)

REM Delete the task
schtasks /Delete /TN "%TASK_NAME%" /F

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [SUCCESS] Auto-start task "%TASK_NAME%" removed.
    echo [SUCCESS] HAPI Dev will no longer start at logon.
    echo.
) else (
    echo.
    echo [ERROR] Failed to remove task. Try running as Administrator.
    echo.
    exit /b 1
)

endlocal
