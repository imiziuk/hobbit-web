@echo off
rem Double-click to play. First run: start.bat "D:\Games\The Hobbit"  (folder with Meridian.exe)
cd /d "%~dp0"
where py >nul 2>nul && (py -3 start.py %*) || (python start.py %*)
pause
