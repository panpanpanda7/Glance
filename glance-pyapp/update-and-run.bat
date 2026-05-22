@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: ログ記録ラッパー
:: 自身を PowerShell Tee-Object 経由で再実行してコンソールとファイルに同時出力
:: ============================================================
if not "%1"=="__INNER__" (
    set LOG_FILE=%~dp0update-and-run.log
    echo ログファイル: %~dp0update-and-run.log
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "& cmd /c '\"%~f0\" __INNER__ %*' 2>&1 | Tee-Object -FilePath '%~dp0update-and-run.log'"
    echo.
    echo ============================================================
    if %errorlevel% neq 0 (
        echo  エラーが発生しました。
    ) else (
        echo  正常終了しました。
    )
    echo  ログ保存先: %~dp0update-and-run.log
    echo ============================================================
    pause
    exit /b
)

chcp 65001 > nul

echo ============================================================
echo  Glance - 更新 ^& 起動
echo  %date% %time%
echo ============================================================
echo.

set SKIP_PULL=0
if "%2"=="--skip-pull" set SKIP_PULL=1

cd /d "%~dp0"

:: ============================================================
:: 1. git pull
:: ============================================================
if %SKIP_PULL%==0 (
    echo [1/4] 最新版を取得中 (git pull)...
    git pull
    if %errorlevel% neq 0 (
        echo [WARNING] git pull に失敗しました。現在のバージョンで続行します。
    ) else (
        echo   [OK] 最新版に更新しました。
    )
    echo.
) else (
    echo [1/4] git pull をスキップしました。
    echo.
)

:: ============================================================
:: 2. Python 依存関係の差分更新
:: ============================================================
echo [2/4] Python 依存関係の確認...

cd /d "%~dp0python-backend"

if not exist venv (
    echo [ERROR] 仮想環境が見つかりません。
    echo         先に setup-first-time.bat を実行してください。
    exit /b 1
)

set REQ_UPDATED=0
if exist requirements.txt (
    certutil -hashfile requirements.txt MD5 2>nul | findstr /v ":" > "%TEMP%\glance_req_new.txt" 2>nul
    if exist venv\.req_hash (
        fc /b "%TEMP%\glance_req_new.txt" venv\.req_hash > nul 2>&1
        if !errorlevel! neq 0 set REQ_UPDATED=1
    ) else (
        set REQ_UPDATED=1
    )
)

if %REQ_UPDATED%==1 (
    echo   requirements.txt の変更を検出。依存関係を更新します...
    call venv\Scripts\activate.bat
    pip install -r requirements.txt --quiet
    if %errorlevel% neq 0 (
        echo [ERROR] Python 依存関係の更新に失敗しました。
        exit /b 1
    )
    copy /y "%TEMP%\glance_req_new.txt" venv\.req_hash > nul
    call venv\Scripts\deactivate.bat 2>nul
    echo   [OK] 更新完了。
) else (
    echo   [OK] 変更なし。スキップしました。
)

cd /d "%~dp0"

:: ============================================================
:: 3. npm 依存関係の差分更新
:: ============================================================
echo.
echo [3/4] Node.js 依存関係の確認...

cd /d "%~dp0electron"

if not exist node_modules (
    echo   node_modules なし。npm install を実行します...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました。
        exit /b 1
    )
    echo   [OK] インストール完了。
    goto :npm_done
)

set NPM_UPDATED=0
if exist package-lock.json (
    certutil -hashfile package-lock.json MD5 2>nul | findstr /v ":" > "%TEMP%\glance_npm_new.txt" 2>nul
    if exist ..\python-backend\venv\.npm_hash (
        fc /b "%TEMP%\glance_npm_new.txt" ..\python-backend\venv\.npm_hash > nul 2>&1
        if !errorlevel! neq 0 set NPM_UPDATED=1
    ) else (
        set NPM_UPDATED=1
    )
)

if %NPM_UPDATED%==1 (
    echo   package-lock.json の変更を検出。npm install を実行します...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました。
        exit /b 1
    )
    copy /y "%TEMP%\glance_npm_new.txt" ..\python-backend\venv\.npm_hash > nul
    echo   [OK] 更新完了。
) else (
    echo   [OK] 変更なし。スキップしました。
)

:npm_done
cd /d "%~dp0"

:: ============================================================
:: 4. アプリ起動
:: ============================================================
echo.
echo [4/4] Glance を起動します...
echo   （初回はモデルのロードに 30 秒〜数分かかります）
echo.

cd /d "%~dp0electron"
call npm run dev
set APP_RESULT=%errorlevel%

if %APP_RESULT% neq 0 (
    echo.
    echo [ERROR] アプリが終了コード %APP_RESULT% で終了しました。
)

cd /d "%~dp0"
endlocal
