@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo [LOI] Khong tim thay Node.js trong PATH. Cai Node.js 22 tro len roi chay lai. & pause & exit /b 3)
node {{CLI_ENTRY}} start --workspace "%~dp0."
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Dich vu da dung voi ma loi %RC%. Doc thong bao o tren hoac xem thu muc logs\
  pause
)
exit /b %RC%
