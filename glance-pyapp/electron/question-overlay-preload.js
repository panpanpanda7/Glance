const { contextBridge, ipcRenderer } = require('electron');

/**
 * 質問オーバーレイ用Preloadスクリプト
 * 透明オーバーレイウィンドウとメインプロセスの通信ブリッジ
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // 質問送信
  submitQuestion: (questionText) => {
    ipcRenderer.send('overlay-question-submit', questionText);
  },
  
  // キャンセル
  cancelQuestion: () => {
    ipcRenderer.send('overlay-question-cancel');
  }
});
