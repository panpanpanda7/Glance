# Glance - 視覚障害者向けPC画面読み上げアプリ

## 概要

Glanceは、視覚障害者がPC画面の内容を瞬時に理解できるようにする画面読み上げアプリケーションです。従来の画面リーダーとは異なり、画面全体をLLM（Vision-Language Model）で分析し、晴眼者が一瞬で捉えるような概要を音声で提供します。

### 特徴

- 🎯 **高精度な画像理解**: InternVL 2.5を使用し、グラフ・図表・テキストを詳細に分析
- ⌨️ **グローバルホットキー**: Ctrl+Shift+G（Mac: Cmd+Shift+G）でいつでも画面読み上げ
- 🔊 **OS標準TTS**: 追加インストール不要で音声読み上げ
- 🔄 **モデル切り替え可能**: 必要に応じて異なるモデルを使用可能
- 🖥️ **クロスプラットフォーム**: Windows/macOS対応

## セットアップ

### 1. 依存関係のインストール

```bash
cd glance-app
npm install
```

### 2. InternVL 2.5モデルのダウンロード

現在、InternVL 2.5-8Bモデルを使用するように設定されています。

#### モデルの取得方法

**Option A: GGUF形式（推奨）**

Hugging FaceからGGUF形式のモデルをダウンロード：

```bash
# llm/models/ディレクトリを作成
mkdir -p llm/models

# モデルをダウンロード（例: Hugging Face CLI使用）
# huggingface-cli download OpenGVLab/InternVL2_5-8B-GGUF --local-dir llm/models/
```

または、手動でダウンロード：
1. https://huggingface.co/OpenGVLab/InternVL2_5-8B にアクセス
2. GGUF形式のモデルファイルをダウンロード
3. `glance-app/llm/models/` に配置
4. ファイル名を `internvl-2.5-8b-q4.gguf` にリネーム（または `config/model-config.yaml` で調整）

**Option B: llama.cppで量子化**

オリジナルのPyTorchモデルをGGUF形式に変換：

```bash
# llama.cppをクローン
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp

# モデルを変換（詳細はllama.cppのドキュメント参照）
# python convert.py <model_path> --outtype f16
# ./quantize <model>.gguf <output>.gguf q4_k_m
```

### 3. モデル配置の確認

モデルファイルが以下のパスに配置されていることを確認：

```
glance-app/
└── llm/
    └── models/
        └── internvl-2.5-8b-q4.gguf
```

### 4. アプリケーションの起動

```bash
# 開発モード（DevToolsが開きます）
npm run dev

# 通常モード
npm start
```

## 使い方

1. **アプリ起動**: `npm start` でGlanceを起動
2. **システムトレイ**: アプリはバックグラウンドで常駐し、システムトレイにアイコンが表示されます
3. **画面読み上げ**: 
   - ホットキー（Ctrl+Shift+G）を押す
   - またはアプリウィンドウの「画面を読み上げ」ボタンをクリック
4. **停止**: 読み上げ中に「停止」ボタンまたはホットキーを再度押す

## 設定

### config/app-config.yaml

アプリケーションの動作設定：

```yaml
app:
  hotkey: CommandOrControl+Shift+G  # ホットキー
  tts:
    speed: 1.0      # 音声速度（0.5-2.0）
    volume: 1.0     # 音量（0.0-1.0）
    language: ja-JP # 言語
```

### config/model-config.yaml

モデルの設定：

```yaml
activeModel: internvl-8b  # 使用するモデル

models:
  internvl-8b:
    name: InternVL 2.5 8B
    type: internvl
    modelPath: ./llm/models/internvl-2.5-8b-q4.gguf
```

## ビルド

### Windows向けビルド

```bash
npm run build:win
```

出力：`dist/Glance-Setup.exe`

### macOS向けビルド

```bash
npm run build:mac
```

出力：`dist/Glance.dmg`, `dist/Glance.app.zip`

## トラブルシューティング

### モデルが見つからないエラー

```
モデルファイルが見つかりません: ./llm/models/internvl-2.5-8b-q4.gguf
```

**解決方法**:
1. モデルファイルが正しいパスに配置されているか確認
2. `config/model-config.yaml` のパスが正しいか確認

### node-llama-cppのインストールエラー

```
Error: Cannot find module 'node-llama-cpp'
```

**解決方法**:
```bash
npm install node-llama-cpp --save
```

### TTS（音声読み上げ）が動作しない

- **macOS**: `say` コマンドが利用可能か確認（デフォルトで利用可能）
- **Windows**: PowerShellが利用可能か確認
- **Linux**: `espeak` をインストール
  ```bash
  sudo apt-get install espeak
  ```

## 開発

### ディレクトリ構造

```
glance-app/
├── config/              # 設定ファイル
│   ├── model-config.yaml
│   └── app-config.yaml
├── llm/                 # LLM関連
│   ├── config-loader.js
│   ├── model-interface.js
│   ├── inference-engine.js
│   └── models/
│       └── internvl.js
├── utils/               # ユーティリティ
│   ├── screenshot.js
│   └── tts.js
├── main.js              # Electronメインプロセス
├── preload.js           # Preloadスクリプト
├── index.html           # メインUI
├── renderer.js          # レンダラープロセス
└── package.json
```

### モデルの追加方法

1. `llm/models/` に新しいモデルクラスを作成（例: `qwen.js`）
2. `VisionLanguageModel` を継承
3. `config/model-config.yaml` に設定を追加
4. `inference-engine.js` の `loadModel()` に分岐を追加

## ライセンス

MIT License

## 貢献

プルリクエスト・イシューは大歓迎です！

## 今後の予定

- [ ] GPU加速対応
- [ ] より軽量なモデルのサポート
- [ ] 音声コマンド機能
- [ ] スクリーンショット履歴機能
- [ ] カスタムプロンプト設定UI
