# 次のステップ

このドキュメントでは、Glanceアプリを完全に動作させるための次のステップを説明します。

## 📍 現在の状態

✅ **完了していること**:
- Electronアプリケーションの基本構造
- モデル抽象化レイヤー（モデル入れ替え可能）
- 画面キャプチャ機能
- グローバルホットキー（Ctrl+Shift+G）
- TTS（音声読み上げ）統合
- システムトレイ・UI
- YAML設定システム
- ドキュメント整備

❌ **未完了（実行が必要）**:
- Vision-Language Modelのダウンロード
- 実機でのテスト
- アイコンの作成（オプション）

---

## 🎯 ステップ1: モデルのダウンロード

**重要**: このステップを完了しないと、アプリは動作しません。

### オプションA: 開発・テスト用（推奨：まず動作確認）

最も簡単な方法は、既にGGUF形式で公開されている軽量モデルを使用することです：

```bash
cd glance-app/llm/models/

# 以下のいずれかをダウンロード（ブラウザまたはCLI）

# 1. LLaVA 1.5 7B (約4GB)
# https://huggingface.co/mys/ggml_llava-v1.5-7b
# ファイル: ggml-model-q4_k.gguf

# 2. LLaVA 1.6 Mistral 7B (約4GB)  
# https://huggingface.co/cjpais/llava-v1.6-mistral-7b-gguf
# ファイル: llava-v1.6-mistral-7b.Q4_K_M.gguf

# 3. Qwen2-VL 2B (約2GB、軽量）
# https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct-GGUF
# ファイル: qwen2-vl-2b-instruct-q4_k_m.gguf
```

ダウンロード後、`config/model-config.yaml`を編集：

```yaml
activeModel: llava-test

models:
  llava-test:
    name: LLaVA 1.5 7B
    type: internvl
    modelPath: ./llm/models/ggml-model-q4_k.gguf  # ダウンロードしたファイル名に合わせる
    precision: medium
```

### オプションB: 高精度版（InternVL 2.5）

**注意**: InternVL 2.5はまだGGUF形式で公開されていない可能性があります。その場合：

1. **代替1**: InternVL 3.0/3.5が公開されているか確認
   - https://huggingface.co/OpenGVLab

2. **代替2**: LLaVA-NeXT 34Bを使用（高精度、約17GB）
   ```bash
   # https://huggingface.co/cjpais/llava-v1.6-34B-gguf
   ```

3. **代替3**: 自分でPyTorchモデルをGGUFに変換
   - 詳細: `llm/models/README.md`

---

## 🎯 ステップ2: アプリの起動とテスト

### 2.1 起動

```bash
cd glance-app
npm run dev
```

### 2.2 確認項目

1. ✅ ウィンドウが表示される
2. ✅ 「モデルをロード中...」→「待機中」に変わる
3. ✅ システムトレイにアイコンが表示される
4. ✅ Ctrl+Shift+Gを押すと画面キャプチャが実行される
5. ✅ LLMが画面を分析する
6. ✅ 音声で説明が再生される

### 2.3 トラブルシューティング

**モデルが読み込めない場合**:
```bash
# ファイルの存在確認
ls -lh llm/models/

# 期待される出力:
# -rw-r--r--  1 user  staff  4.2G  ggml-model-q4_k.gguf
```

**node-llama-cppのエラー**:
```bash
# macOSの場合
xcode-select --install
npm install node-llama-cpp --save --build-from-source

# Windowsの場合
# Visual Studio Build Toolsをインストール
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
npm install node-llama-cpp --save --build-from-source
```

**画面キャプチャの権限エラー（macOS）**:
- システム環境設定 → セキュリティとプライバシー → プライバシー → 画面収録
- Electronアプリを許可

---

## 🎯 ステップ3: カスタマイズ（オプション）

### 3.1 アイコンの作成

```bash
# 512x512pxのPNG画像を作成
# glance-app/build/icon.png に配置
```

オンラインツール:
- https://www.canva.com/
- https://www.figma.com/

### 3.2 設定の調整

`config/app-config.yaml`を編集：

```yaml
app:
  hotkey: CommandOrControl+Shift+G  # 好きなキーに変更
  tts:
    speed: 1.2  # 読み上げ速度を速く
    volume: 0.8 # 音量を下げる
```

### 3.3 プロンプトの調整

`config/model-config.yaml`の`prompt.systemPrompt`を編集して、説明の詳細度を調整できます。

---

## 🎯 ステップ4: ビルド（配布用）

### 4.1 Windows向け

```bash
npm run build:win
```

出力: `dist/Glance-Setup.exe`

### 4.2 macOS向け

```bash
npm run build:mac
```

出力: `dist/Glance.dmg`

### 4.3 コード署名（オプション、推奨）

**Windows**:
- Authenticodeを使用してコード署名
- https://docs.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools

**macOS**:
- Developer IDを使用
- ```bash
  codesign --deep --force --verify --verbose --sign "Developer ID Application: YOUR_NAME" Glance.app
  ```

---

## 🎯 ステップ5: テスト

### 5.1 基本動作テスト

- [ ] アプリが起動する
- [ ] ホットキーが動作する
- [ ] 画面キャプチャが成功する
- [ ] LLMが応答する
- [ ] TTSが音声を出力する

### 5.2 実用テスト

以下のシナリオでテスト：

1. **Teamsミーティング画面**
   - 資料が表示されている画面をキャプチャ
   - 説明が「資料の内容」を含むか確認

2. **Excelグラフ**
   - グラフを含むExcelファイルを開く
   - キャプチャ
   - 「グラフの種類」「データの傾向」が説明されるか確認

3. **Webブラウジング**
   - ニュースサイトを開く
   - キャプチャ
   - 記事のタイトルと要約が説明されるか確認

### 5.3 性能テスト

- 推論時間を測定（15-30秒が目安）
- メモリ使用量を確認
- CPU使用率を確認

---

## 🎯 ステップ6: Windows実機テスト

**重要**: 開発環境がmacOSの場合、Windows環境でのテストが必要です。

### 方法1: 仮想マシン

```bash
# VirtualBoxやParallelsでWindows VMを作成
# ビルドしたGlance-Setup.exeをVMにコピー
# インストールしてテスト
```

### 方法2: Windows PC

- 知人のWindows PCを借りる
- またはWindows実機を用意

### テスト項目

- [ ] インストールが成功する
- [ ] アプリが起動する
- [ ] ホットキーが動作する（Ctrl+Shift+G）
- [ ] TTSがWindows標準音声で動作する
- [ ] 画面キャプチャが動作する

---

## 📊 成功の基準

以下がすべて満たされたら、プロジェクト完成です：

- ✅ モデルが正常にロードされる
- ✅ ホットキーで画面キャプチャが実行される
- ✅ LLMが画面を分析して詳細な説明を生成する
- ✅ TTSが日本語で説明を読み上げる
- ✅ Windows/macOS両方で動作する
- ✅ ビルドしたアプリが配布可能

---

## 🎓 学習リソース

さらなる改善のために：

- [Electron Documentation](https://www.electronjs.org/docs)
- [node-llama-cpp GitHub](https://github.com/withcatai/node-llama-cpp)
- [InternVL Paper](https://arxiv.org/abs/2312.14238)
- [Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

---

**質問があれば、README.md、SETUP_GUIDE.md、llm/models/README.mdを参照してください。**

頑張ってください！🚀
