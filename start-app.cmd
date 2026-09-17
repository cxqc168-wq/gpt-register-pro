@echo off
chcp 65001 >nul
rem 控制台切换到 UTF-8 代码页，避免中文日志在终端显示乱码
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" .
