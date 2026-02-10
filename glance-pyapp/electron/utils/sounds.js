import { exec } from 'child_process';
import os from 'os';

/**
 * 音声フィードバックユーティリティ
 * 視覚障害者向けに操作時に音を鳴らす
 */

let progressSoundInterval = null;

/**
 * ビープ音を鳴らす（クロスプラットフォーム対応）
 * @param {number} frequency - 周波数（Hz）
 * @param {number} duration - 持続時間（ミリ秒）
 */
async function playBeep(frequency, duration) {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      // macOS: osascriptを使用してビープ音を生成
      await playBeepMacOS(frequency, duration);
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
 * @param {number} frequency - 周波数（Hz）- システムサウンドファイル選択に使用
 * @param {number} duration - 持続時間（ミリ秒）- 未使用（システムサウンドの長さに依存）
 */
function playBeepMacOS(frequency, duration) {
  return new Promise((resolve) => {
    // macOSでは周波数を直接制御できないため、
    // 周波数の値に応じて異なるシステムサウンドを使用
    let soundFile;
    
    if (frequency >= 950) {
      // 高音（1000Hz付近）→ Tink（軽い金属音）
      soundFile = '/System/Library/Sounds/Tink.aiff';
    } else if (frequency >= 750) {
      // 中音（800Hz付近）→ Pop（ポップ音）
      soundFile = '/System/Library/Sounds/Pop.aiff';
    } else if (frequency >= 650) {
      // 推論継続音（700Hz付近）→ Tink（控えめ）
      soundFile = '/System/Library/Sounds/Tink.aiff';
    } else if (frequency >= 550) {
      // 低音（600Hz付近）→ Morse（モールス音）
      soundFile = '/System/Library/Sounds/Morse.aiff';
    } else {
      // エラー音など（400Hz以下）→ Basso（低い警告音）
      soundFile = '/System/Library/Sounds/Basso.aiff';
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
  console.log('🔊 キャプチャ音を再生');
  await playBeep(1000, 100);
}

/**
 * 詳細分析音（中音のダブルピッ）
 */
export async function playDetailedSound() {
  console.log('🔊 詳細分析音を再生');
  await playBeep(800, 80);
  await new Promise(resolve => setTimeout(resolve, 100));
  await playBeep(800, 80);
}

/**
 * 質問音（低めの単音）
 */
export async function playQuestionSound() {
  console.log('🔊 質問音を再生');
  await playBeep(600, 100);
}

/**
 * 推論継続中の音（控えめなティック音）
 * 2秒ごとに繰り返し再生
 */
export function startProgressSound() {
  // 既に再生中の場合は停止
  stopProgressSound();
  
  console.log('🔊 推論継続音を開始');
  
  // 2秒ごとに繰り返し
  progressSoundInterval = setInterval(() => {
    playBeep(700, 50);
  }, 2000);
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
 * エラー音（下降音）
 */
export async function playErrorSound() {
  console.log('🔊 エラー音を再生');
  await playBeep(800, 100);
  await new Promise(resolve => setTimeout(resolve, 50));
  await playBeep(400, 150);
}

/**
 * 成功音（上昇音）
 */
export async function playSuccessSound() {
  console.log('🔊 成功音を再生');
  await playBeep(600, 80);
  await new Promise(resolve => setTimeout(resolve, 50));
  await playBeep(900, 100);
}
