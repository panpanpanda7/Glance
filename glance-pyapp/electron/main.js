import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import { captureFullScreen } from './utils/screenshot.js';
import { speak, stopSpeaking } from './utils/tts.js';
import { 
  playCaptureSound, 
  playDetailedSound, 
  playQuestionSound, 
  startProgressSound, 
  stopProgressSound, 
  playErrorSound,
  playStartupSound
} from './utils/sounds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// グローバル変数
let mainWindow = null;
let questionOverlayWindow = null; // 質問入力用の透明オーバーレイウィンドウ
let tray = null;
let pythonProcess = null;
let isProcessing = false;
let isPythonReady = false;
let lastCapturedImageBase64 = null; // 直前の画像（Base64エンコード済み）
let abortController = null; // 推論中断用のAbortController

const PYTHON_API_URL = 'http://127.0.0.1:5001';

// ==========================================
// 設定管理
// ==========================================
const SETTINGS_DEFAULTS = {
  imageMaxSize: '1120'  // '448'|'672'|'896'|'1120'|'1344'|'none'
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(settings) {
  const merged = { ...SETTINGS_DEFAULTS, ...settings };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

let appSettings = loadSettings();

/**
 * Pythonバックエンドを起動
 */
async function startPythonBackend() {
  console.log('🐍 Python Backendを起動中...');
  
  // 起動中の断続音を開始
  startProgressSound();
  
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

  pythonProcess = spawn(executablePath, args, {
    stdio: 'pipe', // 'inherit'から'pipe'に変更して出力をキャプチャ
    cwd: cwd,
    env: env // 環境変数を指定
  });
  
  // 標準出力をキャプチャしてレンダラーに送信
  pythonProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('[Python STDOUT]', output);
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
  });
  
  if (mainWindow) {
    mainWindow.webContents.send('log-message', '[INFO] Python起動コマンドを実行しました');
  }
  
  // Pythonバックエンドの起動を待つ
  await waitForPythonBackend();
}

/**
 * Pythonバックエンドの起動を待つ
 */
async function waitForPythonBackend() {
  console.log('⏳ Pythonバックエンドの起動を待機中...');
  
  if (mainWindow) {
    mainWindow.webContents.send('log-message', '[INFO] バックエンドの状態確認を開始します');
  }
  
  const maxRetries = 300; // 最大300秒
  const initializingTimeoutThreshold = 60; // initializing が60秒以上続いたら異常と判定
  let initializingStartTime = null;
  
  for (let i = 0; i < maxRetries; i++) {
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
      console.log('✅ Pythonバックエンドが準備完了しました');
      if (mainWindow) {
        mainWindow.webContents.send('log-message', '[SUCCESS] バックエンド起動完了（モデルロード済み）');
      }
      isPythonReady = true;
      return;
    } 
    else if (status === 'downloading' || status === 'loading_model') {
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
  if (!lastCapturedImageBase64) {
    console.log('⚠️ 分析する画像がありません。まず画面をキャプチャしてください。');
    return;
  }

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
      label: '画面を読み上げ (Cmd+Shift+G)',
      click: handleScreenCapture
    },
    {
      label: '詳細分析 (Cmd+Shift+D)',
      click: handleDetailedAnalysis
    },
    { type: 'separator' },
    {
      label: '読み上げを停止',
      click: () => {
        stopSpeaking();
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
 * グローバルホットキーを登録
 */
function registerHotkeys() {
  // 最も使用頻度の高いキャプチャ用ショートカット
  const captureHotkey = 'CommandOrControl+Shift+G';
  const success1 = globalShortcut.register(captureHotkey, () => {
    playCaptureSound(); // キャプチャ音を再生
    handleScreenCapture();
  });
  
  // 2番目に使用頻度の高い詳細分析用ショートカット
  const detailedHotkey = 'CommandOrControl+Shift+D';
  const success2 = globalShortcut.register(detailedHotkey, () => {
    playDetailedSound(); // 詳細分析音を再生
    handleDetailedAnalysis();
  });
  
  // 質問機能用ショートカット（透明オーバーレイウィンドウを表示）
  const questionHotkey = 'CommandOrControl+Shift+Q';
  const success3 = globalShortcut.register(questionHotkey, () => {
    playQuestionSound(); // 質問音を再生
    showQuestionOverlay();
  });
  
  // 結果のログ
  if (success1 && success2 && success3) {
    console.log(`✅ ホットキーを登録しました: ${captureHotkey}, ${detailedHotkey}, ${questionHotkey}`);
  } else {
    console.error(`❌ ホットキーの登録に失敗しました`);
  }
}

/**
 * 画面キャプチャ＆読み上げのメイン処理
 */
async function handleScreenCapture() {
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

  isProcessing = true;
  
  try {
    // キャプチャ中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'capturing',
        message: '画面をキャプチャ中...'
      });
    }

    const screenshot = await captureFullScreen();
    lastCapturedImageBase64 = screenshot.toString('base64'); // エンコード済みデータを保存
    
    // 分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を分析中...'
      });
    }
    
    // 推論継続音を開始
    startProgressSound();

    // AbortControllerを作成（推論中断用）
    abortController = new AbortController();

    // Python APIに送信（標準プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'standard',
        imageMaxSize: appSettings.imageMaxSize
      }),
      signal: abortController.signal
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error);
    }

    const description = data.result;
    console.log('📝 生成された説明:', description);
    
    // 推論継続音を停止
    stopProgressSound();

    // 結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString(),
        model: data.model,
        isDetailed: false
      });
    }

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
    isProcessing = false;
  }
}

