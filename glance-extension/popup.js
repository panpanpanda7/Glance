const statusArea = document.getElementById('status');
const captureBtn = document.getElementById('capture-btn');
const speakBtn = document.getElementById('speak-btn');
const stopBtn = document.getElementById('stop-btn');

let lastResult = '';

function updateStatus(text, type = '') {
  statusArea.textContent = text;
  statusArea.className = type;
  console.log(`[Glance]: ${text}`);
}

// 音声読み上げ
function speak(text) {
  chrome.tts.stop();
  chrome.tts.speak(text, {
    lang: 'en-US',
    rate: 0.9,
    onEvent: (event) => {
      if (event.type === 'end') {
        speakBtn.disabled = false;
        stopBtn.disabled = true;
      } else if (event.type === 'start') {
        speakBtn.disabled = true;
        stopBtn.disabled = false;
      }
    }
  });
}

speakBtn.addEventListener('click', () => {
  if (lastResult) speak(lastResult);
});

stopBtn.addEventListener('click', () => {
  chrome.tts.stop();
  speakBtn.disabled = false;
  stopBtn.disabled = true;
});

// ============================================================
// 【変更点】メッセージ受信リスナー (結果もここで受け取る)
// ============================================================
chrome.runtime.onMessage.addListener((message) => {
  // 進捗状況
  if (message.type === 'PROGRESS_UPDATE') {
    updateStatus(message.message);
  }
  
  // 解析完了 (成功)
  else if (message.type === 'ANALYSIS_SUCCESS') {
    lastResult = message.result;
    updateStatus(`【解析結果】\n${message.result}`);
    speak(message.result);
    speakBtn.disabled = false;
    captureBtn.disabled = false; // ボタン復活
  }
  
  // 解析失敗 (エラー)
  else if (message.type === 'ANALYSIS_ERROR') {
    updateStatus(`エラー: ${message.error}`, 'error');
    console.error(message.error);
    captureBtn.disabled = false; // ボタン復活
  }
});

// キャプチャボタン
captureBtn.addEventListener('click', async () => {
  let stream = null;
  captureBtn.disabled = true;

  try {
    updateStatus('画面を選択するダイアログが開きます...');
    await new Promise(r => setTimeout(r, 500));
    
    stream = await navigator.mediaDevices.getDisplayMedia({ 
      video: { cursor: "never" }, 
      audio: false 
    });

    updateStatus('画面を取得中...');

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    
    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        setTimeout(resolve, 300);
      };
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const imageUrl = canvas.toDataURL('image/jpeg', 0.85);
    
    stream.getTracks().forEach(track => track.stop());
    video.remove();

    updateStatus('AIが画像を解析しています...\n（初回は読み込みに時間がかかります）');

    // ============================================================
    // 【変更点】応答を待たない (Send and Forget)
    // ============================================================
    // タイムアウトエラーを防ぐため、ここでは送信するだけです。
    // 結果は onMessage で受け取ります。
    chrome.runtime.sendMessage({
      type: 'REQUEST_ANALYSIS',
      imageData: imageUrl
    });

  } catch (err) {
    console.error("エラー:", err);
    if (err.name === 'NotAllowedError') {
      updateStatus('キャンセルされました。');
    } else {
      updateStatus(`エラー: ${err.message}`);
    }
    if (stream) stream.getTracks().forEach(track => track.stop());
    captureBtn.disabled = false;
  }
});

updateStatus('準備完了。「画面を読み取る」ボタンを押してください。');