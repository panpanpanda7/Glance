import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { captureFullScreen } from './utils/screenshot.js';
import { speak, stopSpeaking } from './utils/tts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// グローバル変数
let mainWindow = null;
let tray = null;
let pythonProcess = null;
let isProcessing = false;
let isPythonReady = false;

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
  
  const maxRetries = 60; // 60秒待つ
  
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
  const hotkey = 'CommandOrControl+Shift+G';
  
  const success = globalShortcut.register(hotkey, handleScreenCapture);
  
  if (success) {
    console.log(`✅ ホットキーを登録しました: ${hotkey}`);
  } else {
    console.error(`❌ ホットキーの登録に失敗しました: ${hotkey}`);
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
    
    // 分析中
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を分析中...'
      });
    }

    // Python APIに送信
    const response = await fetch(`${PYTHON_API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: screenshot.toString('base64')
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
        model: data.model
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
