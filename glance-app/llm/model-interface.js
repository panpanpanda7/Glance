import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Vision-Language Model の共通インターフェース
 * すべてのVLMモデル実装はこのクラスを継承する
 */
class VisionLanguageModel {
  /**
   * @param {Object} config - モデル設定
   * @param {string} config.name - モデル名
   * @param {string} config.type - モデルタイプ
   * @param {string} config.modelPath - モデルファイルパス
   */
  constructor(config) {
    this.modelName = config.name;
    this.modelType = config.type;
    this.modelPath = config.modelPath;
    this.config = config;
    this.isLoaded = false;
    this.model = null;
  }

  /**
   * モデルをメモリにロードする
   * @abstract
   * @returns {Promise<void>}
   */
  async load() {
    throw new Error('load() must be implemented by subclass');
  }

  /**
   * 画像から説明文を生成する
   * @abstract
   * @param {string} imageBase64 - Base64エンコードされた画像
   * @param {string} prompt - プロンプト
   * @param {Object} options - 推論オプション
   * @param {number} options.temperature - 温度パラメータ（デフォルト: 0.1）
   * @param {number} options.maxTokens - 最大トークン数（デフォルト: 1000）
   * @param {number} options.topP - Top-pサンプリング（デフォルト: 0.9）
   * @returns {Promise<string>} 生成された説明文
   */
  async inference(imageBase64, prompt, options = {}) {
    throw new Error('inference() must be implemented by subclass');
  }

  /**
   * モデルをメモリからアンロードする
   * @abstract
   * @returns {Promise<void>}
   */
  async unload() {
    throw new Error('unload() must be implemented by subclass');
  }

  /**
   * モデル情報を取得する
   * @returns {Object} モデル情報
   */
  getModelInfo() {
    return {
      name: this.modelName,
      type: this.modelType,
      loaded: this.isLoaded,
      path: this.modelPath,
      config: this.config
    };
  }

  /**
   * モデルがロード済みかチェックする
   * @returns {boolean}
   */
  isModelLoaded() {
    return this.isLoaded;
  }

  /**
   * モデルパスの存在確認
   * @returns {boolean}
   */
  modelExists() {
    try {
      const fullPath = path.resolve(__dirname, '..', this.modelPath);
      return fs.existsSync(fullPath);
    } catch (error) {
      return false;
    }
  }
}

export default VisionLanguageModel;
