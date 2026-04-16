@echo off
setlocal

set "HAPI_EXE=%USERPROFILE%\.hapi\hapi.exe"

echo.
echo ==========================================
echo  PC2: Update hapi.exe from PC1
echo ==========================================
echo.

echo [INFO] Stopping runner...
"%HAPI_EXE%" runner stop 2>nul
taskkill /F /IM hapi.exe 2>nul
timeout /t 2 /nobreak >nul

echo [INFO] Deleting old hapi.exe...
del /F /Q "%HAPI_EXE%" 2>nul

if exist "%HAPI_EXE%" (
    echo [WARN] Could not delete hapi.exe - may still be running
    echo [WARN] Try closing any terminals using it, then re-run
    pause & exit /b 1
)

echo [SUCCESS] Old hapi.exe removed.
echo.
echo Now run pc2-client-setup.bat to download the new version.
echo.
pause
endlocal