/**
 * 詳細分析処理
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

  isProcessing = true;

  try {
    // キャプチャ
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'capturing',
        message: '画面をキャプチャ中...'
      });
    }

    const screenshot = await captureFullScreen();
    lastCapturedImageBase64 = screenshot.toString('base64');

    // 詳細分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を詳細分析中...'
      });
    }
    
    // 推論継続音を開始
    startProgressSound();
    
    // AbortControllerを作成（推論中断用）
    abortController = new AbortController();
    
    // API送信（詳細プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'detailed',
        imageMaxSize: appSettings.imageMaxSize
      }),
      signal: abortController.signal
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    const description = data.result;
    console.log('📝 詳細分析の結果:', description);
    
    // 推論継続音を停止
    stopProgressSound();
    
    // 結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString(),
        model: data.model,
        isDetailed: true
      });
    }
    
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
    isProcessing = false;
  }
}

/**
 * 質問分析処理
 */
async function handleQuestionAnalysis(questionText) {
  if (!lastCapturedImageBase64) {
    console.log('⚠️ 分析する画像がありません。まず画面をキャプチャしてください。');
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: '画像がありません。先に画面キャプチャを行ってください。'
      });
    }
    return;
  }
  
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
  
  isProcessing = true;
  
  try {
    // 質問分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '質問を分析中...'
      });
    }
    
    // 推論継続音を開始
    startProgressSound();
    
    // AbortControllerを作成（推論中断用）
    abortController = new AbortController();
    
    // API送信（質問プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'question',
        question: questionText,
        imageMaxSize: appSettings.imageMaxSize
      }),
      signal: abortController.signal
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    const description = data.result;
    console.log('📝 質問への回答:', description);
    
    // 推論継続音を停止
    stopProgressSound();
    
    // 結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString(),
        model: data.model,
        isQuestion: true,
        question: questionText
      });
    }
    
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
    isProcessing = false;
  }
}

/**
 * アプリケーション起動時の処理
 */
app.whenReady().then(async () => {
  console.log('🚀 Glance（Python API版）を起動中...');

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
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
  console.log('🛑 停止ボタンが押されました');
  
  // 推論を中断
  if (abortController) {
    console.log('🛑 推論を中断します');
    abortController.abort();
    abortController = null;
  }
  
  // TTS停止
  stopSpeaking();
  
  // 推論継続音を停止
  stopProgressSound();
  
  // 処理中フラグをリセット
  isProcessing = false;
  
  // ステータスを待機中に
  if (mainWindow) {
    mainWindow.webContents.send('status-update', {
      status: 'idle',
      message: '待機中'
    });
  }
  
  return { success: true };
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

// 質問モーダル表示チェック（画像があるかどうか）
ipcMain.handle('can-show-question-modal', async () => {
  return { canShow: !!lastCapturedImageBase64 };
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

// TTS読み上げ（renderer.jsから呼び出し可能に）
ipcMain.handle('speak', async (event, text, options = {}) => {
  await speak(text, {
    speed: options.speed || 1.5,
    volume: options.volume || 1.0,
    language: options.language || 'ja-JP'
  });
  return { success: true };
});
