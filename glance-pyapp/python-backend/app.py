"""
Glance Python Backend - Flask API Server
Vision-Language Modelを使った画像分析API
"""

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import yaml
import base64
from PIL import Image
import io
import os
import sys
import time
from models.internvl import InternVLModel
from models.internvl_gguf import InternVLGGUFModel

# Flask アプリケーション初期化
app = Flask(__name__)
CORS(app)  # Electronからのアクセスを許可

# グローバル変数
current_model = None
config = None


def load_config():
    """設定ファイルを読み込む"""
    config_path = os.path.join(os.path.dirname(__file__), 'config.yaml')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def load_model(model_name: str):
    """モデルをロード"""
    global current_model
    
    print(f"\n{'='*60}")
    print(f"📦 モデルをロード中: {model_name}")
    print(f"{'='*60}\n")
    
    model_config = config['models'][model_name]
    model_path = os.path.join(os.path.dirname(__file__), model_config['path'])
    
    # 既存モデルをアンロード
    if current_model is not None:
        print("🗑️  既存モデルをアンロード中...")
        current_model.unload()
    
    # 新しいモデルをロード
    if model_config['type'] == 'internvl':
        current_model = InternVLModel(model_path)
    elif model_config['type'] == 'internvl_gguf':
        # GGUF量子化モデル
        mmproj_path = model_config.get('mmproj_path')
        draft_model_path = model_config.get('draft_model_path')
        
        # 投機的デコーディングが無効の場合はドラフトモデルパスをNoneに
        if not model_config.get('speculativeDecoding', False):
            draft_model_path = None
            
        current_model = InternVLGGUFModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            draft_model_path=draft_model_path
        )
    elif model_config['type'] == 'qwen':
        # 将来実装
        raise NotImplementedError("Qwenモデルはまだ実装されていません")
    else:
        raise ValueError(f"不明なモデルタイプ: {model_config['type']}")
    
    current_model.load()
    
    print(f"\n✅ モデルロード完了: {model_name}")
    print(f"{'='*60}\n")


# =====================================
# API エンドポイント
# =====================================

@app.route('/health', methods=['GET'])
def health_check():
    """ヘルスチェック"""
    return jsonify({
        'status': 'ok',
        'model_loaded': current_model is not None and current_model.is_loaded
    })


@app.route('/analyze', methods=['POST'])
def analyze():
    """
    画像を分析してテキストを生成
    
    Request Body:
        {
            "image": "base64_encoded_image",
            "prompt": "説明してください"
        }
    
    Response:
        {
            "success": true,
            "result": "生成されたテキスト",
            "model": {...}
        }
    """
    try:
        # リクエストデータを取得
        data = request.json
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'リクエストボディが空です'
            }), 400
        
        image_base64 = data.get('image')
        if not image_base64:
            return jsonify({
                'success': False,
                'error': '画像データがありません'
            }), 400
        
        # デフォルトプロンプトを使用
        prompt = data.get('prompt', config['prompt']['systemPrompt'])
        
        # プロンプトタイプを取得（デフォルトは 'standard'）
        prompt_type = data.get('promptType', 'standard')
        
        # プロンプトタイプに応じてプロンプトを選択（使用頻度順）
        if prompt_type == 'standard':  # 最も頻度が高い
            prompt = data.get('prompt', config['prompt']['systemPrompt'])
        elif prompt_type == 'detailed':
            prompt = data.get('prompt', config['prompt']['detailedPrompt'])
        elif prompt_type == 'question':  # 将来の機能
            question_text = data.get('question', '')
            prompt = config['prompt']['questionPrompt'].format(question=question_text)
        else:
            # 未知のプロンプトタイプの場合はデフォルト
            prompt = data.get('prompt', config['prompt']['systemPrompt'])
            
        # パラメータ
        options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', config['prompt']['maxTokens']),
            'top_p': data.get('top_p', config['prompt']['topP']),
            'repetition_penalty': data.get('repetition_penalty', config['prompt'].get('repetition_penalty', 1.0)),
            'no_repeat_ngram_size': data.get('no_repeat_ngram_size', config['prompt'].get('no_repeat_ngram_size', 0))
        }
        
        print(f"\n📸 画像分析リクエスト受信")
        print(f"   画像サイズ: {len(image_base64)} bytes (base64)")
        print(f"   プロンプトタイプ: {prompt_type}")
        print(f"   プロンプト長: {len(prompt)} 文字")
        
        # Base64をPIL Imageに変換
        try:
            image_bytes = base64.b64decode(image_base64)
            image = Image.open(io.BytesIO(image_bytes))
            print(f"   画像解像度: {image.size}")
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'画像のデコードに失敗: {str(e)}'
            }), 400
        
        # モデルで推論
        if current_model is None or not current_model.is_loaded:
            return jsonify({
                'success': False,
                'error': 'モデルがロードされていません'
            }), 500
        
        result = current_model.inference(image, prompt, **options)
        
        print(f"✅ 分析完了")
        print(f"   結果: {result[:100]}..." if len(result) > 100 else f"   結果: {result}")
        
        return jsonify({
            'success': True,
            'result': result,
            'model': current_model.get_info()
        })
        
    except Exception as e:
        print(f"❌ エラーが発生しました: {e}")
        import traceback
        traceback.print_exc()
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/switch-model', methods=['POST'])
def switch_model():
    """
    モデルを切り替える
    
    Request Body:
        {
            "model": "internvl-8b"
        }
    """
    try:
        data = request.json
        model_name = data.get('model')
        
        if not model_name:
            return jsonify({
                'success': False,
                'error': 'モデル名が指定されていません'
            }), 400
        
        if model_name not in config['models']:
            return jsonify({
                'success': False,
                'error': f'モデル "{model_name}" は設定に存在しません'
            }), 400
        
        load_model(model_name)
        
        return jsonify({
            'success': True,
            'model': current_model.get_info()
        })
        
    except Exception as e:
        print(f"❌ モデル切り替えエラー: {e}")
        import traceback
        traceback.print_exc()
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/models', methods=['GET'])
def get_models():
    """利用可能なモデルのリストを取得"""
    return jsonify({
        'active_model': config['activeModel'],
        'models': {
            name: {
                'name': info['name'],
                'type': info['type'],
                'precision': info['precision'],
                'estimatedInferenceTime': info['estimatedInferenceTime'],
                'ramRequired': info['ramRequired']
            }
            for name, info in config['models'].items()
        }
    })


