import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);

/**
 * TTS（音声読み上げ）ユーティリティ - OS標準のTTS機能を使用する
 *
 * これはフォールバック経路。通常はレンダラー側の Web Speech API
 * （Chromium が Windows の SAPI5 音声を直接鳴らす）を使う。
 * そちらが使えない環境でのみ、ここが呼ばれる。
 *
 * 【Windows での注意】
 * 以前は PowerShell スクリプトを文字列として組み立て exec() に渡していたが、
 * exec() は Windows では cmd.exe /d /s /c 経由で動くため、
 *   - 複数行のコマンド文字列が成立しない
 *   - \" というエスケープは cmd の文法ではない（cmd は "" か ^"）
 *   - 日本語がコードページ932で文字化けする
 * という理由で実行自体が失敗し、Windows では一切音が出なかった。
 * 現在はスクリプトと読み上げテキストを UTF-8 のファイルに書き出し、
 * execFile()（シェルを介さない）で -File 実行する。コマンドラインに
 * 本文を載せないため、エスケープの問題が原理的に発生しない。
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
  if (!text || !text.trim()) return;

  const speed = options.speed || 1.0;
  const volume = options.volume || 1.0;
  const language = options.language || 'ja-JP';

  console.log(`🔊 音声読み上げを開始: "${text.substring(0, 50)}..."`);

  try {
    const platform = os.platform();

    if (platform === 'darwin') {
      await speakMacOS(text, speed, volume, language);
    } else if (platform === 'win32') {
      await speakWindows(text, speed, volume, language);
    } else {
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
 *
 * 本文はコマンドラインに載せず標準入力から渡す。長文や記号でも
 * エスケープ漏れが起きない。
 */
async function speakMacOS(text, speed, volume, language) {
  // macOSのsayコマンドは200 words/minがデフォルト
  const rate = Math.round(200 * speed);
  const voice = language.startsWith('en') ? 'Samantha' : 'Kyoko';

  currentProcess = execFile('say', ['-v', voice, '-r', String(rate)]);
  currentProcess.stdin.end(text);

  return waitForProcess('say');
}

/**
 * Windows用の音声読み上げ（SAPI / System.Speech）
 */
async function speakWindows(text, speed, volume, language) {
  // SAPIのRateは -10〜10（1.0倍 = 0）
  const rate = Math.max(-10, Math.min(10, Math.round((speed - 1.0) * 10)));
  const vol = Math.max(0, Math.min(100, Math.round(volume * 100)));

  const { scriptPath, textPath, cleanup } = writeSpeechFiles(text, language);

  currentProcess = execFile('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, textPath, String(rate), String(vol)
  ], { windowsHide: true });

  // スクリプト側の診断出力（日本語音声の有無など）をログに残す
  currentProcess.stdout?.on('data', d => console.log('[TTS]', String(d).trim()));
  currentProcess.stderr?.on('data', d => console.error('[TTS]', String(d).trim()));

  try {
    await waitForProcess('PowerShell');
  } finally {
    cleanup();
  }
}

/**
 * 読み上げ用の一時ファイル（スクリプトと本文）を書き出す
 *
 * どちらも UTF-8 + BOM で書く。BOM が無いと Windows PowerShell 5.x が
 * スクリプトをANSIとして読み、日本語のコメントや文字列が壊れる。
 */
function writeSpeechFiles(text, language) {
  const stamp = crypto.randomBytes(6).toString('hex');
  const textPath = path.join(os.tmpdir(), `glance-tts-${stamp}.txt`);
  const scriptPath = path.join(os.tmpdir(), `glance-tts-${stamp}.ps1`);

  const culture = language.startsWith('en') ? 'en' : 'ja';
  const script = [
    'param([string]$TextPath, [int]$Rate = 0, [int]$Volume = 100)',
    '$ErrorActionPreference = "Stop"',
    '$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)',
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$synth.Rate = $Rate',
    '$synth.Volume = $Volume',
    // 目的の言語の音声を明示的に選ぶ。既定音声が英語のままだと
    // 日本語が読み上げられず「何も聞こえない」に見えることがある
    `$want = "${culture}"`,
    '$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $want } | Select-Object -First 1',
    'if ($voice) {',
    '  $synth.SelectVoice($voice.VoiceInfo.Name)',
    '} else {',
    '  Write-Output ("指定言語の音声が見つかりません(" + $want + ")。既定の音声で読み上げます。")',
    '}',
    '$synth.Speak($text)',
    '$synth.Dispose()'
  ].join('\r\n');

  fs.writeFileSync(textPath, '﻿' + text, 'utf8');
  fs.writeFileSync(scriptPath, '﻿' + script, 'utf8');

  const cleanup = () => {
    for (const p of [textPath, scriptPath]) {
      try { fs.unlinkSync(p); } catch { /* 消せなくても実害なし */ }
    }
  };
  return { scriptPath, textPath, cleanup };
}

