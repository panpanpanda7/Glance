/**
 * Renderer Process
 * UIの更新とユーザー操作の処理
 */

// DOM要素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const modelInfo = document.getElementById('model-info');
const captureBtn = document.getElementById('capture-btn');
const detailedBtn = document.getElementById('detailed-btn'); // 詳細分析ボタン
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
    detailedBtn.disabled = true;
    detailedBtn.style.opacity = '0.5';
  } else {
    captureBtn.disabled = false;
    captureBtn.style.opacity = '1';
    detailedBtn.disabled = false;
    detailedBtn.style.opacity = '1';
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
  
  // モデル情報も表示
  if (data.model) {
    let modelText = `\n\n---\nモデル: ${data.model.name} (${data.model.device})`;
    // 詳細分析結果かどうかを表示
    if (data.isDetailed) {
      modelText += ' [詳細モード]';
    }
    resultText.textContent += modelText;
  }
  
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
  
  if (data.backend) {
    modelInfo.textContent = `バックエンド: ${data.backend}`;
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

// 詳細分析ボタンのクリック
detailedBtn.addEventListener('click', async () => {
  console.log('Detailed analysis button clicked');
  try {
    if (!lastCaptureExist()) {
      statusDot.className = 'status-dot error';
      statusText.textContent = '画像がありません。先に画面キャプチャを行ってください。';
      return;
    }
    await window.electronAPI.detailedAnalysis();
  } catch (error) {
    console.error('Detailed analysis error:', error);
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

// 直前の画像キャプチャが存在するかチェック
function lastCaptureExist() {
  // 結果テキストが非表示であれば画像キャプチャが行われていない
  return resultText.style.display !== 'none';
}

// ページロード時
window.addEventListener('DOMContentLoaded', () => {
  console.log('Renderer loaded');
  statusText.textContent = 'Pythonバックエンド起動中...';
});