@app.route('/analyze-stream', methods=['POST'])
def analyze_stream():
    """
    画像を分析してストリーミング形式でテキストを生成
    視覚障害者への即時フィードバック用
    
    Request Body:
        {
            "image": "base64_encoded_image",
            "promptType": "standard"
        }
    
    Response:
        Server-Sent Events (text/event-stream)
        各チャンクは "data: {text}" 形式で送信
    """
    try:
        # リクエストデータを取得
        data = request.json
        
        if not data:
            return jsonify({
                'success': False,
                'error': 'リクエストボディが空です'
            }), 400
        
        image_base64 = data.get('image')
        if not image_base64:
            return jsonify({
                'success': False,
                'error': '画像データがありません'
            }), 400
        
        # プロンプトタイプを取得
        prompt_type = data.get('promptType', 'standard')
        
        # プロンプトタイプに応じてプロンプトを選択
        if prompt_type == 'standard':
            prompt = config['prompt']['systemPrompt']
        elif prompt_type == 'detailed':
            prompt = config['prompt']['detailedPrompt']
        elif prompt_type == 'question':
            question_text = data.get('question', '')
            prompt = config['prompt']['questionPrompt'].format(question=question_text)
        else:
            prompt = config['prompt']['systemPrompt']
        
        # パラメータ
        options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', config['prompt']['maxTokens']),
        }
        
        print(f"\n📸 ストリーミング分析リクエスト受信")
        print(f"   プロンプトタイプ: {prompt_type}")
        
        # Base64をPIL Imageに変換
        try:
            image_bytes = base64.b64decode(image_base64)
            image = Image.open(io.BytesIO(image_bytes))
            print(f"   画像解像度: {image.size}")
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'画像のデコードに失敗: {str(e)}'
            }), 400
        
        # モデルチェック
        if current_model is None or not current_model.is_loaded:
            return jsonify({
                'success': False,
                'error': 'モデルがロードされていません'
            }), 500
        
        # ストリーミング非対応モデルの場合は通常の推論を実行
        if not hasattr(current_model, 'inference_stream'):
            result = current_model.inference(image, prompt, **options)
            return jsonify({
                'success': True,
                'result': result,
                'model': current_model.get_info()
            })
        
        def generate():
            """ストリーミングジェネレーター"""
            start_time = time.time()
            token_count = 0
            first_token_time = None
            
            try:
                for chunk in current_model.inference_stream(image, prompt, **options):
                    if first_token_time is None:
                        first_token_time = time.time() - start_time
                    
                    token_count += 1
                    yield f"data: {chunk}\n\n"
                
                # 性能統計を出力
                total_time = time.time() - start_time
                tps = token_count / total_time if total_time > 0 else 0
                
                print(f"✅ ストリーミング分析完了")
                print(f"   📊 TTFT (初動時間): {first_token_time:.2f}s")
                print(f"   📊 TPS (トークン/秒): {tps:.2f}")
                print(f"   📊 総時間: {total_time:.2f}s")
                
                yield f"data: [DONE]\n\n"
                
            except Exception as e:
                print(f"❌ ストリーミングエラー: {e}")
                yield f"data: [ERROR] {str(e)}\n\n"
        
        return Response(
            stream_with_context(generate()),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            }
        )
        
    except Exception as e:
        print(f"❌ ストリーミングエラー: {e}")
        import traceback
        traceback.print_exc()
        
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =====================================
# アプリケーション起動
# =====================================

if __name__ == '__main__':
    print("\n" + "="*60)
    print("🚀 Glance Python Backend 起動中...")
    print("="*60 + "\n")
    
    # 設定を読み込む
    try:
        config = load_config()
        print("✅ 設定ファイル読み込み成功")
    except Exception as e:
        print(f"❌ 設定ファイルの読み込みに失敗: {e}")
        sys.exit(1)
    
    # アクティブモデルをロード
    try:
        active_model = config['activeModel']
        load_model(active_model)
    except Exception as e:
        print(f"❌ モデルのロードに失敗: {e}")
        print("⚠️  モデルなしでサーバーを起動します")
    
    # Flaskサーバーを起動
    server_config = config.get('server', {})
    host = server_config.get('host', '127.0.0.1')
    port = server_config.get('port', 5000)
    debug = server_config.get('debug', False)
    
    print(f"\n{'='*60}")
    print(f"🌐 Flask サーバーを起動: http://{host}:{port}")
    print(f"{'='*60}\n")
    
    app.run(host=host, port=port, debug=debug, threaded=True)
