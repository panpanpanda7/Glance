@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

echo ============================================================
echo  Glance - Windows 初回セットアップ
echo ============================================================
echo.
echo このスクリプトは初回のみ実行してください。
echo 2回目以降の起動は update-and-run.bat を使用してください。
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
    pause & exit /b 1
)
echo   [OK] Git:
git --version

:: Python
where python > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python が見つかりません。
    echo         https://www.python.org/downloads/ から Python 3.11 以上をインストールしてください。
    echo         インストール時に "Add Python to PATH" にチェックを入れてください。
    pause & exit /b 1
)
echo   [OK] Python:
python --version

:: Node.js
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。
    echo         https://nodejs.org/ から LTS 版をインストールしてください。
    pause & exit /b 1
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

if exist venv (
    echo   既存の仮想環境が見つかりました。スキップします。
) else (
    echo   仮想環境を作成中...
    python -m venv venv
    if %errorlevel% neq 0 (
        echo [ERROR] 仮想環境の作成に失敗しました。
        pause & exit /b 1
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

:: 依存関係インストール
echo   Python 依存関係をインストール中...
echo   （PyTorch 等のダウンロードに数分かかります）
echo.
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Python 依存関係のインストールに失敗しました。
    echo         エラー内容を確認してください。
    pause & exit /b 1
)
echo.
echo   [OK] Python 依存関係のインストール完了

:: llama-cpp-python を CPU 向けに再ビルド
echo.
echo   llama-cpp-python を CPU 向けに再ビルド中...
echo   （数分かかる場合があります）
pip uninstall -y llama-cpp-python > nul 2>&1
pip install llama-cpp-python --force-reinstall --no-cache-dir --no-binary llama-cpp-python
if %errorlevel% neq 0 (
    echo   [WARNING] ソースビルドに失敗しました。バイナリ版にフォールバックします。
    pip install llama-cpp-python
)
echo   [OK] llama-cpp-python の準備完了

call venv\Scripts\deactivate.bat 2>nul
cd /d "%~dp0"

:: ============================================================
:: 3. Node.js 依存関係のセットアップ
:: ============================================================
echo.
echo [3/5] Node.js 依存関係のセットアップ...
echo.

cd /d "%~dp0electron"

:: package-lock.json のハッシュを記録（更新検出用）
if exist package-lock.json (
    certutil -hashfile package-lock.json MD5 2>nul | findstr /v ":" > ..\python-backend\venv\.npm_hash 2>nul
)

echo   npm install を実行中...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install に失敗しました。
    pause & exit /b 1
)
echo   [OK] Node.js 依存関係のインストール完了

cd /d "%~dp0"

:: ============================================================
:: 4. モデルのダウンロード案内
:: ============================================================
echo.
echo [4/5] AI モデルのダウンロード...
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
:: 5. 完了
:: ============================================================
echo.
echo ============================================================
echo  [5/5] セットアップ完了！
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
