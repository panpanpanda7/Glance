@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

echo ============================================================
echo  Glance - 起動診断スクリプト
echo ============================================================
echo.
echo このスクリプトは起動に失敗した場合の原因調査に使用します。
echo.

cd /d "%~dp0"

:: ============================================================
:: 診断1: venv の Python 動作確認
:: ============================================================
echo [診断1] Python 仮想環境の確認...
if not exist "python-backend\venv\Scripts\python.exe" (
    echo   [NG] venv\Scripts\python.exe が見つかりません。
    echo        setup-first-time.bat を再実行してください。
    goto :end
)
python-backend\venv\Scripts\python.exe --version
if %errorlevel% neq 0 (
    echo   [NG] venv の Python が実行できません。
    echo        venv フォルダを削除して setup-first-time.bat を再実行してください。
    goto :end
)
echo   [OK] venv の Python は正常です。
echo.

:: ============================================================
:: 診断2: Python バックエンドの単体起動テスト（5秒）
:: ============================================================
echo [診断2] Python バックエンドの起動テスト（5秒間）...
echo   エラーが出る場合はその内容を開発者に共有してください。
echo.
cd python-backend
start "Glance Python Backend [診断]" /wait cmd /c "venv\Scripts\python.exe app.py & pause"
cd ..
echo.

:: ============================================================
:: 診断3: モデルファイルの存在確認
:: ============================================================
echo [診断3] モデルファイルの確認...
set MODEL_DIR=python-backend\models\gguf

:: config.yaml から activeModel を読み取り
python-backend\venv\Scripts\python.exe -c "
import yaml, os, sys
with open('python-backend/config.yaml', encoding='utf-8') as f:
    cfg = yaml.safe_load(f)
active = cfg.get('activeModel', '')
model_cfg = cfg.get('models', {}).get(active, {})
model_path = model_cfg.get('path', '')
mmproj_path = model_cfg.get('mmproj_path', '')
print(f'activeModel: {active}')
print(f'model_path: {model_path}')
print(f'mmproj_path: {mmproj_path}')
ok = True
for p in [model_path, mmproj_path]:
    if p:
        exists = os.path.exists(p)
        size = os.path.getsize(p) // (1024*1024) if exists else 0
        status = f'[OK] {size}MB' if exists else '[NG] ファイルなし'
        print(f'  {status}: {p}')
        if not exists:
            ok = False
sys.exit(0 if ok else 1)
"
if %errorlevel% neq 0 (
    echo.
    echo   [NG] モデルファイルが不足しています。
    echo        setup-first-time.bat を再実行してモデルをダウンロードしてください。
    goto :end
)
echo   [OK] モデルファイルは揃っています。
echo.

:: ============================================================
:: 診断4: Node.js / Electron の確認
:: ============================================================
echo [診断4] Node.js / Electron の確認...
cd electron
if not exist node_modules (
    echo   [NG] node_modules が見つかりません。
    echo        npm install を実行してください。
    cd ..
    goto :end
)
if not exist "node_modules\.bin\electron.cmd" (
    echo   [NG] electron が node_modules にインストールされていません。
    echo        electron フォルダで npm install を実行してください。
    cd ..
    goto :end
)
echo   [OK] Electron は正常にインストールされています。
cd ..
echo.

:: ============================================================
:: 診断5: Electron 単体起動テスト（エラーをコンソールに表示）
:: ============================================================
echo [診断5] Electron の起動テスト...
echo   Electron ウィンドウが表示されるか確認してください。
echo   このウィンドウにエラーが表示される場合は内容を開発者に共有してください。
echo.
cd electron
call node_modules\.bin\electron.cmd . --dev
if %errorlevel% neq 0 (
    echo.
    echo   [NG] Electron が終了コード %errorlevel% で終了しました。
)
cd ..

:end
echo.
echo ============================================================
echo  診断完了
echo ============================================================
echo このウィンドウの内容をスクリーンショットして開発者に共有してください。
pause
