@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

:: ============================================================
:: 管理者権限チェック・自動昇格
:: ============================================================
net session > nul 2>&1
if %errorlevel% neq 0 (
    echo 管理者権限が必要です。管理者として再起動します...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ============================================================
echo  Glance - Windows 初回セットアップ
echo ============================================================
echo.
echo このスクリプトは初回のみ実行してください。
echo 2回目以降の起動は update-and-run.bat を使用してください。
echo.

:: ============================================================
:: Windows Long Path サポートを有効化
:: ============================================================
echo [0/5] Windows Long Path サポートの確認...

reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled 2>nul | findstr "0x1" > nul
if %errorlevel% equ 0 (
    echo   [OK] Long Path は既に有効です。
) else (
    echo   Long Path を有効化します...
    reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f > nul
    if %errorlevel% equ 0 (
        echo   [OK] Long Path を有効化しました。
    ) else (
        echo   [ERROR] Long Path の有効化に失敗しました。
        pause
    exit /b 1
    )
)
echo.

pause

:: ============================================================
:: 1. 必須ツール確認
:: ============================================================
echo [1/5] 必須ツールの確認...
echo.

:: Git
where git > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Git が見つかりません。
    echo         https://git-scm.com/download/win からインストールしてください。
    pause
    exit /b 1
)
echo   [OK] Git:
git --version

:: Python
where python > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python が見つかりません。
    echo         https://www.python.org/downloads/release/python-3128/
    echo         から Python 3.12 をインストールしてください。
    echo         インストール時に "Add Python to PATH" にチェックを入れてください。
    pause
    exit /b 1
)
echo   [OK] Python:
python --version

:: Python バージョンチェック（3.13以上は非対応）
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PY_VER=%%v
for /f "tokens=1,2 delims=." %%a in ("%PY_VER%") do (
    set PY_MAJOR=%%a
    set PY_MINOR=%%b
)
if %PY_MAJOR% equ 3 if %PY_MINOR% geq 13 (
    echo.
    echo [ERROR] Python %PY_VER% は非対応です。
    echo         Python 3.12 を使用してください。
    echo         ダウンロード: https://www.python.org/downloads/release/python-3128/
    echo.
    echo         Python 3.13 をアンインストール後、Python 3.12 をインストールしてから
    echo         再度このスクリプトを実行してください。
    pause
    exit /b 1
)

:: Node.js
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。
    echo         https://nodejs.org/ から LTS 版をインストールしてください。
    pause
    exit /b 1
)
echo   [OK] Node.js:
node --version

echo.

:: ============================================================
:: 2. Python 仮想環境のセットアップ
:: ============================================================
echo [2/5] Python 仮想環境のセットアップ...
echo.

cd /d "%~dp0python-backend"

:: venv が存在しても python.exe が動かない場合は作り直す
if exist venv (
    venv\Scripts\python.exe --version > nul 2>&1
    if !errorlevel! neq 0 (
        echo   既存の仮想環境が壊れています。作り直します...
        rmdir /s /q venv
    ) else (
        echo   既存の仮想環境が見つかりました。スキップします。
    )
)

if not exist venv (
    echo   仮想環境を作成中...
    python -m venv venv
    if %errorlevel% neq 0 (
        echo [ERROR] 仮想環境の作成に失敗しました。
        pause
    exit /b 1
    )
    echo   [OK] 仮想環境を作成しました。
)

:: pip 更新
echo   pip を更新中...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip --quiet

:: requirements.txt のハッシュを記録（更新検出用）
if exist requirements.txt (
    certutil -hashfile requirements.txt MD5 2>nul | findstr /v ":" > venv\.req_hash 2>nul
)

:: llama-cpp-python をビルド済み CPU Wheel で先行インストール（C++コンパイラ不要）
echo   llama-cpp-python をインストール中（ビルド済みWheel使用）...
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu --quiet
if %errorlevel% neq 0 (
    echo   [WARNING] ビルド済みWheelの取得に失敗しました。ソースビルドを試みます。
    echo             Visual Studio Build Tools がインストールされていない場合は失敗します。
    pip install llama-cpp-python
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] llama-cpp-python のインストールに失敗しました。
        echo         開発者に連絡してください。
        pause
    exit /b 1
    )
)
echo   [OK] llama-cpp-python のインストール完了

:: 残りの依存関係インストール（llama-cpp-python は上でインストール済みなのでスキップされる）
echo.
echo   Python 依存関係をインストール中...
echo   （PyTorch 等のダウンロードに数分かかります）
echo.
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Python install failed.
    echo         Please check the error above and contact the developer.
    pause
    exit /b 1
)
echo.
echo   [OK] Python 依存関係のインストール完了

call venv\Scripts\deactivate.bat 2>nul
cd /d "%~dp0"

:: ============================================================
:: 3. Node.js 依存関係のセットアップ
:: ============================================================
echo.
echo [3/5] Node.js 依存関係のセットアップ...
echo.

cd /d "%~dp0electron"

