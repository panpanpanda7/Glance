@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

set LOG_FILE=%~dp0update-and-run.log

:: ログ初期化
echo [%date% %time%] === Glance update-and-run 開始 === > "%LOG_FILE%"

:: ログ付きechoマクロ
:: 使い方: call :log "メッセージ"
goto :main

:log
echo %~1
echo %~1 >> "%LOG_FILE%"
goto :eof

:main

call :log "============================================================"
call :log " Glance - 更新 & 起動"
call :log " %date% %time%"
call :log "============================================================"
call :log ""

set SKIP_PULL=0
if "%1"=="--skip-pull" set SKIP_PULL=1

cd /d "%~dp0"

:: ============================================================
:: 1. git pull
:: ============================================================
if %SKIP_PULL%==0 (
    call :log "[1/4] 最新版を取得中 (git pull)..."
    git pull >> "%LOG_FILE%" 2>&1
    git pull
    if %errorlevel% neq 0 (
        call :log "[WARNING] git pull に失敗しました。現在のバージョンで続行します。"
    ) else (
        call :log "  [OK] 最新版に更新しました。"
    )
    call :log ""
) else (
    call :log "[1/4] git pull をスキップしました。"
    call :log ""
)

:: ============================================================
:: 2. Python 依存関係の差分更新
:: ============================================================
call :log "[2/4] Python 依存関係の確認..."

cd /d "%~dp0python-backend"

if not exist venv (
    call :log "[ERROR] 仮想環境が見つかりません。"
    call :log "        先に setup-first-time.bat を実行してください。"
    goto :error_end
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
    call :log "  requirements.txt の変更を検出。依存関係を更新します..."
    call venv\Scripts\activate.bat
    pip install -r requirements.txt --quiet >> "%LOG_FILE%" 2>&1
    pip install -r requirements.txt --quiet
    if %errorlevel% neq 0 (
        call :log "[ERROR] Python 依存関係の更新に失敗しました。"
        goto :error_end
    )
    copy /y "%TEMP%\glance_req_new.txt" venv\.req_hash > nul
    call venv\Scripts\deactivate.bat 2>nul
    call :log "  [OK] 更新完了。"
) else (
    call :log "  [OK] 変更なし。スキップしました。"
)

cd /d "%~dp0"

:: ============================================================
:: 2.5. llama-server.exe の確認・補完
:: ============================================================
set LLAMA_BIN_DIR=%~dp0python-backend\llama-cpp-bin
if not exist "%LLAMA_BIN_DIR%\llama-server.exe" (
    call :log ""
    call :log "[2.5/4] llama-server.exe が見つかりません。ダウンロードします..."
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-llama-server.ps1" -DestDir "%LLAMA_BIN_DIR%"
    if %errorlevel% neq 0 (
        call :log "[ERROR] llama-server.exe のダウンロードに失敗しました。"
        call :log "        手動で download-llama-server.ps1 を実行してください。"
        goto :error_end
    )
    call :log "  [OK] llama-server.exe の準備完了。"
)

cd /d "%~dp0"

:: ============================================================
:: 3. npm 依存関係の差分更新
:: ============================================================
call :log ""
call :log "[3/4] Node.js 依存関係の確認..."

cd /d "%~dp0electron"

if not exist node_modules (
    call :log "  node_modules なし。npm install を実行します..."
    call npm install >> "%LOG_FILE%" 2>&1
    call npm install
    if %errorlevel% neq 0 (
        call :log "[ERROR] npm install に失敗しました。"
        goto :error_end
    )
    call :log "  [OK] インストール完了。"
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
    call :log "  package-lock.json の変更を検出。npm install を実行します..."
    call npm install >> "%LOG_FILE%" 2>&1
    call npm install
    if %errorlevel% neq 0 (
        call :log "[ERROR] npm install に失敗しました。"
        goto :error_end
    )
    copy /y "%TEMP%\glance_npm_new.txt" ..\python-backend\venv\.npm_hash > nul
    call :log "  [OK] 更新完了。"
) else (
    call :log "  [OK] 変更なし。スキップしました。"
)

:npm_done
cd /d "%~dp0"

:: ============================================================
:: 4. アプリ起動
:: ============================================================
call :log ""
call :log "[4/4] Glance を起動します..."
call :log "  （初回はモデルのロードに 30 秒〜数分かかります）"
call :log ""

cd /d "%~dp0electron"
call npm run dev >> "%LOG_FILE%" 2>&1
call npm run dev
set APP_RESULT=%errorlevel%

if %APP_RESULT% neq 0 (
    call :log ""
    call :log "[ERROR] アプリが終了コード %APP_RESULT% で終了しました。"
    goto :error_end
)

goto :normal_end

:error_end
echo.
echo ============================================================
echo  エラーが発生しました。
echo  ログファイルを開発者に共有してください:
echo  %LOG_FILE%
echo ============================================================
pause
exit /b 1

:normal_end
echo.
echo ============================================================
echo  ログ保存先: %LOG_FILE%
echo ============================================================
pause
endlocal
