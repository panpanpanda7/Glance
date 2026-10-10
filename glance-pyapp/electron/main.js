import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import { captureFullScreen } from './utils/screenshot.js';
import { speak, stopSpeaking } from './utils/tts.js';
import { startLogRecording, buildDiagnostics, sendFeedback } from './utils/feedback.js';
import { 
  playCaptureSound, 
  playDetailedSound, 
  playQuestionSound, 
  startProgressSound, 
  stopProgressSound, 
  playErrorSound,
  playStartupSound
} from './utils/sounds.js';

// ご意見の送信で添える「動作の記録」のため、最初のログから残しておく
startLogRecording();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 二重起動の防止
 *
 * 前回の Glance が残ったまま起動すると、ホットキーは先に登録した側の
 * プロセスが受け取る。そちらのバックエンドは終了済みなので、押しても
 * 「Pythonバックエンドが起動していません」としか言わなくなる。
 * 画面が見えない利用者には、二重に起動していること自体が分からない。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('⚠️  Glance は既に起動しています。二重起動を中止します。');
  app.quit();
}

// グローバル変数
let mainWindow = null;
let questionOverlayWindow = null; // 質問入力用の透明オーバーレイウィンドウ
let tray = null;
let pythonProcess = null;
let pythonExitCode = null;      // バックエンドが自ら終了したときの終了コード（起動待ちの打ち切り用）
let lastBackendDetail = null;   // バックエンドが出力した最後のエラー内容（利用者への説明用）
let isProcessing = false;
let isSpeaking = false;         // 画面側で読み上げ中か（レンダラーから通知される）
let isPythonReady = false;

/**
 * 現在の対象画像。G（画面を説明）または P（事前キャプチャ）で更新され、
 * D（詳細）と Q（質問）は撮り直さず必ずこれを使う。
 *
 * 撮り直さないのは2つの理由による:
 *  1. G で聞いた画面と D / Q の対象がズレる問題をなくす（テスターからの報告）
 *  2. 画像バイト列が変わらない限り llama-server の KV キャッシュが再利用され、
 *     重い画像エンコード + prefill をやり直さずに済む
 *
 * { id: sha256, base64: string, capturedAt: number, registered: boolean }
 */
let currentImage = null;

/**
 * /analyze-stream を SSE で消費し、文の区切りごとに analysis-result を逐次送る。
 * 全文の完成を待たず「第一文を TTFT(数秒)で表示」できるため体感が大幅に速くなる。
 *
 * 各フレームは JSON ({"t": 差分} / {"done": true} / {"error": "..."})。
 * 以前は本文をそのまま "data: {本文}" に埋めていたため、モデル出力に改行が
 * 含まれるとフレーム境界がずれ、後続チャンクが黙って捨てられていた
 * （「説明が途中で消える」の原因）。
 *
 * @param {object} body リクエストボディ(imageId / [image] / promptType / [question] / imageMaxSize)
 * @param {object} resultMeta analysis-result に付与する追加情報(isDetailed / isQuestion / question)
 * @returns {Promise<string>} 最終的な全文
 */
async function streamAnalyze(body, resultMeta) {
  const controller = new AbortController();
  abortController = controller;
  try {
    return await streamAnalyzeInner(body, resultMeta, controller);
  } catch (error) {
    // 利用者が Esc で止めたのは失敗ではない。エラー音も「エラー」の表示も出さない
    if (controller.signal.aborted) {
      console.log('🛑 利用者の指示で生成を止めました');
      return '';
    }
    throw error;
  }
}

async function streamAnalyzeInner(body, resultMeta, controller) {
  const response = await fetch(`${PYTHON_API_URL}/analyze-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  // 409 = バックエンド側で imageId が失効している。画像を添えて1度だけ再送する
  if (response.status === 409 && !body.image && currentImage) {
    console.log('♻️ imageId が失効していたため画像を再送します');
    return streamAnalyze({ ...body, image: currentImage.base64 }, resultMeta);
  }
  if (!response.ok || !response.body) {
    throw new Error(`サーバーエラー (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  let sentCount = -1;      // 送信済みの文区切り数(チラつき防止のスロットル用)
  let firstToken = true;
  let stoppedBy = null;    // 'loop'（繰り返しで打ち切り）| 'length'（上限に到達）

  const pushResult = (done) => {
    if (!mainWindow) return;
    mainWindow.webContents.send('analysis-result', {
      text: full,
      timestamp: new Date().toISOString(),
      streaming: !done,
      stoppedBy: done ? stoppedBy : null,
      ...resultMeta
    });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!line.startsWith('data: ')) continue;

      let frame;
      try {
        frame = JSON.parse(line.slice(6));
      } catch (e) {
        console.warn('⚠️ SSEフレームの解析に失敗しました:', line.slice(0, 80));
        continue;
      }

      if (frame.error) throw new Error(frame.error || '推論エラー');
      if (frame.done) {
        // 完了フレームには確定版の本文が入る。重複除去・繰り返しの打ち切り・
        // 尻切れの丸めが反映されているので、こちらで置き換える
        if (typeof frame.text === 'string' && frame.text) full = frame.text;
        stoppedBy = frame.stoppedBy || null;
        pushResult(true);
        return full;
      }
      if (typeof frame.t !== 'string') continue;

      if (firstToken) { stopProgressSound(); firstToken = false; } // 応答開始で継続音を止める
      full += frame.t;
      // 文区切り(。！？)が増えたときだけ再描画してチラつきを抑える
      const terms = (full.match(/[。！？]/g) || []).length;
      if (terms > sentCount) { sentCount = terms; pushResult(false); }
    }
  }
  pushResult(true);
  return full;
}

/**
 * キャプチャする長辺の上限を決める
 *
 * バックエンドは imageMaxSize（既定896px）まで縮小してからモデルへ渡すため、
 * その2倍より大きく撮っても認識精度は上がらず、PNGエンコードと転送の時間
 * だけが増える（実測: 2940px で 330ms / 2.7MB）。2倍あれば縮小時の品質は
 * 十分に保たれる。「原寸」設定のときだけ上限を外す。
 *
 * @returns {number|undefined} 長辺の上限。undefined ならディスプレイの実ピクセル数
 */
function getCaptureLongEdge() {
  const setting = appSettings.imageMaxSize;
  if (setting === 'none') return undefined;
  const target = parseInt(setting, 10);
  return Number.isFinite(target) ? target * 2 : 1792;
}

/**
 * 画面をキャプチャして currentImage を更新する
 *
 * 画像IDは Base64 の SHA-256。バックエンドと同じ値になるため、以降は
 * ID だけを送れば済み、1MB弱の Base64 を毎回往復させずに済む。
 *
 * @returns {Promise<object>} currentImage
 */
async function captureAndStore() {
  const base64 = await captureFullScreen({ maxLongEdge: getCaptureLongEdge() });
  const id = crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  currentImage = { id, base64, capturedAt: Date.now(), registered: false };
  return currentImage;
}

/**
 * 分析リクエストのボディを組み立てる
 * 初回（バックエンド未登録）のみ Base64 を添付し、2回目以降は ID のみ送る
 */
