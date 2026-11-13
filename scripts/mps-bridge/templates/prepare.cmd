@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo [LOI] Khong tim thay Node.js trong PATH. Cai Node.js 22 tro len roi chay lai. & pause & exit /b 3)
node {{CLI_ENTRY}} prepare --workspace "%~dp0."
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Xong. Chay start.cmd de khoi dong dich vu.
) else (
  echo Chuan bi worktree that bai voi ma loi %RC%. Doc thong bao o tren roi chay lai prepare.cmd.
)
rem Always pause: prepare is usually started by double-click and ends on its own, so the window would close at once.
pause
exit /b %RC%
