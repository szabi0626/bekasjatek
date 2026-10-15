@echo off
rem Starts the game server on this machine: builds the game, then serves it and
rem runs the matches on port 8080. Friends connect to http://<public IP>:8080
rem once the router forwards TCP port 8080 to this machine.
cd /d "%~dp0"
title Bekajatek szerver

echo Jatek forditasa...
call npm run build || goto :error

rem A snapshot every tick (40 a second) and room for 100 frogs: this machine has CPU to spare.
set PORT=8080
set SNAPSHOT_EVERY=1
set MAX_BODIES=100

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Invoke-RestMethod -Uri https://api.ipify.org -TimeoutSec 5) } catch { '?' }"`) do set PUBLIC_IP=%%i
echo.
echo ============================================================
echo   Itthonrol:      http://localhost:%PORT%
echo   Barataidnak:    http://%PUBLIC_IP%:%PORT%
echo   Leallitas:      Ctrl+C, vagy zard be ezt az ablakot
echo ============================================================
echo.
node server\index.js
goto :eof

:error
echo.
echo A forditas nem sikerult.
pause
