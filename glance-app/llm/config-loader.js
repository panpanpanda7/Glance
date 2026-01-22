import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * YAML設定ファイルを読み込む
 * @param {string} configPath - 設定ファイルのパス
 * @returns {Object} パースされた設定オブジェクト
 */
export function loadConfig(configPath) {
  try {
    const absolutePath = path.resolve(__dirname, '..', configPath);
    const fileContents = fs.readFileSync(absolutePath, 'utf8');
    const config = yaml.load(fileContents);
    console.log(`✓ 設定ファイル読み込み成功: ${configPath}`);
    return config;
  } catch (error) {
    console.error(`✗ 設定ファイル読み込みエラー: ${configPath}`, error);
    throw error;
  }
}

/**
 * YAML設定ファイルを保存する
 * @param {Object} config - 保存する設定オブジェクト
 * @param {string} configPath - 保存先パス
 */
export function saveConfig(config, configPath) {
  try {
    const absolutePath = path.resolve(__dirname, '..', configPath);
    const yamlStr = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
    fs.writeFileSync(absolutePath, yamlStr, 'utf8');
    console.log(`✓ 設定ファイル保存成功: ${configPath}`);
  } catch (error) {
    console.error(`✗ 設定ファイル保存エラー: ${configPath}`, error);
    throw error;
  }
}

/**
 * モデル設定を読み込む
 * @returns {Object} モデル設定
 */
export function loadModelConfig() {
  return loadConfig('config/model-config.yaml');
}

/**
 * アプリ設定を読み込む
 * @returns {Object} アプリ設定
 */
export function loadAppConfig() {
  return loadConfig('config/app-config.yaml');
}

/**
 * モデル設定を保存する
 * @param {Object} config - モデル設定
 */
export function saveModelConfig(config) {
  saveConfig(config, 'config/model-config.yaml');
}

/**
 * アプリ設定を保存する
 * @param {Object} config - アプリ設定
 */
export function saveAppConfig(config) {
  saveConfig(config, 'config/app-config.yaml');
}
