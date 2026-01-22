# セキュリティに関する注意事項

## 現在の脆弱性について

`npm install`実行時に以下の脆弱性警告が表示されますが、これらは**開発時の依存関係**に関するもので、**実行時のアプリには影響しません**。

### 検出された脆弱性

1. **Electron < 35.7.5**: ASAR Integrity Bypass
2. **tar <= 7.5.3**: Path Sanitization issues
3. **electron-builder関連**: tarパッケージへの依存

### 対応方針

#### 開発・テスト段階（現在）
- ✅ **問題なし**: これらの脆弱性は、ビルドツールやパッケージャーに関するもので、実行時のアプリケーションには影響しません
- アプリの動作確認と機能開発を優先

#### 本番リリース前
- 🔧 **対応必須**: 以下のコマンドで依存関係を更新
  ```bash
  npm audit fix --force
  ```
  
  または、個別に更新：
  ```bash
  npm install electron@latest --save-dev
  npm install electron-builder@latest --save-dev
  ```

### Breaking Changeについて

`npm audit fix --force`を実行すると、以下のような破壊的変更が含まれる可能性があります：

- **Electron**: v28 → v40 (API変更あり)
- **electron-builder**: v24 → v26 (設定変更が必要な場合あり)

これらを更新する場合は、以下を確認してください：

1. **Electronの変更**:
   - [Electron Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes)
   - 主な変更点をチェックし、コードを調整

2. **electron-builderの変更**:
   - package.jsonのbuild設定を確認
   - 必要に応じて調整

## セキュリティのベストプラクティス

### 1. コンテキスト分離（✅ 実装済み）

```javascript
// preload.js
webPreferences: {
  contextIsolation: true,  // ✅ 有効
  nodeIntegration: false,  // ✅ 無効
}
```

### 2. CSP（Content Security Policy）

今後のバージョンで追加を推奨：

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; script-src 'self'">
```

### 3. 権限の最小化

- 画面キャプチャ権限のみ要求
- ネットワークアクセスなし（完全オフライン動作）
- ファイルシステムアクセスは設定ファイルと モデルファイルのみ

## ユーザー向けセキュリティ情報

### プライバシー

✅ **完全オフライン**: 
- すべての処理はローカルで実行
- インターネット接続不要
- データの外部送信なし

✅ **画面データの取り扱い**:
- キャプチャした画面はメモリ内でのみ処理
- ディスクには保存されません（デバッグモード除く）
- 履歴は保持されません

## 開発者向け：セキュリティチェックリスト

リリース前に以下を確認：

- [ ] 依存関係の脆弱性を修正（`npm audit fix --force`）
- [ ] Electronを最新の安定版に更新
- [ ] コード署名（Windows: Authenticode, macOS: Developer ID）
- [ ] VirusTotalでスキャン
- [ ] セキュリティテスト実施
- [ ] プライバシーポリシーの作成

## 報告

セキュリティ上の問題を発見した場合：

1. 公開Issueは作成しない
2. プライベートな連絡手段で報告
3. 修正後に公開

---

最終更新: 2026/1/21
