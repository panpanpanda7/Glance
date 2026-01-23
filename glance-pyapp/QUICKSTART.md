# 🚀 Glance PyApp クイックスタートガイド

最速で動作確認するための手順

## ⚡ 3ステップでテスト起動

### Step 1: Python Backendセットアップ（5-10分）

```bash
cd glance-pyapp/python-backend

# 仮想環境作成 + 依存関係インストール
chmod +x setup-dev.sh
./setup-dev.sh
```

**注意**: PyTorchのダウンロードに5-10分かかります。

---

### Step 2: テスト用モデルのダウンロード（5-10分）

```bash
# 仮想環境を有効化
source venv/bin/activate

# Hugging Face CLIをインストール
pip install huggingface-hub

# テスト用: InternVL 2.5-4B（約4GB）
cd models
huggingface-cli download OpenGVLab/InternVL2_5-4B --local-dir ./InternVL2.5-4B
```

**config.yamlを編集**:
```bash
cd ../
nano config.yaml
```

変更内容:
```yaml
activeModel: internvl-4b  # この行を確認/変更
```

---

### Step 3: アプリ起動（1分）

**ターミナル1: Python Backend起動**
```bash
cd glance-pyapp/python-backend
source venv/bin/activate
python app.py
```

待機: 「Flask サーバーを起動」と表示されるまで待つ（初回は数分）

**ターミナル2（新しいターミナル）: Electron起動**
```bash
cd glance-pyapp/electron
npm install  # 初回のみ
npm run dev
```

---

## ✅ 動作確認

### 1. アプリが起動したか確認

- Electronウィンドウが表示される
- ステータスが「待機中」になる（緑色の点）

### 2. 画面キャプチャをテスト

- **Cmd+Shift+G** (Mac) を押す
- または「画面を読み上げ」ボタンをクリック

### 3. 期待される動作

```
1. 「画面をキャプチャ中...」→ 即座
2. 「画面を分析中...」→ 15-30秒（4Bモデル、CPU）
3. 音声で説明が再生される
4. アプリ内に説明テキストが表示される
```

---

## 🎯 精度が良ければ26Bモデルに切り替え

### Step 1: 26Bモデルをダウンロード

```bash
cd glance-pyapp/models

# InternVL 2.5-26B（約26GB、1-2時間）
huggingface-cli download OpenGVLab/InternVL2_5-26B --local-dir ./InternVL2.5-26B
```

### Step 2: config.yaml変更

```yaml
activeModel: internvl-26b  # 4b → 26b に変更
```

### Step 3: Python Backend再起動

```bash
# Ctrl+C でPythonを停止
# 再起動
python app.py
```

---

## ⚠️ トラブルシューティング

### Pythonバックエンドが起動しない

```bash
# エラーメッセージを確認
cd python-backend
source venv/bin/activate
python app.py

# よくあるエラー:
# - モデルが見つからない → Step 2を確認
# - PyTorchが入っていない → setup-dev.shを再実行
```

### Electronが「Pythonバックエンドが起動していません」

```bash
# Pythonが起動しているか確認
curl http://127.0.0.1:5000/health

# 期待されるレスポンス:
# {"status":"ok","model_loaded":true}

# Pythonが起動していない場合:
# → ターミナル1でPythonを起動
```

### モデルダウンロードが遅い

```bash
# 代替ミラーを使用（中国）
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download ...

# または手動ダウンロード:
# https://huggingface.co/OpenGVLab/InternVL2_5-4B
# → Files and versions → すべてダウンロード
```

---

## 💡 開発のヒント

### デバッグモードで起動

```bash
# Electron
npm run dev  # DevToolsが開く

# Python
# config.yaml: server.debug: true
```

### ログを確認

```bash
# Python Backend
# → ターミナル1に出力される

# Electron
# → DevToolsのConsoleタブ
```

### APIを直接テスト

```bash
# Base64エンコード済みの画像でテスト
curl -X POST http://127.0.0.1:5000/analyze \
  -H "Content-Type: application/json" \
  -d @test-request.json
```

---

## 📊 次のステップ

### テスト完了後

1. ✅ 動作確認
2. ✅ 精度確認（Teams、Excel、Webブラウザ）
3. ⏳ 26Bモデルに切り替え
4. ⏳ パッケージング準備
5. ⏳ インストーラー作成

### より詳しい情報

- Python Backend: `python-backend/README.md`
- 全体構成: `README.md`

---

**質問があれば README.md を参照してください！**
