@echo off
REM 開発環境セットアップスクリプト（Windows）

echo ============================================================
echo 🐍 Glance Python Backend - 開発環境セットアップ
echo ============================================================
echo.

REM Pythonバージョン確認
echo 📋 Pythonバージョン確認...
python --version

REM 仮想環境作成
echo.
echo 📦 仮想環境を作成中...
python -m venv venv

REM 仮想環境を有効化
echo ✅ 仮想環境を有効化...
call venv\Scripts\activate.bat

REM pip更新
echo.
echo ⬆️  pipを最新版に更新...
python -m pip install --upgrade pip

REM 依存関係インストール
echo.
echo 📥 依存関係をインストール中...
echo ⚠️  PyTorchのダウンロードには時間がかかります（数分〜10分）
pip install -r requirements.txt

echo.
echo ============================================================
echo ✅ セットアップ完了！
echo ============================================================
echo.
echo 次のステップ:
echo 1. 仮想環境を有効化:
echo    venv\Scripts\activate.bat
echo.
echo 2. モデルをダウンロード（テスト用に小さいモデルを推奨）:
echo    cd ..\models
echo    huggingface-cli download OpenGVLab/InternVL2_5-4B --local-dir .\InternVL2.5-4B
echo.
echo 3. config.yamlを編集してactiveModelを設定
echo.
echo 4. サーバーを起動:
echo    python app.py
echo.

pause
