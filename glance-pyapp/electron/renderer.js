/**
 * Renderer Process
 * UIの更新とユーザー操作の処理
 */

// DOM要素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const noResult = document.getElementById('no-result');
const resultText = document.getElementById('result-text');
const timestamp = document.getElementById('timestamp');

// 質問モーダル関連の要素
const questionModal = document.getElementById('question-modal');
const questionInput = document.getElementById('question-input');
const questionSubmit = document.getElementById('question-submit');
const questionCancel = document.getElementById('question-cancel');

// ステータス更新
window.electronAPI.onStatusUpdate((data) => {
  console.log('Status update:', data);
  
  // ★IPCイベントを受信したらポーリングを停止
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
    console.log('✅ ステータスポーリングを停止しました（IPCイベント受信）');
  }
  
  // ステータスドットのクラスを更新
  statusDot.className = `status-dot ${data.status}`;
  
  // ステータステキストを更新
  statusText.textContent = data.message;
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
    // 質問結果かどうかを表示
    if (data.isQuestion) {
      modelText += ' [質問モード]';
      // 質問内容も表示
      resultText.textContent = `Q: ${data.question}\n\nA: ${data.text}`;
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

// 質問モーダル表示
function showQuestionModal() {
  questionModal.style.display = 'block';
  questionInput.value = '';
  questionInput.focus();
}

// 質問モーダル非表示
function hideQuestionModal() {
  questionModal.style.display = 'none';
  questionInput.value = '';
}

// 質問送信
async function submitQuestion() {
  const questionText = questionInput.value.trim();
  
  if (!questionText) {
    alert('質問を入力してください。');
    return;
  }
  
  hideQuestionModal();
  
  try {
    await window.electronAPI.questionAnalysis(questionText);
  } catch (error) {
    console.error('Question analysis error:', error);
  }
}

// 質問モーダルのイベントリスナー
questionSubmit.addEventListener('click', submitQuestion);

questionCancel.addEventListener('click', hideQuestionModal);

// モーダル外クリックで閉じる
questionModal.addEventListener('click', (e) => {
  if (e.target === questionModal) {
    hideQuestionModal();
  }
});

// ESCキーでモーダルを閉じる
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && questionModal.style.display === 'block') {
    hideQuestionModal();
  }
});

// Enterキーで質問送信
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitQuestion();
  }
});

// 直前の画像キャプチャが存在するかチェック
function lastCaptureExist() {
  // 結果テキストが非表示であれば画像キャプチャが行われていない
  return resultText.style.display !== 'none';
}

// ==========================================
// システム状態監視
// ==========================================

let lastStatus = "";
let lastSpokenProgress = -1; // 前回読み上げた進捗
let statusCheckInterval = null; // ポーリング用のインターバルID

function checkSystemStatus() {
  fetch('http://127.0.0.1:5001/status')
    .then(res => res.json())
    .then(data => {
      if (data.status === 'initializing') {
        // 初期化中
        if (statusText) statusText.textContent = data.message;
        statusDot.className = 'status-dot connecting';
        
      } else if (data.status === 'downloading') {
        // ダウンロード中
        let displayText = `${data.message}`;
        if (data.detail) {
          displayText += ` ${data.detail}`;
        }
        if (statusText) statusText.textContent = displayText;
        statusDot.className = 'status-dot connecting';
        
        // 音声読み上げ（10%刻みで通知）- ポーリング有効時のみ
        if (data.progress % 10 === 0 && data.progress !== lastSpokenProgress && data.progress > 0 && statusCheckInterval) {
          window.electronAPI.speak(`準備中、${data.progress}パーセント完了`);
          lastSpokenProgress = data.progress;
        }
        
      } else if (data.status === 'loading_model') {
        // モデルロード中
        if (statusText) statusText.textContent = data.message;
        statusDot.className = 'status-dot connecting';
        // ポーリング有効時のみTTS読み上げ
        if (lastStatus !== 'loading_model' && statusCheckInterval) {
          window.electronAPI.speak("ダウンロード完了。AIを起動しています。");
        }
        
      } else if (data.status === 'ready') {
        // 準備完了
        if (statusText) statusText.textContent = "待機中";
        statusDot.className = 'status-dot idle';
        // ポーリングが有効な場合のみTTS読み上げ（エラー後の遅延読み上げを防止）
        if (lastStatus !== 'ready' && statusCheckInterval) {
          window.electronAPI.speak("準備が完了しました。Glanceを使用できます。");
        }
        
        // ★準備完了したらポーリングを停止（main.jsのIPCステータスに任せる）
        if (statusCheckInterval) {
          clearInterval(statusCheckInterval);
          statusCheckInterval = null;
          console.log('✅ ステータスポーリングを停止しました（バックエンド準備完了）');
        }
        
      } else if (data.status === 'error') {
        // エラー
        let errorText = data.message;
        if (data.detail) {
          errorText += `: ${data.detail}`;
        }
        if (statusText) statusText.textContent = errorText;
        statusDot.className = 'status-dot error';
        // エラー時のTTS読み上げ（コメントアウト - エラー音で代替）
        // if (lastStatus !== 'error') {
        //   window.electronAPI.speak("エラーが発生しました。詳細はステータス欄を確認してください。");
        // }
      }
      
      lastStatus = data.status;
    })
    .catch(err => {
      console.log("Waiting for backend...", err);
      // バックエンドがまだ起動していない場合のみメッセージを表示
      if (!lastStatus || lastStatus === '') {
        if (statusText) statusText.textContent = 'Pythonバックエンド起動中...';
        statusDot.className = 'status-dot connecting';
      }
    });
}

// ログメッセージの受信と表示
const startupLogs = document.getElementById('startup-logs');
let logLines = [];

window.electronAPI.onLogMessage((text) => {
  console.log('Log message:', text);
  
  // ログを配列に追加
  logLines.push(text);
  
  // 最大500行に制限（メモリ節約）
  if (logLines.length > 500) {
    logLines.shift();
  }
  
  // ログエリアを更新
  if (startupLogs) {
    startupLogs.textContent = logLines.join('\n');
    // 自動スクロール（最新のログが見えるように）
    startupLogs.scrollTop = startupLogs.scrollHeight;
  }
});

// ページロード時
window.addEventListener('DOMContentLoaded', () => {
  console.log('Renderer loaded');
  statusText.textContent = 'Pythonバックエンド起動中...';
  
  // ログエリアを初期化
  if (startupLogs) {
    startupLogs.textContent = 'ログ待機中...';
  }
  
  // 2秒ごとにシステムステータスをチェック
  statusCheckInterval = setInterval(checkSystemStatus, 2000);
  // 即座に1回チェック
  checkSystemStatus();
});