function buildAnalyzeBody(promptType, extra = {}) {
  const body = {
    imageId: currentImage.id,
    promptType,
    imageMaxSize: appSettings.imageMaxSize,
    ...extra
  };
  if (!currentImage.registered) {
    body.image = currentImage.base64;
    currentImage.registered = true;
  }
  return body;
}
let abortController = null; // 推論中断用のAbortController

// バックエンド（Flask）のポート。保存してあるポート（なければ既定のポート）を
// 先に試し、別のソフトが使っているときだけ別のポートに移って、その番号を
// 保存する（resolveBackendPort）。考え方は python-backend/ports.py と同じ。
const DEFAULT_BACKEND_PORT = 5001;
// 移る先のポートを選ぶ範囲。OS が通信に一時的に割り当てる範囲
// （Windows・macOS は 49152〜65535）の番号を保存して使い続けると、
// ブラウザなどの通信といつか重なるため、それより下から選ぶ
const PERSISTENT_PORT_RANGE = [20000, 30000];
// バックエンドがポート使用中で起動できなかったときの終了コード（app.py と合わせる）
const PORT_IN_USE_EXIT_CODE = 3;
let backendPort = DEFAULT_BACKEND_PORT;
let PYTHON_API_URL = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
// ポートが決まるまでは画面側に URL を渡さない。決まる前に既定のポートへ
// 問い合わせると、前回の残りや別のソフトの応答を読んでしまうため
let backendUrlResolved = false;

function setBackendPort(port) {
  backendPort = port;
  PYTHON_API_URL = `http://127.0.0.1:${port}`;
}

// ==========================================
// 設定管理
// ==========================================
// ホットキーは設定で変更できる。スクリーンリーダー（PC-Talker 等）や
// 常用アプリと衝突した場合に、利用者の手元で逃がせるようにするため。
const HOTKEY_DEFAULTS = {
  capture: 'CommandOrControl+Shift+G',   // 画面を説明（キャプチャあり）
  // 画面をひとことで（キャプチャあり・1文だけ）。
  // 当初の S は多くのアプリの「名前を付けて保存」とぶつかるため避けた。
  // 0.3.3 では H、0.3.5 から F
  overview: 'CommandOrControl+Shift+F',
  detailed: 'CommandOrControl+Shift+D',  // 詳しく説明（キャプチャしない）
  question: 'CommandOrControl+Shift+Q',  // 画面へ質問（キャプチャしない）
  prepare: 'CommandOrControl+Shift+P'    // 事前キャプチャ（出力なし・裏で準備）
};

// 以前の版の既定値。保存済みの設定には、変更していないキーも既定値のまま
// 書き込まれている（saveSettings が全キーを保存するため）。既定値を変えても
// それだけでは既存の利用者に届かないので、以前の既定値が残っていれば
// 新しい既定値に置き換える（loadSettings）
const LEGACY_HOTKEY_DEFAULTS = {
  overview: ['CommandOrControl+Shift+H']
};

function migrateHotkeys(hotkeys) {
  for (const [name, legacyValues] of Object.entries(LEGACY_HOTKEY_DEFAULTS)) {
    if (legacyValues.includes(hotkeys[name])) {
      hotkeys[name] = HOTKEY_DEFAULTS[name];
    }
  }
  return hotkeys;
}

const SETTINGS_DEFAULTS = {
  imageMaxSize: '896',  // '448'|'672'|'896'|'1120'|'1344'|'none'。896が精度を落とさず軽い既定
  guideShown: false,    // 初回認識後の「詳細・質問」案内を表示済みか（インストール後1回のみ）
  // 読み上げ。既定はレンダラーの Web Speech API（'builtin'）。
  // 'system' は OS 標準の音声合成（PowerShell/say 経由）、'off' は
  // スクリーンリーダーに任せて Glance からは喋らない
  ttsMode: 'builtin',
  ttsRate: 1.5,
  ttsVoiceURI: '',
  ttsAutoRead: true,
  hotkeys: { ...HOTKEY_DEFAULTS },
  // バックエンドのポート。別のソフトが既定のポートを使っていて移ったときだけ
  // 入る。次の起動からはこのポートを最初に試す（resolveBackendPort）
  backendPort: null
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    const saved = JSON.parse(raw);
    return {
      ...SETTINGS_DEFAULTS,
      ...saved,
      // hotkeys は入れ子なので個別にマージする。
      // 浅いマージだと、保存済みファイルに一部のキーしか無い場合に
      // 残りが undefined になり登録が失敗する。
      hotkeys: migrateHotkeys({ ...HOTKEY_DEFAULTS, ...(saved.hotkeys || {}) })
    };
  } catch {
    return { ...SETTINGS_DEFAULTS, hotkeys: { ...HOTKEY_DEFAULTS } };
  }
}

function saveSettings(settings) {
  // 既存の保存値とマージする（部分更新で他のキーが既定値に戻らないように）
  const current = loadSettings();
  const merged = {
    ...current,
    ...settings,
    hotkeys: { ...current.hotkeys, ...(settings.hotkeys || {}) }
  };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

let appSettings = loadSettings();

/**
 * そのポートで何かが接続を受け付けているか
 *
 * bind ではなく connect で調べる。Windows では、他のソフトが 0.0.0.0 で
 * 待ち受けているポートにも 127.0.0.1 で bind できてしまうことがあり、
 * bind の成否では「誰も使っていない」と判断できないため（ports.py と同じ）。
 */
function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * OS に空いているポートを割り当ててもらう
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * そのポートで待ち受けられるか
 */
function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * 保存して使い続けるためのポートを選ぶ
 *
 * PERSISTENT_PORT_RANGE から、接続を受け付けておらず、実際に待ち受けられる
 * 番号を選ぶ。見つからなければ OS に割り当ててもらう。
 */
async function findPersistentPort() {
  const [low, high] = PERSISTENT_PORT_RANGE;
  for (let i = 0; i < 100; i++) {
    const port = low + Math.floor(Math.random() * (high - low));
    if (await isPortInUse(port)) continue;
    if (await canListen(port)) return port;
  }
  return findFreePort();
}

/**
 * 別のポートへ移ったことを保存する。次の起動からはこのポートを最初に試す
 */
function rememberBackendPort(port) {
  try {
    appSettings = saveSettings({ backendPort: port });
  } catch (e) {
    console.warn(`⚠️ バックエンドのポートを保存できませんでした: ${e.message}`);
  }
}

/**
 * 指定のポートで応答しているのが Glance のバックエンドなら、その状態を返す
 *
 * 新しい版は /status に app と pid を含める。前の版（更新の直前まで
 * 動いていたもの）には無いので、/status の項目の組み合わせでも見分ける。
 */
async function getLeftoverBackendStatus(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    const isGlance = data && (
      data.app === 'glance-backend' ||
      (typeof data.status === 'string' && 'progress' in data && 'message' in data && 'detail' in data)
    );
    return isGlance ? data : null;
  } catch (e) {
    return null;
  }
}

