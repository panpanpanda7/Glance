# GitHub Actions ビルド効率化ガイド

## 現在の問題
- **ビルド時間**: 20分以上
- **コスト**: 1回のエラーで20分待機
- **開発効率**: イテレーションが遅い

## 効率化方案

### 方案1: ローカルコード検査（推奨）

#### A. Python構文チェック
```bash
# 1. flake8をインストール
pip install flake8

# 2. app.pyをチェック
flake8 glance-pyapp/python-backend/app.py \
  --max-line-length=200 \
  --ignore=E501,W503,E402

# 3. モデルファイルをチェック
flake8 glance-pyapp/python-backend/models/
```

#### B. importチェック
```bash
# 1. isortをインストール
pip install isort

# 2. importの重複・未使用を検査
isort --check-only glance-pyapp/python-backend/
python -m py_compile glance-pyapp/python-backend/app.py
```

#### C. 型チェック
```bash
# 1. mypyをインストール
pip install mypy

# 2. 型チェック実行
mypy glance-pyapp/python-backend/app.py --ignore-missing-imports
```

### 方案2: 事前チェックスクリプト

**ファイル: `glance-pyapp/python-backend/check.sh`**
```bash
#!/bin/bash
set -e

echo "🔍 Python構文チェック..."
python -m py_compile app.py
python -m py_compile models/*.py

echo "✅ チェック完了"
exit 0
```

**使用方法:**
```bash
cd glance-pyapp/python-backend
bash check.sh  # ビルド前に実行
```

### 方案3: GitHub Actions最適化

#### キャッシング戦略
```yaml
# .github/workflows/build.yml（抜粋）
- name: キャッシュPython依存関係
  uses: actions/cache@v3
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('**/requirements.txt') }}
    restore-keys: |
      ${{ runner.os }}-pip-

- name: キャッシュNode依存関係
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
```

#### 並列ビルド
```yaml
# Python + Node同時ビルド
jobs:
  check:
    runs-on: macos-latest
    steps:
      - name: Python構文チェック
        run: |
          python -m py_compile glance-pyapp/python-backend/app.py
          python -m py_compile glance-pyapp/python-backend/models/*.py

  build-python:
    needs: check
    runs-on: windows-latest
    # PyInstaller実行

  build-electron:
    needs: check
    runs-on: macos-latest
    # Electron実行
```

## 既に修正したエラー

### ✅ 修正済みエラー

1. **importエラー: Optional未定義**
   ```python
   # 修正: typing.Optionalをimport
   from typing import Optional
   ```

2. **sysモジュル未定義**
   ```python
   # 修正: qwen3_vl_server.pyに import sys を追加
   import sys
   ```

3. **その他のimport**
   ```python
   # 追加済み
   import subprocess
   import re
   ```

## 潜在的エラーチェック結果

### ✅ チェック完了

- [x] app.py: すべてのimportが正しく追加された
- [x] qwen3_vl_server.py: sys モジュール追加完了
- [x] 型ヒント: Optional使用箇所に対応
- [x] exception処理: 適切に実装
- [x] ログ出力: 統一されている

### ⚠️ 注意事項

- llama-server `--n-batch` エラーは**exeのllama-serverバージョンが古い（b8981）**ため
- 新しいexeビルド時に自動更新される（自動ダウンロード機能）

## 実装手順

### Step1: ローカルチェック前に実行
```bash
cd glance-pyapp/python-backend

# 依存関係インストール
pip install flake8 isort mypy

# チェック実行
flake8 app.py --max-line-length=200
python -m py_compile app.py models/*.py
```

### Step2: GitHub Actions設定
`.github/workflows/build.yml`に以下を追加：
```yaml
# ステップ3の前に追加
- name: コード品質チェック
  run: |
    pip install flake8 mypy
    python -m py_compile glance-pyapp/python-backend/app.py
    python -m py_compile glance-pyapp/python-backend/models/*.py
```

### Step3: キャッシュ有効化
```yaml
- uses: actions/cache@v3
  with:
    path: ~/.cache/pip
    key: ${{ runner.os }}-pip-${{ hashFiles('**/requirements.txt') }}
```

## 期待される改善効果

| 項目 | 修正前 | 修正後 |
|------|-------|-------|
| **ビルド時間** | 20分+ | 15分（キャッシュで短縮）|
| **エラー検出** | ビルド時 | **ローカルで即座** |
| **フィードバック** | 20分待機 | **1分以内** |
| **開発効率** | 低 | **大幅向上** |

## 使用例

```bash
# 1. ローカル開発時
cd glance-pyapp/python-backend
python -m py_compile app.py  # エラーチェック

# 2. Push前に検証
bash check.sh

# 3. GitHub Actionsで自動実行
git push  # 自動的にチェック→ビルド
```

## 結論

✅ **本修正により以下が実現**
- 構文エラーをローカルで即座に検出
- ビルド時間の短縮
- 20分待機の無駄を削減
- 開発イテレーションの高速化
