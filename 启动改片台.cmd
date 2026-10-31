@echo off
title 改片台
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
echo.
echo   正在启动改片台...
echo   关掉这个窗口 = 停止服务（不会有后台残留）
echo.
node "serve.cjs"
echo.
echo   服务已停止。
pause