async function waitUntilPortFree(port, seconds) {
  for (let i = 0; i < seconds * 5; i++) {
    if (!await isPortInUse(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return !await isPortInUse(port);
}

/**
 * バックエンドに使うポートを決める
 *
 * 1. 保存してあるポート（なければ既定のポート）が空いていればそれを使う
 * 2. 前回の Glance のバックエンドが残っていれば、終わらせてからそのポートを使う。
 *    更新の直後などに起きる。残りを理由に別のポートへ移ると、残ったバックエンドと
 *    そのモデルがメモリを抱えたまま二重に動くため、移らない
 * 3. 別のソフトが使っているときだけ別のポートに移り、その番号を保存する
 */
async function resolveBackendPort() {
  const preferred = appSettings.backendPort || DEFAULT_BACKEND_PORT;
  if (!await isPortInUse(preferred)) return preferred;

  const leftover = await getLeftoverBackendStatus(preferred);
  if (leftover) {
    console.log('⚠️  前回の Glance のバックエンドが残っています。終了を待ちます...');
    if (mainWindow) {
      mainWindow.webContents.send('log-message',
        '[INFO] 前回のバックエンドが残っています。終了を待っています...');
    }
    // 残ったバックエンドは、親プロセスの終了に気づくと2秒以内に自分で終了する
    if (await waitUntilPortFree(preferred, 5)) return preferred;

    // それでも残っていれば止める。pid は新しい版だけが返す
    if (leftover.pid) {
      try { process.kill(leftover.pid); } catch (e) { /* 既に終了している */ }
    } else {
      try {
        await fetch(`http://127.0.0.1:${preferred}/shutdown`, {
          method: 'POST', signal: AbortSignal.timeout(3000)
        });
      } catch (e) { /* 応答なしでも続ける */ }
    }
    if (await waitUntilPortFree(preferred, 10)) return preferred;

    throw new Error(
      '前回の Glance が終了できませんでした。\n' +
      'パソコンを再起動してから、Glance を起動してください。'
    );
  }

  const port = await findPersistentPort();
  rememberBackendPort(port);
  console.log(`ℹ️  ポート ${preferred} は別のソフトが使用中のため、ポート ${port} を使います`);
  if (mainWindow) {
    mainWindow.webContents.send('log-message',
      `[INFO] ポート ${preferred} は別のソフトが使用中のため、ポート ${port} を使います`);
  }
  return port;
}

/**
 * Pythonバックエンドを起動
 */
async function startPythonBackend() {
  console.log('🐍 Python Backendを起動中...');
  pythonExitCode = null;
  lastBackendDetail = null;
  
  // 起動中の断続音を開始
  startProgressSound();

  setBackendPort(await resolveBackendPort());
  backendUrlResolved = true;
  
  const isDev = process.argv.includes('--dev');
  let executablePath, args, cwd;
  
  if (isDev) {
    // 開発環境：venv内のPythonを使用（Windows/macOS共通）
    const isWin = process.platform === 'win32';
    const pythonBin = isWin
      ? path.join(__dirname, '..', 'python-backend', 'venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', 'python-backend', 'venv', 'bin', 'python3');
    executablePath = pythonBin;
    const scriptPath = path.join(__dirname, '..', 'python-backend', 'app.py');
    args = [scriptPath];
    cwd = path.dirname(scriptPath);
  } else {
    // 本番環境：PyInstallerでビルドされたEXEを使用
    const resourcesPath = process.resourcesPath;
    const backendDir = path.join(resourcesPath, 'glance-backend');
    executablePath = path.join(backendDir, 'glance-backend.exe');
    args = [];
    cwd = backendDir;
  }
  
  console.log(`   実行ファイル: ${executablePath}`);
  console.log(`   作業ディレクトリ: ${cwd}`);
  
  // レンダラーにパス情報を送信
  if (mainWindow) {
    mainWindow.webContents.send('log-message', `[INFO] 実行ファイルパス: ${executablePath}`);
    mainWindow.webContents.send('log-message', `[INFO] 作業ディレクトリ: ${cwd}`);
    mainWindow.webContents.send('log-message', `[INFO] 開発モード: ${isDev ? '有効' : '無効'}`);
  }
  
  // 環境変数を設定（既存の環境変数を継承しつつ、PYTHONIOENCODINGを追加）
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  
  // 親プロセスのPIDを引数として渡す（孤児プロセス防止）
  args.push(`--parent-pid=${process.pid}`);

  // ポートを決めてから起動するまでの間に、別のソフトが同じポートを
  // 使い始めることがある。そのときはバックエンドが終了コード 3 で
  // 終わるので、空いているポートでやり直す
  for (let attempt = 1; ; attempt++) {
    spawnPythonBackend(executablePath, [...args, `--port=${backendPort}`], cwd, env);
    try {
      await waitForPythonBackend();
      return;
    } catch (error) {
      if (pythonExitCode !== PORT_IN_USE_EXIT_CODE || attempt >= 3) throw error;
      setBackendPort(await findPersistentPort());
      rememberBackendPort(backendPort);
      console.log(`ℹ️  ポートが使用中だったため、ポート ${backendPort} で起動し直します`);
    }
  }
}

/**
 * バックエンドのプロセスを起動し、出力と終了を見張る
 */
function spawnPythonBackend(executablePath, args, cwd, env) {
  pythonExitCode = null;
  lastBackendDetail = null;

  pythonProcess = spawn(executablePath, args, {
    stdio: 'pipe', // 'inherit'から'pipe'に変更して出力をキャプチャ
    cwd: cwd,
    env: env, // 環境変数を指定
    windowsHide: true // コンソール窓を出さない（出ると利用者の作業中の窓から焦点を奪う）
  });
  
  // 標準出力をキャプチャしてレンダラーに送信
  pythonProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('[Python STDOUT]', output);

    // バックエンドが起動できずに終了したとき、その理由を利用者へそのまま
    // 見せられるように控えておく（ポート競合・モデル読み込み失敗など）
    if (output.includes('❌')) {
      lastBackendDetail = output
        .split('\n')
        .filter(line => line.trim() && !line.startsWith('='))
        .join('\n')
        .trim();
    }

    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[STDOUT] ${output.trim()}`);
    }
  });
  
  // 標準エラー出力をキャプチャしてレンダラーに送信
  pythonProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.error('[Python STDERR]', output);
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[STDERR] ${output.trim()}`);
    }
  });
  
  pythonProcess.on('error', (err) => {
    console.error('❌ Python起動エラー:', err);
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[ERROR] Python起動エラー: ${err.message}`);
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `Pythonバックエンドの起動に失敗: ${err.message}`
      });
    }
  });
  
  pythonProcess.on('exit', (code) => {
    console.log(`⚠️  Pythonプロセスが終了しました (code: ${code})`);
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[INFO] Pythonプロセスが終了しました (終了コード: ${code})`);
    }
    isPythonReady = false;
    // 起動待ちループに終了を伝える。これが無いと、バックエンドが
    // 即死しても「起動処理中...」のまま300秒待たされる
    pythonExitCode = code;
  });
  
  if (mainWindow) {
    mainWindow.webContents.send('log-message', '[INFO] Python起動コマンドを実行しました');
  }
}

/**
 * Pythonバックエンドの起動を待つ
 */
