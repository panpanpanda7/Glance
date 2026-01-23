# Glance PyApp セットアップ手順

以下に、Glance PyAppをセットアップし、実行するための手順を示します。

## 問題解決済み

以下の問題は修正済みです：

1. モデルパスの問題（`../models/InternVL2.5-4B` → `./models/InternVL2.5-4B`）
2. ポート競合の問題（5000 → 5001に変更）
3. モデルローダーの改良（`local_files_only=True`を追加）

## セットアップ手順

### 1. モデルを確認

モデルは既に正しい場所にダウンロードされているようです：
```
glance-pyapp/python-backend/models/InternVL2.5-4B/
```

### 2. Python環境をセットアップ

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend

# macOSの場合
chmod +x setup-dev.sh
./setup-dev.sh

# Windowsの場合
setup-dev.bat
```

### 3. アプリを起動

#### 3.1 Python Backend

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend

# 仮想環境を有効化
source venv/bin/activate  # macOS/Linux
venv\Scripts\activate.bat  # Windows

# Flaskサーバー起動
python app.py
```

以下の出力が表示されるはずです：

```
============================================================
🚀 Glance Python Backend 起動中...
============================================================

✅ 設定ファイル読み込み成功

============================================================
📦 モデルをロード中: internvl-4b
============================================================

🖥️  デバイス: cpu
📦 InternVLをロード中: /Users/takeshi/Project/Glance/glance-pyapp/python-backend/models/InternVL2.5-4B
⏳ 初回ロードには数分かかる場合があります...
✅ InternVLのロードが完了しました
   デバイス: cpu
   モデルサイズ: X.XX GB

============================================================
🌐 Flask サーバーを起動: http://127.0.0.1:5001
============================================================
```

#### 3.2 Electron Frontend

新しいターミナルを開いて：

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/electron

# 初回のみ
npm install

# 開発モードで起動
npm run dev
```

## 機能テスト

1. Electronウィンドウが起動し、「待機中」（緑色のドット）と表示されるのを確認
2. 「画面を読み上げ」ボタンをクリックするか、`Cmd+Shift+G`（macOS）/`Ctrl+Shift+G`（Windows）ホットキーを押す
3. 画面キャプチャ後、画像分析が始まり（15-30秒かかります）、結果が音声で読み上げられます

## トラブルシューティング

### Python Backendが起動しない場合

1. `venv`が正しく作成されているか確認
   ```bash
   ls -la venv  # venvディレクトリがあるか確認
   ```

2. もし`venv`がなければ、セットアップスクリプトを再実行
   ```bash
   chmod +x setup-dev.sh
   ./setup-dev.sh
   ```

### 「モデルのロードに失敗」エラーが出る場合

1. モデルのパスが正しいことを確認
   ```
   ls -la ./models/InternVL2.5-4B/
   ```

2. モデルファイルの権限を確認
   ```
   chmod -R 755 ./models/InternVL2.5-4B/
   ```

### ポートがまだ使用中の場合

1. config.yamlでポート番号を変更（例：5002）
2. main.jsでも同じポート番号に変更
3. 占有しているプロセスを特定して終了：
   ```bash
   # macOS
   sudo lsof -i :5001
   # 表示されたPIDのプロセスを終了
   kill -9 <PID>
   ```

## 次のステップ

1. ✅ 設定ファイルとモデルローダーの修正
2. ✅ ポート競合の解決
3. ⏳ セットアップテスト
4. ⏳ 精度検証
5. ⏳ 26Bモデルへの切り替え（高精度）
