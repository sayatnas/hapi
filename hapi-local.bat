@echo off
REM Local HAPI development runner for Windows
REM Usage: hapi-local.bat [args...]

set "HAPI_DIR=K:\BENCH\Proto\hapi-dev"
cd /d "%HAPI_DIR%\cli"
bun src/index.ts %*