let progressSoundPausedForDownload = false;

async function waitForPythonBackend() {
  console.log('⏳ Pythonバックエンドの起動を待機中...');
  
  if (mainWindow) {
    mainWindow.webContents.send('log-message', '[INFO] バックエンドの状態確認を開始します');
  }
  
  const maxRetries = 300; // 最大300秒
  const initializingTimeoutThreshold = 60; // initializing が60秒以上続いたら異常と判定
  let initializingStartTime = null;
  
  for (let i = 0; i < maxRetries; i++) {
    // バックエンドが自ら終了していたら、待ち続けても意味がない。
    // ポート競合など、起動直後に終了する不具合を即座に伝える
    if (pythonExitCode !== null) {
      const detail = lastBackendDetail ? `\n\n${lastBackendDetail}` : '';
      throw new Error(
        `Pythonバックエンドが起動直後に終了しました（終了コード: ${pythonExitCode}）${detail}`
      );
    }

    // 【通信部分のみを try/catch で囲む】
    let data;
    try {
      const response = await fetch(`${PYTHON_API_URL}/status`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      data = await response.json();
    } catch (e) {
      // ネットワーク失敗：まだサーバーが起動していないか通信エラー
      if (mainWindow && i % 10 === 0) {
        mainWindow.webContents.send('log-message', `[INFO] バックエンド起動処理中... (${i}秒経過)`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;  // ここで continue する
    }
    
    // 【ここからは状態判定。catch の外で行う】
    const status = data.status;
    console.log(`[Status Check] ${status} - message: ${data.message}`);
    
    // ステータスに応じた処理
    if (status === 'ready') {
      // 自分が起動したプロセスが既に死んでいるのに ready が返るのは、
      // 前回の Glance が残っていて、そちらが応答している状態。
      // ここで気づかないと、別プロセスのモデルを操作しているのに
      // 正常起動したように見えてしまう。
      if (pythonExitCode !== null) {
        throw new Error(
          `別の Glance が既に起動しているようです（このプロセスは終了コード ${pythonExitCode} で終了）。\n` +
          `update-and-run.bat から起動し直すと、残ったプロセスを停止してからクリーンに起動します。`
        );
      }

      console.log('✅ Pythonバックエンドが準備完了しました');
      if (mainWindow) {
        mainWindow.webContents.send('log-message', '[SUCCESS] バックエンド起動完了（モデルロード済み）');
      }
      isPythonReady = true;
      return;
    }
    else if (status === 'downloading' || status === 'loading_model') {
      // ダウンロード中は2秒おきの進行音を止める。30分近く鳴り続けると、
      // その間ほかの仕事をしている利用者の邪魔になる（テスターからの報告）。
      // 進み具合は画面側が25%ごとに音声で伝える。AIの起動に移ったら鳴らし直す
      if (status === 'downloading' && !progressSoundPausedForDownload) {
        stopProgressSound();
        progressSoundPausedForDownload = true;
      } else if (status === 'loading_model' && progressSoundPausedForDownload) {
        startProgressSound();
        progressSoundPausedForDownload = false;
      }
      // ダウンロード・ロード中：待機継続
      if (mainWindow && i % 5 === 0) { // 5秒ごとに通知
        mainWindow.webContents.send('log-message', `[INFO] ${data.message} (${i}秒経過)`);
        if (data.detail) {
          mainWindow.webContents.send('log-message', `[INFO]   詳細: ${data.detail}`);
        }
      }
      // initializing タイマーをリセット
      initializingStartTime = null;
    }
    else if (status === 'error') {
      // エラー：即座に失敗（catch で握りつぶされない）
      console.error('❌ バックエンドがエラー状態です');
      if (mainWindow) {
        mainWindow.webContents.send('log-message', `[ERROR] バックエンドエラー: ${data.message}`);
        if (data.detail) {
          mainWindow.webContents.send('log-message', `[ERROR] 詳細: ${data.detail}`);
        }
      }
      throw new Error(`Pythonバックエンドエラー: ${data.message}${data.detail ? ' - ' + data.detail : ''}`);
    }
    else if (status === 'initializing') {
      // initializing が一定時間以上続いたら異常扱い
      if (initializingStartTime === null) {
        initializingStartTime = i;
      }
      
      const initializingElapsed = i - initializingStartTime;
      if (initializingElapsed >= initializingTimeoutThreshold) {
        // ハング状態：即座に失敗（catch で握りつぶされない）
        console.error(`❌ initializing が${initializingTimeoutThreshold}秒以上続いています`);
        if (mainWindow) {
          mainWindow.webContents.send('log-message', `[ERROR] バックエンド初期化がハング状態です（${initializingElapsed}秒継続中）`);
          if (data.detail) {
            mainWindow.webContents.send('log-message', `[ERROR] 詳細: ${data.detail}`);
          }
        }
        throw new Error(`Pythonバックエンド初期化がハング状態: ${initializingTimeoutThreshold}秒以上応答なし`);
      }
      
      // 通常のハング時間内：待機継続
      if (mainWindow && i % 10 === 0) {
        mainWindow.webContents.send('log-message', `[INFO] バックエンド初期化中... (${i}秒経過)`);
      }
    }
    else {
      // その他の未知状態
      if (mainWindow && i % 10 === 0) {
        mainWindow.webContents.send('log-message', `[INFO] バックエンド起動処理中... (ステータス: ${status}, ${i}秒経過)`);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('log-message', `[ERROR] バックエンド起動タイムアウト（${maxRetries}秒経過）`);
  }
  throw new Error('Pythonバックエンドの起動タイムアウト（300秒）');
}

/**
 * メインウィンドウを作成
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 700,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
  });

  mainWindow.loadFile('index.html');

  // 常駐中に窓を作り直したときは起動済みなので、「起動中」のままにしない
  mainWindow.webContents.on('did-finish-load', () => {
    if (isPythonReady && mainWindow) {
      mainWindow.webContents.send('status-update', { status: 'idle', message: '待機中' });
    }
  });

  // Glance 自身をキャプチャ対象から外す。
  // 常に最前面に出るため、対象アプリの上に被った状態で写り込み、
  // 「見えている画面と違うものを説明する」原因になっていた。
  // Windows 10 2004+ と macOS では、画面には見えたままキャプチャからだけ除外される。
  try {
    mainWindow.setContentProtection(true);
  } catch (error) {
    console.warn('⚠️ キャプチャ除外を設定できませんでした:', error.message);
  }

  // 画面側で起きたエラーをログへ流す。開発者ツールを開けない利用者の環境で
  // 不具合が起きたとき、report-bug に情報が残らないと原因を追えないため。
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return;  // 0=verbose, 1=info は拾わない
    const where = sourceId ? `${path.basename(sourceId)}:${line}` : '画面';
    const text = `[RENDERER] ${where} ${message}`;
    console.error(text);
    if (mainWindow) mainWindow.webContents.send('log-message', text);
  });

  if (process.argv.includes('--debug')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 質問用透明オーバーレイウィンドウを作成
 */
function createQuestionOverlayWindow() {
  if (questionOverlayWindow) {
    return; // 既に存在する場合は何もしない
  }

  questionOverlayWindow = new BrowserWindow({
    width: 500,
    height: 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    type: 'panel', // パネルタイプ（macOSで有効）
    vibrancy: 'under-window', // macOSのvibrancy効果
    webPreferences: {
      preload: path.join(__dirname, 'question-overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  questionOverlayWindow.loadFile('question-overlay.html');

  // 質問入力欄もキャプチャに写り込ませない
  try {
    questionOverlayWindow.setContentProtection(true);
  } catch (error) {
    console.warn('⚠️ オーバーレイのキャプチャ除外を設定できませんでした:', error.message);
  }

  questionOverlayWindow.on('closed', () => {
    questionOverlayWindow = null;
  });

  // 画面の中央上部に配置
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  questionOverlayWindow.setPosition(Math.round((width - 600) / 2), 100);
}

/**
 * 質問オーバーレイウィンドウを表示
 */
function showQuestionOverlay() {
  // 画像が無くても弾かない。質問送信時に ensureCurrentImage() が
  // その場で1枚撮るため、「押しても何も起きない」状態を作らない。
  createQuestionOverlayWindow();
  
  // showInactiveを使用してアクティブにせずに表示
  questionOverlayWindow.showInactive();
  
  // 少し遅延してからフォーカスを当てる（画面切り替えを最小限に）
  setTimeout(() => {
    questionOverlayWindow.focus();
  }, 50);
}

/**
 * 質問オーバーレイウィンドウを非表示
 */
function hideQuestionOverlay() {
  if (questionOverlayWindow) {
    questionOverlayWindow.hide();
  }
}

/**
 * システムトレイアイコンを作成
 */
/**
 * 説明書（docs/manual.txt）の場所。Glance の画面の中で読む（renderer.js）。
 * インストーラ版では resources/manual.txt に同梱している（package.json の extraResources）。
 */
function getManualPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'manual.txt')
    : path.join(__dirname, '..', '..', 'docs', 'manual.txt');
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let trayIcon;
  
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
  } catch (error) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Glanceを表示',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    {
      label: '画面を読み上げ',
      click: () => handleScreenCapture()
    },
    {
      label: '画面をひとことで',
      click: () => handleScreenCapture('overview')
    },
    {
      label: '事前キャプチャ（説明なし）',
      click: handlePrepareCapture
    },
    {
      label: '詳細分析',
      click: handleDetailedAnalysis
    },
    { type: 'separator' },
    {
      label: '読み上げを停止（Esc）',
      click: () => stopAll()
    },
    {
      label: 'ご意見・不具合を送る',
      click: () => {
        if (!mainWindow) createWindow();
        mainWindow.show();
        mainWindow.focus();
        if (mainWindow.webContents.isLoading()) {
          mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('show-feedback'));
        } else {
          mainWindow.webContents.send('show-feedback');
        }
      }
    },
    {
      label: '説明書を開く（F1）',
      click: () => {
        if (!mainWindow) createWindow();
        mainWindow.show();
        mainWindow.focus();
        // 窓を作り直した直後は画面の準備が済むまで待つ
        if (mainWindow.webContents.isLoading()) {
          mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('show-manual'));
        } else {
          mainWindow.webContents.send('show-manual');
        }
      }
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Glance - AI画面読み上げ');
  tray.setContextMenu(contextMenu);
}

/**
 * グローバルホットキーを登録（設定値を使用）
 *
 * 他アプリが既に握っているキーは register() が false を返す。その場合は
 * 黙って無効にせず、どのキーが取れなかったかを画面のログへ知らせる。
 * 利用者は設定画面から別のキーへ変更できる。
 *
 * @returns {Object} 各機能の登録可否
 */
function registerHotkeys() {
  globalShortcut.unregisterAll();

  const actions = {
    capture: () => { playCaptureSound(); handleScreenCapture(); },
    overview: () => { playCaptureSound(); handleScreenCapture('overview'); },
    prepare: () => { playCaptureSound(); handlePrepareCapture(); },
    detailed: () => { playDetailedSound(); handleDetailedAnalysis(); },
    question: () => { playQuestionSound(); showQuestionOverlay(); }
  };
  const labels = {
    capture: '画面を説明', overview: '画面をひとことで', prepare: '事前キャプチャ',
    detailed: '詳しく説明', question: '画面へ質問'
  };

  const results = {};
  for (const [name, handler] of Object.entries(actions)) {
    const accelerator = (appSettings.hotkeys && appSettings.hotkeys[name]) || HOTKEY_DEFAULTS[name];
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (error) {
      console.error(`❌ ホットキーの指定が不正です (${name}: ${accelerator}):`, error.message);
    }
    results[name] = { accelerator, ok };

    const line = ok
      ? `[INFO] ホットキー登録: ${labels[name]} = ${accelerator}`
      : `[WARN] ホットキーを登録できませんでした: ${labels[name]} = ${accelerator}（他のアプリが使用中の可能性があります。設定画面から変更できます）`;
    console.log(line);
    if (mainWindow) mainWindow.webContents.send('log-message', line);
  }

  // unregisterAll() で Esc も外れているので、いまの状態に合わせて付け直す
  updateStopHotkey();

  return results;
}

function setProcessing(value) {
  isProcessing = value;
  updateStopHotkey();
}

/**
 * 読み上げと推論をまとめて止める
 *
 * 読み上げだけ止めても推論が続いていると、次の文が届いた時点でまた
 * 読み始めてしまい、利用者には「止まらない」としか感じられない。
 */
function stopAll() {
  console.log('🛑 停止の指示を受けました');

  if (abortController) {
    console.log('🛑 推論を中断します');
    abortController.abort();
    abortController = null;
  }

  stopSpeaking();
  stopProgressSound();
  setProcessing(false);

  if (mainWindow) {
    mainWindow.webContents.send('stop-all');
    mainWindow.webContents.send('status-update', {
      status: 'idle',
      message: '待機中'
    });
  }
}

/**
 * 「Esc で止める」を、Glance がしゃべっている間だけ全体のキーとして登録する
 *
 * 説明は他のアプリを使っている最中に Ctrl+Shift+G で始まるので、Glance の
 * 窓の中でしか効かない Esc では止められなかった（利用者からの報告）。
 * かといって Esc を常に奪うと、ほかのアプリでダイアログを閉じられなくなる。
 * そこで読み上げ・推論の間だけ借り、終わったらすぐ返す。
 *
 * Glance の窓に焦点があるときは登録しない。窓の中では設定画面や質問欄を
 * 閉じるのにも Esc を使っており、全体のキーにすると窓まで届かなくなるため。
 * 窓の中の Esc は renderer.js 側で同じ停止処理を呼ぶ。
 */
function updateStopHotkey() {
  const busy = isProcessing || isSpeaking;
  const glanceFocused = BrowserWindow.getFocusedWindow() !== null;
  const want = busy && !glanceFocused;
  const has = globalShortcut.isRegistered('Escape');

  if (want && !has) {
    if (!globalShortcut.register('Escape', stopAll)) {
      console.warn('⚠️ 停止用の Esc を登録できませんでした（他のアプリが使用中の可能性があります）');
    }
  } else if (!want && has) {
    globalShortcut.unregister('Escape');
  }
}

// 窓を切り替えた直後は焦点の所在がまだ確定していないことがあるので、一拍置いて見る
app.on('browser-window-focus', () => setImmediate(updateStopHotkey));
app.on('browser-window-blur', () => setImmediate(updateStopHotkey));

/**
 * 画面キャプチャ＆読み上げのメイン処理
 *
 * @param {'standard'|'overview'} promptType
 *   standard … Ctrl+Shift+G。2〜4文で説明する
 *   overview … Ctrl+Shift+F。何の画面かだけを1文で。G より早く言い終わる
 *              （テスターからの要望。画面を切り替えた直後の確認用）
 */
async function handleScreenCapture(promptType = 'standard') {
  if (isProcessing) {
    console.log('⚠️  既に処理中です');
    return;
  }

  if (!isPythonReady) {
    console.log('⚠️  Pythonバックエンドが準備できていません');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: 'Pythonバックエンドが起動していません'
      });
    }
    return;
  }

  setProcessing(true);

  try {
    // チャット履歴にユーザー操作と応答プレースホルダーを追加させる
    if (mainWindow) {
      mainWindow.webContents.send('analysis-start', { type: promptType });
    }

    // キャプチャ中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'capturing',
        message: '画面をキャプチャ中...'
      });
    }

    // 新しい画面を撮り直す。以降の D / Q はこの画像をそのまま使う
    await captureAndStore();

    // 分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を分析中...'
      });
    }

    // 推論継続音を開始
    startProgressSound();

    // ストリーミングで解析（第一文が TTFT で届くので体感が速い）
    const description = await streamAnalyze(
      buildAnalyzeBody(promptType), { isDetailed: false }
    );
    console.log('📝 生成された説明:', description);

    // 推論継続音を停止（streamAnalyze 内で第一トークン時に停止済みだが念のため）
    stopProgressSound();

    // 完了
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }

    console.log('✅ 処理が完了しました');
    
  } catch (error) {
    console.error('❌ 処理中にエラーが発生しました:', error);
    
    // 推論継続音を停止
    stopProgressSound();
    
    // エラー音を再生
    playErrorSound();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `エラー: ${error.message}`
      });
    }
  } finally {
    setProcessing(false);
  }
}

