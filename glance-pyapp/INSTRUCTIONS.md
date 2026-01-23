# InternVL 2.5モデル対応版 - Glanceセットアップ手順

今回のカスタムモデル読み込み問題の修正内容と実行手順です。

## 修正内容

カスタムモデルコードの読み込みに関する問題を解決しました：

### 1. モジュールパス問題の解決
- transformers_modulesディレクトリを自動生成するよう実装
- InternVL2のカスタムコードを適切なPythonパスに配置
- インポートシステムに登録するロジックを追加

### 2. モデルロード方法の改善
- `InternVLChatModel`を直接インポートして使用
- 生成パラメータをGenerationConfig形式に変換
- 複数のモデルインターフェースに対応するフォールバックを実装

### 3. ポート設定の同期
- Flask APIポートを5000から5001に変更
- Electronクライアントも同じポート(5001)に変更

## 使用方法

### 1. 事前確認
Python 3.11以上がインストールされていることを確認してください。

### 2. Python Backend実行

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend

# 仮想環境をセットアップ（初回のみ）
chmod +x setup-dev.sh
./setup-dev.sh

# 仮想環境を有効化
source venv/bin/activate

# サーバーを起動
python app.py
```

出力を確認：
```
============================================================
🚀 Glance Python Backend 起動中...
============================================================

✅ 設定ファイル読み込み成功

============================================================
📦 モデルをロード中: internvl-4b
============================================================

🖥️  デバイス: cpu
📦 InternVLをロード中: /Users/takeshi/Project/Glance/glance-pyapp/python-backend/./models/InternVL2.5-4B
⏳ 初回ロードには数分かかる場合があります...
✅ カスタムモデルコードをPythonパスに登録しました
✅ InternVLのロードが完了しました
   デバイス: cpu
   モデルサイズ: X.XX GB

============================================================
🌐 Flask サーバーを起動: http://127.0.0.1:5001
============================================================
```

### 3. Electron Frontend実行

別のターミナルで：

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/electron

# 依存関係をインストール（初回のみ）
npm install

# 開発モードで起動
npm run dev
```

## トラブルシューティング

### フォルダ権限問題
モデルコードの登録中にフォルダ作成権限エラーが発生する場合：

```bash
# transformers_modulesディレクトリを作成
mkdir -p /Users/takeshi/Project/Glance/glance-pyapp/python-backend/transformers_modules/InternVL2
chmod -R 755 /Users/takeshi/Project/Glance/glance-pyapp/python-backend/transformers_modules
```

### Python環境の問題
必要なライブラリがインストールされていない場合：

```bash
pip install -r requirements.txt
```

### バージョンの問題
transformersのバージョンが古い場合：

```bash
pip install transformers>=4.37.0
```

## 検証方法

1. Electronアプリが起動し、「待機中」（緑色のドット）と表示されるのを確認
2. 「画面を読み上げ」ボタンをクリック
3. 画面キャプチャ後、画像分析が始まり、結果が表示・読み上げされることを確認
