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
  
  // TTS読み上げ
  speak: (text, options) => ipcRenderer.invoke('speak', text, options),
  
  // イベントリスナー
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, data) => callback(data));
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
  }
});