/**
 * 事前キャプチャ処理（P）
 *
 * 説明の出力は行わず、「今の画面」を記録するだけ。そのあと D / Q を押すと
 * この画像に対して答える。
 *
 * ユーザーが待っていないこのタイミングで、後続で効く重い準備を先に済ませる:
 *   - 画面キャプチャ（正しいディスプレイの選択を含む）
 *   - バックエンドへの画像登録（以降 D / Q は ID だけ送れば済む）
 *   - リサイズ + PNG エンコード
 *   - llama-server の KV キャッシュへ画像プレフィックスを焼き込む（prewarm）
 *
 * 実測（Qwen3-VL-4B / Metal / 896px）:
 *   D の初動 3.83s → 1.61s (-58%) 、Q の初動 2.78s → 0.58s (-79%)
 */
async function handlePrepareCapture() {
  if (isProcessing) {
    console.log('⚠️ 既に処理中です');
    return;
  }

  if (!isPythonReady) {
    console.log('⚠️ Pythonバックエンドが準備できていません');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: 'Pythonバックエンドが起動していません'
      });
    }
    return;
  }

  setProcessing(true);

  try {
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'capturing',
        message: '画面を記録中...'
      });
    }

    const image = await captureAndStore();

    const response = await fetch(`${PYTHON_API_URL}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageId: image.id,
        image: image.base64,
        imageMaxSize: appSettings.imageMaxSize
      })
    });
    if (!response.ok) {
      throw new Error(`サーバーエラー (HTTP ${response.status})`);
    }
    const result = await response.json();
    currentImage.registered = true;
    console.log(`📌 事前キャプチャ完了 (prewarm: ${result.prewarmed ? '実行中' : 'スキップ'})`);

    // 画面が見えない利用者には「撮れたかどうか」が分からないため、
    // 記録できたことを履歴に残して読み上げられるようにする
    if (mainWindow) {
      mainWindow.webContents.send('capture-prepared', {
        timestamp: new Date(image.capturedAt).toISOString()
      });
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }
  } catch (error) {
    console.error('❌ 事前キャプチャ中にエラーが発生しました:', error);
    playErrorSound();
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `エラー: ${error.message}`
      });
    }
  } finally {
    setProcessing(false);
  }
}

/**
 * D / Q が使う対象画像を確保する
 *
 * G / P を一度も押していない状態でも無反応にはせず、その場で1枚撮って続行する。
 * （以前の Q は画像が無いと何も起こらず、原因も分からなかった）
 *
 * @returns {Promise<boolean>} 新規に撮ったかどうか
 */
async function ensureCurrentImage() {
  if (currentImage) return false;
  console.log('ℹ️ 対象画像が無いため、その場でキャプチャします');
  await captureAndStore();
  return true;
}

/**
 * 詳細分析処理（D）
 *
 * 撮り直さず、G / P で記録した画像をそのまま使う。
 */
async function handleDetailedAnalysis() {
  if (isProcessing) {
    console.log('⚠️ 既に処理中です');
    return;
  }

  if (!isPythonReady) {
    console.log('⚠️ Pythonバックエンドが準備できていません');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: 'Pythonバックエンドが起動していません'
      });
    }
    return;
  }

  setProcessing(true);

  try {
    const captured = await ensureCurrentImage();

    // チャット履歴にユーザー操作と応答プレースホルダーを追加させる
    if (mainWindow) {
      mainWindow.webContents.send('analysis-start', {
        type: 'detailed',
        imageCapturedAt: new Date(currentImage.capturedAt).toISOString(),
        freshCapture: captured
      });
    }

    // 詳細分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を詳細分析中...'
      });
    }

    // 推論継続音を開始
    startProgressSound();

    const description = await streamAnalyze(
      buildAnalyzeBody('detailed'), { isDetailed: true }
    );
    console.log('📝 詳細分析の結果:', description);

    // 推論継続音を停止
    stopProgressSound();
    
    // 完了
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }
    
  } catch (error) {
    console.error('❌ 詳細分析中にエラーが発生しました:', error);
    
    // 推論継続音を停止
    stopProgressSound();
    
    // エラー音を再生
    playErrorSound();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `エラー: ${error.message}`
      });
    }
  } finally {
    setProcessing(false);
  }
}

/**
 * 質問分析処理
 */
async function handleQuestionAnalysis(questionText) {
  if (isProcessing) {
    console.log('⚠️ 既に処理中です');
    return;
  }
  
  if (!isPythonReady) {
    console.log('⚠️ Pythonバックエンドが準備できていません');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: 'Pythonバックエンドが起動していません'
      });
    }
    return;
  }
  
  if (!questionText || questionText.trim() === '') {
    console.log('⚠️ 質問文が空です');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: '質問文を入力してください。'
      });
    }
    return;
  }
  
  setProcessing(true);

  try {
    // 撮り直さず、G / P で記録した画像に対して答える
    const captured = await ensureCurrentImage();

    // チャット履歴にユーザーの質問と応答プレースホルダーを追加させる
    if (mainWindow) {
      mainWindow.webContents.send('analysis-start', {
        type: 'question',
        question: questionText,
        imageCapturedAt: new Date(currentImage.capturedAt).toISOString(),
        freshCapture: captured
      });
    }

    // 質問分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '質問を分析中...'
      });
    }

    // 推論継続音を開始
    startProgressSound();

    // ストリーミングで解析（回答が順次届く）
    const description = await streamAnalyze(
      buildAnalyzeBody('question', { question: questionText }),
      { isQuestion: true, question: questionText }
    );
    console.log('📝 質問への回答:', description);

    // 推論継続音を停止
    stopProgressSound();
    
    // 完了
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }
    
  } catch (error) {
    console.error('❌ 質問分析中にエラーが発生しました:', error);
    
    // 推論継続音を停止
    stopProgressSound();
    
    // エラー音を再生
    playErrorSound();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `エラー: ${error.message}`
      });
    }
  } finally {
    setProcessing(false);
  }
}

/**
 * アプリケーション起動時の処理
 */
/**
 * 自動更新（インストーラ版のみ）
 *
 * 開発と、テスターの git clone + update-and-run.bat 経由の起動では
 * app.isPackaged が false になるので、この関数は何もせずに戻る。
 * そちらの更新は今までどおり git pull が担当する。
 *
 * インストーラ版では GitHub Releases の latest.yml を見て、新しい版が
 * あれば黙ってダウンロードし、次にアプリを終了したときに適用する。
 * ダイアログは一切出さない。画面の見えない利用者にとっては、操作を
 * 求められない（次に起動したら新しくなっている）のが最も負担が軽い。
 * electron-updater は依存に入っているが、万一読み込めなくてもアプリ
 * 本体は動くべきなので、失敗はログに残すだけにする。
 */
async function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('ℹ️  開発起動のため自動更新は行いません（更新は git pull）');
    return;
  }

  try {
    const { autoUpdater } = (await import('electron-updater')).default;

    // 次回終了時に適用（既定値だが、意図を明示しておく）
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      console.log(`⬆️  新しいバージョンがあります: ${info.version}`);
    });
    autoUpdater.on('update-not-available', () => {
      console.log('✅ Glance は最新です');
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`⬆️  ${info.version} をダウンロードしました。次回終了時に更新されます`);
      if (mainWindow) {
        mainWindow.webContents.send('log-message',
          `[INFO] 新しいバージョン ${info.version} を次回終了時に適用します`);
      }
    });
    autoUpdater.on('error', (err) => {
      console.error('⚠️  自動更新の確認に失敗しました:', err?.message || err);
    });

    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('⚠️  自動更新を初期化できませんでした:', error?.message || error);
  }
}

/**
 * AI モデルの保存先（python-backend/app.py の get_writable_model_path と同じ場所）
 */
function getModelDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Glance', 'models');
  }
  if (process.platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'Glance', 'models');
  }
  return path.join(app.getPath('home'), '.local', 'share', 'Glance', 'models');
}

/**
 * 初回起動時、モデルのダウンロードを始めてよいか利用者に確かめる
 *
 * インストーラの最後で Glance が自動で起動するため、何も聞かずに
 * 約1.9GBのダウンロードが始まっていた。時間も通信量もかかるので、
 * 始める前に一言断り、都合が悪ければ後にできるようにする（利用者からの要望）。
 *
 * 一度でも .gguf が揃っていれば聞かない（更新後や2回目以降の起動）。
 * 途中で切れたダウンロードは .part のまま残るので、そのときはもう一度聞く。
 *
 * @returns {Promise<boolean>} 起動を続けてよいか
 */
async function confirmFirstModelDownload() {
  // 開発時のモデルは python-backend/models/gguf にあり、ここでは判定できない
  if (!app.isPackaged) return true;

  try {
    if (fs.readdirSync(getModelDir()).some(name => name.endsWith('.gguf'))) return true;
  } catch (error) {
    // フォルダがまだ無い = 初回
  }

  // 標準のメッセージボックスを使う。スクリーンリーダーがタイトル・本文・
  // ボタンをそのまま読み上げられ、Tab と Enter だけで操作できる
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Glance 初回起動の確認',
    message: 'AI モデル（約1.9GB）のダウンロードが必要です。今すぐ始めますか？',
    detail:
      'Glance を使うには、初回だけ AI モデルをインターネットから取得します。' +
      '回線の速さによって、5分から30分ほどかかります。' +
      '進み具合は音声でお知らせします。ダウンロード中もパソコンはふだんどおり使えます。\n\n' +
      '「後でダウンロードする」を選ぶと、Glance を終了します。' +
      '次に Glance を起動したときに、もう一度お聞きします。',
    buttons: ['今すぐダウンロードする', '後でダウンロードする'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

app.whenReady().then(async () => {
  // 二重起動側は何もしない（ホットキーもバックエンドも奪わせない）
  if (!gotSingleInstanceLock) return;

  console.log('🚀 Glance（Python API版）を起動中...');

  if (!await confirmFirstModelDownload()) {
    console.log('ℹ️  初回のモデルダウンロードを見送ったため終了します');
    app.quit();
    return;
  }

  createWindow();
  createTray();
  registerHotkeys();

  // Pythonバックエンドを起動
  try {
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'loading',
        message: 'Pythonバックエンドを起動中...'
      });
    }

    await startPythonBackend();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
      
      mainWindow.webContents.send('model-loaded', {
        backend: 'Python API',
        url: PYTHON_API_URL
      });
    }

    // 起動継続音を停止
    stopProgressSound();
    
    // 起動完了音を再生
    playStartupSound();
    
    console.log('✅ Glanceの起動が完了しました');
  } catch (error) {
    console.error('❌ Pythonバックエンドの起動に失敗しました:', error);
    
    // 起動継続音を停止
    stopProgressSound();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `Pythonバックエンドの起動に失敗: ${error.message}`
      });
    }
  }

  // 自動更新の確認（インストーラ版のみ）
  await setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // もう一度起動されたときは、既にある窓を前面に出して知らせる
  // 窓を閉じた後（トレイに常駐中）に起動し直したときは、窓を作り直す
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

/**
 * Pythonバックエンドを段階的に終了する
 * 1. /shutdown API でグレースフルシャットダウン（llama-server含む）
 * 2. 5秒待機 → まだ生きていれば SIGTERM
 * 3. 3秒待機 → まだ生きていれば SIGKILL
 */
async function killPythonBackend() {
  if (!pythonProcess) return;

  const proc = pythonProcess;
  pythonProcess = null; // 重複実行防止

  console.log('🐍 Pythonバックエンドの終了処理を開始...');

  // ステップ1: /shutdown API でグレースフルシャットダウン
  try {
    console.log('   📨 /shutdown API を呼び出し中...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    await fetch(`${PYTHON_API_URL}/shutdown`, {
      method: 'POST',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    console.log('   ✅ /shutdown API 呼び出し成功');
  } catch (e) {
    console.log(`   ⚠️ /shutdown API 呼び出し失敗（続行します）: ${e.message}`);
  }

  // プロセスが終了するまで最大5秒待機
  const isAlive = () => {
    try {
      process.kill(proc.pid, 0); // シグナル0 = 死活確認のみ
      return true;
    } catch {
      return false;
    }
  };

  for (let i = 0; i < 50; i++) {
    if (!isAlive()) {
      console.log('   ✅ Pythonプロセスが正常終了しました');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // ステップ2: SIGTERM
  console.log('   ⚠️ まだ生きています → SIGTERM を送信');
  try {
    proc.kill('SIGTERM');
  } catch (e) {
    console.log(`   ⚠️ SIGTERM 送信失敗: ${e.message}`);
  }

  for (let i = 0; i < 30; i++) {
    if (!isAlive()) {
      console.log('   ✅ Pythonプロセスが SIGTERM で終了しました');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // ステップ3: SIGKILL（強制終了）
  console.log('   ⚠️ まだ生きています → SIGKILL で強制終了');
  try {
    proc.kill('SIGKILL');
  } catch (e) {
    console.log(`   ⚠️ SIGKILL 送信失敗: ${e.message}`);
  }

  console.log('   ✅ Pythonプロセスを強制終了しました');
}

// 終了処理が重複実行されないようにガード
let isCleaningUp = false;

/**
 * アプリ終了時の共通クリーンアップ処理
 */
async function performCleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;

  console.log('🛑 Glanceを終了中...');
  globalShortcut.unregisterAll();
  await killPythonBackend();
  console.log('✅ Glanceを終了しました');
}

/**
 * すべてのウィンドウが閉じられたときの処理
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Windowsではシステムトレイに残る
  }
});

/**
 * アプリケーション終了前の処理（before-quit → will-quit の順に発火）
 */
app.on('before-quit', (event) => {
  if (isCleaningUp) return;
  // 非同期クリーンアップのため一度キャンセルして再実行
  event.preventDefault();
  performCleanup().then(() => {
    app.exit(0);
  });
});

/**
 * アプリケーション終了時の処理（フォールバック）
 */
app.on('will-quit', () => {
  // before-quit でクリーンアップ済みの場合はここは通常通過するだけ
  // クリーンアップがまだなら同期的に最低限の処理を行う
  if (!isCleaningUp && pythonProcess) {
    console.log('⚠️ will-quit: フォールバックとして Pythonプロセスを強制終了');
    try {
      pythonProcess.kill('SIGKILL');
    } catch (e) {
      // 無視
    }
    pythonProcess = null;
  }
});

/**
 * プロセス自体が終了する直前（同期的な最終手段）
 */
process.on('exit', () => {
  if (pythonProcess) {
    try {
      pythonProcess.kill('SIGKILL');
    } catch (e) {
      // 無視
    }
  }
});

/**
 * IPCハンドラー
 */

// 画面キャプチャ
ipcMain.handle('capture-screen', async () => {
  await handleScreenCapture();
  return { success: true };
});

// 読み上げ停止（推論も中断）
ipcMain.handle('stop-speaking', async () => {
  stopAll();
  return { success: true };
});

// 説明書の本文（Glance の画面で読む）
// バックエンドの URL。ポートが決まる前は null を返す
ipcMain.handle('get-backend-url', () => backendUrlResolved ? PYTHON_API_URL : null);

ipcMain.handle('get-manual', () => {
  try {
    return fs.readFileSync(getManualPath(), 'utf-8');
  } catch (error) {
    console.error(`❌ 説明書を読み込めませんでした: ${error.message}`);
    return '';
  }
});

// 画面側の読み上げが始まった／終わった。Esc で止められるかどうかの判定に使う
ipcMain.handle('send-feedback', async (_event, { message, contact, includeDiagnostics }) => {
  const text = String(message || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  const diagnostics = includeDiagnostics
    ? buildDiagnostics({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        backendState: isPythonReady ? '準備完了' : '起動していない',
        ttsMode: appSettings.ttsMode,
        imageMaxSize: appSettings.imageMaxSize,
        hotkeys: appSettings.hotkeys
      })
    : '';
  return sendFeedback({ message: text, contact: String(contact || '').trim(), diagnostics });
});

ipcMain.on('speech-state', (_event, speaking) => {
  isSpeaking = !!speaking;
  updateStopHotkey();
});

// モデル切り替え
ipcMain.handle('switch-model', async (event, modelName) => {
  try {
    const response = await fetch(`${PYTHON_API_URL}/switch-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName })
    });
    
    const data = await response.json();
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 利用可能なモデルリストを取得
ipcMain.handle('get-available-models', async () => {
  try {
    const response = await fetch(`${PYTHON_API_URL}/models`);
    const data = await response.json();
    return data;
  } catch (error) {
    return { error: error.message };
  }
});

