"""
Glance Python Backend - Flask API Server
Vision-Language Modelを使った画像分析API
"""

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import yaml
import base64
import json
from PIL import Image
import io
import os
import sys
import time
import threading
import signal
import socket
import atexit
import hashlib
from collections import OrderedDict
import requests
from models.internvl import InternVLModel
from models.internvl_gguf import InternVLGGUFModel
from models.qwen_vl_gguf import QwenVLGGUFModel
from models.qwen3_vl_server import Qwen3VLServerModel
from models.qwen3_vl_server import IMAGE_MAX_SIZE as IMAGE_MAX_SIZE_DEFAULT

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

# ==========================================
# 結果キャッシュ（無変化スキップ）
# 同一画像(バイト一致)＋同一プロンプト種別の再要求は推論せずキャッシュを返す。
# バイト完全一致のみヒットするため、内容が変われば必ず再推論される（誤返答しない）。
# ==========================================
_result_cache = OrderedDict()
_RESULT_CACHE_MAX = 16


def _cache_get(key):
    if key in _result_cache:
        _result_cache.move_to_end(key)
        return _result_cache[key]
    return None


def _cache_put(key, value):
    _result_cache[key] = value
    _result_cache.move_to_end(key)
    while len(_result_cache) > _RESULT_CACHE_MAX:
        _result_cache.popitem(last=False)


# ==========================================
# 画像ストア（imageId 参照方式）
#
# 目的は2つ:
#  1. G / P で撮った1枚を D / Q が「そのまま」使えるようにする。
#     撮り直すと PNG のバイト列が変わり、llama-server が別画像と判定して
#     画像エンコード（低スペックCPUでは数秒）からやり直しになる。
#  2. Electron から毎回 1MB 弱の Base64 を送る無駄をなくす。
#     2回目以降は imageId（64文字）だけを送れば済む。
#
# リサイズ済みBase64も併せてキャッシュする。同一画面・同一解像度設定なら
# 必ず同一の文字列が llama-server へ渡り、KVキャッシュが確実に再利用される。
# ==========================================
_image_store = OrderedDict()
_IMAGE_STORE_MAX = 6
_image_store_lock = threading.Lock()


class ImageNotAvailable(Exception):
    """imageId が期限切れ／未登録で、画像を復元できない"""
    pass


def _store_image(image_id, image_bytes):
    """画像を登録して entry を返す（既存なら再利用してLRUを更新）"""
    with _image_store_lock:
        entry = _image_store.get(image_id)
        if entry is None:
            entry = {"bytes": image_bytes, "encoded": {}}
            _image_store[image_id] = entry
        _image_store.move_to_end(image_id)
        while len(_image_store) > _IMAGE_STORE_MAX:
            _image_store.popitem(last=False)
    return entry


def _encoded_for(entry, image_max_size):
    """
    リサイズ済みBase64を返す（未生成なら1回だけ生成してキャッシュ）

    レガシーモデル（encode_image 未実装）では None を返し、
    呼び出し側は従来どおり PIL Image を渡す。
    """
    if current_model is None or not hasattr(current_model, 'encode_image'):
        return None
    key = str(image_max_size)
    cached = entry["encoded"].get(key)
    if cached:
        return cached
    image = Image.open(io.BytesIO(entry["bytes"]))
    encoded = current_model.encode_image(image, max_size=image_max_size)
    entry["encoded"][key] = encoded
    return encoded


def _resolve_request_image(data):
    """
    リクエストから画像を解決する

    - image(Base64) 付き … 初回登録（G / P）。imageId 未指定なら SHA-256 から採番
    - imageId のみ    … 登録済みを引く（D / Q）

    Returns:
        (image_id, entry)

    Raises:
        ImageNotAvailable: imageId が失効している（Electron 側で画像を再送させる）
        ValueError: 画像が不正
    """
    image_base64 = data.get('image')
    image_id = data.get('imageId')

    if image_base64:
        image_bytes = base64.b64decode(image_base64)
        if not image_id:
            image_id = hashlib.sha256(image_bytes).hexdigest()
        # 壊れた画像をストアに入れないよう、ここで一度デコードを検証する
        Image.open(io.BytesIO(image_bytes)).verify()
        return image_id, _store_image(image_id, image_bytes)

    if not image_id:
        raise ValueError('画像データも imageId もありません')

    with _image_store_lock:
        entry = _image_store.get(image_id)
        if entry is not None:
            _image_store.move_to_end(image_id)
    if entry is None:
        raise ImageNotAvailable(image_id)
    return image_id, entry


def _select_prompt(prompt_type, question):
    """プロンプト種別に応じた単段プロンプトと maxTokens を返す"""
    if prompt_type == 'detailed':
        return config['prompt']['single_pass_detailed'], config['prompt']['maxTokens']['detailed']
    if prompt_type == 'question':
        return (config['prompt']['questionPrompt'].format(question=question or ''),
                config['prompt']['maxTokens']['question'])
    return config['prompt']['single_pass_summary'], config['prompt']['maxTokens']['summary']


