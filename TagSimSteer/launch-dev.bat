@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5183" ^| findstr "LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
title TagSim Steering Simulator - Dev Server
cd /d "%~dp0"

set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; if (Test-Path '%CHROME%') { Start-Process '%CHROME%' -ArgumentList '--new-window','http://localhost:5183/' } else { Start-Process 'http://localhost:5183/' }"

call npm run dev
pause
