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
// 読み上げ
//
// 既定はレンダラーの Web Speech API。Chromium が Windows の SAPI5 音声を
// 直接鳴らすため、外部プロセスを起動する必要がなく、開始が速く、停止も確実。
// 従来の PowerShell 経由（'system'）はフォールバックとして残す。
//
// 文が確定するたびにキューへ積むので、生成の途中経過も順に読み上げられる。
// 以前は生成完了後にボタンを押さないと読まれず、継続出力が読まれなかった。
// ==========================================
const speech = {
  mode: 'builtin',   // 'builtin'（Web Speech） | 'system'（OS標準） | 'off'
  rate: 1.5,
  voiceURI: '',
  autoRead: true
};

let ttsQueue = [];
let ttsRunning = false;
let ttsVoices = [];

function speechAvailable() {
  return typeof window.speechSynthesis !== 'undefined';
}

function refreshVoices() {
  if (!speechAvailable()) return [];
  ttsVoices = window.speechSynthesis.getVoices() || [];
  return ttsVoices;
}

// 日本語の音声を優先して選ぶ。既定の音声が英語だと日本語が読まれず、
// 「何も聞こえない」ように見えることがある
function pickVoice() {
  if (!ttsVoices.length) refreshVoices();
  if (speech.voiceURI) {
    const chosen = ttsVoices.find(v => v.voiceURI === speech.voiceURI);
    if (chosen) return chosen;
  }
  return ttsVoices.find(v => (v.lang || '').toLowerCase().startsWith('ja')) || null;
}

function speakOne(text) {
  if (speech.mode === 'system' || !speechAvailable()) {
    return window.electronAPI.speak(text, { speed: speech.rate }).catch(() => {});
  }

  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = (voice && voice.lang) || 'ja-JP';
    utterance.rate = Math.max(0.1, Math.min(10, speech.rate));

    // Chromium では onend が発火しないことが稀にある。番人を置かないと
    // キューがそこで止まり、以降が一切読まれなくなる
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(done, 2000 + text.length * 300);

    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
  });
}

async function runTtsQueue() {
  if (ttsRunning) return;
  ttsRunning = true;
  try {
    while (ttsQueue.length) {
      await speakOne(ttsQueue.shift());
    }
  } finally {
    ttsRunning = false;
  }
}

// 読み上げ待ちに積む（生成中の逐次読み上げ用）
function enqueueSpeech(text) {
  if (!text || speech.mode === 'off') return;
  ttsQueue.push(text);
  runTtsQueue();
}

// 今すぐ読む（操作の確認など。溜まっている分は捨てる）
function speakNow(text) {
  if (!text || speech.mode === 'off') return;
  stopSpeech();
  enqueueSpeech(text);
}

function stopSpeech() {
  ttsQueue = [];
  if (speechAvailable()) {
    try { window.speechSynthesis.cancel(); } catch (e) { /* 実害なし */ }
  }
  window.electronAPI.stopTTS().catch(() => {});
}

// ==========================================
// スクリーンリーダーへの通知
//
// 「読み上げない（スクリーンリーダーに任せる）」を選んだ利用者向け。
// チャット本体を live region にすると書き換えのたびに全文が読み直されるため、
// 確定した文だけをこの専用領域へ追記する。
// ==========================================
const srAnnouncer = document.getElementById('sr-announcer');

function announce(text) {
  if (!srAnnouncer || !text) return;
  const line = document.createElement('div');
  line.textContent = text;
  srAnnouncer.appendChild(line);
  while (srAnnouncer.childElementCount > 20) {
    srAnnouncer.removeChild(srAnnouncer.firstElementChild);
  }
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
  // キーボードで1件ずつ移動できるようにする。tabindex="-1" は
  // Tab の巡回対象にはせず、スクリプトからフォーカスを当てられる状態
  msg.tabIndex = -1;
  msg.dataset.time = formatTime();
  msg.dataset.role = role === 'user' ? '操作' : 'Glanceの説明';

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

// フォーカス時に「時刻・種別・本文」がまとめて読まれるようにする
function updateMessageLabel(msg) {
  const root = msg.root || msg;
  const bubble = root.querySelector('.bubble');
  const text = bubble ? bubble.textContent : '';
  root.setAttribute('aria-label',
    `${root.dataset.time} ${root.dataset.role}。${text}`);
}

// ユーザーの操作（右側の吹き出し）
function addUserMessage(text) {
  const msg = createMessage('user');
  msg.bubble.textContent = text;
  const time = document.createElement('span');
  time.textContent = formatTime();
  msg.meta.appendChild(time);
  updateMessageLabel(msg);
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
      stopSpeech();
      reset();
      return;
    }

    // 他の吹き出しを読み上げ中なら止める
    if (speakingButton) {
      speakingButton.classList.remove('speaking');
      speakingButton.textContent = '🔊 読み上げ';
    }
    stopSpeech();

    speakingButton = btn;
    btn.classList.add('speaking');
    btn.textContent = '⏹ 停止';

    try {
      // 文ごとに区切って積む。1回の発話が長いと Chromium 側で
      // 途中打ち切りが起きることがあるため
      splitSentences(getText()).forEach(enqueueSpeech);
      await waitForSpeechIdle();
    } catch (error) {
      // 途中停止でもここに来るため、エラー表示はしない
      console.log('読み上げが停止されました:', error.message);
    } finally {
      reset();
    }
  });

  return btn;
}

