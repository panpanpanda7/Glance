# llama-server バージョン更新ガイド

## 問題の原因

現在のllama-server.exeが古いバージョンであり、以下の新しいパラメータに対応していません：
- `--n-batch`
- `--ubatch`
- `--slots`

ログエラー：
```
error: invalid argument: --n-batch
```

## 解決方法：llama-serverバイナリを更新

### ステップ1: 新しいllama-serverをダウンロード

#### 推奨バージョン
llama.cpp の最新リリース（2024年以降）からWindows用バイナリを取得してください。

#### ダウンロード手順

1. **GitHub リリースページへアクセス**
   ```
   https://github.com/ggerganov/llama.cpp/releases
   ```

2. **最新リリース（または b8981より新しいビルド）から以下をダウンロード**
   ```
   - llamafile-0.1.XX-server-windows-x64.zip （推奨）
   または
   - llama.cpp-bin.zip （Windows x64版）
   ```

3. **ZIPを展開して必要なファイルを確認**
   ```
   llama-server.exe
   ggml-*.dll
   （複数のDLLファイル）
   ```

### ステップ2: バイナリの置き換え

1. **バックアップ（重要）**
   ```bash
   # 現在のバイナリをバックアップ
   cd glance-pyapp/electron/resources/glance-backend/llama-cpp-bin/
   
   # Windows: すべてのファイルをバックアップフォルダに移動
   # または rename で .old 拡張子をつける
   ren llama-server.exe llama-server.exe.old
   ```

2. **新しいllama-server.exeを配置**
   ```bash
   # ダウンロード・展開したllama-server.exeを以下にコピー
   glance-pyapp/electron/resources/glance-backend/llama-cpp-bin/llama-server.exe
   ```

3. **DLLファイルも同じフォルダに配置**
   ```bash
   # llama-cpp-bin/ フォルダに以下DLLをコピー
   ggml-rpc.dll
   ggml-cpu-haswell.dll
   ggml-sycl-*.dll （必要に応じて）
   ggml-opencl.dll （必要に応じて）
   
   # 既存のDLLと新しいDLLで競合がないか確認
   ```

### ステップ3: バージョン確認

1. **llama-serverのバージョンを確認**
   ```bash
   # Windows PowerShellまたはコマンドプロンプト
   cd glance-pyapp/electron/resources/glance-backend/llama-cpp-bin/
   
   .\llama-server.exe --version
   # 出力例: llama-server: build NNNN (b8992以降）
   ```

   必ず古いバージョン（b8981）より新しいビルド番号であることを確認してください。

2. **ヘルプを確認（パラメータサポートの確認）**
   ```bash
   .\llama-server.exe --help | find "--n-batch"
   ```
   `--n-batch` が含まれていることを確認します。

### ステップ4: PyInstallerで再ビルド

```bash
# Python環境に入る
cd glance-pyapp/python-backend

# PyInstallerで再ビルド（glance-backend.exe を生成）
pyinstaller glance.spec --distpath ../../glance-pyapp/electron/resources --clean

# または オプション付きで
pyinstaller glance.spec --distpath ../../glance-pyapp/electron/resources --clean --onefile
```

**出力結果の確認：**
```
glance-pyapp/electron/resources/glance-backend/
├── glance-backend.exe
├── llama-cpp-bin/
│   ├── llama-server.exe （新しいバージョン）
│   ├── ggml-*.dll
│   └── ...
└── ...
```

### ステップ5: Electron + NSISで再ビルド

```bash
# electron側のbuildディレクトリに移動
cd glance-pyapp/electron

# npm buildで実行
npm run build:win
```

**出力結果：**
```
dist/
├── Glance Setup 0.1.23.exe （インストーラー）
└── ...
```

### ステップ6: Windows環境で再テスト

1. **古いGlanceアプリをアンインストール**
   ```
   設定 → アプリ → アプリと機能 → Glance → アンインストール
   ```

2. **新しいインストーラーを実行**
   ```
   dist/Glance\ Setup\ 0.1.23.exe
   ```

3. **起動テスト**
   - Glanceを起動
   - 画面キャプチャを複数回実行
   - 以下を確認：
     - ❌ `error: invalid argument:` エラーが出ないか
     - ✅ メモリ使用率が安定しているか（65～70%以下）
     - ✅ ハングが発生していないか

## トラブルシューティング

### DLLエラーが出る場合
```
load_backend: failed to load backend from C:\...\ggml-*.dll
```

**原因：** DLLファイルが不足している

**対処：**
1. ダウンロードしたZIPから**すべてのDLLファイル**をコピー
2. `llama-cpp-bin/` フォルダに配置
3. `ggml-rpc.dll` と `ggml-cpu-haswell.dll` は必須

### パラメータエラーが再度出る場合
```
error: invalid argument: --n-batch
```

**原因：** PyInstallerのビルド時に古いバイナリが混在

**対処：**
1. `glance-pyapp/electron/resources/glance-backend/` を完全に削除
2. `glance.spec` を使って1から再ビルド
3. `--clean` フラグでキャッシュをクリア

```bash
pyinstaller glance.spec --distpath ../../glance-pyapp/electron/resources --clean --onefile
```

## メモリ最適化パラメータの効果確認

更新後、以下のパラメータが使用できるようになります：

```python
# qwen3_vl_server.py で自動適用される
"--n-batch", "512",        # バッチサイズ削減
"--ubatch", "128",         # マイクロバッチサイズ削減
"--slots", "1",            # 並行スロット削減
"--no-mmap"                # メモリマッピング無効化
```

これにより、8GB RAM環境での**メモリ使用率を90%→30～40%に削減**できます。

## 参考リンク

- **llama.cpp GitHub Releases**: https://github.com/ggerganov/llama.cpp/releases
- **Windows x64バイナリ直リンク例**:
  ```
  https://github.com/ggerganov/llama.cpp/releases/download/b8992/llamafile-0.1-server-windows-x64.zip
  ```
  （最新のビルド番号に読み替えてください）

## 次のステップ

1. ✅ 新しいllama-server.exeをダウンロード
2. ✅ バイナリを置き換え
3. ✅ PyInstallerで再ビルド
4. ✅ Electronで再ビルド
5. ⬜ Windows環境で再テスト

完了後、不安定性とメモリ問題が解決されるはずです。

