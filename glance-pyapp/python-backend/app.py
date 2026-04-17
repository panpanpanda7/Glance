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
import threading
import requests
from models.internvl import InternVLModel
from models.internvl_gguf import InternVLGGUFModel
from models.qwen_vl_gguf import QwenVLGGUFModel
from models.qwen3_vl_server import Qwen3VLServerModel

# ==========================================
# WindowsでのUnicode出力エラー対策
# ==========================================
# 標準出力と標準エラー出力をUTF-8に強制する
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Flask アプリケーション初期化
app = Flask(__name__)
CORS(app)  # Electronからのアクセスを許可

# ==========================================
# グローバル変数・設定
# ==========================================
# ※ダウンロードURLは config.yaml のモデル定義から取得されます

# グローバル変数
current_model = None
config = None

# アプリの状態管理
app_state = {
    "status": "initializing",  # initializing, downloading, loading_model, ready, error
    "progress": 0,             # ダウンロード進捗 (0-100)
    "message": "起動準備中...",
    "detail": ""
}


def get_writable_model_path():
    """書き込み可能なモデル保存先パスを取得"""
    if getattr(sys, 'frozen', False):
        # EXE実行時はユーザーのAppDataフォルダを使用 (権限エラー回避)
        if sys.platform == 'win32':
            base_dir = os.path.join(os.environ.get('APPDATA', ''), 'Glance', 'models')
        elif sys.platform == 'darwin':
            base_dir = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'Glance', 'models')
        else:
            base_dir = os.path.join(os.path.expanduser('~'), '.local', 'share', 'Glance', 'models')
    else:
        # 開発時はローカルのmodelsフォルダ
        base_dir = os.path.join(os.path.dirname(__file__), 'models', 'gguf')
    
    os.makedirs(base_dir, exist_ok=True)
    return base_dir


