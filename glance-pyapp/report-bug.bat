@echo off
chcp 65001 > nul

echo ============================================================
echo  Glance - バグレポート送信
echo ============================================================
echo.
echo 開発者にバグレポートを送信します。
echo ログファイルと基本的なシステム情報が含まれます。
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0report-bug.ps1" -RepoDir "%~dp0"

echo.
pause
