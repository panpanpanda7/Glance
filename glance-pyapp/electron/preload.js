const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preloadスクリプト
 * レンダラープロセスとメインプロセスの安全なブリッジ
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // モデル切り替え
  switchModel: (modelName) => ipcRenderer.invoke('switch-model', modelName),
  
  // 利用可能なモデルリストを取得
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
  
  // 画面キャプチャ
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  
  // 詳細分析
  detailedAnalysis: () => ipcRenderer.invoke('detailed-analysis'),
  
  // 質問分析
  questionAnalysis: (questionText) => ipcRenderer.invoke('question-analysis', questionText),
  
  // 質問モーダル表示チェック
  canShowQuestionModal: () => ipcRenderer.invoke('can-show-question-modal'),
  
  // 読み上げ停止
  stopSpeaking: () => ipcRenderer.invoke('stop-speaking'),

  // TTSのみ停止（推論は継続。読み上げボタンの停止用）
  stopTTS: () => ipcRenderer.invoke('stop-tts'),

  // TTS読み上げ
  speak: (text, options) => ipcRenderer.invoke('speak', text, options),

  // バックエンドの URL（ポートは起動のたびに決まる。決まる前は null）
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // 説明書の本文（docs/manual.txt）を取得する
  getManual: () => ipcRenderer.invoke('get-manual'),

  // トレイのメニューから「説明書を開く」が選ばれた
  onShowManual: (callback) => {
    ipcRenderer.on('show-manual', () => callback());
  },

  // ご意見・不具合を開発者へ送る（Google フォーム経由）
  sendFeedback: (data) => ipcRenderer.invoke('send-feedback', data),

  // トレイのメニューから「ご意見・不具合を送る」が選ばれた
  onShowFeedback: (callback) => {
    ipcRenderer.on('show-feedback', () => callback());
  },

  // 読み上げ中かどうかを知らせる（Glance の外でも Esc で止められるようにするため）
  notifySpeechState: (speaking) => ipcRenderer.send('speech-state', speaking),

  // 読み上げと推論の停止（全体の Esc やトレイのメニューから）
  onStopAll: (callback) => {
    ipcRenderer.on('stop-all', () => callback());
  },

  // イベントリスナー
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, data) => callback(data));
  },

  // 分析開始（チャット履歴への吹き出し追加用）
  onAnalysisStart: (callback) => {
    ipcRenderer.on('analysis-start', (event, data) => callback(data));
  },
  
  onAnalysisResult: (callback) => {
    ipcRenderer.on('analysis-result', (event, data) => callback(data));
  },
  
  onModelLoaded: (callback) => {
    ipcRenderer.on('model-loaded', (event, data) => callback(data));
  },
  
  onTriggerQuestionButton: (callback) => {
    ipcRenderer.on('trigger-question-button', () => callback());
  },
  
  // ログメッセージを受信
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (_event, text) => callback(text));
  },

  // 事前キャプチャ（P）の完了通知
  onCapturePrepared: (callback) => {
    ipcRenderer.on('capture-prepared', (_event, data) => callback(data));
  },

  // 設定
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ホットキー設定
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  saveHotkeys: (hotkeys) => ipcRenderer.invoke('save-hotkeys', hotkeys)
});
