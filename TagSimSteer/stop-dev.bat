@echo off
title TagSim Steering Simulator - Stop
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5183" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>&1
  set FOUND=1
)
if %FOUND%==1 (
  echo TagSim dev server stopped.
) else (
  echo No running TagSim dev server was found.
)
timeout /t 2 /nobreak >nul
