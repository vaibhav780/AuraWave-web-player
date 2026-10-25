@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~dpnx0\"\"' -Verb RunAs"
    exit /b
)
echo Starting AuraWave Windows Service...
sc.exe start AuraWaveMusicServer
timeout /t 2 /nobreak >nul
.venv\Scripts\python.exe service_manager.py status
pause
