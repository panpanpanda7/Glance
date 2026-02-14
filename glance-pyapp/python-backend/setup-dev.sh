#!/bin/bash
# 開発環境セットアップスクリプト（macOS/Linux）

set -e

echo "============================================================"
echo "🐍 Glance Python Backend - 開発環境セットアップ"
echo "============================================================"
echo ""

# Pythonバージョン確認
echo "📋 Pythonバージョン確認..."
python3 --version

# 仮想環境作成
echo ""
echo "📦 仮想環境を作成中..."
python3 -m venv venv

# 仮想環境を有効化
echo "✅ 仮想環境を有効化..."
source venv/bin/activate

# pip更新
echo ""
echo "⬆️  pipを最新版に更新..."
pip install --upgrade pip

# 依存関係インストール
echo ""
echo "📥 依存関係をインストール中..."
echo "⚠️  PyTorchのダウンロードには時間がかかります（数分〜10分）"
pip install -r requirements.txt

echo ""
echo "============================================================"
echo "✅ セットアップ完了！"
echo "============================================================"
echo ""
echo "次のステップ:"
echo "1. 仮想環境を有効化:"
echo "   source venv/bin/activate"
echo ""
echo "2. モデルをダウンロード（テスト用に小さいモデルを推奨）:"
echo "   cd ../models"
echo "   huggingface-cli download OpenGVLab/InternVL3_5-1B --local-dir ./InternVL3.5-1B"
echo ""
echo "3. config.yamlを編集してactiveModelを設定"
echo ""
echo "4. サーバーを起動:"
echo "   python app.py"
echo ""
