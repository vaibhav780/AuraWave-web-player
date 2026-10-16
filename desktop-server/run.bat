@echo off
REM ============================================================================
REM  AuraWave Desktop Music Server - setup & launch (Windows)
REM  Double-click this file, or run it from Command Prompt / PowerShell.
REM  It creates a local virtual environment, installs dependencies into it,
REM  and starts the app. Safe to run repeatedly (install steps are skipped
REM  once satisfied).
REM ============================================================================

setlocal
cd /d "%~dp0"

set "VENV_PY=.venv\Scripts\python.exe"

REM --- 1. Locate a Python launcher -------------------------------------------
set "PY_CMD="
where py >nul 2>&1 && set "PY_CMD=py -3"
if not defined PY_CMD (
    where python >nul 2>&1 && set "PY_CMD=python"
)
if not defined PY_CMD (
    echo [ERROR] Python was not found on PATH.
    echo         Install Python 3.9+ from https://www.python.org/downloads/
    echo         and tick "Add Python to PATH" during setup.
    pause
    exit /b 1
)

REM --- 2. Create the virtual environment (only if missing) --------------------
if not exist "%VENV_PY%" (
    echo [1/3] Creating virtual environment in .venv ...
    %PY_CMD% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create the virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Virtual environment already exists - skipping.
)

REM --- 3. Install / update dependencies into the venv -------------------------
echo [2/3] Installing dependencies ...
"%VENV_PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)

REM --- 4. Launch the application ----------------------------------------------
echo [3/3] Starting AuraWave Music Server ...
echo.
"%VENV_PY%" app.py

REM Keep the window open if the app exits with an error.
if errorlevel 1 (
    echo.
    echo [The application exited with an error. See the message above.]
    pause
)

endlocal
