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

REM llama-cpp-pythonをCPU互換性のために再ビルド
echo.
echo ============================================================
echo 🔧 llama-cpp-pythonをCPU互換性のために再ビルド中...
echo    (Illegal Instruction エラーを修正するため、ローカルでコンパイルします)
echo ============================================================
pip uninstall -y llama-cpp-python
pip install llama-cpp-python --force-reinstall --no-cache-dir --no-binary llama-cpp-python

if %errorlevel% neq 0 (
    echo.
    echo ⚠️  [WARNING] ソースビルドに失敗しました。デフォルトのバイナリにフォールバック中...
    echo    ビルドに失敗した場合、"Visual Studio Build Tools" (C++ Desktop Development) が必要な場合があります。
    pip install llama-cpp-python
)

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
echo    huggingface-cli download OpenGVLab/InternVL3_5-1B --local-dir .\InternVL3.5-1B
echo.
echo 3. config.yamlを編集してactiveModelを設定
echo.
echo 4. サーバーを起動:
echo    python app.py
echo.

pause
