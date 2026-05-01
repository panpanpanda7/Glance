# llama-server 自動ダウンロード実装ガイド

## 現在の問題

exeに同梱されている古いllama-serverバイナリを新しいバージョンに更新するには、現在は**手動**でバイナリを置き換える必要があります。

## 解決方法：自動ダウンロード機能の実装

モデルファイル（Qwen3VL-4B等）と同様に、llama-serverも初回起動時に自動ダウンロード・更新される仕組みを実装します。

### 実装概要

1. **app.pyの修正**
   - `download_file()` 関数を使用して、llama-serverをダウンロード
   - ダウンロード先：`~/.Glance/llama-server/`（OS別に設定）
   - バージョン確認と自動更新

2. **qwen3_vl_server.pyの修正**
   - `_find_server_binary()` でダウンロード済みバイナリを優先検索
   - exeに同梱されたバイナリは **フォールバック** のみ

3. **パッケージング戦略の変更**
   - exeファイル内には古いllama-serverを同梱しない（サイズ削減）
   - または: 同梱バイナリをプレースホルダー化

### 実装ステップ

#### ステップ1: `app.py`にダウンロード関数を追加

```python
def download_llama_server():
    """llama-serverの最新バージョンを自動ダウンロード"""
    llama_server_dir = get_llama_server_path()
    llama_server_exe = os.path.join(llama_server_dir, 'llama-server.exe')
    
    # バージョンチェック
    current_version = get_llama_server_version(llama_server_exe)
    latest_version = "b8992"  # または更新チェック機能を実装
    
    if current_version < latest_version or not os.path.exists(llama_server_exe):
        # ダウンロード
        url = "https://github.com/ggerganov/llama.cpp/releases/download/b8992/llamafile-0.1-server-windows-x64.zip"
        download_file(url, ..., "llama-server")
        # 解凍・配置処理
```

#### ステップ2: `qwen3_vl_server.py`の`_find_server_binary()`を修正

```python
def _find_server_binary(self) -> Optional[str]:
    """優先順位：
    1. ダウンロード済みバイナリ（AppData/Roaming/Glance/llama-server/）
    2. exeに同梱されたバイナリ（フォールバック）
    3. システムPATH
    """
```

#### ステップ3: `pyinstaller`ビルド時の設定

- exeファイルサイズを削減するため、古いllama-serverは除外
- または: プレースホルダー版を同梱（数MBサイズ）

### 利点

- ✅ exeを実行するだけで自動更新
- ✅ ユーザー操作なし
- ✅ exeファイルサイズ削減（llama-server除外で50MB以上削減可能）
- ✅ 今後のバージョン更新が容易

### 実装工数

- **app.py修正**: 1～2時間
- **qwen3_vl_server.py修正**: 30分
- **テスト**: 1時間
- **PyInstaller再設定**: 1時間

**合計**: 半日程度

## 推奨実装手順

1. `app.py`に`download_llama_server()`関数を実装
2. `qwen3_vl_server.py`の`_find_server_binary()`を修正
3. `initialize_system()`で初回ダウンロードをチェック
4. PyInstallerから古いllama-serverを除外
5. テスト & リリース

## その他の検討事項

### セキュリティ

- ✅ GitHub Releases からのダウンロードは安全
- バージョン確認で悪意あるバージョンダウンロードを防止

### ネットワーク

- インストール初回時にはインターネット接続が必要
- オフラインインストールには対応しない（モデルファイルと同様）

### ロールバック

- 古いバージョンはバックアップフォルダに保存
- トラブル時は手動で旧バージョンに戻せるように

