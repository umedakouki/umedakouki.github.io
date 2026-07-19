@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0diary-publisher.ps1" -RepoRoot "%~dp0.."
if errorlevel 1 pause
