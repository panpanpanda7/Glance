import { exec } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 音声フィードバックユーティリティ
 * 視覚障害者向けに操作時に音を鳴らす
 */

let progressSoundInterval = null;
let soundConfig = null;

/**
 * 設定ファイルを読み込む
 */
function loadConfig() {
  if (soundConfig) return soundConfig;
  
  try {
    const configPath = path.join(__dirname, '..', 'config.yaml');
    const fileContents = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContents);
    soundConfig = config.sounds;
    console.log('✅ 音声設定を読み込みました:', configPath);
    return soundConfig;
  } catch (error) {
    console.error('⚠️ 音声設定の読み込みに失敗しました。デフォルト設定を使用します:', error);
    // デフォルト設定
    soundConfig = {
      enabled: true,
      progressInterval: 2000,
      actions: {
        capture: { frequency: 1000, duration: 100 },
        detailed: { frequency: 800, duration: 80 },
        question: { frequency: 600, duration: 100 },
        progress: { frequency: 700, duration: 50 },
        error: { sequences: [{ frequency: 800, duration: 100 }, { delay: 50 }, { frequency: 400, duration: 150 }] },
        success: { sequences: [{ frequency: 600, duration: 80 }, { delay: 50 }, { frequency: 900, duration: 100 }] }
      }
    };
    return soundConfig;
  }
}

/**
 * ビープ音を鳴らす（クロスプラットフォーム対応）
 * @param {number} frequency - 周波数（Hz）
 * @param {number} duration - 持続時間（ミリ秒）
 * @param {string} macSound - macOS用のサウンドファイルパス（オプション）
 */
async function playBeep(frequency, duration, macSound = null) {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      // macOS: osascriptを使用してビープ音を生成
      await playBeepMacOS(frequency, duration, macSound);
    } else if (platform === 'win32') {
      // Windows: PowerShellの[console]::Beep()を使用
      await playBeepWindows(frequency, duration);
    } else {
      // Linux: beepコマンドを使用（インストールが必要）
      await playBeepLinux(frequency, duration);
    }
  } catch (error) {
    console.error('❌ ビープ音の再生に失敗しました:', error);
    // エラーでも続行（音が鳴らなくても機能は動作する）
  }
}

/**
 * macOS用のビープ音
 * @param {number} frequency - 周波数（Hz）- フォールバック用
 * @param {number} duration - 持続時間（ミリ秒）- 未使用（システムサウンドの長さに依存）
 * @param {string} macSound - macOS用のサウンドファイルパス（オプション）
 */
function playBeepMacOS(frequency, duration, macSound = null) {
  return new Promise((resolve) => {
    // config.yamlでmacSoundが指定されている場合はそれを使用
    let soundFile;
    
    if (macSound) {
      soundFile = macSound;
      console.log(`🔊 macOS: 設定されたサウンドを使用: ${soundFile}`);
    } else {
      // macSoundが指定されていない場合は周波数ベースでフォールバック
      if (frequency >= 950) {
        soundFile = '/System/Library/Sounds/Tink.aiff';
      } else if (frequency >= 750) {
        soundFile = '/System/Library/Sounds/Pop.aiff';
      } else if (frequency >= 650) {
        soundFile = '/System/Library/Sounds/Tink.aiff';
      } else if (frequency >= 550) {
        soundFile = '/System/Library/Sounds/Morse.aiff';
      } else {
        soundFile = '/System/Library/Sounds/Basso.aiff';
      }
      console.log(`🔊 macOS: 周波数ベースでサウンドを選択 (${frequency}Hz): ${soundFile}`);
    }
    
    exec(`afplay "${soundFile}"`, (error) => {
      if (error) {
        console.log('システムサウンド再生エラー、デフォルトビープを使用');
        // フォールバック：システムビープ
        exec('osascript -e "beep"', () => resolve());
      } else {
        resolve();
      }
    });
  });
}

/**
 * Windows用のビープ音
 */
function playBeepWindows(frequency, duration) {
  return new Promise((resolve) => {
    const command = `powershell -Command "[console]::Beep(${frequency}, ${duration})"`;
    exec(command, (error) => {
      if (error) {
        console.error('ビープ音エラー:', error);
      }
      resolve();
    });
  });
}

/**
 * Linux用のビープ音
 */
