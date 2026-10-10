# Glance

**Glance は、いま画面に映っているものを AI が読み上げてくれる Windows 用アプリです。**

スクリーンリーダーでは読めない画像・図・レイアウトを、ホットキー一つで日本語の説明にします。
画像は外部に送信されません。AI はパソコンの中だけで動きます（インターネット接続は初回のモデル
ダウンロード時のみ必要です）。

- 完全ローカル動作。スクリーンショットがどこかへ送られることはありません
- 無料・オープンソース（MIT ライセンス）
- 利用登録・アカウント作成は不要です

---

## ダウンロード

利用者向けの案内ページ: <https://panpanpanda7.github.io/Glance/>

[**Glance をダウンロード（Windows 用、zip ファイル、約 115MB）**](https://github.com/panpanpanda7/Glance/releases/latest/download/Glance-Setup.zip)

このリンクを押すと、最新版のインストーラを入れた zip ファイル `Glance-Setup.zip` のダウンロードがすぐに始まります。
GitHub のアカウントやログインは必要ありません。

zip を使えない場合は、[インストーラを直接ダウンロード（Glance-Setup.exe）](https://github.com/panpanpanda7/Glance/releases/latest/download/Glance-Setup.exe)することもできます。
ただし、ブラウザやセキュリティソフトの設定によっては、ダウンロードが途中で止まることがあります。

### 動作条件

- OS: Windows 10 または Windows 11（64ビット）
- メモリ: 8GB 以上
- 空き容量: 約 3GB（アプリ本体と AI モデルの合計）
- インターネット: 初回起動時のみ必要（AI モデルのダウンロードのため）

グラフィックス機能があれば自動的に使用して高速化します。無い場合も CPU で動作します。

### インストール手順

1. 上のリンクから `Glance-Setup.zip` をダウンロードします。
2. ダウンロードした zip ファイルを選んでアプリケーションキー（または右クリック）を押し、
   「すべて展開」を選びます。続いて「展開」ボタンを押します。
3. 展開してできたフォルダーの中の `Glance-Setup.exe` を実行します。
4. **「WindowsによってPCが保護されました」という青い画面が出た場合**、次の操作で進めてください。
   これは、開発者証明書を購入していない個人開発のアプリすべてに出る警告で、
   Glance に問題があるという意味ではありません。
   - 「詳細情報」というリンクを押します（スクリーンリーダーではリンクとして読まれます）
   - 表示された「実行」ボタンを押します
5. インストールが終わると、デスクトップとスタートメニューに Glance が追加されます。
6. 初回起動時に、AI モデル（約 1.9GB）をダウンロードするか確認します。
   進捗は音声で案内されます。回線によっては 5〜30 分ほどかかります。
   2回目以降の起動ではダウンロードは発生しません。

新しい版が出ると自動で更新されます。
操作は必要ありません。

---

## 使い方

インストール後は常駐します。どのアプリを使っているときでも、次のキーが使えます。

| キー | 動作 |
|---|---|
| `Ctrl + Shift + G` | いまの画面を説明する |
| `Ctrl + Shift + F` | 何の画面かだけを、ひとことで伝える（いちばん早く言い終わる） |
| `Ctrl + Shift + D` | 直前に説明した画面を、さらに詳しく説明する |
| `Ctrl + Shift + Q` | 直前の画面について質問する |
| `Ctrl + Shift + P` | 画面を先に取り込んでおく（読み上げはしない） |

`Ctrl + Shift + P` は、これから説明させたい画面を先に取り込んでおく機能です。
取り込みだけ済ませておくと、`Ctrl + Shift + D` や `Ctrl + Shift + Q` の応答が速くなります。

---

## うまく動かないときは

- **キーを押しても何も言わない** … 他のアプリが同じキーを使っている可能性があります。
  一度 Glance を終了して起動し直してください。
- **起動が遅い** … 初回はモデルの読み込みに 30 秒〜数分かかります。
- **セキュリティソフトに止められた** … AI の実行ファイルが誤検知されることがあります。
  Glance のインストール先を除外設定に追加してください。

解決しない場合は、Glance の画面の右上にある「ご意見を送る」から知らせてください（GitHub のアカウントは不要です）。
Glance が起動しないときは [ご意見・不具合の送信フォーム](https://docs.google.com/forms/d/e/1FAIpQLSdWVYUHsIb-B-35mfaPNddtYoOsTRok1CKnpYhg4sfBNIKNHg/viewform) から送れます。

---

## 開発者向け

### 構成

```
glance-pyapp/
  electron/         Electron 製のフロントエンド（ホットキー・画面取得・読み上げ）
  python-backend/   Flask の API サーバー（llama-server.exe を子プロセスとして起動）
```

推論そのものは llama.cpp の `llama-server.exe` が別プロセスで行い、Python 側は
REST で叩くだけです。そのため Python 側に推論ライブラリは要りません。

使用モデルは `python-backend/config.yaml` の `activeModel` で切り替えます
（既定は Qwen3.5-2B の GGUF 量子化版。低スペックの仕事PCでも実用速度で動くことを
優先しています。精度重視の Qwen3-VL-4B は `set GLANCE_MODEL=qwen3-vl-4b-server` で
起動時に切り替えられます）。

### 依存関係の分け方

`requirements.txt` は実行時の依存（flask / pillow / requests / pyyaml / psutil）だけを
書いています。ここに書いたものは PyInstaller ですべてインストーラに同梱されます。
**実際に import されないものを足さないでください。**

同様に `python-backend/glance.spec` の `excludes` に torch / transformers /
llama_cpp などを列挙しています。開発環境にインストールされていても、
インストーラには入りません。

### モデルを差し替えるとき

`config.yaml` のダウンロード URL は `resolve/main/` ではなく**コミットを直接指しています**。
`main` のままだと、上流が再量子化した瞬間に「検証した重み」と「利用者が落とす重み」が
黙って食い違います。

差し替え手順:

1. 対象リビジョンとチェックサムを調べます。

   ```bash
   REPO=unsloth/Qwen3.5-2B-GGUF
   REV=$(curl -s "https://huggingface.co/api/models/$REPO" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
   curl -sIL "https://huggingface.co/$REPO/resolve/$REV/<ファイル名>" | grep -i "x-linked-etag\|x-linked-size"
   ```

   `x-linked-etag` が SHA-256、`x-linked-size` がバイト数です。

2. `config.yaml` に**別エントリとして**追加します（`activeModel` はまだ変えない）。
   `download_url` / `mmproj_download_url` の revision と、`sha256` / `size` /
   `mmproj_sha256` / `mmproj_size` を必ずセットで書きます。
3. `GLANCE_MODEL` 環境変数で切り替えて、速度と精度を検証します。
4. 良ければ `activeModel` を切り替えてタグを打ちます。

ダウンロードは `.part` へ書いてから SHA-256 とサイズを検証し、通ったものだけを
本来の名前へ差し替えます。起動時にはサイズだけを見て破損を検出します
（2〜3GB の SHA-256 を毎回計算すると起動が数十秒延びるため）。

### セットアップ

```bash
cd glance-pyapp/python-backend
python3 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate.bat
pip install -r requirements.txt

cd ../electron
npm install
npm run dev
```

この起動方法では `app.isPackaged` が false になるため、自動更新は動作しません。

### リリース

1. `glance-pyapp/electron/package.json` の `version` を上げます（semver。先頭ゼロ不可）
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. GitHub Actions（`.github/workflows/build-windows.yml`）が Windows ランナーで
   llama-server の取得 → PyInstaller → electron-builder まで行い、
   インストーラと `latest.yml` を Releases へ添付します

`latest.yml` が electron-updater の更新元です。これが欠けると自動更新が止まります。

リリース本文は CI が組み立てます。先頭にダウンロード案内（対象ファイル名と恒久リンク）を
日本語で置き、その後ろに GitHub の自動生成の変更履歴が付きます。利用者向けの変更点を
書きたいときは `docs/release-notes/vX.Y.Z.md` を用意してください。あれば案内の直後に
差し込まれます。自動生成のコミット一覧をそのまま先頭に出さないための仕組みです。

インストーラは `Glance-Setup-X.Y.Z.exe` として作られ、CI が `Glance-Setup.exe` という
バージョン無しの複製も一緒に添付します。README のダウンロードリンクはこちらを指している
ため、リリースのたびに書き換える必要はありません。

### API

バックエンドは `http://127.0.0.1:5001` で待ち受けます。

| エンドポイント | 用途 |
|---|---|
| `GET /health` | 死活確認 |
| `GET /status` | 起動状態とモデルのダウンロード進捗 |
| `POST /analyze` | 画像（Base64）または `imageId` を渡して説明を生成 |

---

## ライセンス

MIT License（[LICENSE](LICENSE)）

インストーラに含まれる第三者ソフトウェアのライセンスは
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) にあります。
