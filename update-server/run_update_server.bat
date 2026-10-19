@echo off
title AuraWave App Update Server
cls
echo =========================================================
echo    AuraWave - App Update Server
echo =========================================================
echo.

setlocal
cd /d "%~dp0"

REM --- Locate Python -------------------------------------------------------
where python >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON_CMD=python"
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON_CMD=py -3"
    ) else (
        echo [ERROR] Python 3 is not installed or not on PATH.
        echo Install it from https://www.python.org/ ^(tick "Add Python to PATH"^).
        pause
        exit /b 1
    )
)

REM --- Best-effort install of the optional 'qrcode' package (terminal QR) ---
REM Not fatal if it fails; the /qr web page works without it.
%PYTHON_CMD% -c "import qrcode" >nul 2>nul || %PYTHON_CMD% -m pip install --disable-pip-version-check -q qrcode >nul 2>nul

REM --- Run the update server (serves any .apk placed in this folder) --------
if not "%~1"=="" (
    %PYTHON_CMD% update_server.py --dir "%~1"
) else (
    %PYTHON_CMD% update_server.py
)

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Update server exited with error code %errorlevel%.
    pause
)

endlocal
