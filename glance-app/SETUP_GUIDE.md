# Glance セットアップガイド

このガイドに従って、Glanceアプリケーションを起動してください。

## 📋 前提条件

- Node.js 18以上
- npm または yarn
- Python 3.8以上（モデル変換が必要な場合）

## 🚀 クイックスタート

### ステップ1: 依存関係のインストール

```bash
cd glance-app
npm install
```

**予想される所要時間**: 2-5分

### ステップ2: モデルのダウンロード

**重要**: このステップはアプリの動作に必須です。

#### オプションA: テスト用の小さいモデル（開発/検証用）

まずはアプリの動作確認をしたい場合、軽量なLLaVAモデルを使用できます：

```bash
# llm/models/ディレクトリに移動
cd llm/models/

# LLaVA 1.5 7B GGUF版をダウンロード（約4GB）
# Hugging Face CLIを使用
pip install huggingface-hub
huggingface-cli download mys/ggml_llava-v1.5-7b --local-dir ./

# または、ブラウザでダウンロード
# https://huggingface.co/mys/ggml_llava-v1.5-7b/tree/main
# ggml-model-q4_k.gguf をダウンロード
```

ダウンロード後、`config/model-config.yaml`を編集：

```yaml
activeModel: llava-test

models:
  llava-test:
    name: LLaVA 1.5 7B (Test)
    type: internvl  # 同じインターフェースを使用
    modelPath: ./llm/models/ggml-model-q4_k.gguf
    precision: medium
```

#### オプションB: 本番用の高精度モデル（InternVL）

高精度が必要な場合はInternVL 2.5を使用：

詳細は `llm/models/README.md` を参照してください。

**予想される所要時間**: 10-30分（モデルサイズによる）

### ステップ3: アプリケーションの起動

```bash
# 開発モード（推奨）
npm run dev

# または通常モード
npm start
```

### ステップ4: 動作確認

1. アプリが起動し、ウィンドウが表示される
2. ステータスが「モデルをロード中...」→「待機中」に変わる
3. システムトレイにアイコンが表示される
4. **Ctrl+Shift+G**（Mac: Cmd+Shift+G）を押す
5. 画面がキャプチャされ、音声で説明が再生される

## 🔧 トラブルシューティング

### 問題1: `npm install`が失敗する

```bash
# キャッシュをクリア
npm cache clean --force

# 再インストール
rm -rf node_modules package-lock.json
npm install
```

### 問題2: モデルのロードに失敗

**エラーメッセージ**: `モデルファイルが見つかりません`

**解決策**:
1. モデルファイルが `llm/models/` に配置されているか確認
2. ファイル名が `config/model-config.yaml` と一致しているか確認
3. ファイルのパーミッションを確認（読み取り可能か）

```bash
# ファイルの存在確認
ls -lh llm/models/

# 期待される出力例:
# -rw-r--r--  1 user  staff  4.2G  internvl-2.5-8b-q4.gguf
```

### 問題3: node-llama-cppのエラー

**エラーメッセージ**: `Cannot find module 'node-llama-cpp'`

**解決策**:
```bash
# 直接インストール
npm install node-llama-cpp@latest --save

# または、ビルドツールが必要な場合（macOS）
xcode-select --install
npm install node-llama-cpp --save --build-from-source
```

### 問題4: 画面キャプチャができない

**エラーメッセージ**: `画面ソースが見つかりません`

**解決策**:
- **macOS**: システム環境設定 → セキュリティとプライバシー → プライバシー → 画面収録でElectronを許可
- **Windows**: 管理者権限で実行

### 問題5: TTSが動作しない

**macOS**: デフォルトで動作するはずです
**Windows**: PowerShellが利用可能か確認
```powershell
# PowerShellで実行
Add-Type -AssemblyName System.Speech
```

## 📦 ビルド（配布用パッケージ作成）

### Windows向け

```bash
npm run build:win
```

出力: `dist/Glance-Setup.exe`

### macOS向け

```bash
npm run build:mac
```

出力: `dist/Glance.dmg`

## 🧪 テスト

### 基本的な動作テスト

1. **ホットキーテスト**: Ctrl+Shift+Gが反応するか
2. **キャプチャテスト**: 画面が正しくキャプチャされるか
3. **LLMテスト**: モデルが正しく推論を実行するか
4. **TTSテスト**: 音声が再生されるか

### テストケース例

```bash
# 1. シンプルなテキスト画面を開く
# 2. Ctrl+Shift+Gを押す
# 3. 画面の説明が音声で再生されることを確認
```

## 📝 次のステップ

1. ✅ アプリが正常に動作することを確認
2. 📊 実際の使用ケース（Teams、Excel、Webブラウザ）でテスト
3. 🎨 アイコンをカスタマイズ（`build/icon.png`）
4. ⚙️ 設定をカスタマイズ（`config/*.yaml`）
5. 🚀 ビルドして配布

## 🆘 サポート

問題が解決しない場合：

1. `README.md`の詳細なドキュメントを確認
2. `llm/models/README.md`でモデル固有の問題を確認
3. GitHubでIssueを作成（該当する場合）

## 📚 参考資料

- [Electron Documentation](https://www.electronjs.org/docs)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- [InternVL](https://github.com/OpenGVLab/InternVL)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)

---

**質問やフィードバック**: プロジェクトのREADMEを参照してください。
