@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul || (echo [LOI] Khong tim thay Node.js trong PATH. Cai Node.js 22 tro len roi chay lai. & pause & exit /b 3)
rem update rewrites this file when the template changed. cmd.exe reads a batch file by offset, so everything after
rem the update runs from this one parenthesized block, which is parsed before node starts.
(
  node {{CLI_ENTRY}} update --workspace "%~dp0."
  set "RC=!ERRORLEVEL!"
  if not "!RC!"=="0" (
    echo.
    echo Cap nhat that bai voi ma loi !RC!.
    pause
  )
  exit /b !RC!
)
