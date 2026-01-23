# Glance Python Backend

InternVL 2.5を使った高精度画像分析APIサーバー

## 概要

このPython Backendは、InternVL 2.5などの高精度Vision-Language Modelを使用して、画面キャプチャ画像を詳細に分析し、視覚障害者向けの説明文を生成します。

## セットアップ

### 前提条件

- Python 3.11以上（3.12.8で動作確認済み）
- 32GB RAM推奨（InternVL 2.5-26B使用時）
- GPU推奨（CUDA対応、なくてもCPUで動作）

### 開発環境セットアップ

#### macOS/Linux

```bash
cd glance-pyapp/python-backend

# セットアップスクリプトを実行
chmod +x setup-dev.sh
./setup-dev.sh
```

#### Windows

```cmd
cd glance-pyapp\python-backend

REM セットアップスクリプトを実行
setup-dev.bat
```

#### 手動セットアップ

```bash
# 仮想環境作成
python3 -m venv venv

# 有効化（macOS/Linux）
source venv/bin/activate

# 有効化（Windows）
venv\Scripts\activate.bat

# 依存関係インストール
pip install -r requirements.txt
```

## モデルのダウンロード

### 推奨：テスト用に小さいモデルから始める

```bash
# Hugging Face CLIをインストール
pip install huggingface-hub

# InternVL 2.5-4B（約4GB、テスト用）
cd ../models
huggingface-cli download OpenGVLab/InternVL2_5-4B --local-dir ./InternVL2.5-4B

# config.yamlを編集
# activeModel: internvl-4b に変更
```

### 本番用：最高精度モデル

```bash
# InternVL 2.5-8B（約8GB、推奨）
huggingface-cli download OpenGVLab/InternVL2_5-8B --local-dir ./InternVL2.5-8B

# または InternVL 2.5-26B（約26GB、最高精度）
huggingface-cli download OpenGVLab/InternVL2_5-26B --local-dir ./InternVL2.5-26B
```

## 使い方

### サーバー起動

```bash
# 仮想環境を有効化
source venv/bin/activate  # macOS/Linux
venv\Scripts\activate.bat  # Windows

# サーバー起動
python app.py
```

起動すると以下のように表示されます：

```
============================================================
🚀 Glance Python Backend 起動中...
============================================================

✅ 設定ファイル読み込み成功

============================================================
📦 モデルをロード中: internvl-4b
============================================================

🖥️  デバイス: cuda
📦 InternVLをロード中: ../models/InternVL2.5-4B
⏳ 初回ロードには数分かかる場合があります...
✅ InternVLのロードが完了しました
   デバイス: cuda
   モデルサイズ: 7.89 GB

============================================================
🌐 Flask サーバーを起動: http://127.0.0.1:5000
============================================================
```

### APIテスト

```bash
# ヘルスチェック
curl http://127.0.0.1:5000/health

# 画像分析（Base64エンコードした画像）
curl -X POST http://127.0.0.1:5000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "image": "iVBORw0KGgoAAAANS...",
    "prompt": "この画像の内容を詳細に日本語で説明してください"
  }'

# モデル一覧取得
curl http://127.0.0.1:5000/models

# モデル切り替え
curl -X POST http://127.0.0.1:5000/switch-model \
  -H "Content-Type: application/json" \
  -d '{"model": "internvl-8b"}'
```

## API仕様

### `GET /health`

**Response:**
```json
{
  "status": "ok",
  "model_loaded": true
}
```

### `POST /analyze`

**Request:**
```json
{
  "image": "base64_encoded_image_data",
  "prompt": "この画像を説明してください",
  "temperature": 0.1,
  "max_tokens": 1000,
  "top_p": 0.9
}
```

**Response:**
```json
{
  "success": true,
  "result": "画面にはVisual Studio Codeエディタが表示されています...",
  "model": {
    "name": "InternVL 2.5",
    "device": "cuda",
    "is_loaded": true,
    "model_size_gb": 7.89
  }
}
```

### `POST /switch-model`

**Request:**
```json
{
  "model": "internvl-8b"
}
```

**Response:**
```json
{
  "success": true,
  "model": {
    "name": "InternVL 2.5",
    "device": "cuda",
    "is_loaded": true
  }
}
```

### `GET /models`

**Response:**
```json
{
  "active_model": "internvl-4b",
  "models": {
    "internvl-26b": {...},
    "internvl-8b": {...},
    "internvl-4b": {...}
  }
}
```

## 設定

### config.yaml

```yaml
activeModel: internvl-4b  # 使用するモデル

models:
  internvl-4b:
    name: InternVL 2.5 4B
    type: internvl
    path: ../models/InternVL2.5-4B
```

### モデル切り替え

`config.yaml`の`activeModel`を変更してサーバーを再起動、またはAPI経由で切り替え可能。

## トラブルシューティング

### PyTorchのインストールエラー

```bash
# CPU版を明示的にインストール
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

### CUDA Out of Memory

```bash
# より小さいモデルに切り替え
# config.yaml: activeModel: internvl-4b
```

### モデルが見つからない

```bash
# モデルパスを確認
ls -la ../models/InternVL2.5-4B/

# 期待される構造:
# InternVL2.5-4B/
# ├── config.json
# ├── model.safetensors
# └── ...
```

## パフォーマンス

### 推論時間（参考値）

| モデル | CPU（16コア） | GPU（RTX 4090） |
|--------|--------------|----------------|
| 4B     | 15-30秒      | 3-8秒          |
| 8B     | 30-60秒      | 5-15秒         |
| 26B    | 60-180秒     | 15-40秒        |

### メモリ使用量

| モデル | CPU RAM | GPU VRAM |
|--------|---------|----------|
| 4B     | 8GB     | 4GB      |
| 8B     | 16GB    | 8GB      |
| 26B    | 32GB    | 16GB     |

## 次のステップ

1. ✅ Python Backendのセットアップ
2. ⏳ Electron統合
3. ⏳ 自動起動スクリプト
4. ⏳ パッケージング
5. ⏳ インストーラー作成

## ライセンス

MIT License
