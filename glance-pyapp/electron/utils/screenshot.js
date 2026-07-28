import { desktopCapturer, screen } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * 画面キャプチャユーティリティ
 */

/**
 * 「使用者が今見ている」ディスプレイを決める
 *
 * マウスカーソルのある画面を採用する。以前は desktopCapturer が返した
 * sources[0] を無条件に使っていたが、この並び順はプライマリディスプレイである
 * 保証がなく、マルチモニタ環境では「見ている画面と別のディスプレイを撮る」
 * 原因になっていた。
 *
 * @returns {Electron.Display}
 */
function getActiveDisplay() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (error) {
    console.warn('⚠️ カーソル位置の取得に失敗、プライマリディスプレイを使用します:', error.message);
    return screen.getPrimaryDisplay();
  }
}

/**
 * 全画面スクリーンショットを取得する
 *
 * @param {Object} [options]
 * @param {number} [options.maxLongEdge] 長辺の上限ピクセル数。
 *   バックエンドが縮小する解像度の2倍を渡すと、縮小時の品質を保ったまま
 *   キャプチャの所要時間と転送量を抑えられる（実測: 2940px で 330ms / 2.7MB、
 *   1792px なら約40%に減る）。省略時はディスプレイの実ピクセル数。
 * @returns {Promise<string>} Base64エンコードされた画像データ（PNG）
 */
export async function captureFullScreen(options = {}) {
  console.log('📸 画面キャプチャを開始...');

  try {
    const display = getActiveDisplay();

    // サムネイルサイズは対象ディスプレイの実ピクセル数を基準にする。
    // 1920x1080 固定だと高DPI機や4K・縦向きモニタで解像度が落ち、
    // 小さな文字がモデルから読めなくなる。
    const scale = display.scaleFactor || 1;
    let width = Math.round(display.size.width * scale);
    let height = Math.round(display.size.height * scale);

    // 縮小先より極端に大きく撮っても品質は上がらず、PNGエンコードと
    // 転送の時間だけが増える。長辺の上限で頭打ちにする（縦横比は維持）
    const limit = options.maxLongEdge;
    if (limit && Math.max(width, height) > limit) {
      const ratio = limit / Math.max(width, height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const thumbnailSize = { width, height };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize
    });

    if (sources.length === 0) {
      throw new Error('画面ソースが見つかりません');
    }

    // カーソルのあるディスプレイに対応するソースを選ぶ。
    // display_id が取れない環境（古いWindows等）ではソース順にフォールバック。
    const targetSource =
      sources.find(source => source.display_id === String(display.id)) || sources[0];

    if (targetSource.display_id !== String(display.id)) {
      console.warn(
        `⚠️ display_id が一致するソースがないため先頭を使用します ` +
        `(期待: ${display.id} / 取得: ${sources.map(s => s.display_id).join(',')})`
      );
    }

    const base64Image = targetSource.thumbnail.toPNG().toString('base64');

    console.log(
      `✅ 画面キャプチャ完了 (display=${display.id} ${thumbnailSize.width}x${thumbnailSize.height}, ` +
      `${(base64Image.length / 1024).toFixed(0)} KB)`
    );

    return base64Image;

  } catch (error) {
    console.error('❌ 画面キャプチャに失敗しました:', error);
    throw error;
  }
}

/**
 * 特定のウィンドウをキャプチャする
 * @param {string} windowTitle - ウィンドウのタイトル（部分一致）
 * @returns {Promise<string>} Base64エンコードされた画像データ
 */
export async function captureWindow(windowTitle) {
  console.log(`📸 ウィンドウをキャプチャ中: ${windowTitle}`);
  
  try {
    // 利用可能なウィンドウソースを取得
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: 1920,
        height: 1080
      }
    });

    // タイトルに一致するウィンドウを検索
    const targetWindow = sources.find(source => 
      source.name.toLowerCase().includes(windowTitle.toLowerCase())
    );

    if (!targetWindow) {
      throw new Error(`ウィンドウが見つかりません: ${windowTitle}`);
    }

    const thumbnail = targetWindow.thumbnail;
    const image = thumbnail.toPNG();
    const base64Image = image.toString('base64');
    
    console.log(`✅ ウィンドウキャプチャ完了: ${targetWindow.name}`);
    
    return base64Image;
    
  } catch (error) {
    console.error('❌ ウィンドウキャプチャに失敗しました:', error);
    throw error;
  }
}

/**
 * キャプチャした画像をファイルに保存する（デバッグ用）
 * @param {string} base64Image - Base64エンコードされた画像
 * @param {string} outputPath - 保存先パス
 */
export function saveScreenshot(base64Image, outputPath) {
  try {
    const buffer = Buffer.from(base64Image, 'base64');
    fs.writeFileSync(outputPath, buffer);
    console.log(`💾 スクリーンショットを保存しました: ${outputPath}`);
  } catch (error) {
    console.error('❌ スクリーンショットの保存に失敗しました:', error);
    throw error;
  }
}

/**
 * 利用可能な画面とウィンドウのリストを取得する
 * @returns {Promise<Object>} 画面とウィンドウのリスト
 */
export async function getAvailableSources() {
  try {
    const screens = await desktopCapturer.getSources({
      types: ['screen']
    });
    
    const windows = await desktopCapturer.getSources({
      types: ['window']
    });

    return {
      screens: screens.map(s => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id
      })),
      windows: windows.map(w => ({
        id: w.id,
        name: w.name
      }))
    };
  } catch (error) {
    console.error('❌ ソースの取得に失敗しました:', error);
    throw error;
  }
}
