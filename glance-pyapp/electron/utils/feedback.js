import os from 'os';

/**
 * ご意見・不具合の送信
 *
 * 以前は GitHub の Issue で受け付けていたが、GitHub のアカウント作成と
 * Issue の画面は、スクリーンリーダーの利用者には手順が多く難しかった。
 * Glance の画面から書いて送れるように、Google フォームへ直接送る。
 *
 * GitHub のトークンをアプリに入れると誰でも取り出せるため使わない。
 * フォームの URL は公開してよいもので、できるのは回答を送ることだけ。
 * 回答はフォームの持ち主のスプレッドシートとメールに届く。
 *
 * 画面の画像と説明の文は送らない（「画面は外に送らない」という約束のため）。
 */

const FORM_ID = '1FAIpQLSdWVYUHsIb-B-35mfaPNddtYoOsTRok1CKnpYhg4sfBNIKNHg';
const FORM_RESPONSE_URL = `https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`;
const ENTRY = {
  message: 'entry.1781464034',
  contact: 'entry.1556522734',
  diagnostics: 'entry.874264929'
};

const SEND_TIMEOUT_MS = 15000;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 8000;

/**
 * 動作の記録（直近のログ）
 *
 * report-bug.bat は起動用 bat のログを送っていたが、配布版には bat が無い。
 * メインプロセスの console 出力（バックエンドの出力も含む）を手元に残しておく。
 */
const recentLogs = [];

// 画面の内容が分かる行は記録に残さない。説明の文（app.py の「最終結果」）と
// 質問の文（main.js の「質問を受信」）が該当する
const PRIVATE_LINE_PATTERNS = [/最終結果/, /質問を受信/];

// 起動待ちの間、数百ミリ秒ごとに出る行。記録が埋まって肝心の行が押し出される
const NOISE_LINE_PATTERNS = [/GET \/status/, /\[Status Check\]/, /推論継続音|設定されたサウンド/];

function recordLog(args) {
  const text = args
    .map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  const time = new Date().toTimeString().slice(0, 8);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (PRIVATE_LINE_PATTERNS.some(p => p.test(line))) continue;
    if (NOISE_LINE_PATTERNS.some(p => p.test(line))) continue;
    recentLogs.push(`${time} ${line}`);
  }
  if (recentLogs.length > MAX_LOG_LINES) recentLogs.splice(0, recentLogs.length - MAX_LOG_LINES);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * console.log / warn / error を、元の出力はそのままに記録にも残す
 */
export function startLogRecording() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      recordLog(args);
      original(...args);
    };
  }
}

// ログに出るパスから利用者名を消す（C:\Users\山田\... や /Users/yamada/...）
function maskUserName(text) {
  const home = os.homedir();
  let masked = text.split(home).join('~');
  masked = masked.replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1<user>');
  return masked.replace(/(\/Users\/)[^/\s]+/g, '$1<user>');
}

/**
 * 診断情報。フォームの「診断情報」欄に入る
 * @param {Object} info - main.js が知っている状態（版、設定など）
 */
export function buildDiagnostics(info = {}) {
  const totalGB = (os.totalmem() / 1024 ** 3).toFixed(1);
  const freeGB = (os.freemem() / 1024 ** 3).toFixed(1);
  const cpus = os.cpus();
  const lines = [
    `Glance: ${info.appVersion || '不明'}${info.isPackaged === false ? '（開発版）' : ''}`,
    `OS: ${os.type()} ${os.release()} (${os.arch()})`,
    `CPU: ${cpus[0]?.model?.trim() || '不明'} / ${cpus.length} スレッド`,
    `メモリ: ${totalGB} GB（空き ${freeGB} GB）`,
    `AI の状態: ${info.backendState || '不明'}`,
    `読み上げ方法: ${info.ttsMode || '不明'} / 画像解像度: ${info.imageMaxSize || '不明'}`,
    `ホットキー: ${info.hotkeys ? Object.values(info.hotkeys).join(', ') : '不明'}`
  ];

  let log = recentLogs.join('\n');
  if (log.length > MAX_LOG_CHARS) log = '...(省略)...\n' + log.slice(log.length - MAX_LOG_CHARS);

  return maskUserName(`${lines.join('\n')}\n\n--- 動作の記録 ---\n${log || '(なし)'}`);
}

/**
 * フォームへ送る
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendFeedback({ message, contact, diagnostics }) {
  const body = new URLSearchParams({
    [ENTRY.message]: message,
    [ENTRY.contact]: contact || '',
    [ENTRY.diagnostics]: diagnostics || ''
  });

  try {
    const response = await fetch(FORM_RESPONSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (response.ok) return { ok: true };
    console.error(`❌ ご意見の送信に失敗しました: HTTP ${response.status}`);
    return { ok: false, reason: 'server' };
  } catch (error) {
    console.error('❌ ご意見の送信に失敗しました:', error.message);
    return { ok: false, reason: 'network' };
  }
}