echo   対象フォルダ: %CD%
if not exist package.json (
    echo [ERROR] package.json が見つかりません。
    echo         フォルダ構成を確認してください: %CD%
    pause
    exit /b 1
)

:: package-lock.json のハッシュを記録（更新検出用）
if exist package-lock.json (
    certutil -hashfile package-lock.json MD5 2>nul | findstr /v ":" > ..\python-backend\venv\.npm_hash 2>nul
)

echo   npm install を実行中...
echo   （electron のダウンロードに時間がかかる場合があります）
echo.
call npm install
set NPM_RESULT=%errorlevel%
echo.
if %NPM_RESULT% neq 0 (
    echo ============================================================
    echo [ERROR] npm install に失敗しました ^(終了コード: %NPM_RESULT%^)
    echo         上記のエラーメッセージを開発者に共有してください。
    echo ============================================================
    pause
    exit /b 1
)
echo   [OK] Node.js 依存関係のインストール完了

cd /d "%~dp0"

:: ============================================================
:: 4. llama-server.exe のダウンロード
:: ============================================================
echo.
echo [4/6] llama-server.exe のダウンロード...
echo.

set LLAMA_BIN_DIR=%~dp0python-backend\llama-cpp-bin

if exist "%LLAMA_BIN_DIR%\llama-server.exe" (
    echo   [OK] llama-server.exe は既に存在します。スキップします。
) else (
    echo   llama.cpp の最新 Windows バイナリをダウンロード中...
    echo   （数百MB あります。しばらくお待ちください）
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-llama-server.ps1" -DestDir "%LLAMA_BIN_DIR%"
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] llama-server.exe のダウンロードに失敗しました。
        echo         手動でダウンロードして配置してください:
        echo         1. https://github.com/ggerganov/llama.cpp/releases から
        echo            llama-b*-bin-win-*-x64.zip をダウンロード
        echo         2. ZIP を展開し llama-server.exe と DLL を
        echo            glance-pyapp\python-backend\llama-cpp-bin\ にコピー
        pause
        exit /b 1
    )
)
echo.
echo.
echo [5/6] AI モデルのダウンロード...
echo.
echo   モデルは glance-pyapp\python-backend\models\gguf\ に配置します。
echo.
echo   使用モデル（config.yaml の activeModel を確認）:
echo   - qwen3-vl-4b-server  ... 約 2.5GB + 1.2GB (mmproj)
echo   - qwen2_5-vl-3b-gguf  ... 約 1.8GB + 0.9GB (mmproj)
echo.

set MODELS_DIR=%~dp0python-backend\models\gguf
if not exist "%MODELS_DIR%" mkdir "%MODELS_DIR%"

cd /d "%~dp0python-backend"
call venv\Scripts\activate.bat

:: huggingface-hub のインストール確認
python -c "import huggingface_hub" > nul 2>&1
if %errorlevel% neq 0 (
    pip install huggingface-hub --quiet
)

:: config.yaml から activeModel を読み取ってダウンロードURLを取得
echo   config.yaml からモデル情報を読み取り、自動ダウンロードします...
echo.
python -c "
import yaml, os, sys, urllib.request

with open('config.yaml', encoding='utf-8') as f:
    cfg = yaml.safe_load(f)

active = cfg.get('activeModel')
model_cfg = cfg.get('models', {}).get(active, {})
download_url = model_cfg.get('download_url')
mmproj_url   = model_cfg.get('mmproj_download_url')
model_path   = model_cfg.get('path', '')
mmproj_path  = model_cfg.get('mmproj_path', '')

print(f'アクティブモデル: {active}')

def download(url, dest):
    if not url:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        print(f'  既存ファイルをスキップ: {dest}')
        return
    print(f'  ダウンロード中: {os.path.basename(dest)}')
    print(f'    URL: {url}')
    try:
        urllib.request.urlretrieve(url, dest)
        print(f'  [OK] {os.path.basename(dest)}')
    except Exception as e:
        print(f'  [WARNING] ダウンロード失敗: {e}')
        print(f'            手動でダウンロードして {dest} に配置してください')

download(download_url, model_path)
download(mmproj_url,   mmproj_path)
"
if %errorlevel% neq 0 (
    echo.
    echo [WARNING] モデルの自動ダウンロードに失敗しました。
    echo           手動で config.yaml の download_url からダウンロードし、
    echo           python-backend\models\gguf\ に配置してください。
)

call venv\Scripts\deactivate.bat 2>nul
cd /d "%~dp0"

:: ============================================================
:: 6. 完了
:: ============================================================
echo.
echo ============================================================
echo  [6/6] セットアップ完了！
echo ============================================================
echo.
echo 次回からは update-and-run.bat をダブルクリックするだけで
echo 最新版に更新してアプリを起動できます。
echo.
echo 今すぐアプリを起動しますか？
choice /c yn /m "起動する (y) / あとで起動する (n)"
if %errorlevel% equ 1 (
    echo.
    call "%~dp0update-and-run.bat" --skip-pull
)

pause
