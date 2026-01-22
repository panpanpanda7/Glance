/**
 * Renderer Process
 * UIの更新とユーザー操作の処理
 */

// DOM要素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const modelInfo = document.getElementById('model-info');
const captureBtn = document.getElementById('capture-btn');
const stopBtn = document.getElementById('stop-btn');
const noResult = document.getElementById('no-result');
const resultText = document.getElementById('result-text');
const timestamp = document.getElementById('timestamp');

// ステータス更新
window.electronAPI.onStatusUpdate((data) => {
  console.log('Status update:', data);
  
  // ステータスドットのクラスを更新
  statusDot.className = `status-dot ${data.status}`;
  
  // ステータステキストを更新
  statusText.textContent = data.message;
  
  // ボタンの有効/無効を切り替え
  if (data.status === 'capturing' || data.status === 'analyzing' || data.status === 'speaking') {
    captureBtn.disabled = true;
    captureBtn.style.opacity = '0.5';
  } else {
    captureBtn.disabled = false;
    captureBtn.style.opacity = '1';
  }
});

// 分析結果の受信
window.electronAPI.onAnalysisResult((data) => {
  console.log('Analysis result:', data);
  
  // 結果を表示
  noResult.style.display = 'none';
  resultText.style.display = 'block';
  timestamp.style.display = 'block';
  
  resultText.textContent = data.text;
  
  // タイムスタンプをフォーマット
  const date = new Date(data.timestamp);
  const formattedTime = date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  timestamp.textContent = `📅 ${formattedTime}`;
});

// モデルロード完了
window.electronAPI.onModelLoaded((data) => {
  console.log('Model loaded:', data);
  
  if (data.model) {
    modelInfo.textContent = `モデル: ${data.model.name}`;
  }
});

// キャプチャボタンのクリック
captureBtn.addEventListener('click', async () => {
  console.log('Capture button clicked');
  try {
    await window.electronAPI.captureScreen();
  } catch (error) {
    console.error('Capture error:', error);
  }
});

// 停止ボタンのクリック
stopBtn.addEventListener('click', async () => {
  console.log('Stop button clicked');
  try {
    await window.electronAPI.stopSpeaking();
    statusDot.className = 'status-dot idle';
    statusText.textContent = '待機中';
  } catch (error) {
    console.error('Stop error:', error);
  }
});

// ページロード時
window.addEventListener('DOMContentLoaded', () => {
  console.log('Renderer loaded');
  statusText.textContent = '起動中...';
});