function playBeepLinux(frequency, duration) {
  return new Promise((resolve) => {
    const command = `beep -f ${frequency} -l ${duration}`;
    exec(command, (error) => {
      if (error) {
        // beepコマンドがない場合は代替手段
        exec('echo -e "\\a"', () => resolve());
      } else {
        resolve();
      }
    });
  });
}

/**
 * 画面キャプチャ音（高いピッ）
 */
export async function playCaptureSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.capture;
  console.log('🔊 キャプチャ音を再生');
  await playBeep(settings.frequency, settings.duration, settings.macSound);
}

/**
 * 詳細分析音（中音）
 */
export async function playDetailedSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.detailed;
  console.log('🔊 詳細分析音を再生');
  await playBeep(settings.frequency, settings.duration, settings.macSound);
}

/**
 * 質問音（低めの単音）
 */
export async function playQuestionSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.question;
  console.log('🔊 質問音を再生');
  await playBeep(settings.frequency, settings.duration, settings.macSound);
}

/**
 * 推論継続中の音（控えめなティック音）
 * 設定された間隔ごとに繰り返し再生
 */
export function startProgressSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  // 既に再生中の場合は停止
  stopProgressSound();
  
  const settings = config.actions.progress;
  const interval = config.progressInterval;
  
  console.log(`🔊 推論継続音を開始（${interval}ms間隔）`);
  
  // 設定された間隔ごとに繰り返し
  progressSoundInterval = setInterval(() => {
    playBeep(settings.frequency, settings.duration, settings.macSound);
  }, interval);
}

/**
 * 推論継続中の音を停止
 */
export function stopProgressSound() {
  if (progressSoundInterval) {
    console.log('🔊 推論継続音を停止');
    clearInterval(progressSoundInterval);
    progressSoundInterval = null;
  }
}

/**
 * エラー音（設定されたシーケンス）
 */
export async function playErrorSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.error;
  console.log('🔊 エラー音を再生');
  
  // macOSでmacSoundが設定されている場合は、シーケンスではなくそれを使用
  if (settings.macSound && os.platform() === 'darwin') {
    await playBeep(settings.frequency || 800, settings.duration || 100, settings.macSound);
  } else if (settings.sequences) {
    // シーケンスがある場合はそれを使用
    for (const item of settings.sequences) {
      if (item.delay) {
        await new Promise(resolve => setTimeout(resolve, item.delay));
      } else if (item.frequency) {
        await playBeep(item.frequency, item.duration);
      }
    }
  } else {
    // フォールバック（旧形式）
    await playBeep(settings.frequency || 800, settings.duration || 100, settings.macSound);
  }
}

/**
 * 成功音（設定されたシーケンス）
 */
export async function playSuccessSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.success;
  console.log('🔊 成功音を再生');
  
  // macOSでmacSoundが設定されている場合は、シーケンスではなくそれを使用
  if (settings.macSound && os.platform() === 'darwin') {
    await playBeep(settings.frequency || 600, settings.duration || 80, settings.macSound);
  } else if (settings.sequences) {
    // シーケンスがある場合はそれを使用
    for (const item of settings.sequences) {
      if (item.delay) {
        await new Promise(resolve => setTimeout(resolve, item.delay));
      } else if (item.frequency) {
        await playBeep(item.frequency, item.duration);
      }
    }
  } else {
    // フォールバック（旧形式）
    await playBeep(settings.frequency || 600, settings.duration || 80, settings.macSound);
  }
}

/**
 * 起動完了音（設定されたシーケンス）
 */
export async function playStartupSound() {
  const config = loadConfig();
  if (!config.enabled) return;
  
  const settings = config.actions.startup;
  console.log('🔊 起動完了音を再生');
  
  // macOSでmacSoundが設定されている場合は、シーケンスではなくそれを使用
  if (settings.macSound && os.platform() === 'darwin') {
    await playBeep(settings.frequency || 500, settings.duration || 100, settings.macSound);
  } else if (settings.sequences) {
    // シーケンスがある場合はそれを使用
    for (const item of settings.sequences) {
      if (item.delay) {
        await new Promise(resolve => setTimeout(resolve, item.delay));
      } else if (item.frequency) {
        await playBeep(item.frequency, item.duration);
      }
    }
  } else {
    // フォールバック（旧形式）
    await playBeep(settings.frequency || 500, settings.duration || 100, settings.macSound);
  }
}
