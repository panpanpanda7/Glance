/**
 * Renderer Process
 * UIの更新とユーザー操作の処理
 */

// DOM要素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const chat = document.getElementById('chat');
const noResult = document.getElementById('no-result');

// 質問モーダル関連の要素
const questionModal = document.getElementById('question-modal');
const questionInput = document.getElementById('question-input');
const questionSubmit = document.getElementById('question-submit');
const questionCancel = document.getElementById('question-cancel');

// 設定キャッシュ（初回案内の判定などに使用）
let appSettings = {};

// ==========================================
// Markdown除去
// モデルがMarkdown記法で出力した場合でも、
// 表示・読み上げは平文で行う
// ==========================================
function stripMarkdown(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/```[^\n]*\n?/g, '');                 // コードフェンス
  t = t.replace(/^#{1,6}\s+/gm, '');                  // 見出し
  t = t.replace(/^\s*[-*+]\s+/gm, '');                // 箇条書き
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');              // 番号付きリスト
  t = t.replace(/^\s*>\s?/gm, '');                    // 引用
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');            // 太字
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');              // 斜体
  t = t.replace(/`([^`]+)`/g, '$1');                  // インラインコード
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');    // リンク・画像
  t = t.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '');  // 表の区切り行
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row) => row.split('|').map(c => c.trim()).join('、')); // 表の行
  t = t.replace(/\n{3,}/g, '\n\n');                        // 除去で生じた連続空行を詰める
  return t.trim();
}

// ==========================================
// チャット履歴（LINE風・セッション内のみ）
// ==========================================
const MAX_MESSAGES = 100; // 古いメッセージから破棄してメモリを節約

let currentAiMsg = null;   // ストリーミング更新中のAI吹き出し
let speakingButton = null; // 読み上げ中のボタン（同時読み上げは1つまで）

function scrollChatToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function trimOldMessages() {
  while (chat.querySelectorAll('.msg').length > MAX_MESSAGES) {
    const oldest = chat.querySelector('.msg');
    if (!oldest) break;
    oldest.remove();
  }
}

