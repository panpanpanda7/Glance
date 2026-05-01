# config.yaml YAML構文エラー修正

## 問題の概要

Windows環境でGlanceアプリをexeで実行したところ、以下のエラーが発生していました：

```
❌ 設定ファイルの読み込みに失敗: while parsing a block mapping
  in "config.yaml", line 25, column 3
expected <block end>, but found '<block mapping start>'
  in "config.yaml", line 48, column 4
```

## 原因分析

**config.yaml のインデント不整合**

```yaml
# 正しい（2スペースインデント）✅
  qwen2_5-vl-3b-gguf:
    name: Qwen2.5 VL 3B...
    type: qwen_vl_gguf

# 間違い（3スペースインデント）❌
   qwen3-vl-4b-server:      ← 3スペース
     name: Qwen3 VL 4B...   ← 5スペース
```

YAMLパーサーは混在したインデント幅（2スペース と 3スペース）を同じブロックレベルでは許容しないため、構文エラーが発生していました。

## 実施した修正

### 1. qwen3-vl-4b-server セクション
- **変更**: インデントを 3スペース から 2スペース に統一
- **行**: 47-66行目

```yaml
# BEFORE （3スペース）
   qwen3-vl-4b-server:
     name: Qwen3 VL 4B...

# AFTER （2スペース）
  qwen3-vl-4b-server:
    name: Qwen3 VL 4B...
```

### 2. internvl-3_5-4b-gguf セクション
- **変更**: コメント構文の修正とインデント確認
- **行**: 69-78行目

```yaml
# BEFORE
  internvl-3_5-4b-gguf:
  #   name: InternVL 3.5...  ← インデント不整合
    type: internvl_gguf

# AFTER
  internvl-3_5-4b-gguf:
    # name: InternVL 3.5...  ← 正しいインデント
    type: internvl_gguf
```

## 確認方法

YAMLファイルのバリデーション：

```bash
# Python利用
python -m yaml glance-pyapp/python-backend/config.yaml

# オンラインYAMLバリデータ
# https://www.yamllint.com/
```

## Windows環境での次のステップ

1. **exeファイルを再ビルド**
   - 修正された `config.yaml` を含めてPyInstallerで再ビルド

2. **アプリを再インストール**
   - Windows環境でセットアップを再実行

3. **動作確認**
   - ✅ 設定ファイル読み込み成功
   - ✅ Python Backendが起動完了

## トラブルシューティング

### まだYAMLエラーが出る場合
- キャッシュクリア: `~/.pyinstallerrc` や PyInstaller キャッシュを削除
- 別のYAMLエディタで検証（Visual Studio CodeのYAMLエクステンション等）

### ctx_size設定が反映されない場合
```yaml
qwen3-vl-4b-server:
  # ...
  ctx_size: 8192  # または 4096（4GB RAM環境向け）
```

## 参考資料

- **YAML 1.2 仕様**: https://yaml.org/spec/1.2/spec.html
- **Pythonのyamlモジュール**: https://pyyaml.org/

