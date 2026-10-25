@echo off
REM ============================================================================
REM  AuraWave Desktop Music Server - Uninstall Windows Service
REM ============================================================================

setlocal
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Requesting Administrator privileges to uninstall Windows Service...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~dpnx0\"\"' -Verb RunAs"
    exit /b
)

echo Stopping and removing AuraWaveMusicServer service...
sc.exe stop AuraWaveMusicServer >nul 2>&1
timeout /t 2 /nobreak >nul
sc.exe delete AuraWaveMusicServer
if errorlevel 1 (
    echo [NOTE] Service may have already been removed or does not exist.
) else (
    echo AuraWave Windows Service successfully removed.
)

if exist "service_state.json" del /f /q "service_state.json" >nul 2>&1

echo.
pause
