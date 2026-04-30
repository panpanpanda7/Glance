# Windows環境でのメモリ不足エラー修正

## 問題の概要

Windows環境でGlanceアプリをexeファイルに変換して実行した際、以下のエラーが発生していました：

```
RuntimeError: ❌ llama-server が起動しません（タイムアウト）
```

### ログの分析結果

**主要な問題：メモリ不足**

```
ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 6341787648
llama_init_from_model: failed to initialize the context: failed to allocate buffer for kv cache
```

- **システムメモリ**: 約 8GB（8188 MiB）
- **モデルが要求するメモリ**: 約 38GB（38385 MiB）
- **KVキャッシュのメモリ確保失敗**: 約 6GB

**軽微な問題：`--log-level`引数エラー**

```
error: invalid argument: --log-level
```

古いインストール先に残っているllama-serverプロセスが非標準の引数を使用していた可能性があります。

---

## 実施した修正

### 1. **`qwen3_vl_server.py`の修正**

コンテキストサイズを明示的に制限するパラメータを追加しました。

#### 変更内容：

- **`__init__`メソッド**: `ctx_size`パラメータを追加（デフォルト値: 8192）
- **`_start_server`メソッド**: llama-server起動時に`--ctx-size`フラグを追加

```python
cmd = [
    server_binary,
    "-m", self.model_path,
    "--mmproj", self.mmproj_path,
    "--host", self.server_host,
    "--port", str(self.server_port),
    "--ctx-size", str(self.ctx_size)  # ← 新規追加
]
```

### 2. **`config.yaml`の修正**

`qwen3-vl-4b-server`モデル設定に`ctx_size`オプションを追加しました：

```yaml
qwen3-vl-4b-server:
  # ... 既存設定 ...
  ctx_size: 8192  # コンテキストサイズ（8GB RAM環境向け。4GB RAMの場合は4096を推奨）
```

### 3. **`app.py`の修正**

モデルロード時に、config.yamlから`ctx_size`を読み込みQwen3VLServerModelに渡すようにしました：

```python
ctx_size = active_model_config.get('ctx_size', 8192)
print(f"      コンテキストサイズ: {ctx_size}")

current_model = Qwen3VLServerModel(
    # ... その他のパラメータ ...
    ctx_size=ctx_size
)
```

---

## 推奨設定値

システムメモリに応じて、`config.yaml`の`ctx_size`を調整してください：

| システムメモリ | 推奨`ctx_size` | メモリ使用量概算 |
|---------------|---------------|-----------------|
| 4GB           | 4096          | 3-4GB          |
| 8GB           | 8192          | 6-7GB          |
| 16GB以上      | 16384         | 12-14GB        |

**注意**: コンテキストサイズを大きくすると、より長い会話履歴やコンテキストを扱えますが、メモリ使用量が増加します。

---

## テスト方法

1. **`config.yaml`を編集**（オプション）
   ```yaml
   ctx_size: 8192  # または 4096（4GB RAM の場合）
   ```

2. **アプリケーションを再起動**

3. **llama-server が正常に起動するか確認**
   - ログに以下が表示されていればOK:
   ```
   ✅ llama-server が起動完了しました
   ```

---

## トラブルシューティング

### まだメモリエラーが発生する場合

1. **古いインストールの削除**
   ```
   C:\Program Files\Glance\  ← 古いインストール先がある場合は削除
   ```

2. **`ctx_size`をさらに小さくする**
   - `config.yaml`で`ctx_size: 4096`に変更

3. **タスクマネージャーで確認**
   - メモリ使用率が100%近い場合は、他のアプリケーションを終了

### `--log-level`エラーが続く場合

1. **プロセスを完全に終了**
   - タスクマネージャーで `llama-server.exe` を強制終了

2. **ログファイルをクリア**
   ```
   C:\Users\<ユーザー名>\AppData\Roaming\Glance\logs\llama-server.log
   ```

---

## 変更ファイル一覧

- `glance-pyapp/python-backend/models/qwen3_vl_server.py`
  - `__init__`メソッドに`ctx_size`パラメータを追加
  - `_start_server`メソッドで`--ctx-size`フラグを追加

- `glance-pyapp/python-backend/config.yaml`
  - `qwen3-vl-4b-server`設定に`ctx_size: 8192`を追加

- `glance-pyapp/python-backend/app.py`
  - `initialize_system`関数で`ctx_size`を読み込みモデルに渡すように修正

---

## 参考情報

- **llama.cpp公式リポジトリ**: https://github.com/ggerganov/llama.cpp
- **コンテキストサイズについて**: より大きなコンテキストサイズは、より多くのメモリを使用します。