/**
 * Linux用の音声読み上げ（espeak）
 */
async function speakLinux(text, speed, volume, language) {
  const rate = Math.round(175 * speed);
  const vol = Math.round(volume * 100);
  const lang = language.split('-')[0];

  currentProcess = execFile('espeak', ['-v', lang, '-s', String(rate), '-a', String(vol), '--stdin']);
  currentProcess.stdin.end(text);

  return waitForProcess('espeak');
}

/**
 * 読み上げプロセスの終了を待つ
 *
 * 停止ボタンで kill された場合も正常系として扱う（呼び出し側は
 * 「途中で止めた」と「失敗した」を区別する必要がない）。
 */
function waitForProcess(label) {
  const proc = currentProcess;
  return new Promise((resolve, reject) => {
    proc.on('close', (code, signal) => {
      if (currentProcess === proc) currentProcess = null;
      if (code === 0 || code === null || signal) {
        resolve();
      } else {
        reject(new Error(`${label} が終了コード ${code} で終了しました`));
      }
    });
    proc.on('error', (error) => {
      if (currentProcess === proc) currentProcess = null;
      reject(error);
    });
  });
}

/**
 * 現在の読み上げを停止する
 *
 * Windows では子プロセスツリーごと止める。以前は exec() が起動した
 * cmd.exe だけが kill され、実際に喋っている powershell.exe が生き残って
 * 読み上げが止まらなかった。
 */
export function stopSpeaking() {
  if (!currentProcess) return;

  console.log('🛑 音声読み上げを停止します');
  const proc = currentProcess;
  currentProcess = null;

  if (os.platform() === 'win32' && proc.pid) {
    // /T = 子プロセスも含めて終了、/F = 強制
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  try {
    proc.kill();
  } catch (error) {
    console.warn('⚠️ 読み上げプロセスの停止に失敗しました:', error.message);
  }
}

/**
 * 利用可能な音声のリストを取得する（診断用）
 *
 * テスターの環境で「日本語音声が入っていないから読まれない」のか
 * 「実装が動いていない」のかを切り分けるために使う。
 *
 * @returns {Promise<Array<{name: string, language: string}>>}
 */
export async function getAvailableVoices() {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      const { stdout } = await execAsync('say -v ?');
      return stdout.split('\n')
        .map(line => line.match(/^(\S+)\s+(\S+)/))
        .filter(Boolean)
        .map(m => ({ name: m[1], language: m[2] }));
    }

    if (platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {',
        '  $_.VoiceInfo.Name + "\t" + $_.VoiceInfo.Culture.Name',
        '}'
      ].join('\r\n');
      const scriptPath = path.join(os.tmpdir(), `glance-voices-${crypto.randomBytes(6).toString('hex')}.ps1`);
      fs.writeFileSync(scriptPath, '﻿' + script, 'utf8');
      try {
        const stdout = await new Promise((resolve, reject) => {
          execFile('powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { windowsHide: true, encoding: 'utf8' },
            (error, out) => (error ? reject(error) : resolve(out)));
        });
        return stdout.split(/\r?\n/)
          .map(line => line.split('\t'))
          .filter(parts => parts.length === 2 && parts[0].trim())
          .map(parts => ({ name: parts[0].trim(), language: parts[1].trim() }));
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* 実害なし */ }
      }
    }

    return [];
  } catch (error) {
    console.error('音声リストの取得に失敗しました:', error.message);
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
      await execAsync('which say');
      return true;
    } else if (platform === 'win32') {
      return true;
    } else {
      await execAsync('which espeak');
      return true;
    }
  } catch (error) {
    return false;
  }
}