def download_file(url, dest_path, file_description="ファイル"):
    """進捗状況を更新しながらファイルをダウンロード"""
    try:
        print(f"📥 {file_description}をダウンロード中: {url}")
        response = requests.get(url, stream=True)
        response.raise_for_status()
        total_size = int(response.headers.get('content-length', 0))
        downloaded_size = 0
        last_reported_progress = -1  # 最後に表示した進捗を記録
        
        with open(dest_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded_size += len(chunk)
                    if total_size > 0:
                        progress = int((downloaded_size / total_size) * 100)
                        # 進捗をグローバル変数に反映
                        app_state["progress"] = progress
                        app_state["detail"] = f"{progress}% ({downloaded_size // 1024 // 1024}MB / {total_size // 1024 // 1024}MB)"
                        
                        # 10%刻みでログ出力（前回と異なる場合のみ）
                        if progress % 10 == 0 and progress != 0 and progress != last_reported_progress:
                            print(f"   進捗: {progress}%")
                            last_reported_progress = progress  # 更新
        
        print(f"✅ {file_description}のダウンロード完了: {dest_path}")
                        
    except Exception as e:
        print(f"❌ ダウンロードエラー: {e}")
        raise e


def initialize_system():
    """バックグラウンド初期化処理"""
    global current_model, config
    
    try:
        # 1. アクティブモデルを config から取得
        active_model_name = config.get('activeModel')
        if not active_model_name or active_model_name not in config.get('models', {}):
            raise ValueError(f"config.yaml に有効な activeModel が設定されていません: {active_model_name}")
        
        active_model_config = config['models'][active_model_name]
        model_type = active_model_config.get('type')
        
        if model_type not in ['internvl_gguf', 'qwen_vl_gguf', 'qwen3_vl_server']:
            raise NotImplementedError(f"モデルタイプ '{model_type}' はまだサポートされていません")
        
        # 2. 保存先パスの決定とファイル名を config から抽出
        model_dir = get_writable_model_path()
        
        # config の相対パスからファイル名を抽出
        model_relative_path = active_model_config.get('path', '')
        model_filename = os.path.basename(model_relative_path)
        mmproj_relative_path = active_model_config.get('mmproj_path', '')
        mmproj_filename = os.path.basename(mmproj_relative_path)
        
        model_path = os.path.join(model_dir, model_filename)
        mmproj_path = os.path.join(model_dir, mmproj_filename)
        
        # 3. ダウンロードURL を config から取得
        model_download_url = active_model_config.get('download_url')
        mmproj_download_url = active_model_config.get('mmproj_download_url')
        
        if not model_download_url or not mmproj_download_url:
            raise ValueError(f"モデル設定に download_url または mmproj_download_url が設定されていません")
        
        # 4. モデルの存在確認とダウンロード
        if not os.path.exists(model_path):
            app_state["status"] = "downloading"
            app_state["message"] = "AIモデルをダウンロードしています..."
            app_state["progress"] = 0
            download_file(model_download_url, model_path, "AIモデル")
            
        if not os.path.exists(mmproj_path):
            app_state["status"] = "downloading"
            app_state["message"] = "画像処理エンジンをダウンロードしています..."
            app_state["progress"] = 0
            download_file(mmproj_download_url, mmproj_path, "画像処理エンジン")

        # 5. モデルのロード
        app_state["status"] = "loading_model"
        app_state["message"] = "AIを起動しています..."
        app_state["progress"] = 100
        app_state["detail"] = ""
        
        print(f"\n{'='*60}")
        print(f"📦 モデルをロード中: {active_model_name}")
        print(f"   パス: {model_path}")
        print(f"{'='*60}\n")
        
        # モデルをロード（タイプ別）
        if model_type == 'internvl_gguf':
            current_model = InternVLGGUFModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                draft_model_path=None
            )
        elif model_type == 'qwen_vl_gguf':
            current_model = QwenVLGGUFModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                draft_model_path=None
            )
        elif model_type == 'qwen3_vl_server':
            # Qwen3-VL (llama-server経由)
            server_url = active_model_config.get('server_url', 'http://127.0.0.1:8080')
            current_model = Qwen3VLServerModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                server_url=server_url
            )
        
        current_model.load()
        
        app_state["status"] = "ready"
        app_state["message"] = "準備完了"
        app_state["detail"] = ""
        
        print(f"\n✅ モデルロード完了")
        print(f"{'='*60}\n")
        
    except Exception as e:
        print(f"❌ 初期化エラー: {e}")
        import traceback
        traceback.print_exc()
        app_state["status"] = "error"
        app_state["message"] = "起動エラーが発生しました"
        app_state["detail"] = str(e)


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
    model_path = model_config['path']
    
    # 相対パスの場合は絶対パスに変換
    if not os.path.isabs(model_path):
        model_path = os.path.join(os.path.dirname(__file__), model_path)
    
    # 既存モデルをアンロード
    if current_model is not None:
        print("🗑️  既存モデルをアンロード中...")
        current_model.unload()
    
    # 新しいモデルをロード
    if model_config['type'] == 'internvl':
        current_model = InternVLModel(model_path)
    elif model_config['type'] == 'internvl_gguf':
        # GGUF量子化モデル（InternVL）
        mmproj_path = model_config.get('mmproj_path')
        draft_model_path = model_config.get('draft_model_path')
        
        # mmproj_pathも相対パスの場合は絶対パスに変換
        if mmproj_path and not os.path.isabs(mmproj_path):
            mmproj_path = os.path.join(os.path.dirname(__file__), mmproj_path)
        
        # draft_model_pathも相対パスの場合は絶対パスに変換
        if draft_model_path and not os.path.isabs(draft_model_path):
            draft_model_path = os.path.join(os.path.dirname(__file__), draft_model_path)
        
        # 投機的デコーディングが無効の場合はドラフトモデルパスをNoneに
        if not model_config.get('speculativeDecoding', False):
            draft_model_path = None
            
        current_model = InternVLGGUFModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            draft_model_path=draft_model_path
        )
    elif model_config['type'] == 'qwen_vl_gguf':
        # GGUF量子化モデル（Qwen VL）
        mmproj_path = model_config.get('mmproj_path')
        
        # mmproj_pathも相対パスの場合は絶対パスに変換
        if mmproj_path and not os.path.isabs(mmproj_path):
            mmproj_path = os.path.join(os.path.dirname(__file__), mmproj_path)
        
        current_model = QwenVLGGUFModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            draft_model_path=None
        )
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


