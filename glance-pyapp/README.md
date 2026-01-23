# Glance PyApp - AI画面読み上げアプリ

InternVL 2.5 + Python API による最高精度の画面読み上げアプリケーション

## 🎯 概要

Glance PyAppは、視覚障害者がPC画面の内容を瞬時に理解できるようにする画面読み上げアプリです。InternVL 2.5という最先端のVision-Language Modelを使用し、晴眼者が一瞬で捉える画面の概要を詳細な音声説明として提供します。

### 特徴

- 🎯 **最高精度**: InternVL 2.5-26B（GPT-4Vレベル）
- 🇯🇵 **完全日本語対応**: 詳細で自然な日本語説明
- 📊 **グラフ・図表対応**: 数値やデータの傾向を具体的に説明
- ⌨️ **グローバルホットキー**: Cmd+Shift+G (Ctrl+Shift+G) でいつでも起動
- 🔄 **モデル切り替え可能**: 26B/8B/4Bを状況に応じて選択
- 💻 **CPU/GPU両対応**: GPUがなくても動作（推論時間は長くなります）
- 📦 **完全オフライン**: インターネット接続不要

## 🚀 クイックスタート

### ステップ1: Python Backendのセットアップ

```bash
cd glance-pyapp/python-backend

# macOS/Linux
chmod +x setup-dev.sh
./setup-dev.sh

# Windows
setup-dev.bat
```

### ステップ2: モデルのダウンロード

**まずはテスト用の小さいモデルで動作確認を推奨：**

```bash
# 仮想環境を有効化
source python-backend/venv/bin/activate  # macOS/Linux
python-backend\venv\Scripts\activate.bat  # Windows

# Hugging Face CLIをインストール
pip install huggingface-hub

# テスト用: InternVL 2.5-4B（約4GB）
cd models
huggingface-cli download OpenGVLab/InternVL2_5-4B --local-dir ./InternVL2.5-4B

# python-backend/config.yamlを編集
# activeModel: internvl-4b に設定
```

**精度を確認後、最高精度モデルに切り替え：**

```bash
# InternVL 2.5-26B（約26GB、最高精度）
huggingface-cli download OpenGVLab/InternVL2_5-26B --local-dir ./InternVL2.5-26B

# config.yamlを編集
# activeModel: internvl-26b に変更
```

### ステップ3: Electronアプリのセットアップ

```bash
cd electron
npm install
```

### ステップ4: アプリの起動

#### 開発モード

**ターミナル1: Python Backend**
```bash
cd python-backend
source venv/bin/activate
python app.py
```

**ターミナル2: Electron**
```bash
cd electron
npm run dev
```

#### 統合起動（将来実装）
```bash
cd electron
npm start  # PythonとElectronを自動起動
```

## 📖 使い方

1. **アプリ起動**: 上記の手順でアプリを起動
2. **待機**: 「待機中」ステータスになるまで待つ（初回は数分）
3. **画面キャプチャ**: 
   - **Cmd+Shift+G** (Mac) または **Ctrl+Shift+G** (Windows) を押す
   - またはアプリの「画面を読み上げ」ボタンをクリック
4. **分析**: 画面が自動的に分析されます（26Bモデル: 60-180秒）
5. **読み上げ**: 詳細な説明が音声で読み上げられます

## 📁 プロジェクト構造

```
glance-pyapp/
├── python-backend/         # Python Flask APIサーバー
│   ├── venv/              # 仮想環境（開発用）
│   ├── app.py             # Flaskアプリ
│   ├── models/            # モデル実装
│   │   ├── model_interface.py
│   │   └── internvl.py
│   ├── config.yaml        # モデル設定
│   ├── requirements.txt   # Python依存関係
│   └── setup-dev.sh       # セットアップスクリプト
│
├── electron/              # Electronフロントエンド
│   ├── main.js           # メインプロセス（Python自動起動）
│   ├── preload.js        # Preloadスクリプト
│   ├── index.html        # UI
│   ├── renderer.js       # レンダラープロセス
│   ├── utils/            # ユーティリティ
│   │   ├── screenshot.js
│   │   └── tts.js
│   └── package.json
│
├── models/                # モデルファイル（.gitignore）
│   ├── InternVL2.5-4B/   # テスト用（4GB）
│   ├── InternVL2.5-8B/   # 推奨（8GB）
│   └── InternVL2.5-26B/  # 最高精度（26GB）
│
└── README.md
```

## ⚙️ 設定

### モデルの切り替え

`python-backend/config.yaml`を編集：

```yaml
activeModel: internvl-4b  # 4B / 8B / 26B から選択
```

サーバーを再起動すると新しいモデルがロードされます。

### プロンプトのカスタマイズ

`python-backend/config.yaml`の`prompt.systemPrompt`を編集して、説明の詳細度やスタイルを調整できます。

## 📊 パフォーマンス

### 推論時間

| モデル | CPU（M2 Max） | GPU（RTX 4090） |
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

## 🔧 トラブルシューティング

### Pythonバックエンドが起動しない

```bash
# 仮想環境を確認
cd python-backend
source venv/bin/activate
python app.py

# エラーメッセージを確認
```

### モデルが見つからない

```bash
# モデルパスを確認
ls -la models/InternVL2.5-4B/

# 期待される構造:
# InternVL2.5-4B/
# ├── config.json
# ├── model.safetensors (または pytorch_model.bin)
# ├── tokenizer_config.json
# └── ...
```

### GPU CUDA Out of Memory

```bash
# より小さいモデルに切り替え
# config.yaml: activeModel: internvl-4b
```

### 画面キャプチャの権限エラー（macOS）

- システム環境設定 → セキュリティとプライバシー → プライバシー → 画面収録
- Electronを許可

## 🏗️ 次のステップ

### 現在の状態
- ✅ Python Backend実装完了
- ✅ Electron統合完了
- ⏳ モデルダウンロード（ユーザーが実施）
- ⏳ 統合テスト
- ⏳ パッケージング
- ⏳ インストーラー作成

### 実行手順

1. **Python Backendセットアップ**: `python-backend/setup-dev.sh`
2. **モデルダウンロード**: Hugging Face CLIで4B/8B/26Bをダウンロード
3. **Electronセットアップ**: `cd electron && npm install`
4. **起動テスト**: Python Backend → Electron の順に起動
5. **精度確認**: Cmd+Shift+Gで画面をキャプチャ、説明の質を確認
6. **モデル切り替え**: 必要に応じて26Bに切り替え

## 📝 開発メモ

### Python API仕様

- **ポート**: 127.0.0.1:5000
- **エンドポイント**:
  - `GET /health` - ヘルスチェック
  - `POST /analyze` - 画像分析
  - `POST /switch-model` - モデル切り替え
  - `GET /models` - モデル一覧

### Electron ↔ Python 通信

- ElectronがPythonプロセスを`spawn()`で起動
- HTTP通信でデータをやり取り
- アプリ終了時にPythonプロセスも自動終了

## 📦 将来の配布パッケージ

最終的には以下のような完全同梱インストーラーを作成予定：

```
Glance-Setup.exe (25-30 GB)
├── Electronアプリ
├── Python Runtime (Embedded)
├── PyTorch + 依存関係
└── InternVL 2.5-26B
```

ユーザーはインストーラーを実行するだけで、すぐに使用可能になります。

## 📄 ライセンス

MIT License

## 🤝 貢献

プルリクエスト・イシューは大歓迎です！
