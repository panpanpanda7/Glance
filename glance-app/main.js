import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import InferenceEngine from './llm/inference-engine.js';
import { captureFullScreen } from './utils/screenshot.js';
import { speak, stopSpeaking } from './utils/tts.js';
import { loadAppConfig } from './llm/config-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// グローバル変数
let mainWindow = null;
let tray = null;
let inferenceEngine = null;
let appConfig = null;
let isProcessing = false;

/**
 * メインウィンドウを作成
 */
function createWindow() {
  appConfig = loadAppConfig();
  
  mainWindow = new BrowserWindow({
    width: appConfig.app.window.width,
    height: appConfig.app.window.height,
    alwaysOnTop: appConfig.app.window.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build/icon.png'),
  });

  mainWindow.loadFile('index.html');

  // 開発モードではDevToolsを開く
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // ウィンドウを閉じたときの処理
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * システムトレイアイコンを作成
 */
function createTray() {
  // トレイアイコン作成（とりあえずデフォルトアイコン）
  const iconPath = path.join(__dirname, 'build/icon.png');
  let trayIcon;
  
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // アイコンが見つからない場合は空のアイコンを作成
      trayIcon = nativeImage.createEmpty();
    }
  } catch (error) {
    console.warn('トレイアイコンの読み込みに失敗しました:', error);
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
      label: '画面を読み上げ (Ctrl+Shift+G)',
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

  tray.setToolTip('Glance - 画面読み上げアプリ');
  tray.setContextMenu(contextMenu);
  
  // トレイアイコンをクリックしたときの処理
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
  });
}

/**
 * グローバルホットキーを登録
 */
function registerHotkeys() {
  const hotkey = appConfig.app.hotkey;
  
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
    console.log('⚠️ 既に処理中です');
    return;
  }

  isProcessing = true;
  
  try {
    // ウィンドウにステータスを通知
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'capturing',
        message: '画面をキャプチャ中...'
      });
    }

    // 画面をキャプチャ
    const screenshot = await captureFullScreen();
    
    // ウィンドウにステータスを通知
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'analyzing',
        message: '画面を分析中...'
      });
    }

    // LLMで分析
    const description = await inferenceEngine.analyze(screenshot);
    
    console.log('📝 生成された説明:', description);

    // ウィンドウに結果を表示
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', {
        text: description,
        timestamp: new Date().toISOString()
      });
    }

    // ウィンドウにステータスを通知
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'speaking',
        message: '読み上げ中...'
      });
    }

    // 音声で読み上げ
    await speak(description, {
      speed: appConfig.app.tts.speed,
      volume: appConfig.app.tts.volume,
      language: appConfig.app.tts.language
    });

    // ウィンドウにステータスを通知
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
  console.log('🚀 Glanceを起動中...');

  // 設定を読み込む
  appConfig = loadAppConfig();

  // ウィンドウを作成
  createWindow();

  // システムトレイを作成
  createTray();

  // ホットキーを登録
  registerHotkeys();

  // 推論エンジンを初期化
  console.log('🤖 推論エンジンを初期化中...');
  
  if (mainWindow) {
    mainWindow.webContents.send('status-update', {
      status: 'loading',
      message: 'モデルをロード中...'
    });
  }

  try {
    inferenceEngine = new InferenceEngine();
    await inferenceEngine.initialize();
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'idle',
        message: '待機中'
      });
      
      mainWindow.webContents.send('model-loaded', {
        model: inferenceEngine.getCurrentModelInfo()
      });
    }

    console.log('✅ Glanceの起動が完了しました');
  } catch (error) {
    console.error('❌ 推論エンジンの初期化に失敗しました:', error);
    
    if (mainWindow) {
      mainWindow.webContents.send('status-update', {
        status: 'error',
        message: `モデルのロードに失敗しました: ${error.message}`
      });
    }
  }

  // macOS: アプリがアクティブになったときの処理
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
  // macOS以外ではアプリを終了
  if (process.platform !== 'darwin') {
    // ただし、システムトレイがある場合は終了しない
    // app.quit();
  }
});

/**
 * アプリケーション終了時の処理
 */
app.on('will-quit', async () => {
  console.log('🛑 Glanceを終了中...');

  // ホットキーの登録を解除
  globalShortcut.unregisterAll();

  // 推論エンジンをシャットダウン
  if (inferenceEngine) {
    await inferenceEngine.shutdown();
  }

  console.log('✅ Glanceを終了しました');
});

/**
 * IPCハンドラー
 */

// モデル切り替え
ipcMain.handle('switch-model', async (event, modelName) => {
  try {
    await inferenceEngine.switchModel(modelName);
    return { success: true };
  } catch (error) {
    console.error('モデル切り替えエラー:', error);
    return { success: false, error: error.message };
  }
});

// 利用可能なモデルリストを取得
ipcMain.handle('get-available-models', async () => {
  return inferenceEngine.getAvailableModels();
});

// 手動で画面キャプチャ
ipcMain.handle('capture-screen', async () => {
  await handleScreenCapture();
  return { success: true };
});

// 読み上げ停止
ipcMain.handle('stop-speaking', async () => {
  stopSpeaking();
  return { success: true };
});