@app.route('/status', methods=['GET'])
def get_status():
    """現在のシステム状態を返す（Electronポーリング用）"""
    return jsonify(app_state)


@app.route('/analyze', methods=['POST'])
def analyze():
    """
    画像を分析してテキストを生成（2段階生成）
    
    Request Body:
        {
            "image": "base64_encoded_image",
            "promptType": "standard" | "detailed" | "question",
            "question": "質問文（promptType='question'の場合）",
            "debug": false
        }
    
    Response:
        {
            "success": true,
            "result": "最終的な説明文",
            "intermediate": {...},  // debug=true の場合のみ
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
        
        # プロンプトタイプを取得（デフォルトは 'standard'）
        prompt_type = data.get('promptType', 'standard')
        debug = data.get('debug', False)
        
        # プロンプトタイプに応じてプロンプトとmaxTokensを選択
        max_tokens_map = {
            'standard': config['prompt']['maxTokens']['summary'],    # 150
            'detailed': config['prompt']['maxTokens']['detailed'],   # 400
            'question': config['prompt']['maxTokens']['question']    # 200
        }
        
        if prompt_type == 'standard':
            phase2_prompt_template = config['prompt']['phase2_summary']
            default_max_tokens = max_tokens_map['standard']
        elif prompt_type == 'detailed':
            phase2_prompt_template = config['prompt']['phase2_detailed']
            default_max_tokens = max_tokens_map['detailed']
        elif prompt_type == 'question':
            question_text = data.get('question', '')
            phase2_prompt_template = config['prompt']['questionPrompt'].format(question=question_text)
            default_max_tokens = max_tokens_map['question']
        else:
            # 未知のプロンプトタイプの場合はデフォルト
            phase2_prompt_template = config['prompt']['phase2_summary']
            default_max_tokens = max_tokens_map['standard']
        
        # 第1段階・第2段階の共通パラメータ
        phase1_options = {
            'temperature': config['prompt']['temperature'],  # 0.0（決定論的）
            'max_tokens': 300,
            'top_p': config['prompt']['topP'],
            'repetition_penalty': config['prompt'].get('repetition_penalty', 1.3)
        }
        
        phase2_options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', default_max_tokens),
            'top_p': data.get('top_p', config['prompt']['topP']),
            'repetition_penalty': data.get('repetition_penalty', config['prompt'].get('repetition_penalty', 1.3))
        }
        
        print(f"\n📸 【2段階分析】リクエスト受信")
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
        
        # モデルロード確認
        if current_model is None or not current_model.is_loaded:
            return jsonify({
                'success': False,
                'error': 'モデルがロードされていません'
            }), 500
        
        # ========================
        # 【第1段階】構造化抽出
        # ========================
        phase1_prompt = config['prompt']['phase1_extraction']
        intermediate_json = current_model.inference_phase1_extraction(
            image, phase1_prompt, **phase1_options
        )
        
        # ========================
        # 【第2段階】自然文生成
        # ========================
        final_result = current_model.inference_phase2_generation(
            intermediate_json, phase2_prompt_template, **phase2_options
        )
        
        print(f"✅ 【2段階分析】完了")
        print(f"   最終結果: {final_result[:100]}..." if len(final_result) > 100 else f"   最終結果: {final_result}")
        
        # レスポンス構築
        response = {
            'success': True,
            'result': final_result,
            'model': current_model.get_info()
        }
        
        # debugモードでは中間JSONも返す
        if debug:
            response['intermediate'] = intermediate_json
        
        return jsonify(response)
        
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
    画像を分析してストリーミング形式でテキストを生成（2段階生成）
    視覚障害者への即時フィードバック用
    
    フロー:
    - 第1段階（非ストリーミング）: 画像から構造化JSON抽出
    - 第2段階（ストリーミング）: JSONから自然文説明生成
    
    Request Body:
        {
            "image": "base64_encoded_image",
            "promptType": "standard" | "detailed"
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
        
        # プロンプトタイプに応じてプロンプトとmaxTokensを選択
        max_tokens_map = {
            'standard': config['prompt']['maxTokens']['summary'],
            'detailed': config['prompt']['maxTokens']['detailed'],
            'question': config['prompt']['maxTokens']['question']
        }
        
        if prompt_type == 'standard':
            phase2_prompt_template = config['prompt']['phase2_summary']
            default_max_tokens = max_tokens_map['standard']
        elif prompt_type == 'detailed':
            phase2_prompt_template = config['prompt']['phase2_detailed']
            default_max_tokens = max_tokens_map['detailed']
        elif prompt_type == 'question':
            question_text = data.get('question', '')
            phase2_prompt_template = config['prompt']['questionPrompt'].format(question=question_text)
            default_max_tokens = max_tokens_map['question']
        else:
            phase2_prompt_template = config['prompt']['phase2_summary']
            default_max_tokens = max_tokens_map['standard']
        
        # 第1段階・第2段階のパラメータ
        phase1_options = {
            'temperature': config['prompt']['temperature'],
            'max_tokens': 300,
            'top_p': config['prompt']['topP'],
            'repetition_penalty': config['prompt'].get('repetition_penalty', 1.3)
        }
        
        phase2_options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', default_max_tokens),
            'top_p': data.get('top_p', config['prompt']['topP']),
            'repetition_penalty': data.get('repetition_penalty', config['prompt'].get('repetition_penalty', 1.3))
        }
        
        print(f"\n📸 【2段階ストリーミング分析】リクエスト受信")
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
        
        def generate():
            """ストリーミングジェネレーター"""
            start_time = time.time()
            token_count = 0
            first_token_time = None
            
            try:
                # ========================
                # 【第1段階】構造化抽出（非ストリーミング）
                # ========================
                print(f"   🔄 第1段階実行中...")
                phase1_prompt = config['prompt']['phase1_extraction']
                intermediate_json = current_model.inference_phase1_extraction(
                    image, phase1_prompt, **phase1_options
                )
                print(f"   ✅ 第1段階完了、第2段階実行中...")
                
                # ========================
                # 【第2段階】自然文生成（ストリーミング）
                # ========================
                if not hasattr(current_model, 'inference_phase2_generation_stream'):
                    # ストリーミング非対応の場合は通常推論で返す
                    final_result = current_model.inference_phase2_generation(
                        intermediate_json, phase2_prompt_template, **phase2_options
                    )
                    yield f"data: {final_result}\n\n"
                    yield f"data: [DONE]\n\n"
                    return
                
                # ストリーミング推論実行
                for chunk in current_model.inference_phase2_generation_stream(
                    intermediate_json, phase2_prompt_template, **phase2_options
                ):
                    if first_token_time is None:
                        first_token_time = time.time() - start_time
                    
                    token_count += 1
                    yield f"data: {chunk}\n\n"
                
                # 性能統計を出力
                total_time = time.time() - start_time
                tps = token_count / total_time if total_time > 0 else 0
                
                print(f"✅ 【2段階ストリーミング分析】完了")
                print(f"   📊 TTFT (初動時間): {first_token_time:.2f}s")
                print(f"   📊 TPS (トークン/秒): {tps:.2f}")
                print(f"   📊 総時間: {total_time:.2f}s")
                
                yield f"data: [DONE]\n\n"
                
            except Exception as e:
                print(f"❌ ストリーミングエラー: {e}")
                import traceback
                traceback.print_exc()
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
    
    # ★バックグラウンドスレッドで初期化を開始
    print("🔄 バックグラウンドで初期化処理を開始...")
    threading.Thread(target=initialize_system, daemon=True).start()
    
    # Flaskサーバーを起動
    server_config = config.get('server', {})
    host = server_config.get('host', '127.0.0.1')
    port = server_config.get('port', 5001)
    debug = server_config.get('debug', False)
    
    print(f"\n{'='*60}")
    print(f"🌐 Flask サーバーを起動: http://{host}:{port}")
    print(f"{'='*60}\n")
    
    app.run(host=host, port=port, debug=debug, threaded=True)