def _resolve_image_max_size(raw):
    """imageMaxSize 設定値を実際の値へ（'none'=リサイズなし / 'default'=モデル既定）"""
    if raw == 'none':
        return None
    if raw == 'default' or raw is None:
        return IMAGE_MAX_SIZE_DEFAULT
    return int(raw)


# ==========================================
# 出力の停止制御
#
# 方針: 「max_tokens を低く設定して打ち切る」のをやめ、
#   (1) 自然に完結する分は必ず収まる上限を与える
#   (2) 暴走（同じ文言の繰り返し）は明示的に検知して即座に止める
# の2本立てにする。従来は (1) を犠牲にして (2) を抑えていたため、
# 「途中で切れる」と「ループする」がトレードオフになっていた。
# ==========================================

# ループ判定に使う末尾の窓。全文を走査しないので生成速度に影響しない
_LOOP_WINDOW = 300
_LOOP_MIN_UNIT = 8       # これ未満の繰り返し（「、」の連続など）は誤検知になりやすい
_LOOP_MAX_UNIT = 80
_LOOP_REPEATS = 3        # 同じ断片が連続3回で暴走とみなす


def _find_loop_unit(text: str):
    """
    末尾で繰り返されている断片の長さを返す（繰り返しが無ければ None）

    「〜します。〜します。〜します。」のように、一定長の断片が連続して
    3回現れたらループとみなす。判定は末尾 _LOOP_WINDOW 文字だけを見るため、
    生成が長くなっても計算量は一定。
    """
    tail = text[-_LOOP_WINDOW:]
    for unit in range(_LOOP_MIN_UNIT, min(_LOOP_MAX_UNIT, len(tail) // _LOOP_REPEATS) + 1):
        chunk = tail[-unit:]
        if not chunk.strip():
            continue
        if all(tail[-unit * (i + 1):-unit * i or None] == chunk for i in range(1, _LOOP_REPEATS)):
            return unit
    return None


def _looks_looping(text: str) -> bool:
    """末尾が同じ断片の繰り返しになっていないか"""
    return _find_loop_unit(text) is not None


def _strip_repeated_tail(text: str) -> str:
    """
    末尾で繰り返されている断片を取り除く

    ループを検知して打ち切っても、検知までに出た繰り返しがそのまま残る。
    読み上げでは同じ文言が何度も流れることになり、耳障りなだけでなく
    「どこまでが本当の説明か」が分からなくなるため、末尾から削り落とす。
    """
    unit = _find_loop_unit(text)
    if not unit:
        return text
    chunk = text[-unit:]
    while text.endswith(chunk):
        text = text[:-unit]
    return text


def _trim_incomplete_tail(text: str) -> str:
    """
    文の途中で切れている末尾を落とす

    上限に当たって「〜であり、」で終わると、読み上げでは何が言いたかったのか
    分からないまま途切れる。最後の句点までを残す。ただし本文の大半を
    捨てることになる場合は、情報が失われる方が損なのでそのまま返す。
    """
    last = max(text.rfind(mark) for mark in ('。', '！', '？'))
    if last >= 0 and last >= len(text) * 0.5:
        return text[:last + 1]
    return text


def _sse(payload: dict) -> str:
    """
    SSE の1フレームを組み立てる

    ★本文をそのまま "data: {text}" に埋めてはいけない。モデル出力に改行が
    含まれるとフレーム境界がずれ、後続チャンクが受信側で捨てられる
    （「説明が途中で消える」の原因）。JSONに包んで改行を無害化する。
    """
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

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
        print("\n" + "="*60)
        print("🔄 バックグラウンド初期化処理を開始...")
        print("="*60 + "\n")
        
        # 1. アクティブモデルを取得。環境変数 GLANCE_MODEL が config より優先
        # （update-and-run-light.bat 等の「別起動」でモデルを切り替えるための仕組み。
        #  実行時切替だと2モデル分のRAMを食うため、起動時に1つだけ選ぶ）
        print("📋 [ステップ1] アクティブモデルの確認...")
        env_model = os.environ.get('GLANCE_MODEL')
        active_model_name = env_model or config.get('activeModel')
        if env_model:
            print(f"   🔀 環境変数 GLANCE_MODEL でモデルを上書き: {env_model}")
        if not active_model_name or active_model_name not in config.get('models', {}):
            raise ValueError(f"有効なモデルが設定されていません (GLANCE_MODEL/activeModel): {active_model_name}")
        
        print(f"   ✅ アクティブモデル: {active_model_name}")
        
        active_model_config = config['models'][active_model_name]
        model_type = active_model_config.get('type')
        
        if model_type not in ['internvl_gguf', 'qwen_vl_gguf', 'qwen3_vl_server']:
            raise NotImplementedError(f"モデルタイプ '{model_type}' はまだサポートされていません")
        
        print(f"   ✅ モデルタイプ: {model_type}")
        
        # 2. 保存先パスの決定とファイル名を config から抽出
        print("\n📋 [ステップ2] ファイルパスの決定...")
        model_dir = get_writable_model_path()
        print(f"   モデルディレクトリ: {model_dir}")
        
        # config の相対パスからファイル名を抽出
        model_relative_path = active_model_config.get('path', '')
        model_filename = os.path.basename(model_relative_path)
        mmproj_relative_path = active_model_config.get('mmproj_path', '')
        mmproj_filename = os.path.basename(mmproj_relative_path)
        
        model_path = os.path.join(model_dir, model_filename)
        mmproj_path = os.path.join(model_dir, mmproj_filename)
        
        print(f"   モデルファイル: {model_filename}")
        print(f"   mmproj ファイル: {mmproj_filename}")
        
        # 3. ダウンロードURL を config から取得
        print("\n📋 [ステップ3] ダウンロードURL の確認...")
        model_download_url = active_model_config.get('download_url')
        mmproj_download_url = active_model_config.get('mmproj_download_url')
        
        if not model_download_url or not mmproj_download_url:
            raise ValueError(f"モデル設定に download_url または mmproj_download_url が設定されていません")
        
        print(f"   ✅ ダウンロードURL が正しく設定されています")
        
        # 4. モデルの存在確認とダウンロード
        print("\n📋 [ステップ4] モデルファイルの確認...")
        
        if not os.path.exists(model_path):
            print(f"   📥 モデルファイルが見つかりません: {model_path}")
            print(f"      ダウンロードを開始します...")
            app_state["status"] = "downloading"
            app_state["message"] = "AIモデルをダウンロードしています..."
            app_state["progress"] = 0
            app_state["detail"] = ""
            
            try:
                download_file(model_download_url, model_path, "AIモデル")
                print(f"   ✅ モデルファイルのダウンロード完了")
            except Exception as e:
                print(f"   ❌ モデルファイルのダウンロードに失敗: {e}")
                raise
        else:
            print(f"   ✅ モデルファイルが存在します: {model_path}")
            
        if not os.path.exists(mmproj_path):
            print(f"   📥 mmproj ファイルが見つかりません: {mmproj_path}")
            print(f"      ダウンロードを開始します...")
            app_state["status"] = "downloading"
            app_state["message"] = "画像処理エンジンをダウンロードしています..."
            app_state["progress"] = 0
            app_state["detail"] = ""
            
            try:
                download_file(mmproj_download_url, mmproj_path, "画像処理エンジン")
                print(f"   ✅ mmproj ファイルのダウンロード完了")
            except Exception as e:
                print(f"   ❌ mmproj ファイルのダウンロードに失敗: {e}")
                raise
        else:
            print(f"   ✅ mmproj ファイルが存在します: {mmproj_path}")

        # 5. モデルのロード
        print("\n📋 [ステップ5] モデルのロード...")
        app_state["status"] = "loading_model"
        app_state["message"] = "AIを起動しています..."
        app_state["progress"] = 100
        app_state["detail"] = ""
        
        print(f"\n{'='*60}")
        print(f"📦 モデルをロード中: {active_model_name}")
        print(f"   タイプ: {model_type}")
        print(f"   モデルパス: {model_path}")
        print(f"   mmproj パス: {mmproj_path}")
        print(f"{'='*60}\n")
        
        # モデルをロード（タイプ別）
        if model_type == 'internvl_gguf':
            print("   🚀 InternVLGGUFModel を初期化中...")
            current_model = InternVLGGUFModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                draft_model_path=None
            )
            print("   🔄 モデルをロード中...")
            current_model.load()
            print("   ✅ InternVLGGUFModel ロード完了")
            
        elif model_type == 'qwen_vl_gguf':
            print("   🚀 QwenVLGGUFModel を初期化中...")
            current_model = QwenVLGGUFModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                draft_model_path=None
            )
            print("   🔄 モデルをロード中...")
            current_model.load()
            print("   ✅ QwenVLGGUFModel ロード完了")
            
        elif model_type == 'qwen3_vl_server':
            print("   🚀 Qwen3VLServerModel を初期化中...")
            # Qwen3-VL (llama-server経由)
            server_url = active_model_config.get('server_url', 'http://127.0.0.1:8080')
            server_host = active_model_config.get('server_host', '127.0.0.1')
            server_port = active_model_config.get('server_port', 8080)
            auto_start_server = active_model_config.get('auto_start_server', True)
            bundled_server_binary = active_model_config.get('bundled_server_binary')
            ctx_size = active_model_config.get('ctx_size', 8192)
            
            print(f"      サーバーURL: {server_url}")
            print(f"      ホスト: {server_host}:{server_port}")
            print(f"      自動起動: {auto_start_server}")
            print(f"      コンテキストサイズ: {ctx_size}")
            
            cpu_opts = active_model_config.get('cpu') or {}
            current_model = Qwen3VLServerModel(
                model_path=model_path,
                mmproj_path=mmproj_path,
                server_url=server_url,
                server_host=server_host,
                server_port=server_port,
                auto_start_server=auto_start_server,
                bundled_server_binary=bundled_server_binary,
                ctx_size=ctx_size,
                cpu_options=cpu_opts,
                use_mlock=active_model_config.get('mlock', False),
                extra_chat_payload=active_model_config.get('extra_chat_payload')
            )

            # バックエンド自動選定（速度プローブ方式 / Option B）
            # GPU(-ngl 99)とCPU(-ngl 0)を実測し速い方を採用。手動上書きは config の accel。
            accel_mode = active_model_config.get('accel', config.get('accel', 'auto'))
            try:
                from backend_selector import select_backend
                binary = current_model._find_server_binary()
                if binary:
                    sel = select_backend(
                        binary, model_path, mmproj_path,
                        mode=accel_mode, cache_dir=model_dir,
                        host=server_host, probe_port=server_port + 19,
                        threads=cpu_opts.get('threads'),
                        model_key=model_filename,
                    )
                    current_model.n_gpu_layers = sel['ngl']
                    print(f"   🧭 バックエンド: ngl={sel['ngl']} ({sel['source']})")
                else:
                    print("   ⚠️ バイナリ未検出のためバックエンド判定をスキップ")
            except Exception as e:
                print(f"   ⚠️ バックエンド判定エラー（既定で継続）: {e}")

            print("   🔄 llama-server に接続・起動中...")
            try:
                current_model.load()
            except Exception as load_err:
                # GPU構成での起動失敗 → CPUへフォールバックし、次回以降もCPUを記憶
                if current_model.n_gpu_layers and current_model.n_gpu_layers > 0:
                    print(f"   ⚠️ GPU起動に失敗（{load_err}）→ CPUで再試行")
                    current_model.n_gpu_layers = 0
                    try:
                        from backend_selector import force_backend
                        force_backend(model_dir, 0, 'gpu-load-failed',
                                      model_key=model_filename,
                                      binary=current_model._find_server_binary())
                    except Exception:
                        pass
                    current_model.load()
                else:
                    raise
            print("   ✅ Qwen3VLServerModel ロード完了")
        
        app_state["status"] = "ready"
        app_state["message"] = "準備完了"
        app_state["detail"] = ""
        
        print(f"\n{'='*60}")
        print(f"✅ モデルロード完了")
        print(f"{'='*60}\n")
        
    except Exception as e:
        print(f"\n{'='*60}")
        print(f"❌ 初期化エラー: {e}")
        print(f"{'='*60}\n")
        import traceback
        traceback.print_exc()
        app_state["status"] = "error"
        app_state["message"] = "起動エラーが発生しました"
        app_state["detail"] = str(e)
        print(f"\n⚠️ app_state を error に設定しました")
        print(f"   message: {app_state['message']}")
        print(f"   detail: {app_state['detail']}\n")


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
    model_type = model_config.get('type')
    
    # 相対パスの場合は絶対パスに変換
    if not os.path.isabs(model_path):
        model_path = os.path.join(get_writable_model_path(), os.path.basename(model_path))
    
    # 既存モデルをアンロード
    if current_model is not None:
        print("🗑️  既存モデルをアンロード中...")
        current_model.unload()
    
    # 新しいモデルをロード
    if model_type == 'internvl':
        current_model = InternVLModel(model_path)
    elif model_type == 'internvl_gguf':
        # GGUF量子化モデル（InternVL）
        mmproj_path = model_config.get('mmproj_path')
        draft_model_path = model_config.get('draft_model_path')
        
        # mmproj_pathも相対パスの場合は絶対パスに変換
        if mmproj_path and not os.path.isabs(mmproj_path):
            mmproj_path = os.path.join(get_writable_model_path(), os.path.basename(mmproj_path))
        
        # draft_model_pathも相対パスの場合は絶対パスに変換
        if draft_model_path and not os.path.isabs(draft_model_path):
            draft_model_path = os.path.join(get_writable_model_path(), os.path.basename(draft_model_path))
        
        # 投機的デコーディングが無効の場合はドラフトモデルパスをNoneに
        if not model_config.get('speculativeDecoding', False):
            draft_model_path = None
            
        current_model = InternVLGGUFModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            draft_model_path=draft_model_path
        )
    elif model_type == 'qwen_vl_gguf':
        # GGUF量子化モデル（Qwen VL）
        mmproj_path = model_config.get('mmproj_path')
        
        # mmproj_pathも相対パスの場合は絶対パスに変換
        if mmproj_path and not os.path.isabs(mmproj_path):
            mmproj_path = os.path.join(get_writable_model_path(), os.path.basename(mmproj_path))
        
        current_model = QwenVLGGUFModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            draft_model_path=None
        )
    elif model_type == 'qwen3_vl_server':
        # Qwen3-VL (llama-server経由)
        mmproj_path = model_config.get('mmproj_path')
        
        # mmproj_pathも相対パスの場合は絶対パスに変換
        if mmproj_path and not os.path.isabs(mmproj_path):
            mmproj_path = os.path.join(get_writable_model_path(), os.path.basename(mmproj_path))
        
        server_url = model_config.get('server_url', 'http://127.0.0.1:8080')
        server_host = model_config.get('server_host', '127.0.0.1')
        server_port = model_config.get('server_port', 8080)
        auto_start_server = model_config.get('auto_start_server', True)
        bundled_server_binary = model_config.get('bundled_server_binary')
        
        current_model = Qwen3VLServerModel(
            model_path=model_path,
            mmproj_path=mmproj_path,
            server_url=server_url,
            server_host=server_host,
            server_port=server_port,
            auto_start_server=auto_start_server,
            bundled_server_binary=bundled_server_binary,
            ctx_size=model_config.get('ctx_size', 8192),
            cpu_options=model_config.get('cpu'),
            use_mlock=model_config.get('mlock', False),
            extra_chat_payload=model_config.get('extra_chat_payload')
        )
    else:
        raise ValueError(f"不明なモデルタイプ: {model_type}")
    
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
    画像を分析してテキストを生成（単段生成）

    全タイプとも画像から直接生成する。旧2段階(画像→JSON→文)は
    第2段階が画像を見ないため情報が欠落し、第1段階の生成分だけ遅かった。

    Request Body:
        {
            "image": "base64_encoded_image",
            "promptType": "standard" | "detailed" | "question",
            "question": "質問文（promptType='question'の場合）"
        }

    Response:
        {
            "success": true,
            "result": "最終的な説明文",
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
        
        # 画像の解決（imageId 参照 or 初回登録）
        try:
            image_id, entry = _resolve_request_image(data)
        except ImageNotAvailable:
            return jsonify({'success': False, 'error': 'unknown_image'}), 409
        except Exception as e:
            return jsonify({'success': False, 'error': f'画像のデコードに失敗: {str(e)}'}), 400

        # プロンプトタイプを取得（デフォルトは 'standard'）
        prompt_type = data.get('promptType', 'standard')
        question_text = data.get('question', '')
        prompt, default_max_tokens = _select_prompt(prompt_type, question_text)

        # 画像解像度設定（リクエストから取得、未指定はモデルデフォルトを使用）
        image_max_size = _resolve_image_max_size(data.get('imageMaxSize', 'default'))

        # 生成パラメータ（repetition_penalty はレガシーモデルのみで有効）
        gen_options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', default_max_tokens),
            'top_p': data.get('top_p', config['prompt']['topP']),
            # repetition_penalty はレガシーモデル用。llama-server 系は
            # repeat_penalty / repeat_last_n を使う（logit補正なので温度0でも効く）
            'repetition_penalty': data.get('repetition_penalty', config['prompt'].get('repetition_penalty', 1.3)),
            'repeat_penalty': data.get('repeat_penalty', config['prompt'].get('repeat_penalty')),
            'repeat_last_n': data.get('repeat_last_n', config['prompt'].get('repeat_last_n'))
        }

        print(f"\n📸 【単段分析】リクエスト受信")
        print(f"   プロンプトタイプ: {prompt_type} / imageId={image_id[:12]}…")

        # モデルロード確認
        if current_model is None or not current_model.is_loaded:
            return jsonify({
                'success': False,
                'error': 'モデルがロードされていません'
            }), 500

        encoded_image = _encoded_for(entry, image_max_size)
        image = None if encoded_image else Image.open(io.BytesIO(entry["bytes"]))

        # 無変化スキップ：同一画像＋同一プロンプトならキャッシュ即返し（推論回避）
        cache_key = f"{image_id}:{prompt_type}:{question_text or ''}"
        cached = _cache_get(cache_key)
        if cached is not None:
            print("♻️ 同一画像+プロンプト：キャッシュ結果を返却（推論スキップ）")
            return jsonify({
                'success': True,
                'result': cached,
                'cached': True,
                'model': current_model.get_info()
            })

        # 【単段】画像から直接生成。中間JSONを経由しないため高速で、
        # 画像に直接根ざすため情報欠落も防ぐ。
        final_result = current_model.inference(
            image, prompt, image_max_size=image_max_size,
            encoded_image=encoded_image, **gen_options
        )

        # キャッシュに保存（次回同一画像+プロンプトで即返し）
        _cache_put(cache_key, final_result)

        print(f"✅ 【分析】完了")
        print(f"   最終結果: {final_result[:100]}..." if len(final_result) > 100 else f"   最終結果: {final_result}")
        
        # レスポンス構築
        response = {
            'success': True,
            'result': final_result,
            'model': current_model.get_info()
        }

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


