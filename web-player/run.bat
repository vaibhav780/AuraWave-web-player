@echo off
REM ===========================================================================
REM  AuraWave Web Player launcher
REM  Serves a modern browser music player for a folder of local music.
REM  Usage:
REM    run.bat                       prompts for the port (default 8000)
REM    run.bat "D:\Music"            serves that folder, prompts for the port
REM    run.bat "D:\Music" 8010       serves that folder on port 8010 (no prompt)
REM ===========================================================================
setlocal

set "MUSIC_DIR=%~1"
if "%MUSIC_DIR%"=="" set "MUSIC_DIR=%USERPROFILE%\Music"

REM Port: use the 2nd argument if given, otherwise ask (Enter accepts 8000).
set "PORT=%~2"
if not "%PORT%"=="" goto :have_port

:ask_port
set "PORT="
set /p "PORT=Enter port to run on [default 8000]: "
if "%PORT%"=="" set "PORT=8000"

REM Validate: must be all digits and within 1-65535, else ask again.
echo %PORT%| findstr /r "^[1-9][0-9]*$" >nul
if errorlevel 1 (
  echo   "%PORT%" is not a valid number. Try again.
  goto :ask_port
)
if %PORT% GTR 65535 (
  echo   Port must be between 1 and 65535. Try again.
  goto :ask_port
)

:have_port
REM Prefer the desktop-server venv (it has mutagen for rich tags) if present,
REM otherwise fall back to the system python (works fine, tags via metadata.json).
set "PY=python"
if exist "%~dp0..\desktop-server\.venv\Scripts\python.exe" set "PY=%~dp0..\desktop-server\.venv\Scripts\python.exe"

echo.
echo Starting AuraWave Web Player
echo   Folder : "%MUSIC_DIR%"
echo   Port   : %PORT%
echo.
"%PY%" "%~dp0web_player.py" --dir "%MUSIC_DIR%" --port %PORT%

endlocal
