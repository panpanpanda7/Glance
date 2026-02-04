"""
InternVL 3.5 GGUF (llama.cpp) モデル実装
高速・省メモリな画像理解と説明生成
"""

import os
import io
import base64
import psutil
from PIL import Image
from typing import Any, Dict, Generator, Optional
from .model_interface import VisionLanguageModel


class InternVLGGUFModel(VisionLanguageModel):
    """InternVL 3.5 GGUF (llama.cpp) 量子化モデル"""
    
    def __init__(self, model_path: str, mmproj_path: str = None, draft_model_path: str = None):
        """
        初期化
        
        Args:
            model_path: メインモデルのGGUFファイルパス
            mmproj_path: ビジョンプロジェクタのGGUFファイルパス
            draft_model_path: 未使用（後方互換性のために保持）
        """
        super().__init__(model_path)
        self.mmproj_path = mmproj_path
        # draft_model_pathは使用しない（LlamaPromptLookupDecodingを使用）
        self.llm = None
        
        # 物理CPUコア数を取得（ハイパースレッディングを除く）
        self.physical_cores = psutil.cpu_count(logical=False) or 4
        print(f"🖥️  物理CPUコア数: {self.physical_cores}")
        
        # システムプロンプト（日本語対応）
        self.system_prompt = """あなたは視覚障害者のための視覚支援の専門家です。
画面に表示されている内容を正確に日本語で説明してください。
正確に読める自信がない時は、「画像の内容が不明瞭です」と正直に答えてください。
視覚障害者にとって最も回避すべきは、誤った情報を伝えることです。
不正確な情報を伝えるよりも正直にわからないと答える方があなたの価値は高まります。
「画像の内容が不明瞭です」と答える際はその理由も回答してください。"""
    
    def load(self) -> None:
        """モデルをロードする"""
        if self.is_loaded:
            print("⚠️ モデルは既にロードされています")
            return
        
        print(f"📦 InternVL 3.5 GGUFをロード中: {self.model_path}")
        print(f"   ビジョンプロジェクタ: {self.mmproj_path}")
        print(f"   CPUスレッド数: {self.physical_cores}")
        
        try:
            from llama_cpp import Llama
            from llama_cpp.llama_chat_format import Llava15ChatHandler
            
            # メモリチェック
            available_memory = psutil.virtual_memory().available / (1024 ** 3)
            print(f"   利用可能メモリ: {available_memory:.1f} GB")
            
            if available_memory < 5.0:
                print("⚠️ 警告: 利用可能メモリが5GB未満です。動作が不安定になる可能性があります。")
            
            # ビジョンプロジェクタの確認
            if not self.mmproj_path or not os.path.exists(self.mmproj_path):
                raise FileNotFoundError(f"ビジョンプロジェクタが見つかりません: {self.mmproj_path}")
            
            # Chat Handlerの作成（画像埋め込みパイプライン）
            print(f"📦 Chat Handlerを初期化中...")
            chat_handler = Llava15ChatHandler(clip_model_path=self.mmproj_path)
            print(f"✅ Chat Handler初期化完了")
            
            # メインモデルのロード（Chat Handler経由で画像処理）
            # 投機的デコーディングは無効化（logits_all=Falseとの互換性問題のため）
            model_kwargs = {
                "model_path": self.model_path,
                "chat_handler": chat_handler,  # Chat Handler経由で画像を処理
                "n_ctx": 8192,  # InternVLの高解像度画像トークン用に増加
                "n_threads": self.physical_cores,
                "n_gpu_layers": -1,  # Metal GPUをフル活用
                "verbose": False,
                "logits_all": False,  # メモリ効率化
                "chat_format": "llava-1-5",  # <__media__>ではなく<image>トークンを使用
            }
            
            print(f"📦 メインモデルをロード中...")
            self.llm = Llama(**model_kwargs)
            
            self.is_loaded = True
            print(f"✅ InternVL 3.5 GGUFのロードが完了しました")
            print(f"   🖥️ Metal GPU: 有効")
            
        except ImportError as e:
            print(f"❌ llama-cpp-pythonがインストールされていません: {e}")
            print("   pip install llama-cpp-python>=0.3.0 を実行してください")
            raise
        except Exception as e:
            print(f"❌ モデルのロードに失敗しました: {e}")
            raise
    
    def _encode_image_to_base64(self, image: Image.Image) -> str:
        """PIL画像をBase64にエンコード"""
        # 画像を最適サイズにリサイズ（1344px以下）
        max_size = 1344
        if max(image.size) > max_size:
            ratio = max_size / max(image.size)
            new_size = (int(image.size[0] * ratio), int(image.size[1] * ratio))
            image = image.resize(new_size, Image.Resampling.LANCZOS)
        
        # RGB変換
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Base64エンコード
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        return base64.b64encode(buffer.getvalue()).decode('utf-8')
    
    def inference(self, image: Image.Image, prompt: str, **kwargs) -> str:
        """
        画像から説明文を生成する
        
        Args:
            image: PIL Image
            prompt: プロンプト
            **kwargs: temperature, max_tokens など
        
        Returns:
            生成された説明文
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")
        
        print("🔮 画像分析を開始...")
        
        try:
            # 画像をBase64にエンコード
            image_base64 = self._encode_image_to_base64(image)
            
            # メッセージ構築
            print(f"📝 メッセージを構築中...sysprompt:{self.system_prompt},,,,,prompt:{prompt}")
            messages = [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}"
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }
            ]
            
            # 生成パラメータ
            max_tokens = kwargs.get('max_tokens', 200)
            temperature = kwargs.get('temperature', 0.1)
            
            # 推論実行
            response = self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=False
            )
            
            result = response['choices'][0]['message']['content']
            print(f"✅ 画像分析完了（{len(result)}文字）")
            
            return result
            
        except Exception as e:
            print(f"❌ 推論中にエラーが発生: {e}")
            raise
    
    def inference_stream(self, image: Image.Image, prompt: str, **kwargs) -> Generator[str, None, None]:
        """
        ストリーミング形式で説明文を生成する
        
        Args:
            image: PIL Image
            prompt: プロンプト
            **kwargs: temperature, max_tokens など
        
        Yields:
            生成されたテキストのチャンク
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")
        
        print("🔮 画像分析を開始（ストリーミング）...")
        
        try:
            # 画像をBase64にエンコード
            image_base64 = self._encode_image_to_base64(image)
            
            # メッセージ構築
            messages = [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}"
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }
            ]
            
            # 生成パラメータ
            max_tokens = kwargs.get('max_tokens', 1000)
            temperature = kwargs.get('temperature', 0.1)
            
            # ストリーミング推論実行
            # Unicodeバッファリング（日本語対応）
            unicode_buffer = ""
            
            for chunk in self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True
            ):
                if 'choices' in chunk and len(chunk['choices']) > 0:
                    delta = chunk['choices'][0].get('delta', {})
                    content = delta.get('content', '')
                    
                    if content:
                        # Unicodeバッファリング処理
                        unicode_buffer += content
                        
                        # 完全なUTF-8文字列のみを出力
                        try:
                            # バッファの内容をエンコード→デコードして検証
                            unicode_buffer.encode('utf-8').decode('utf-8')
                            yield unicode_buffer
                            unicode_buffer = ""
                        except UnicodeDecodeError:
                            # 不完全なマルチバイト文字がある場合は保持
                            continue
            
            # 残りのバッファを出力
            if unicode_buffer:
                yield unicode_buffer
            
            print("✅ ストリーミング分析完了")
            
        except Exception as e:
            print(f"❌ ストリーミング推論中にエラーが発生: {e}")
            raise
    
    def unload(self) -> None:
        """モデルをメモリから解放する"""
        if self.llm is not None:
            del self.llm
            self.llm = None
        
        self.is_loaded = False
        print("🗑️ GGUFモデルをアンロードしました")
    
    def get_info(self) -> Dict[str, Any]:
        """モデル情報を取得する"""
        return {
            'name': 'InternVL 3.5 GGUF',
            'path': self.model_path,
            'mmproj_path': self.mmproj_path,
            'is_loaded': self.is_loaded,
            'physical_cores': self.physical_cores,
            'speculative_decoding': 'disabled'
        }
