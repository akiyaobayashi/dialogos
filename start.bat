@echo off
chcp 65001 >nul
title Dialogos Sales
cd /d "%~dp0"
node launch.js
pause
