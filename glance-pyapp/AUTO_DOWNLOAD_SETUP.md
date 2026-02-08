# 自動モデルダウンロード機能 セットアップガイド

アプリ初回起動時に自動でAIモデルをダウンロードする機能を実装しました。

## 📋 実装内容

### 1. **app.py** - バックエンドのダウンロード機能

以下の機能を追加しました：

- **`get_writable_model_path()`**: OSに応じた適切なモデル保存先を決定
  - Windows: `%APPDATA%/Glance/models`
  - macOS: `~/Library/Application Support/Glance/models`
  - Linux: `~/.local/share/Glance/models`
  - 開発環境: `models/gguf`

- **`download_file()`**: 進捗状況を追跡しながらファイルをダウンロード
  - リアルタイムで進捗率を更新
  - 10%刻みでログ出力

- **`initialize_system()`**: バックグラウンド初期化処理
  - モデルファイルの存在確認
  - 存在しない場合は自動ダウンロード
  - モデルのロード

- **`/status` エンドポイント**: Electronからポーリングできる状態API
  - `status`: initializing, downloading, loading_model, ready, error
  - `progress`: 0-100のダウンロード進捗
  - `message`: ステータスメッセージ
  - `detail`: 詳細情報（進捗率、サイズなど）

### 2. **renderer.js** - フロントエンドの状態監視

以下の機能を追加しました：

- **`checkSystemStatus()`**: 2秒ごとにバックエンドの状態をポーリング
- **視覚的フィードバック**: ステータスドットの色とテキストを更新
- **音声フィードバック**: 10%刻みで進捗を音声で通知
  - 「準備中、10パーセント完了」
  - 「ダウンロード完了。AIを起動しています。」
  - 「準備が完了しました。Glanceを使用できます。」

### 3. **glance.spec** - PyInstallerビルド設定

モデルファイルを含まない軽量なビルド設定：

- 必要なPythonモジュールのみをバンドル
- `config.yaml`と`.py`ファイルのみを含める
- 実際のモデルファイル（.gguf）は除外

### 4. **build-windows.yml** - GitHub Actions自動ビルド

Windows用インストーラーを自動生成：

- タグプッシュ時に自動実行（例: `v1.0.0`）
- 手動実行も可能（`workflow_dispatch`）
- PyInstallerでPythonバックエンドをビルド
- Electron Builderでインストーラーを生成
- Releaseページに自動アップロード

## 🚀 使用方法

### モデルURLの設定

`app.py`の冒頭でダウンロードするモデルのURLを設定してください：

```python
MODEL_DOWNLOAD_URL = "https://huggingface.co/bartowski/OpenGVLab_InternVL3_5-4B-GGUF/resolve/main/OpenGVLab_InternVL3_5-4B-Q4_K_M.gguf?download=true"
MMPROJ_DOWNLOAD_URL = "https://huggingface.co/bartowski/OpenGVLab_InternVL3_5-4B-GGUF/resolve/e9319b553f22bd6e3bae10cff2e50985c1ab1d1a/mmproj-OpenGVLab_InternVL3_5-4B-f16.gguf?download=true"
```

⚠️ **注意**: 必ず`/resolve/main/`を含む直リンクを使用してください。

### リリースの作成方法

1. コードをコミット＆プッシュ：
```bash
git add .
git commit -m "自動モデルダウンロード機能を実装"
git push origin main
```

2. リリースタグを作成してプッシュ：
```bash
git tag v1.0.0
git push origin v1.0.0
```

3. GitHubの「Actions」タブでビルド進行状況を確認

4. 完了後、「Releases」ページにインストーラーが公開されます

### ローカルでのテスト

開発環境で動作確認する場合：

```bash
cd glance-pyapp/python-backend
python app.py
```

初回起動時に自動的にモデルがダウンロードされます。

## 📦 ファイル構成

```
Glance/
├── .github/
│   └── workflows/
│       └── build-windows.yml      # GitHub Actions設定
├── glance-pyapp/
│   ├── python-backend/
│   │   ├── app.py                 # ダウンロード機能を実装
│   │   ├── glance.spec            # PyInstallerビルド設定
│   │   └── config.yaml
│   └── electron/
│       └── renderer.js            # 状態監視機能を実装
└── AUTO_DOWNLOAD_SETUP.md         # このファイル
```

## 🎯 ユーザー体験

### アプリ初回起動時の流れ

1. **起動**: ユーザーがアプリを起動
2. **状態表示**: 「起動準備中...」と表示
3. **ダウンロード開始**: 「AIモデルをダウンロードしています... 0%」
4. **進捗通知**: 10%, 20%, 30%...と音声で進捗を通知
5. **モデルロード**: 「AIを起動しています...」
6. **完了**: 「準備が完了しました。Glanceを使用できます。」

### 2回目以降の起動

モデルは既にダウンロード済みなので、すぐにロードして起動完了します。

## 🔧 トラブルシューティング

### ダウンロードが失敗する場合

- インターネット接続を確認
- ファイアウォール設定を確認
- モデルURLが正しいか確認（Hugging Faceのリンク）

### 保存先の権限エラー

Windowsの場合、`%APPDATA%`フォルダへのアクセス権限を確認してください。

### GitHub Actionsのビルドが失敗する場合

- `requirements.txt`に必要な依存関係がすべて含まれているか確認
- `glance.spec`のパス設定が正しいか確認
- GitHubリポジトリの設定で「Actions」が有効になっているか確認

## 📝 今後の拡張案

- [ ] 複数モデルの選択機能
- [ ] ダウンロード一時停止・再開機能
- [ ] キャッシュクリア機能
- [ ] 更新チェック機能
- [ ] オフラインモードのサポート

## 🔗 関連リンク

- [PyInstaller ドキュメント](https://pyinstaller.org/)
- [GitHub Actions ドキュメント](https://docs.github.com/ja/actions)
- [Electron Builder](https://www.electron.build/)
- [InternVL モデル](https://huggingface.co/OpenGVLab)

---

**作成日**: 2026/02/05  
**作成者**: Glance開発チーム
