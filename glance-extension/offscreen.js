import { 
    Florence2ForConditionalGeneration, 
    AutoProcessor,
    AutoTokenizer,
    RawImage,
    env 
} from './lib/core.js';

// 環境設定
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = chrome.runtime.getURL('models/');

console.log('[Offscreen] Model path:', env.localModelPath);

let model = null;
let processor = null;
let tokenizer = null;
let isLoading = false;

function sendEvent(type, payload = {}) {
    chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

async function initializeModel() {
    if (model && processor && tokenizer) return { model, processor, tokenizer };
    if (isLoading) {
        while (isLoading) await new Promise(r => setTimeout(r, 100));
        return { model, processor, tokenizer };
    }

    isLoading = true;
    sendEvent('PROGRESS_UPDATE', { message: 'AIモデルを読み込み中...\n（初回は1-2分かかります）' });

    try {
        const modelId = 'onnx-community/Florence-2-base-ft';
        
        sendEvent('PROGRESS_UPDATE', { message: 'プロセッサを読み込み中...' });
        processor = await AutoProcessor.from_pretrained(modelId);
        tokenizer = processor?.tokenizer;

        if (!tokenizer) {
            sendEvent('PROGRESS_UPDATE', { message: 'トークナイザを読み込み中...' });
            tokenizer = await AutoTokenizer.from_pretrained(modelId);
        }

        // デバッグ: プロセッサの中身を確認（後で役立ちます）
        console.log('[Offscreen] Processor internals:', Object.keys(processor));

        sendEvent('PROGRESS_UPDATE', { message: 'モデル本体を読み込み中...' });
        model = await Florence2ForConditionalGeneration.from_pretrained(modelId, {
            dtype: {
                embed_tokens: 'q4',
                vision_encoder: 'fp16',
                encoder_model: 'q4',
                decoder_model_merged: 'q4',
            },
            device: 'webgpu',
        });
        
        console.log('[Offscreen] Model loaded');
        return { model, processor, tokenizer };
    } catch (error) {
        console.error('[Offscreen] Load error:', error);
        throw error;
    } finally {
        isLoading = false;
    }
}

async function analyzeImage(imageDataUrl) {
    const { model, processor, tokenizer } = await initializeModel();
    sendEvent('PROGRESS_UPDATE', { message: '画像を解析中...' });
    
    try {
        const image = await RawImage.fromURL(imageDataUrl);
        const task = '<MORE_DETAILED_CAPTION>';
        const prompts = [task];

        // ============================================================
        // 【最終解決策】 手動組み立て方式 (Manual Assembly)
        // processor() 関数を使わず、部品を個別に呼び出して確実にデータを作ります
        // ============================================================

        // 1. 画像処理コンポーネントの特定
        // ライブラリのバージョンによって名前が違うため、両方チェックします
        const vision_processor = processor.image_processor || processor.feature_extractor;
        if (!vision_processor) {
            throw new Error("画像処理コンポーネント(feature_extractor)が見つかりません。");
        }

        // 2. 画像を処理 -> pixel_values を生成
        // 【重要】配列 [image] で渡すことでイテレータエラーを回避
        const image_inputs = await vision_processor([image]);

        // 3. テキスト処理 -> input_ids と attention_mask を生成
        // tokenizer が関数として呼べない環境があるため、フォールバックを用意
        if (!tokenizer) {
            throw new Error('トークナイザが見つかりません。');
        }

        const tokenizeOptions = {
            padding: true,
            truncation: true,
            return_tensors: 'tensor' // WebGPU用にTensorオブジェクトで受け取る
        };

        let text_inputs;
        if (typeof tokenizer === 'function') {
            text_inputs = tokenizer(prompts, tokenizeOptions);
        } else if (typeof tokenizer._call === 'function') {
            text_inputs = tokenizer._call(prompts, tokenizeOptions);
        } else {
            throw new Error('トークナイザが関数として利用できません。');
        }

        // 4. 合体
        const inputs = {
            ...image_inputs, // pixel_values
            ...text_inputs,  // input_ids, attention_mask
        };

        // デバッグ: ここで attention_mask があることを確認
        console.log('[Offscreen] Inputs assembled:', {
            keys: Object.keys(inputs),
            has_mask: !!inputs.attention_mask,
            mask_type: inputs.attention_mask?.type
        });

        // 5. 推論実行
        const generatedIds = await model.generate({
            ...inputs,
            max_new_tokens: 256,
        });
        
        // 6. デコード
        const decode = tokenizer.batch_decode
            ? tokenizer.batch_decode.bind(tokenizer)
            : (ids, options) => ids.map(entry => tokenizer.decode(entry, options));

        const generatedText = decode(generatedIds, { 
            skip_special_tokens: false 
        })[0];
        
        const caption = generatedText
            .replace('<s>', '')
            .replace('</s>', '')
            .replace(task, '')
            .trim();
        
        console.log('[Offscreen] Result:', caption);
        return caption;
        
    } catch (error) {
        console.error('[Offscreen] Analyze error:', error);
        throw error;
    }
}

// メッセージ受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_ANALYSIS') {
        analyzeImage(message.imageData)
            .then(result => {
                sendEvent('ANALYSIS_SUCCESS', { result });
                sendResponse({ success: true });
            })
            .catch(error => {
                sendEvent('ANALYSIS_ERROR', { error: error.toString() });
                sendResponse({ success: false, error: error.toString() });
            });
        return true; 
    }
});

console.log('[Offscreen] Ready');