// 詳細分析
ipcMain.handle('detailed-analysis', async () => {
  await handleDetailedAnalysis();
  return { success: true };
});

// 質問分析
ipcMain.handle('question-analysis', async (event, questionText) => {
  await handleQuestionAnalysis(questionText);
  return { success: true };
});

// 質問モーダル表示チェック（画像が無い場合は送信時に自動キャプチャされる）
ipcMain.handle('can-show-question-modal', async () => {
  return { canShow: true, hasImage: !!currentImage };
});

// ホットキー設定の取得（設定画面での表示用）
ipcMain.handle('get-hotkeys', () => {
  return { hotkeys: appSettings.hotkeys, defaults: HOTKEY_DEFAULTS };
});

// ホットキーの保存と再登録。登録可否をそのまま返し、設定画面で結果を伝える
ipcMain.handle('save-hotkeys', (_event, hotkeys) => {
  appSettings = saveSettings({ hotkeys });
  const results = registerHotkeys();
  return { hotkeys: appSettings.hotkeys, results };
});

// 透明オーバーレイウィンドウからの質問送信
ipcMain.on('overlay-question-submit', async (event, questionText) => {
  console.log('📝 オーバーレイから質問を受信:', questionText);
  
  // オーバーレイウィンドウを非表示
  hideQuestionOverlay();
  
  // 質問処理を実行
  await handleQuestionAnalysis(questionText);
});

// 透明オーバーレイウィンドウからのキャンセル
ipcMain.on('overlay-question-cancel', () => {
  console.log('❌ 質問がキャンセルされました');
  hideQuestionOverlay();
});

// 設定取得
ipcMain.handle('get-settings', () => {
  appSettings = loadSettings();
  return appSettings;
});

// 設定保存
ipcMain.handle('save-settings', (_event, settings) => {
  appSettings = saveSettings(settings);
  return appSettings;
});

// TTSのみ停止（推論は継続。読み上げボタンの停止用）
ipcMain.handle('stop-tts', () => {
  stopSpeaking();
  return { success: true };
});

// TTS読み上げ（renderer.jsから呼び出し可能に）
ipcMain.handle('speak', async (event, text, options = {}) => {
  await speak(text, {
    speed: options.speed || 1.5,
    volume: options.volume || 1.0,
    language: options.language || 'ja-JP'
  });
  return { success: true };
});
