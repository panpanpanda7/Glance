import InternVLModel from './models/internvl.js';
import InternVLTransformers from './models/internvl-transformers.js';
import { loadModelConfig } from './config-loader.js';

/**
 * 推論エンジン
 * モデルの管理と推論を担当する
 */
class InferenceEngine {
  constructor() {
    this.currentModel = null;
    this.modelConfig = null;
    this.activeModelName = null;
  }

  /**
   * エンジンを初期化する
   * @returns {Promise<void>}
   */
  async initialize() {
    console.log('🚀 推論エンジンを初期化中...');
    
    try {
      // 設定ファイルを読み込む
      this.modelConfig = loadModelConfig();
      this.activeModelName = this.modelConfig.activeModel;
      
      console.log(`📋 アクティブモデル: ${this.activeModelName}`);
      
      // アクティブモデルをロード
      await this.loadModel(this.activeModelName);
      
      console.log('✅ 推論エンジンの初期化が完了しました');
    } catch (error) {
      console.error('❌ 推論エンジンの初期化に失敗しました:', error);
      throw error;
    }
  }

  /**
   * 指定されたモデルをロードする
   * @param {string} modelName - モデル名
   * @returns {Promise<void>}
   */
  async loadModel(modelName) {
    console.log(`📦 モデルをロード中: ${modelName}`);
    
    // モデル設定を取得
    const config = this.modelConfig.models[modelName];
    if (!config) {
      throw new Error(`モデル設定が見つかりません: ${modelName}`);
    }

    // モデルタイプに応じてインスタンスを作成
    let model;
    switch (config.type) {
      case 'internvl':
        model = new InternVLModel(config);
        break;
      case 'transformers':
        // Transformers.js版（推奨）
        model = new InternVLTransformers(config);
        break;
      case 'qwen':
        // 将来的にQwenモデルを追加
        throw new Error('Qwenモデルはまだ実装されていません');
      default:
        throw new Error(`未知のモデルタイプ: ${config.type}`);
    }

    // モデルをロード
    await model.load();
    this.currentModel = model;
    this.activeModelName = modelName;
    
    console.log(`✅ ${modelName} のロードが完了しました`);
  }

  /**
   * モデルを切り替える
   * @param {string} modelName - 新しいモデル名
   * @returns {Promise<void>}
   */
  async switchModel(modelName) {
    console.log(`🔄 モデルを切り替え中: ${this.activeModelName} → ${modelName}`);
    
    // 既存のモデルをアンロード
    if (this.currentModel) {
      await this.currentModel.unload();
      this.currentModel = null;
    }

    // 新しいモデルをロード
    await this.loadModel(modelName);
    
    console.log(`✅ モデルの切り替えが完了しました: ${modelName}`);
  }

  /**
   * 画面を分析して説明文を生成する
   * @param {string} imageBase64 - Base64エンコードされた画像
   * @param {string} customPrompt - カスタムプロンプト（オプション）
   * @returns {Promise<string>} 生成された説明文
   */
  async analyze(imageBase64, customPrompt = null) {
    if (!this.currentModel) {
      throw new Error('モデルがロードされていません');
    }

    console.log('🔍 画面を分析中...');
    
    // プロンプトを構築
    const systemPrompt = this.modelConfig.prompt.systemPrompt;
    const prompt = customPrompt || systemPrompt;
    
    // 推論オプション
    const options = {
      temperature: this.modelConfig.prompt.temperature,
      maxTokens: this.modelConfig.prompt.maxTokens,
      topP: this.modelConfig.prompt.topP,
    };

    // 推論を実行
    const result = await this.currentModel.inference(imageBase64, prompt, options);
    
    console.log('✅ 分析が完了しました');
    return result;
  }

  /**
   * 現在のモデル情報を取得する
   * @returns {Object|null} モデル情報
   */
  getCurrentModelInfo() {
    if (!this.currentModel) {
      return null;
    }
    return this.currentModel.getModelInfo();
  }

  /**
   * 利用可能なモデルのリストを取得する
   * @returns {Array<Object>} モデルリスト
   */
  getAvailableModels() {
    const models = [];
    for (const [key, config] of Object.entries(this.modelConfig.models)) {
      models.push({
        id: key,
        name: config.name,
        type: config.type,
        precision: config.precision,
        estimatedInferenceTime: config.estimatedInferenceTime,
        ramRequired: config.ramRequired,
        active: key === this.activeModelName,
      });
    }
    return models;
  }

  /**
   * エンジンをシャットダウンする
   * @returns {Promise<void>}
   */
  async shutdown() {
    console.log('🛑 推論エンジンをシャットダウン中...');
    
    if (this.currentModel) {
      await this.currentModel.unload();
      this.currentModel = null;
    }
    
    console.log('✅ 推論エンジンのシャットダウンが完了しました');
  }
}

export default InferenceEngine;
