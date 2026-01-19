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
        const modelId = 'onnx-community/Florence-2-large-ft';
        
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
        const captionTask = '<CAPTION>';
        const detailTask = '<MORE_DETAILED_CAPTION>';
        const ocrTask = '<OCR>';

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

        const decode = tokenizer.batch_decode
            ? tokenizer.batch_decode.bind(tokenizer)
            : (ids, options) => ids.map(entry => tokenizer.decode(entry, options));

        const tokenize = (prompts) => {
            if (typeof tokenizer === 'function') {
                return tokenizer(prompts, tokenizeOptions);
            }
            if (typeof tokenizer._call === 'function') {
                return tokenizer._call(prompts, tokenizeOptions);
            }
            throw new Error('トークナイザが関数として利用できません。');
        };

        const runTask = async (task, maxTokens = 256) => {
            const prompts = [task];
            const text_inputs = tokenize(prompts);

            const inputs = {
                ...image_inputs, // pixel_values
                ...text_inputs,  // input_ids, attention_mask
            };

            console.log('[Offscreen] Inputs assembled:', {
                keys: Object.keys(inputs),
                has_mask: !!inputs.attention_mask,
                mask_type: inputs.attention_mask?.type,
                task
            });

            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: maxTokens,
            });

            const generatedText = decode(generatedIds, { 
                skip_special_tokens: false 
            })[0];

            const taskToken = task.replace(/[<>]/g, '');
            return generatedText
                .replace('<s>', '')
                .replace('</s>', '')
                .replace(task, '')
                .replace(taskToken, '')
                .replace(/<loc_\d+>/g, '')
                .replace(/<\/?poly>/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const caption = await runTask(captionTask, 256);
        const detailed = await runTask(detailTask, 256);
        const ocrText = await runTask(ocrTask, 512);

        const ocrLines = ocrText
            .split(/\n|  +/)
            .map(line => line.trim())
            .filter(line => line.length > 2)
            .filter(line => !/^[\W_]+$/.test(line))
            .filter(line => !/^[A-Za-z]$/.test(line));

        const uniqueLines = Array.from(new Set(ocrLines));
        const pickTopLines = (lines) => {
            const ranked = lines.map((line) => {
                const hasRank = /^(?:\d+|[①-⑳])[\).、]?\s*/.test(line);
                const hasPercent = /[%％]/.test(line);
                const hasNumber = /\d/.test(line);
                const lengthScore = Math.min(line.length, 80);
                return {
                    line,
                    score: (hasRank ? 40 : 0) + (hasPercent ? 20 : 0) + (hasNumber ? 10 : 0) + lengthScore,
                };
            });

            return ranked
                .sort((a, b) => b.score - a.score)
                .map(entry => entry.line)
                .slice(0, 6);
        };

        const topLines = pickTopLines(uniqueLines);

        const result = topLines.length > 0
            ? `画面内テキストの要約: ${topLines.join('、')}`
            : (detailed || caption || '画面内テキストを抽出できませんでした。');
        
        console.log('[Offscreen] Result:', result);
        return result;
        
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
