@echo off
cd /d "%~dp0"
echo ============================================
echo    MoodTune  -  Face Emotion Music Engine
echo ============================================
echo.
echo    Browser:  http://localhost:8080
echo    Stop   :  Ctrl + C
echo.
echo ============================================
echo.
where python >nul 2>nul
if errorlevel 1 goto trypy
python -m http.server 8080
goto end
:trypy
where py >nul 2>nul
if errorlevel 1 goto nopy
py -m http.server 8080
goto end
:nopy
echo [!] Python not found. Please install Python 3 and retry.
pause
:end