@app.route('/prepare', methods=['POST'])
def prepare():
    """
    事前キャプチャ（Ctrl+Shift+P）用エンドポイント

    出力は行わない。この時点ではユーザーが待っていないので、後続の
    D / Q で効いてくる重い処理をここで先に済ませておく:

      1. 画像を imageId で登録（以降 D / Q は ID だけ送れば済む）
      2. リサイズ + PNG エンコードを実施してキャッシュ
      3. llama-server へ「system + 画像 + 共通プレフィックス」を投げ、
         生成させずに KV キャッシュへ焼き込む（prewarm）

    実測（Qwen3-VL-4B / Metal / 896px）:
      D の TTFT 3.83s → 1.61s (-58%) 、Q の TTFT 2.78s → 0.58s (-79%)

    Request Body:
        {"image": "base64", "imageId": "省略可", "imageMaxSize": "896"}
    """
    try:
        data = request.json or {}

        try:
            image_id, entry = _resolve_request_image(data)
        except ImageNotAvailable:
            return jsonify({'success': False, 'error': 'unknown_image'}), 409
        except Exception as e:
            return jsonify({'success': False, 'error': f'画像のデコードに失敗: {e}'}), 400

        if current_model is None or not current_model.is_loaded:
            # 画像の登録だけは済んでいるので、モデル準備後の D / Q は成立する
            return jsonify({'success': True, 'imageId': image_id, 'prewarmed': False,
                            'detail': 'モデル未ロードのため事前warmはスキップ'})

        image_max_size = _resolve_image_max_size(data.get('imageMaxSize', 'default'))
        print(f"\n📌 【事前キャプチャ】受信 imageId={image_id[:12]}…")

        # エンコードは同期で済ませる（数百ms。ここで確定させると D / Q が
        # 必ず同一バイト列を使うことになり、KVキャッシュのヒットが保証される）
        encoded = _encoded_for(entry, image_max_size)

        prewarm_prefix = config['prompt'].get('prewarm_prefix')
        if not prewarm_prefix or not hasattr(current_model, 'prewarm'):
            return jsonify({'success': True, 'imageId': image_id, 'prewarmed': False})

        def do_prewarm():
            """
            prefill はモデル任せで数秒かかるため別スレッドで実行し、
            Electron へは即座に応答を返す（キャプチャ音や確認表示を待たせない）。
            llama-server は -np 1 なので、途中で D / Q が来ても取りこぼさず
            順番に処理され、後続はキャッシュが温まった状態で走る。
            """
            try:
                current_model.prewarm(None, prewarm_prefix,
                                      encoded_image=encoded,
                                      image_max_size=image_max_size)
            except Exception as e:
                print(f"⚠️ 事前warmに失敗（本処理には影響しません）: {e}")

        threading.Thread(target=do_prewarm, daemon=True).start()

        return jsonify({'success': True, 'imageId': image_id, 'prewarmed': True})

    except Exception as e:
        print(f"❌ 事前キャプチャでエラー: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/analyze-stream', methods=['POST'])
def analyze_stream():
    """
    画像を分析してストリーミング形式でテキストを生成（単段生成）
    視覚障害者への即時フィードバック用

    全タイプとも画像から直接ストリーミング生成する。
    第1段階(JSON抽出・非ストリーム)を挟まないため第一声までが速い。

    Request Body:
        {
            "imageId": "G/P で登録済みの画像ID（D / Q はこれだけ送ればよい）",
            "image": "base64_encoded_image（初回のみ。imageId 未登録時の再送用）",
            "promptType": "standard" | "detailed" | "question",
            "question": "質問文（promptType='question'の場合）"
        }

    Response:
        Server-Sent Events (text/event-stream)
        各フレームは JSON: {"t": "差分テキスト"} / {"done": true} / {"error": "..."}
    """
    try:
        # リクエストデータを取得
        data = request.json

        if not data:
            return jsonify({
                'success': False,
                'error': 'リクエストボディが空です'
            }), 400

        # 画像の解決（imageId 参照 or 初回登録）
        try:
            image_id, entry = _resolve_request_image(data)
        except ImageNotAvailable:
            # 画像が期限切れ。Electron 側は Base64 付きで再送する
            return jsonify({'success': False, 'error': 'unknown_image'}), 409
        except Exception as e:
            return jsonify({'success': False, 'error': f'画像のデコードに失敗: {str(e)}'}), 400

        # プロンプトタイプを取得
        prompt_type = data.get('promptType', 'standard')
        question_text = data.get('question', '')
        prompt, default_max_tokens = _select_prompt(prompt_type, question_text)

        # 画像解像度設定
        image_max_size = _resolve_image_max_size(data.get('imageMaxSize', 'default'))

        # 生成パラメータ（repetition_penalty はレガシーモデルのみで有効）
        gen_options = {
            'temperature': data.get('temperature', config['prompt']['temperature']),
            'max_tokens': data.get('max_tokens', default_max_tokens),
            'top_p': data.get('top_p', config['prompt']['topP']),
            # repetition_penalty はレガシーモデル用。llama-server 系は
            # repeat_penalty / repeat_last_n を使う（logit補正なので温度0でも効く）
            'repetition_penalty': data.get('repetition_penalty', config['prompt'].get('repetition_penalty', 1.3)),
            'repeat_penalty': data.get('repeat_penalty', config['prompt'].get('repeat_penalty')),
            'repeat_last_n': data.get('repeat_last_n', config['prompt'].get('repeat_last_n'))
        }

        print(f"\n📸 【単段ストリーミング分析】リクエスト受信")
        print(f"   プロンプトタイプ: {prompt_type} / imageId={image_id[:12]}…"
              f"{'（画像は再利用）' if not data.get('image') else '（画像を新規受信）'}")

        # モデルチェック
        if current_model is None or not current_model.is_loaded:
            return jsonify({
                'success': False,
                'error': 'モデルがロードされていません'
            }), 500

        # G / P で確定済みのBase64をそのまま使う。撮り直さない限り必ず同一の
        # 文字列になるため、llama-server 側の画像プレフィックスが再利用される。
        encoded_image = _encoded_for(entry, image_max_size)
        image = None if encoded_image else Image.open(io.BytesIO(entry["bytes"]))

        # 無変化スキップ：同一画像＋同一プロンプトのキャッシュ判定
        cache_key = f"{image_id}:{prompt_type}:{question_text or ''}"

        def generate():
            """ストリーミングジェネレーター"""
            start_time = time.time()
            token_count = 0
            first_token_time = None

            # キャッシュヒット時は推論せず一括返却
            cached = _cache_get(cache_key)
            if cached is not None:
                print("♻️ 同一画像+プロンプト：キャッシュ結果を返却（推論スキップ）")
                yield _sse({"t": cached})
                # 完了フレームには常に確定版の本文を載せる（受信側の分岐を減らす）
                yield _sse({"done": True, "text": cached, "stoppedBy": None})
                return

            collected = []
            stats = {}
            stopped_by = None
            stream_iter = None
            try:
                # 【単段ストリーミング】画像から直接生成。
                # 第1段階を挟まないため、第一声までの待ち時間が大幅に短い
                print(f"   🔄 単段（{prompt_type}）実行中...")
                stream_iter = current_model.inference_stream(
                    image, prompt, image_max_size=image_max_size,
                    encoded_image=encoded_image, stats=stats, **gen_options
                )

                # ストリーミング出力
                for chunk in stream_iter:
                    if first_token_time is None:
                        first_token_time = time.time() - start_time

                    token_count += 1
                    collected.append(chunk)
                    yield _sse({"t": chunk})

                    # ループ判定は一定間隔でのみ行う。走査するのも末尾の窓だけなので
                    # 生成速度への影響はない（暴走を早く切る分むしろ速くなる）
                    if token_count % 16 == 0 and _looks_looping("".join(collected)):
                        stopped_by = "loop"
                        print("   🔁 同じ文言の繰り返しを検知したため生成を打ち切ります")
                        break

                if stopped_by is None and stats.get("finish_reason") == "length":
                    stopped_by = "length"
                    print("   ✂️ 出力上限に達しました（末尾の未完文を整えます）")

                final_text = current_model._clean_output("".join(collected)) \
                    if hasattr(current_model, "_clean_output") else "".join(collected).strip()
                if stopped_by == "loop":
                    # 検知までに出てしまった繰り返しを削ってから文を整える
                    final_text = _strip_repeated_tail(final_text)
                if stopped_by:
                    final_text = _trim_incomplete_tail(final_text)

                # 全文をキャッシュ（次回同一画像+プロンプトで即返し）
                if final_text:
                    _cache_put(cache_key, final_text)

                # 性能統計を出力
                total_time = time.time() - start_time
                tps = token_count / total_time if total_time > 0 else 0

                print(f"✅ 【単段ストリーミング分析】完了")
                if first_token_time is not None:
                    print(f"   📊 TTFT (初動時間): {first_token_time:.2f}s")
                print(f"   📊 TPS (トークン/秒): {tps:.2f}")
                print(f"   📊 総時間: {total_time:.2f}s")

                # 確定版の本文を添えて返す。ループ打ち切りの整形・尻切れの丸め・
                # 重複除去の結果を画面へ反映させるため、受信側はこれで置き換える
                yield _sse({"done": True, "text": final_text, "stoppedBy": stopped_by})

            except Exception as e:
                print(f"❌ ストリーミングエラー: {e}")
                import traceback
                traceback.print_exc()
                yield _sse({"error": str(e)})
            finally:
                # 打ち切った場合はジェネレータを閉じ、llama-server 側の生成も止める。
                # 閉じないと上限に達するまで裏で生成が続き、次の操作を待たせてしまう
                if stream_iter is not None:
                    try:
                        stream_iter.close()
                    except Exception:
                        pass
        
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
# シャットダウン・クリーンアップ処理
# =====================================

def cleanup():
    """モデルとサブプロセスのクリーンアップ"""
    global current_model
    print("\n🛑 クリーンアップ処理を開始...")
    if current_model is not None:
        try:
            print("🗑️  モデルをアンロード中（llama-server 停止含む）...")
            current_model.unload()
            current_model = None
            print("✅ モデルのアンロード完了")
        except Exception as e:
            print(f"⚠️  モデルアンロード中にエラー: {e}")
    print("✅ クリーンアップ完了")


def shutdown_server():
    """Flaskサーバーを安全に停止する"""
    # werkzeug の内部シャットダウン関数を使用
    func = request.environ.get('werkzeug.server.shutdown')
    if func is not None:
        func()
    else:
        # werkzeug 開発サーバー以外の場合は os.kill を使用
        os.kill(os.getpid(), signal.SIGTERM)


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """
    Electronからのシャットダウン要求を受け付ける
    モデルをアンロードしてサーバーを停止する
    """
    print("\n📨 シャットダウン要求を受信しました")
    # バックグラウンドでクリーンアップしてから終了
    def do_shutdown():
        time.sleep(0.5)  # レスポンスを返してから終了
        cleanup()
        os.kill(os.getpid(), signal.SIGTERM)
    
    threading.Thread(target=do_shutdown, daemon=True).start()
    return jsonify({'success': True, 'message': 'シャットダウンを開始します'})


def handle_signal(signum, frame):
    """SIGTERMやSIGINTを受け取った際のハンドラ"""
    print(f"\n⚡ シグナル {signum} を受信しました")
    cleanup()
    sys.exit(0)


def monitor_parent_process(parent_pid: int):
    """
    親プロセス（Electron）の死活を監視するスレッド
    親が死んだら自分も終了する（孤児プロセス防止）
    
    macOS/Linux: os.getppid() が変わると親が死んだとみなす
                 （孤児プロセスは launchd/init に引き取られるため ppid が 1 になる）
    Windows:     psutil.pid_exists() で PID の存在をチェック
    """
    original_ppid = os.getppid()
    print(f"👁️  親プロセス監視を開始: parent_pid={parent_pid}, os.getppid()={original_ppid}")

    while True:
        try:
            parent_dead = False

            if sys.platform != 'win32':
                # macOS/Linux: ppid が変わったら親が死んで孤児になった
                current_ppid = os.getppid()
                if current_ppid != original_ppid:
                    print(f"\n⚠️  親プロセスが変わりました: {original_ppid} → {current_ppid}（孤児検出）")
                    parent_dead = True
            else:
                # Windows: psutil で PID の存在を確認
                try:
                    import psutil
                    if not psutil.pid_exists(parent_pid):
                        print(f"\n⚠️  親プロセス（PID={parent_pid}）が見つかりません")
                        parent_dead = True
                except ImportError:
                    print("⚠️  psutil が利用できません（Windows での親プロセス監視をスキップ）")

            if parent_dead:
                print(f"🛑 孤児プロセス検出 → クリーンアップして終了します")
                cleanup()
                # Flask/werkzeug のシグナルハンドラ競合を避けるため os._exit() で即終了
                os._exit(0)

        except Exception as e:
            print(f"⚠️  親プロセス監視中にエラー: {e}")

        time.sleep(2)  # 2秒ごとに確認


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
    
    # シグナルハンドラを登録（SIGTERMでクリーンアップ）
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    
    # atexit ハンドラでクリーンアップを保証
    atexit.register(cleanup)
    
    # 親プロセスPIDを引数から取得（Electronから渡される）
    parent_pid = None
    for arg in sys.argv[1:]:
        if arg.startswith('--parent-pid='):
            try:
                parent_pid = int(arg.split('=')[1])
                print(f"✅ 親プロセスPID: {parent_pid}")
            except ValueError:
                print(f"⚠️  無効な親プロセスPID: {arg}")
    
    # 親プロセス監視スレッドを起動
    # macOS/Linux は os.getppid() を使用するため psutil 不要
    # Windows のみ psutil を使用（monitor_parent_process 内で処理）
    if parent_pid is not None:
        monitor_thread = threading.Thread(
            target=monitor_parent_process,
            args=(parent_pid,),
            daemon=True
        )
        monitor_thread.start()
    
    server_config = config.get('server', {})
    host = server_config.get('host', '127.0.0.1')
    port = server_config.get('port', 5001)
    debug = server_config.get('debug', False)

    # ポート競合を先に検出する。
    # 前回の Glance が残っているとここが埋まっており、そのまま進むと
    # Flask の起動失敗と初期化スレッドが同時に走って atexit の cleanup が
    # current_model を None にし、「AttributeError: 'NoneType' object has
    # no attribute 'n_gpu_layers'」という無関係な例外だけがログに残る。
    # 原因がまったく読み取れないため、ここで明確に伝えて終了する。
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(1)
    port_in_use = probe.connect_ex((host, port)) == 0
    probe.close()

    if port_in_use:
        message = (
            f"ポート {port} は既に使用されています。\n"
            f"前回の Glance がまだ終了していない可能性があります。\n"
            f"update-and-run.bat（または update-and-run-light.bat）から起動し直すと、\n"
            f"残ったプロセスを自動で停止してからクリーンに起動します。"
        )
        print(f"\n{'='*60}")
        print(f"❌ 起動できません")
        print(message)
        print(f"{'='*60}\n")
        app_state["status"] = "error"
        app_state["message"] = "Glanceが既に起動しています"
        app_state["detail"] = message
        sys.exit(1)

    # ★バックグラウンドスレッドで初期化を開始
    print("🔄 バックグラウンドで初期化処理を開始...")
    threading.Thread(target=initialize_system, daemon=True).start()

    print(f"\n{'='*60}")
    print(f"🌐 Flask サーバーを起動: http://{host}:{port}")
    print(f"{'='*60}\n")

    app.run(host=host, port=port, debug=debug, threaded=True)