function formatTime(dateLike) {
  const date = dateLike ? new Date(dateLike) : new Date();
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function createMessage(role) {
  if (noResult) noResult.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  msg.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  msg.appendChild(meta);

  chat.appendChild(msg);
  trimOldMessages();
  scrollChatToBottom();
  return { root: msg, bubble, meta };
}

// ユーザーの操作（右側の吹き出し）
function addUserMessage(text) {
  const msg = createMessage('user');
  msg.bubble.textContent = text;
  const time = document.createElement('span');
  time.textContent = formatTime();
  msg.meta.appendChild(time);
  scrollChatToBottom();
}

// AIの回答（左側の吹き出し）。ストリーミングで随時更新する
function addAiMessage() {
  const msg = createMessage('ai');
  msg.bubble.textContent = '認識中…';
  return msg;
}

// 読み上げボタン（Geminiのようにボタン押下で読み上げ・再押下で停止）
function createSpeakButton(getText) {
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.textContent = '🔊 読み上げ';

  const reset = () => {
    btn.classList.remove('speaking');
    btn.textContent = '🔊 読み上げ';
    if (speakingButton === btn) speakingButton = null;
  };

  btn.addEventListener('click', async () => {
    // 読み上げ中に押されたら停止
    if (speakingButton === btn) {
      await window.electronAPI.stopTTS();
      reset();
      return;
    }

    // 他の吹き出しを読み上げ中なら止める
    if (speakingButton) {
      await window.electronAPI.stopTTS();
      speakingButton.classList.remove('speaking');
      speakingButton.textContent = '🔊 読み上げ';
    }

    speakingButton = btn;
    btn.classList.add('speaking');
    btn.textContent = '⏹ 停止';

    try {
      await window.electronAPI.speak(getText());
    } catch (error) {
      // 途中停止でもここに来るため、エラー表示はしない
      console.log('読み上げが停止されました:', error.message);
    } finally {
      reset();
    }
  });

  return btn;
}

// AI吹き出しを確定（タイムスタンプと読み上げボタンを付与）
function finalizeAiMessage(msg, timestamp) {
  msg.meta.innerHTML = '';
  const time = document.createElement('span');
  time.textContent = formatTime(timestamp);
  msg.meta.appendChild(time);
  msg.meta.appendChild(createSpeakButton(() => msg.bubble.textContent));
  scrollChatToBottom();
}

// ==========================================
// 初回案内（インストール後1回のみ）
// ==========================================
async function maybeShowFirstTimeGuide() {
  if (appSettings.guideShown) return;
  appSettings.guideShown = true;
  await window.electronAPI.saveSettings({ guideShown: true });

  const keys = currentHotkeys || {};
  const detailedKey = prettifyAccelerator(keys.detailed) || 'Ctrl+Shift+D';
  const questionKey = prettifyAccelerator(keys.question) || 'Ctrl+Shift+Q';
  const prepareKey = prettifyAccelerator(keys.prepare) || 'Ctrl+Shift+P';

  const guideText =
    `さらに詳しい説明が欲しいときは ${detailedKey}、画面について質問したいときは ${questionKey} が使えます。` +
    `どちらも直前に読み取った画面について答えます。` +
    `別の画面に切り替えてから使いたいときは、先に ${prepareKey} でその画面を記録してください。`;
  const msg = createMessage('ai');
  msg.root.classList.add('guide');
  msg.bubble.textContent = `💡 ${guideText}`;
  finalizeAiMessage(msg);

  window.electronAPI.speak(guideText).catch(() => {});
}

// ==========================================
// 分析イベント
// ==========================================

// 分析開始: ユーザーの吹き出しとAIのプレースホルダーを追加
window.electronAPI.onAnalysisStart((data) => {
  let label = '画面を説明して';
  if (data.type === 'detailed') label = '画面を詳しく説明して';
  if (data.type === 'question') label = data.question || '画面への質問';

  // 詳細・質問は撮り直さず、記録済みの画面に対して答える。
  // どの時点の画面について話しているのかが分かるよう明示する。
  if ((data.type === 'detailed' || data.type === 'question') && data.imageCapturedAt) {
    label += `（${formatTime(data.imageCapturedAt)}の画面について）`;
  }

  addUserMessage(label);
  currentAiMsg = addAiMessage();
});

// 事前キャプチャ（P）: 説明は出さず、記録できたことだけ伝える
window.electronAPI.onCapturePrepared((data) => {
  const time = formatTime(data && data.timestamp);
  const msg = createMessage('ai');
  msg.root.classList.add('guide');
  msg.bubble.textContent = `📌 ${time} の画面を記録しました。このあとの「詳しく説明」「質問」は、この画面について答えます。`;
  finalizeAiMessage(msg, data && data.timestamp);
});

// 分析結果（ストリーミング）: 現在のAI吹き出しを更新
window.electronAPI.onAnalysisResult((data) => {
  if (!currentAiMsg) {
    currentAiMsg = addAiMessage();
  }

  const text = stripMarkdown(data.text);
  currentAiMsg.bubble.textContent = text || '認識中…';
  scrollChatToBottom();

  if (!data.streaming) {
    finalizeAiMessage(currentAiMsg, data.timestamp);
    const isFirstRecognition = !data.isDetailed && !data.isQuestion;
    currentAiMsg = null;
    if (isFirstRecognition) {
      maybeShowFirstTimeGuide();
    }
  }
});

// ステータス更新
window.electronAPI.onStatusUpdate((data) => {
  console.log('Status update:', data);

  // ★IPCイベントを受信したらポーリングを停止
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
    console.log('✅ ステータスポーリングを停止しました（IPCイベント受信）');
  }

  statusDot.className = `status-dot ${data.status}`;
  statusText.textContent = data.message;

  // エラー発生時、応答待ちの吹き出しがあればエラー表示に切り替える
  if (data.status === 'error' && currentAiMsg) {
    currentAiMsg.root.classList.add('error');
    currentAiMsg.bubble.textContent = `⚠️ ${data.message}`;
    currentAiMsg.meta.innerHTML = '';
    const time = document.createElement('span');
    time.textContent = formatTime();
    currentAiMsg.meta.appendChild(time);
    currentAiMsg = null;
  }
});

// ==========================================
// 質問モーダル
// ==========================================
function showQuestionModal() {
  questionModal.style.display = 'block';
  questionInput.value = '';
  questionInput.focus();
}

function hideQuestionModal() {
  questionModal.style.display = 'none';
  questionInput.value = '';
}

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

