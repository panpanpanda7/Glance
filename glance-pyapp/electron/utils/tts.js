import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

/**
 * TTS（音声読み上げ）ユーティリティ
 * OS標準のTTS機能を使用する
 */

let currentProcess = null;

/**
 * テキストを音声で読み上げる
 * @param {string} text - 読み上げるテキスト
 * @param {Object} options - 読み上げオプション
 * @param {number} options.speed - 読み上げ速度（0.5-2.0、デフォルト: 1.0）
 * @param {number} options.volume - 音量（0.0-1.0、デフォルト: 1.0）
 * @param {string} options.language - 言語コード（デフォルト: ja-JP）
 * @returns {Promise<void>}
 */
export async function speak(text, options = {}) {
  const speed = options.speed || 1.0;
  const volume = options.volume || 1.0;
  const language = options.language || 'ja-JP';

  console.log(`🔊 音声読み上げを開始: "${text.substring(0, 50)}..."`);

  try {
    const platform = os.platform();

    if (platform === 'darwin') {
      // macOS: say コマンドを使用
      await speakMacOS(text, speed, volume, language);
    } else if (platform === 'win32') {
      // Windows: PowerShell + SAPI を使用
      await speakWindows(text, speed, volume, language);
    } else {
      // Linux: espeak を使用（インストールが必要）
      await speakLinux(text, speed, volume, language);
    }

    console.log('✅ 音声読み上げが完了しました');
  } catch (error) {
    console.error('❌ 音声読み上げに失敗しました:', error);
    throw error;
  }
}

/**
 * macOS用の音声読み上げ
 * @param {string} text - テキスト
 * @param {number} speed - 速度
 * @param {number} volume - 音量
 * @param {string} language - 言語
 */
async function speakMacOS(text, speed, volume, language) {
  // macOSのsayコマンドは速度調整が200 words/minがデフォルト
  // speedが1.0の場合は200、2.0の場合は400に変換
  const rate = Math.round(200 * speed);
  
  // 日本語の場合は日本語音声を使用
  let voice = 'Kyoko'; // デフォルトの日本語音声
  if (language.startsWith('en')) {
    voice = 'Samantha'; // 英語音声
  }

  // テキストをエスケープ
  const escapedText = text.replace(/"/g, '\\"');

  const command = `say -v "${voice}" -r ${rate} "${escapedText}"`;
  
  currentProcess = exec(command);
  
  return new Promise((resolve, reject) => {
    currentProcess.on('close', (code) => {
      currentProcess = null;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say command exited with code ${code}`));
      }
    });
    
    currentProcess.on('error', (error) => {
      currentProcess = null;
      reject(error);
    });
  });
}

/**
 * Windows用の音声読み上げ
 * @param {string} text - テキスト
 * @param {number} speed - 速度
 * @param {number} volume - 音量
 * @param {string} language - 言語
 */
async function speakWindows(text, speed, volume, language) {
  // Windows PowerShellでSAPIを使用
  // speedは-10から10の範囲に変換（1.0 = 0）
  const rate = Math.round((speed - 1.0) * 10);
  
  // volumeは0-100に変換
  const vol = Math.round(volume * 100);

  // テキスト内のシングルクォートをエスケープ
  const escapedText = text.replace(/'/g, "''");

  // PowerShellスクリプト
  const psScript = `
    Add-Type -AssemblyName System.Speech;
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $synth.Rate = ${rate};
    $synth.Volume = ${vol};
    $synth.Speak('${escapedText}');
  `;

  // PowerShellコマンドを実行
  const command = `powershell -Command "${psScript.replace(/"/g, '\\"')}"`;
  
  await execAsync(command);
}

/**
 * Linux用の音声読み上げ
 * @param {string} text - テキスト
 * @param {number} speed - 速度
 * @param {number} volume - 音量
 * @param {string} language - 言語
 */
async function speakLinux(text, speed, volume, language) {
  // espeakの速度は80-450 words/min（デフォルト: 175）
  const rate = Math.round(175 * speed);
  
  // 音量は0-200（デフォルト: 100）
  const vol = Math.round(volume * 100);

  // 言語コード（ja, en等）
  const lang = language.split('-')[0];

  const escapedText = text.replace(/"/g, '\\"');
  const command = `espeak -v ${lang} -s ${rate} -a ${vol} "${escapedText}"`;
  
  await execAsync(command);
}

/**
 * 現在の読み上げを停止する
 */
export function stopSpeaking() {
  console.log('🛑 音声読み上げを停止します');
  
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    console.log('✅ 音声読み上げを停止しました');
  }
}

/**
 * 利用可能な音声のリストを取得する（macOSのみ）
 * @returns {Promise<Array<string>>} 音声名のリスト
 */
export async function getAvailableVoices() {
  try {
    const platform = os.platform();
    
    if (platform === 'darwin') {
      const { stdout } = await execAsync('say -v ?');
      const voices = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^(\S+)/);
          return match ? match[1] : null;
        })
        .filter(v => v);
      return voices;
    }
    
    // Windows/Linuxでは未実装
    return [];
  } catch (error) {
    console.error('音声リストの取得に失敗しました:', error);
    return [];
  }
}

/**
 * TTS機能が利用可能かチェックする
 * @returns {Promise<boolean>}
 */
export async function isTTSAvailable() {
  try {
    const platform = os.platform();
    
    if (platform === 'darwin') {
      // macOSではsayコマンドが標準で利用可能
      await execAsync('which say');
      return true;
    } else if (platform === 'win32') {
      // WindowsではPowerShellが利用可能
      return true;
    } else {
      // Linuxではespeakの確認
      await execAsync('which espeak');
      return true;
    }
  } catch (error) {
    return false;
  }
}
