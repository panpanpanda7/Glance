# 新しいexeの生成ガイド（llama-server自動ダウンロード対応）

## 修正内容の確認

以下の3つのファイルが修正されています：

1. **app.py** - llama-server自動ダウンロード関数を追加
   - `get_llama_server_path()`: ダウンロード先を決定
   - `download_llama_server()`: GitHub Releasesから最新版をダウンロード・解凍

2. **qwen3_vl_server.py** - バイナリ探索を修正
   - `_find_server_binary()`: 自動ダウンロード済みバイナリを最優先で探索

3. **config.yaml** - YAML構文とメモリ設定を修正
   - インデント修正: 3スペース → 2スペース
   - `ctx_size: 4096` 追加（8GB RAM向け）

## exeファイル生成手順

### ステップ1: Python環境のセットアップ

```bash
cd glance-pyapp/python-backend

# 仮想環境に入る（既に作成されている場合）
source venv/bin/activate  # Linux/Mac
# または
venv\Scripts\activate  # Windows

# 依存関係が最新か確認
pip install -r requirements.txt
pip install pyinstaller
```

### ステップ2: PyInstallerでビルド

```bash
# glance.spec を使用してビルド
pyinstaller glance.spec --distpath ../../glance-pyapp/electron/resources --clean

# 出力結果:
# glance-pyapp/electron/resources/glance-backend/
# ├── glance-backend.exe
# ├── llama-cpp-bin/
# │   ├── ggml-rpc.dll
# │   ├── ggml-cpu-haswell.dll
# │   └── ...
# └── (その他のファイル)
```

### ステップ3: Electronアプリケーションをビルド

```bash
cd glance-pyapp/electron

# npm パッケージをインストール（初回のみ）
npm install

# Windows用インストーラーをビルド
npm run build:win

# 出力結果:
# dist/Glance Setup 0.1.23.exe
```

### ステップ4: Windows環境でテスト

1. **古いGlanceをアンインストール**
   ```
   コントロールパネル → プログラムと機能 → Glance → アンインストール
   ```

2. **新しいインストーラーを実行**
   ```
   dist/Glance\ Setup\ 0.1.23.exe
   ```

3. **動作確認**
   - Glanceを起動
   - 初回起動時に `llama-server` が自動ダウンロードされるか確認
   - ログ出力で以下が表示されることを確認：
     ```
     📥 llama-server をダウンロード中: https://github.com/ggerganov/llama.cpp/releases/download/b8992/...
     📦 llama-server を解凍中...
     ✅ llama-server のセットアップ完了
     ```
   - 画面キャプチャを複数回実行して安定性を確認

## 重要な注意点

### ダウンロード先

Windows環境でのllama-serverダウンロード先：
```
C:\Users\<ユーザー名>\AppData\Roaming\Glance\llama-server\
```

初回起動時に以下がダウンロードされます：
- `llama-server.exe` (約100MB)
- 各種DLLファイル

### パフォーマンス

- **初回起動**: llama-serverのダウンロード・解凍により、通常より時間がかかります（3～5分程度）
- **2回目以降の起動**: 通常速度で起動

### トラブルシューティング

#### ダウンロード失敗時
```
❌ llama-server のダウンロードに失敗: ...
```
→ インターネット接続を確認してください

#### DLLエラー時
```
load_backend: failed to load backend from ...dll
```
→ ZIP解凍に失敗した可能性。`AppData\Roaming\Glance\llama-server\` を削除して再起動

#### ダウンロード済みなのに古いバージョンが使用される場合
```
🔄 自動ダウンロード済みllama-server...
❌ 見つかりません
```
→ `AppData\Roaming\Glance\llama-server\` フォルダが存在するか確認

## exeファイル配布

新しいexeファイルをリリースする際：

```bash
# ファイル名例
Glance-0.1.23-auto-download.exe

# または単に
Glance-0.1.23.exe
```

GitHubのReleasesページにアップロードしてください。

## 変更点のまとめ

| 項目 | 変更内容 |
|------|--------|
| **llama-server配信** | exeに同梱 → 自動ダウンロード |
| **初回起動時間** | 数秒 → 3～5分（ダウンロード時） |
| **メンテナンス性** | 高い（バージョン更新時は新exeをリリースするだけ） |
| **ユーザー操作** | 不要（完全自動） |
| **exeファイルサイズ** | 約50MB削減（llama-server除外で） |