// ==========================================
// 設定UI
// ==========================================
const imageSizeSelect = document.getElementById('image-size-select');
const hotkeyInputs = Array.from(document.querySelectorAll('[data-hotkey]'));
const hotkeySaveBtn = document.getElementById('hotkey-save');
const hotkeyResetBtn = document.getElementById('hotkey-reset');
const hotkeyStatus = document.getElementById('hotkey-status');
const hotkeyHint = document.getElementById('hotkey-hint');

const HOTKEY_LABELS = {
  capture: '画面を説明',
  prepare: '事前キャプチャ',
  detailed: '詳しく説明',
  question: '画面へ質問'
};

let hotkeyDefaults = {};
let currentHotkeys = {};

// Electron 内部表記(CommandOrControl)を、画面表示用の見慣れた表記へ
function prettifyAccelerator(accelerator) {
  if (!accelerator) return '';
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return accelerator.replace(/CommandOrControl/gi, isMac ? 'Cmd' : 'Ctrl');
}

// 表示用の表記を Electron が解釈できる形へ戻す
function normalizeAccelerator(text) {
  return (text || '')
    .trim()
    .replace(/\s*\+\s*/g, '+')
    .replace(/\b(ctrl|control|cmd|command)\b/gi, 'CommandOrControl');
}

function applyHotkeysToUI(hotkeys) {
  currentHotkeys = hotkeys || {};
  hotkeyInputs.forEach(input => {
    input.value = prettifyAccelerator(hotkeys[input.dataset.hotkey]);
  });
  if (hotkeyHint && hotkeys.capture) {
    hotkeyHint.innerHTML = '';
    const kbd = document.createElement('kbd');
    kbd.textContent = prettifyAccelerator(hotkeys.capture);
    hotkeyHint.appendChild(kbd);
    hotkeyHint.appendChild(document.createTextNode(' で今の画面を認識して説明します'));
  }
}

async function initHotkeys() {
  if (!hotkeyInputs.length) return;
  const { hotkeys, defaults } = await window.electronAPI.getHotkeys();
  hotkeyDefaults = defaults || {};
  applyHotkeysToUI(hotkeys);
}

// 保存結果を文章で伝える。登録に失敗したキーは名指しで知らせないと、
// 画面が見えない利用者には「効かない理由」が分からない
function reportHotkeyResults(results) {
  const failed = Object.entries(results || {})
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${HOTKEY_LABELS[name] || name}（${prettifyAccelerator(r.accelerator)}）`);

  const message = failed.length === 0
    ? 'ホットキーを保存しました。すべて登録できています。'
    : `ホットキーを保存しました。ただし ${failed.join('、')} は他のアプリが使用中で登録できませんでした。別のキーに変更してください。`;

  if (hotkeyStatus) hotkeyStatus.textContent = message;
  window.electronAPI.speak(message).catch(() => {});
}

async function saveHotkeys(values) {
  const { hotkeys, results } = await window.electronAPI.saveHotkeys(values);
  applyHotkeysToUI(hotkeys);
  reportHotkeyResults(results);
}

if (hotkeySaveBtn) {
  hotkeySaveBtn.addEventListener('click', () => {
    const values = {};
    hotkeyInputs.forEach(input => {
      values[input.dataset.hotkey] = normalizeAccelerator(input.value);
    });
    saveHotkeys(values);
  });
}

if (hotkeyResetBtn) {
  hotkeyResetBtn.addEventListener('click', () => saveHotkeys({ ...hotkeyDefaults }));
}

async function initSettings() {
  appSettings = await window.electronAPI.getSettings();
  if (imageSizeSelect && appSettings.imageMaxSize) {
    imageSizeSelect.value = appSettings.imageMaxSize;
  }
}

if (imageSizeSelect) {
  imageSizeSelect.addEventListener('change', async () => {
    appSettings = await window.electronAPI.saveSettings({ imageMaxSize: imageSizeSelect.value });
    console.log('設定を保存しました:', imageSizeSelect.value);
  });
}

// ページロード時
window.addEventListener('DOMContentLoaded', () => {
  console.log('Renderer loaded');
  statusText.textContent = 'Pythonバックエンド起動中...';

  // ログエリアを初期化
  if (startupLogs) {
    startupLogs.textContent = 'ログ待機中...';
  }

  // 設定を読み込み
  initSettings();
  initHotkeys();

  // 2秒ごとにシステムステータスをチェック
  statusCheckInterval = setInterval(checkSystemStatus, 2000);
  // 即座に1回チェック
  checkSystemStatus();
});
