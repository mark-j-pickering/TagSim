@echo off
title TagSim Steering Simulator - Dev Server
cd /d "%~dp0"
call npm run dev -- --open
pause
