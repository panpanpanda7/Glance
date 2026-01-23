# 依存関係インストール手順

InternVL 2.5モデルを実行するための追加依存関係をインストールする手順です。

## 新たに追加された依存関係

```
einops>=0.6.0
timm>=0.6.13
```

これらのライブラリは、InternVLモデルのビジョントランスフォーマー部分で必要とされる依存関係です。

## インストール手順

### 方法1：依存関係の再インストール（推奨）

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend

# 仮想環境が有効でない場合は有効化
source venv/bin/activate  # macOS/Linux
# または
venv\Scripts\activate.bat  # Windows

# 更新されたrequirements.txtから依存関係をインストール
pip install -r requirements.txt
```

### 方法2：必要なパッケージだけをインストール

既存の環境を維持したまま、不足しているパッケージだけを追加する場合：

```bash
cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend
source venv/bin/activate  # または Windows の場合は venv\Scripts\activate.bat

pip install einops>=0.6.0 timm>=0.6.13
```

## 設定の変更点

以下の変更を行いました：

1. モデルパスを絶対パスに変更：
   ```
   path: /Users/takeshi/Project/Glance/glance-pyapp/python-backend/models/InternVL2.5-4B
   ```

2. 依存関係を追加：
   ```
   einops>=0.6.0
   timm>=0.6.13
   ```

## 実行手順

依存関係をインストールした後、以下の手順でアプリケーションを起動してください：

1. Pythonバックエンドを起動：
   ```bash
   cd /Users/takeshi/Project/Glance/glance-pyapp/python-backend
   source venv/bin/activate
   python app.py
   ```

2. 別のターミナルでElectronフロントエンドを起動：
   ```bash
   cd /Users/takeshi/Project/Glance/glance-pyapp/electron
   npm run dev
   ```

## トラブルシューティング

依存関係のインストールが失敗する場合：

```bash
# Pythonのバージョンを確認
python --version  # 3.11以上が推奨

# pipを更新
pip install --upgrade pip

# 一時的なキャッシュをクリア
pip cache purge

# 再度インストール
pip install -r requirements.txt
