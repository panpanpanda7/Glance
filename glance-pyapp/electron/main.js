import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { captureFullScreen } from './utils/screenshot.js';
import { speak, stopSpeaking } from './utils/tts.js';

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

const PYTHON_API_URL = 'http://127.0.0.1:5001';

/**
 * Pythonバックエンドを起動
 */
async function startPythonBackend() {
  console.log('🐍 Python Backendを起動中...');
  
  const isDev = process.argv.includes('--dev');
  let pythonPath, scriptPath;
  
  if (isDev) {
    // 開発環境：venv内のPythonを使用
    pythonPath = path.join(__dirname, '..', 'python-backend', 'venv', 'bin', 'python3');
    scriptPath = path.join(__dirname, '..', 'python-backend', 'app.py');
  } else {
    // 本番環境：パッケージ化されたPythonを使用
    const resourcesPath = process.resourcesPath;
    pythonPath = path.join(resourcesPath, 'python-runtime', 'bin', 'python3');
    scriptPath = path.join(resourcesPath, 'python-backend', 'app.py');
  }
  
  console.log(`   Python: ${pythonPath}`);
  console.log(`   Script: ${scriptPath}`);
  
  pythonProcess = spawn(pythonPath, [scriptPath], {
    stdio: 'inherit',
    cwd: path.dirname(scriptPath)
  });
  
  pythonProcess.on('error', (err) => {
    console.error('❌ Python起動エラー:', err);
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `Pythonバックエンドの起動に失敗: ${err.message}`
      });
    }
  });
  
  pythonProcess.on('exit', (code) => {
    console.log(`⚠️  Pythonプロセスが終了しました (code: ${code})`);
    isPythonReady = false;
  });
  
  // Pythonバックエンドの起動を待つ
  await waitForPythonBackend();
}

/**
 * Pythonバックエンドの起動を待つ
 */
async function waitForPythonBackend() {
  console.log('⏳ Pythonバックエンドの起動を待機中...');
  
  const maxRetries = 300; // 300秒待つ
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${PYTHON_API_URL}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data.model_loaded) {
          console.log('✅ Pythonバックエンドが起動しました（モデルロード済み）');
          isPythonReady = true;
          return;
        } else {
          console.log('⏳ モデルロード中...');
        }
      }
    } catch (e) {
      // まだ起動していない
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('Pythonバックエンドの起動タイムアウト（60秒）');
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

  if (process.argv.includes('--dev')) {
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
  const success1 = globalShortcut.register(captureHotkey, handleScreenCapture);
  
  // 2番目に使用頻度の高い詳細分析用ショートカット
  const detailedHotkey = 'CommandOrControl+Shift+D';
  const success2 = globalShortcut.register(detailedHotkey, handleDetailedAnalysis);
  
  // 質問機能用ショートカット（透明オーバーレイウィンドウを表示）
  const questionHotkey = 'CommandOrControl+Shift+Q';
  const success3 = globalShortcut.register(questionHotkey, showQuestionOverlay);
  
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

    // Python APIに送信（標準プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'standard'
      })
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error);
    }

    const description = data.result;
    console.log('📝 生成された説明:', description);

    // 結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString(),
        model: data.model,
        isDetailed: false
      });
    }

    // 読み上げ中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'speaking',
        message: '読み上げ中...'
      });
    }

    await speak(description, {
      speed: 1.5,   // 読み上げ速度（0.5-2.0）
                    // 0.5 = 遅い、1.0 = 標準、1.5 = 速い、2.0 = 非常に速い
      volume: 1.0,  // 音量（0.0-1.0）
      language: 'ja-JP'  // 言語
    });

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
  
  isProcessing = true;
  
  try {
    // 詳細分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を詳細分析中...'
      });
    }
    
    // API送信（詳細プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'detailed'
      })
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    const description = data.result;
    console.log('📝 詳細分析の結果:', description);
    
    // 結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString(),
        model: data.model,
        isDetailed: true
      });
    }
    
    // 読み上げ中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'speaking',
        message: '詳細情報を読み上げ中...'
      });
    }
    
    await speak(description, {
      speed: 1.5,
      volume: 1.0,
      language: 'ja-JP'
    });
    
    // 完了
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }
    
  } catch (error) {
    console.error('❌ 詳細分析中にエラーが発生しました:', error);
    
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
    
    // API送信（質問プロンプト）
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: lastCapturedImageBase64,
        promptType: 'question',
        question: questionText
      })
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    const description = data.result;
    console.log('📝 質問への回答:', description);
    
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
    
    // 読み上げ中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'speaking',
        message: '回答を読み上げ中...'
      });
    }
    
    await speak(description, {
      speed: 1.5,
      volume: 1.0,
      language: 'ja-JP'
    });
    
    // 完了
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
    }
    
  } catch (error) {
    console.error('❌ 質問分析中にエラーが発生しました:', error);
    
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

    console.log('✅ Glanceの起動が完了しました');
  } catch (error) {
    console.error('❌ Pythonバックエンドの起動に失敗しました:', error);
    
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
 * すべてのウィンドウが閉じられたときの処理
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Windowsではシステムトレイに残る
  }
});

/**
 * アプリケーション終了時の処理
 */
app.on('will-quit', async () => {
  console.log('🛑 Glanceを終了中...');

  globalShortcut.unregisterAll();

  // Pythonプロセスを終了
  if (pythonProcess) {
    console.log('🐍 Pythonプロセスを終了中...');
    pythonProcess.kill();
    pythonProcess = null;
  }

  console.log('✅ Glanceを終了しました');
});

/**
 * IPCハンドラー
 */

// 画面キャプチャ
ipcMain.handle('capture-screen', async () => {
  await handleScreenCapture();
  return { success: true };
});

// 読み上げ停止
ipcMain.handle('stop-speaking', async () => {
  stopSpeaking();
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
