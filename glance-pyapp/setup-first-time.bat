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

:: 依存関係のインストール
:: 推論は llama-server.exe （別プロセス）が行うため、Python 側に
:: torch や llama-cpp-python は不要。requirements.txt はリリース版と同じ
:: 最小構成にしてある（開発用の追加依存は requirements-dev.txt）。
echo.
echo   Python 依存関係をインストール中...
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
echo   - qwen3_5-2b-server   ... 約 1.3GB + 0.7GB (mmproj)  ^<-- 既定
echo   - qwen3-vl-4b-server  ... 約 2.5GB + 0.5GB (mmproj)  精度重視
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
import yaml, os, sys, hashlib, urllib.request

with open('config.yaml', encoding='utf-8') as f:
    cfg = yaml.safe_load(f)

active = cfg.get('activeModel')
model_cfg = cfg.get('models', {}).get(active, {})
download_url = model_cfg.get('download_url')
mmproj_url   = model_cfg.get('mmproj_download_url')
model_path   = model_cfg.get('path', '')
mmproj_path  = model_cfg.get('mmproj_path', '')

print(f'アクティブモデル: {active}')

def download(url, dest, expected_sha256=None, expected_size=None):
    # アプリ本体(app.py)と同じ手順:
    # .part へ書いて、サイズと SHA-256 を検証してから本来の名前へ差し替える。
    # 途中で切れた壊れたファイルが正規の名前で残ると、次回以降ずっと
    # スキップされてモデルの読み込みに失敗し続けるため。
    if not url:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        if expected_size is None or os.path.getsize(dest) == expected_size:
            print(f'  既存ファイルをスキップ: {dest}')
            return
        print(f'  [WARNING] サイズ不一致のため取得し直します: {os.path.basename(dest)}')
    part = dest + '.part'
    print(f'  ダウンロード中: {os.path.basename(dest)}')
    print(f'    URL: {url}')
    try:
        hasher = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(url) as res, open(part, 'wb') as f:
            while True:
                chunk = res.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                hasher.update(chunk)
                total += len(chunk)
        if expected_size is not None and total != expected_size:
            raise ValueError(f'サイズ不一致 (期待 {expected_size} / 実際 {total})')
        if expected_sha256 and hasher.hexdigest().lower() != expected_sha256.lower():
            raise ValueError('チェックサム不一致')
        os.replace(part, dest)
        print(f'  [OK] {os.path.basename(dest)}')
    except Exception as e:
        if os.path.exists(part):
            os.remove(part)
        print(f'  [WARNING] ダウンロード失敗: {e}')
        print(f'            もう一度 setup-first-time.bat を実行してください')

download(download_url, model_path,
         model_cfg.get('sha256'), model_cfg.get('size'))
download(mmproj_url, mmproj_path,
         model_cfg.get('mmproj_sha256'), model_cfg.get('mmproj_size'))
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