// 読み上げキューが空になるまで待つ（読み上げボタンの表示を戻すため）
function waitForSpeechIdle() {
  return new Promise(resolve => {
    const check = () => {
      if (!ttsRunning && ttsQueue.length === 0) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}

// 文の区切り（。！？改行）で分割する
function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[。！？])|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// AI吹き出しを確定（タイムスタンプと読み上げボタンを付与）
function finalizeAiMessage(msg, timestamp) {
  msg.meta.innerHTML = '';
  const time = document.createElement('span');
  time.textContent = formatTime(timestamp);
  msg.meta.appendChild(time);
  msg.meta.appendChild(createSpeakButton(() => msg.bubble.textContent));
  msg.root.dataset.time = formatTime(timestamp);
  updateMessageLabel(msg);
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

  speakNow(guideText);
  announce(guideText);
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

/**
 * 生成途中の本文から「新しく完結した文」だけを取り出して読み上げに回す
 *
 * 生成が終わるのを待たずに読み始められるので、待ち時間が体感で消える。
 * 読み上げ済みの位置を覚えておき、同じ文を二度読まない。
 *
 * @param {object} msg 対象の吹き出し
 * @param {string} text ここまでの本文（累積）
 * @param {boolean} finished 生成が完了したか
 */
function speakNewSentences(msg, text, finished) {
  // Markdown除去の結果、前回より本文が短くなることが稀にある。
  // その場合は位置がずれているので読み上げ済み位置を戻す
  if (typeof msg.spokenUpTo !== 'number' || text.length < msg.spokenUpTo) {
    msg.spokenUpTo = 0;
  }

  const pending = text.slice(msg.spokenUpTo);
  const parts = [];
  let consumed = 0;

  const sentence = /[^。！？\n]*[。！？\n]/g;
  let match;
  while ((match = sentence.exec(pending)) !== null) {
    const body = match[0].trim();
    if (body) parts.push(body);
    consumed = match.index + match[0].length;
  }

  // 生成が終わったら、句点で終わっていない末尾も読む
  if (finished && consumed < pending.length) {
    const tail = pending.slice(consumed).trim();
    if (tail) parts.push(tail);
    consumed = pending.length;
  }

  msg.spokenUpTo += consumed;

  parts.forEach(part => {
    if (speech.autoRead) enqueueSpeech(part);
    announce(part);   // スクリーンリーダーに任せる設定でも届くように
  });
}

// 分析結果（ストリーミング）: 現在のAI吹き出しを更新
window.electronAPI.onAnalysisResult((data) => {
  if (!currentAiMsg) {
    currentAiMsg = addAiMessage();
  }

  const text = stripMarkdown(data.text);
  currentAiMsg.bubble.textContent = text || '認識中…';
  updateMessageLabel(currentAiMsg);
  scrollChatToBottom();

  speakNewSentences(currentAiMsg, text, !data.streaming);

  if (!data.streaming) {
    // 説明が最後まで出せなかったことは、画面が見えない利用者には
    // 自力で判断できない。理由を添えて明示する
    if (data.stoppedBy) {
      const notice = data.stoppedBy === 'loop'
        ? '（同じ説明の繰り返しが始まったため、ここで止めました）'
        : '（説明が長くなったため、ここまでで止めました）';
      currentAiMsg.bubble.textContent = `${text}\n${notice}`;
      updateMessageLabel(currentAiMsg);
      if (speech.autoRead) enqueueSpeech(notice);
      announce(notice);
    }
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
// 履歴のキーボード操作
//
// 画面が見えない利用者が、過去の説明を自力でたどれるようにする。
//   Ctrl+Home … 履歴の先頭へ
//   Ctrl+End  … 最新の説明へ
//   Alt+↑ / Alt+↓ … 1件ずつ移動（移動先の時刻と本文が読み上げられる）
//   Enter / Space  … 選択中の説明を読み上げ
//   Esc            … 読み上げを停止
// ==========================================
function getMessages() {
  return Array.from(chat.querySelectorAll('.msg'));
}

function focusMessage(msg) {
  if (!msg) return;
  msg.focus();
  msg.scrollIntoView({ block: 'nearest' });

  // スクリーンリーダーが有効でない利用者にも内容が届くよう、
  // 自前の読み上げでも移動先を読む
  if (speech.autoRead) {
    stopSpeech();
    splitSentences(msg.getAttribute('aria-label') || '').forEach(enqueueSpeech);
  }
}

function moveFocus(step) {
  const messages = getMessages();
  if (!messages.length) return;

  const active = document.activeElement;
  const index = messages.indexOf(active.closest ? active.closest('.msg') : null);

  // 履歴の外から入ってきたときは、末尾（最新）を起点にする
  const next = index === -1
    ? (step < 0 ? messages.length - 1 : 0)
    : Math.min(messages.length - 1, Math.max(0, index + step));

  focusMessage(messages[next]);
}

// 入力中は履歴操作のキーを奪わない
function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

document.addEventListener('keydown', (event) => {
  if (isTypingTarget(event.target)) return;
  if (questionModal && questionModal.style.display === 'block') return;

  const messages = getMessages();

  if (event.ctrlKey && !event.altKey && event.key === 'Home') {
    event.preventDefault();
    focusMessage(messages[0]);
    return;
  }
  if (event.ctrlKey && !event.altKey && event.key === 'End') {
    event.preventDefault();
    focusMessage(messages[messages.length - 1]);
    return;
  }
  if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
    return;
  }
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
    return;
  }
  if (event.key === 'Escape') {
    stopSpeech();
    return;
  }

  const focused = event.target.closest ? event.target.closest('.msg') : null;
  if (focused && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    stopSpeech();
    splitSentences(focused.getAttribute('aria-label') || '').forEach(enqueueSpeech);
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
          speakNow(`準備中、${data.progress}パーセント完了`);
          lastSpokenProgress = data.progress;
        }

      } else if (data.status === 'loading_model') {
        // モデルロード中
        if (statusText) statusText.textContent = data.message;
        statusDot.className = 'status-dot connecting';
        // ポーリング有効時のみTTS読み上げ
        if (lastStatus !== 'loading_model' && statusCheckInterval) {
          speakNow("ダウンロード完了。AIを起動しています。");
        }

      } else if (data.status === 'ready') {
        // 準備完了
        if (statusText) statusText.textContent = "待機中";
        statusDot.className = 'status-dot idle';
        // ポーリングが有効な場合のみTTS読み上げ（エラー後の遅延読み上げを防止）
        if (lastStatus !== 'ready' && statusCheckInterval) {
          speakNow("準備が完了しました。Glanceを使用できます。");
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
  speakNow(message);
  announce(message);
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

// ==========================================
// 読み上げ設定
// ==========================================
const ttsModeSelect = document.getElementById('tts-mode-select');
const ttsVoiceSelect = document.getElementById('tts-voice-select');
const ttsRateSelect = document.getElementById('tts-rate-select');
const ttsAutoRead = document.getElementById('tts-autoread');
const ttsTestBtn = document.getElementById('tts-test');
const ttsStatus = document.getElementById('tts-status');

function populateVoiceOptions() {
  if (!ttsVoiceSelect) return;
  const voices = refreshVoices();

  ttsVoiceSelect.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自動選択（日本語を優先）';
  ttsVoiceSelect.appendChild(auto);

  // 日本語の音声を先頭に寄せる
  const sorted = [...voices].sort((a, b) => {
    const ja = v => ((v.lang || '').toLowerCase().startsWith('ja') ? 0 : 1);
    return ja(a) - ja(b);
  });
  sorted.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name}（${voice.lang}）`;
    ttsVoiceSelect.appendChild(option);
  });
  ttsVoiceSelect.value = speech.voiceURI || '';

  // 日本語音声が1つも無いと日本語は読み上げられない。原因が分かるよう明示する
  const hasJa = voices.some(v => (v.lang || '').toLowerCase().startsWith('ja'));
  if (ttsStatus && voices.length && !hasJa) {
    ttsStatus.textContent =
      '日本語の音声がこのパソコンに見つかりません。Windowsの「設定 → 時刻と言語 → 音声認識」から日本語の音声を追加すると読み上げられるようになります。';
  }
}

function applyTtsSettings(settings) {
  speech.mode = settings.ttsMode || 'builtin';
  speech.rate = Number(settings.ttsRate) || 1.5;
  speech.voiceURI = settings.ttsVoiceURI || '';
  speech.autoRead = settings.ttsAutoRead !== false;

  if (ttsModeSelect) ttsModeSelect.value = speech.mode;
  if (ttsRateSelect) ttsRateSelect.value = String(speech.rate);
  if (ttsAutoRead) ttsAutoRead.checked = speech.autoRead;
}

async function persistTtsSettings() {
  appSettings = await window.electronAPI.saveSettings({
    ttsMode: speech.mode,
    ttsRate: speech.rate,
    ttsVoiceURI: speech.voiceURI,
    ttsAutoRead: speech.autoRead
  });
}

if (ttsModeSelect) {
  ttsModeSelect.addEventListener('change', () => {
    speech.mode = ttsModeSelect.value;
    stopSpeech();
    persistTtsSettings();
    const label = ttsModeSelect.options[ttsModeSelect.selectedIndex].textContent;
    if (ttsStatus) ttsStatus.textContent = `読み上げ方法を「${label}」にしました。`;
    if (speech.mode !== 'off') speakNow('読み上げ方法を変更しました。');
  });
}

if (ttsVoiceSelect) {
  ttsVoiceSelect.addEventListener('change', () => {
    speech.voiceURI = ttsVoiceSelect.value;
    persistTtsSettings();
    speakNow('この音声で読み上げます。');
  });
}

if (ttsRateSelect) {
  ttsRateSelect.addEventListener('change', () => {
    speech.rate = Number(ttsRateSelect.value) || 1.5;
    persistTtsSettings();
    speakNow('この速さで読み上げます。');
  });
}

if (ttsAutoRead) {
  ttsAutoRead.addEventListener('change', () => {
    speech.autoRead = ttsAutoRead.checked;
    persistTtsSettings();
    if (ttsStatus) {
      ttsStatus.textContent = speech.autoRead
        ? '認識結果を自動で読み上げます。'
        : '自動読み上げを止めました。読み上げボタンか Enter キーで読み上げられます。';
    }
  });
}

// 読み上げテスト。「音声が入っていない」のか「実装が動いていない」のかを
// テスターが自分で切り分けられるようにする
if (ttsTestBtn) {
  ttsTestBtn.addEventListener('click', async () => {
    const voices = refreshVoices();
    const chosen = pickVoice();
    const engine = speech.mode === 'system' ? 'OS標準の音声合成' : 'Glance内蔵の音声合成';
    const detail = speech.mode === 'system'
      ? `${engine}でテストします。`
      : `${engine}でテストします。検出された音声は${voices.length}件、` +
        `使用する音声は${chosen ? chosen.name : '自動選択（日本語音声が見つかりません）'}です。`;

    if (ttsStatus) ttsStatus.textContent = detail;

    if (speech.mode === 'off') {
      const message = '読み上げ方法が「読み上げない」になっています。テストするには設定を変更してください。';
      if (ttsStatus) ttsStatus.textContent = message;
      announce(message);
      return;
    }

    stopSpeech();
    enqueueSpeech('読み上げのテストです。この音声が聞こえていれば、読み上げは正しく動いています。');
  });
}

// 音声一覧は非同期に読み込まれるため、届いた時点で選択肢を作り直す
if (speechAvailable()) {
  window.speechSynthesis.addEventListener('voiceschanged', populateVoiceOptions);
}

async function initSettings() {
  appSettings = await window.electronAPI.getSettings();
  if (imageSizeSelect && appSettings.imageMaxSize) {
    imageSizeSelect.value = appSettings.imageMaxSize;
  }
  applyTtsSettings(appSettings);
  populateVoiceOptions();
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
