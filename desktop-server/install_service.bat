@echo off
REM ============================================================================
REM  AuraWave Desktop Music Server - Install Windows Service (Start on Boot)
REM  Right-click and "Run as administrator" or double-click to auto-elevate.
REM ============================================================================

setlocal
cd /d "%~dp0"

REM --- Check for administrative privileges & auto-elevate if needed ----------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Requesting Administrator privileges to install Windows Service...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~dpnx0\"\"' -Verb RunAs"
    exit /b
)

echo ============================================================================
echo   Installing AuraWave Desktop Music Server as a Windows Service
echo ============================================================================
echo.

set "VENV_PY=.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [ERROR] Virtual environment not found at .venv\Scripts\python.exe.
    echo         Please run run.bat first to initialize dependencies.
    pause
    exit /b 1
)

REM Ensure AuraWaveService.exe exists, or compile it
if not exist "AuraWaveService.exe" (
    echo [1/3] Compiling Windows Service wrapper ^(AuraWaveService.exe^)...
    set "CSC_EXE="
    if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
        set "CSC_EXE=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    ) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
        set "CSC_EXE=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )

    if not defined CSC_EXE (
        echo [ERROR] .NET Framework C# compiler ^(csc.exe^) not found.
        pause
        exit /b 1
    )

    "%CSC_EXE%" /target:winexe /r:System.ServiceProcess.dll /out:"%~dp0AuraWaveService.exe" "%~dp0AuraWaveService.cs"
    if errorlevel 1 (
        echo [ERROR] Failed to compile AuraWaveService.exe.
        pause
        exit /b 1
    )
    echo       Compiled successfully.
) else (
    echo [1/3] Service wrapper AuraWaveService.exe is ready.
)

REM Check if service already exists
sc.exe query AuraWaveMusicServer >nul 2>&1
if %errorlevel% equ 0 (
    echo [2/3] Existing AuraWaveMusicServer service found. Stopping and updating...
    sc.exe stop AuraWaveMusicServer >nul 2>&1
    timeout /t 2 /nobreak >nul
    sc.exe delete AuraWaveMusicServer >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [2/3] Creating Windows Service with start=auto ^(Starts on Windows Boot^)...
sc.exe create AuraWaveMusicServer binPath= "\"%~dp0AuraWaveService.exe\"" start= auto DisplayName= "AuraWave Desktop Music Server"
if errorlevel 1 (
    echo [ERROR] Failed to register service with Windows Service Control Manager.
    pause
    exit /b 1
)

sc.exe description AuraWaveMusicServer "AuraWave Desktop Music Server streaming audio on port 8080 from D:\songs" >nul
sc.exe failure AuraWaveMusicServer reset= 60 actions= restart/5000/restart/5000/restart/5000 >nul

echo.
echo [3/3] Starting AuraWave Windows Service...
sc.exe start AuraWaveMusicServer
timeout /t 2 /nobreak >nul

echo.
echo ============================================================================
echo   SUCCESS!
echo   AuraWave Music Server is now installed as a Windows Service.
echo   - Startup type: Automatic (starts automatically when Windows boots)
echo   - Default folder: D:\songs
echo   - Port: 8080
echo   - Logs: %~dp0service.log
echo ============================================================================
echo.
"%VENV_PY%" service_manager.py status
echo.
pause
