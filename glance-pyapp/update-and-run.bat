@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

echo ============================================================
echo  Glance - 更新 ^& 起動
echo ============================================================
echo.

:: --skip-pull オプション（setup-first-time.bat から呼ばれた場合）
set SKIP_PULL=0
if "%1"=="--skip-pull" set SKIP_PULL=1

cd /d "%~dp0"

:: ============================================================
:: 1. git pull
:: ============================================================
if %SKIP_PULL%==0 (
    echo [1/4] 最新版を取得中 (git pull)...
    git pull
    if %errorlevel% neq 0 (
        echo.
        echo [WARNING] git pull に失敗しました。
        echo           ネットワーク接続を確認するか、手動で git pull を実行してください。
        echo           現在のバージョンで起動を続けます。
        echo.
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
    pause & exit /b 1
)

:: requirements.txt のハッシュを比較して変更があれば更新
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
    echo   requirements.txt の変更を検出しました。依存関係を更新します...
    call venv\Scripts\activate.bat
    pip install -r requirements.txt --quiet
    if %errorlevel% neq 0 (
        echo [ERROR] Python 依存関係の更新に失敗しました。
        pause & exit /b 1
    )
    :: ハッシュを更新
    copy /y "%TEMP%\glance_req_new.txt" venv\.req_hash > nul
    call venv\Scripts\deactivate.bat 2>nul
    echo   [OK] Python 依存関係を更新しました。
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
    echo   node_modules が見つかりません。npm install を実行します...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました。
        pause & exit /b 1
    )
    echo   [OK] Node.js 依存関係をインストールしました。
    goto :npm_done
)

:: package-lock.json のハッシュを比較
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
    echo   package-lock.json の変更を検出しました。npm install を実行します...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました。
        pause & exit /b 1
    )
    copy /y "%TEMP%\glance_npm_new.txt" ..\python-backend\venv\.npm_hash > nul
    echo   [OK] Node.js 依存関係を更新しました。
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
echo   アプリを終了するにはシステムトレイのアイコンを右クリックしてください。
echo   このウィンドウは起動後に閉じても構いません。
echo.

cd /d "%~dp0electron"
call npm run dev

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] アプリの起動に失敗しました (終了コード: %errorlevel%)
    echo         エラー内容を開発者に共有してください。
    pause
)

cd /d "%~dp0"
endlocal
