import { desktopCapturer } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * 画面キャプチャユーティリティ
 */

/**
 * 全画面スクリーンショットを取得する
 * @returns {Promise<string>} Base64エンコードされた画像データ
 */
export async function captureFullScreen() {
  console.log('📸 画面キャプチャを開始...');
  
  try {
    // 利用可能な画面ソースを取得
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: 1920,
        height: 1080
      }
    });

    if (sources.length === 0) {
      throw new Error('画面ソースが見つかりません');
    }

    // 最初の画面（プライマリディスプレイ）を使用
    const primarySource = sources[0];
    const thumbnail = primarySource.thumbnail;

    // PNG形式でエンコード
    const image = thumbnail.toPNG();
    
    // Base64に変換
    const base64Image = image.toString('base64');
    
    console.log(`✅ 画面キャプチャ完了 (サイズ: ${(base64Image.length / 1024).toFixed(2)} KB)`);
    
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
