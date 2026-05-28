"""
Qwen2.5-VL GGUF (llama.cpp) モデル実装
JSON mode を使った構造化抽出と2段階生成
"""

import os
import io
import base64
import json
import psutil
from PIL import Image
from typing import Any, Dict, Generator, Optional
from .model_interface import VisionLanguageModel

# Qwen-VL の視覚トークンは 28px グリッド (14px パッチ × 2×2) で処理される。
# 効率的なサイズは 28 の倍数: 448(×16), 672(×24), 896(×32), 1120(×40), 1344(×48)
# 値を大きくするほど認識精度が上がるが、推論速度と VRAM 消費が増える。
# None を指定するとリサイズなし（原寸）。
IMAGE_MAX_SIZE: int | None = 1120


class QwenVLGGUFModel(VisionLanguageModel):
    """Qwenx-VL GGUF (llama.cpp) 量子化モデル"""
    
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
        self.llm = None
        
        # 物理CPUコア数を取得（ハイパースレッディングを除く）
        self.physical_cores = psutil.cpu_count(logical=False) or 4
        print(f"🖥️  物理CPUコア数: {self.physical_cores}")
        
        # システムプロンプト（簡潔化）
        self.system_prompt = """視覚障害者向け画面説明アシスタントです。見えている内容のみを、日本語で説明してください。"""
    
    def load(self) -> None:
        """モデルをロードする"""
        if self.is_loaded:
            print("⚠️ モデルは既にロードされています")
            return
        
        print(f"📦 Qwen-VL GGUFをロード中: {self.model_path}")
        print(f"   ビジョンプロジェクタ: {self.mmproj_path}")
        print(f"   CPUスレッド数: {self.physical_cores}")
        
        try:
            from llama_cpp import Llama
            from llama_cpp.llama_chat_format import Qwen25VLChatHandler
            
            # メモリチェック
            available_memory = psutil.virtual_memory().available / (1024 ** 3)
            print(f"   利用可能メモリ: {available_memory:.1f} GB")
            
            if available_memory < 4.0:
                print("⚠️ 警告: 利用可能メモリが4GB未満です。動作が不安定になる可能性があります。")
            
            # ビジョンプロジェクタの確認
            if not self.mmproj_path or not os.path.exists(self.mmproj_path):
                raise FileNotFoundError(f"ビジョンプロジェクタが見つかりません: {self.mmproj_path}")
            
            # Chat Handlerの作成（Qwen-VL用）
            print(f"📦 QwenVLChatHandler を初期化中...")
            chat_handler = Qwen25VLChatHandler(clip_model_path=self.mmproj_path)
            print(f"✅ QwenVLChatHandler初期化完了")
            
            # メインモデルのロード
            model_kwargs = {
                "model_path": self.model_path,
                "chat_handler": chat_handler,
                "n_ctx": 8192,
                "n_batch": 2048,
                "n_threads": self.physical_cores,
                "n_gpu_layers": -1,  # Metal GPUをフル活用
                "verbose": False,
                "logits_all": False,
                "flash_attn": True,
            }
            
            print(f"📦 メインモデルをロード中...")
            self.llm = Llama(**model_kwargs)
            
            self.is_loaded = True
            print(f"✅ Qwen-VL GGUFのロードが完了しました")
            print(f"   🖥️ Metal GPU: 有効")
            
        except ImportError as e:
            print(f"❌ llama-cpp-pythonがインストールされていません: {e}")
            print("   pip install llama-cpp-python>=0.3.0 を実行してください")
            raise
        except Exception as e:
            print(f"❌ モデルのロードに失敗しました: {e}")
            raise
    
    def _encode_image_to_base64(self, image: Image.Image, max_size: int | None = IMAGE_MAX_SIZE) -> str:
        """PIL画像をBase64にエンコード"""
        if max_size is not None and max(image.size) > max_size:
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
    
    def _clean_output(self, text: str) -> str:
        """
        生成結果の後処理
        - 連続する同一文や同一行の重複を除去
        - 前後の空白や不自然な改行を整理
        - プロンプト再掲を検出・除去（簡易版）
        """
        # ステップ1: 前後の空白と不自然な改行を整理
        text = text.strip()
        while '\n\n\n' in text:
            text = text.replace('\n\n\n', '\n\n')
        
        # ステップ2: 連続する重複文を除去
        lines = text.split('\n')
        cleaned_lines = []
        
        for line in lines:
            if not line.strip():
                cleaned_lines.append(line)
                continue
            
            if cleaned_lines and cleaned_lines[-1].strip():
                prev_line = cleaned_lines[-1].strip()
                curr_line = line.strip()
                
                # 完全一致チェック
                if prev_line == curr_line:
                    continue
                
                # 部分的な重複チェック
                if len(prev_line) > 10 and len(curr_line) > 10:
                    if prev_line[:20] == curr_line[:20]:
                        continue
            
            cleaned_lines.append(line)
        
        result = '\n'.join(cleaned_lines).rstrip()
        
        return result
    
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
            max_tokens = kwargs.get('max_tokens', 200)
            temperature = kwargs.get('temperature', 0.1)
            
            # 推論実行
            response = self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=kwargs.get('top_p', 0.9),
                repeat_penalty=kwargs.get('repetition_penalty', 1.15),
                presence_penalty=0.0,
                frequency_penalty=0.0,
                stream=False
            )
            
            result = response['choices'][0]['message']['content']
            
            # 後処理
            result = self._clean_output(result)
            
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
            unicode_buffer = ""
            
            for chunk in self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=kwargs.get('top_p', 0.9),
                repeat_penalty=kwargs.get('repetition_penalty', 1.15),
                presence_penalty=0.0,
                frequency_penalty=0.0,
                stream=True
            ):
                if 'choices' in chunk and len(chunk['choices']) > 0:
                    delta = chunk['choices'][0].get('delta', {})
                    content = delta.get('content', '')
                    
                    if content:
                        # Unicodeバッファリング処理
                        unicode_buffer += content
                        
                        try:
                            unicode_buffer.encode('utf-8').decode('utf-8')
                            yield unicode_buffer
                            unicode_buffer = ""
                        except UnicodeDecodeError:
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
    
    def _extract_json_block(self, text: str) -> str:
        """
        テキストからJSONブロックを抽出
        - コードフェンス（```json ... ```）を除去
        - 前後の余計なテキストを除去
        """
        text = text.strip()
        
        # コードフェンスで囲まれている場合は除去
        if text.startswith('```'):
            first_fence_end = text.find('\n')
            if first_fence_end != -1:
                text = text[first_fence_end + 1:]
            last_fence_start = text.rfind('```')
            if last_fence_start != -1:
                text = text[:last_fence_start]
        
        return text.strip()
    
    def _safe_parse_json(self, text: str) -> Optional[dict]:
        """
        安全にJSONをパース
        - 余計な装飾を除去
        - 不完全なJSONを修正
        """
        # テキストをクリーン
        cleaned = self._extract_json_block(text)
        
        # 1回目のパース試行
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass
        
        # 末尾の不完全な部分を切り詰めて再試行
        for i in range(len(cleaned) - 1, max(len(cleaned) - 100, 0), -1):
            try:
                return json.loads(cleaned[:i])
            except json.JSONDecodeError:
                continue
        
        return None
    
    def inference_phase1_extraction(self, image: Image.Image, prompt: str, **kwargs) -> dict:
        """
        【第1段階】画像から構造化JSON抽出（response_format JSON mode優先）

        Args:
            image: PIL Image
            prompt: 第1段階用プロンプト
            **kwargs: temperature, max_tokens, image_max_size など

        Returns:
            構造化されたJSON辞書（パース失敗時はフォールバック）
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")

        image_max_size = kwargs.pop('image_max_size', IMAGE_MAX_SIZE)
        try:
            # 画像をBase64にエンコード
            image_base64 = self._encode_image_to_base64(image, max_size=image_max_size)
            
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
            
            # 生成パラメータ（第1段階は短く、決定論的に）
            max_tokens = kwargs.get('max_tokens', 300)
            temperature = kwargs.get('temperature', 0.0)
            
            # JSON Schema定義（phase1の出力形式）
            json_schema = {
                "type": "object",
                "properties": {
                    "screen_type": {"type": "string"},
                    "main_goal": {"type": "string"},
                    "important_elements": {
                        "type": "array",
                        "items": {"type": "string"}
                    },
                    "important_text": {
                        "type": "array",
                        "items": {"type": "string"}
                    },
                    "status_or_warning": {"type": ["string", "null"]},
                    "unclear_parts": {"type": ["string", "null"]},
                    "confidence": {"type": "number"}
                },
                "required": [
                    "screen_type", "main_goal", "important_elements",
                    "important_text", "confidence"
                ]
            }
            
            # 【試行1】response_format を使ったJSON mode
            try:
                print(f"   📝 JSON mode（response_format）で推論実行...")
                response = self.llm.create_chat_completion(
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_p=kwargs.get('top_p', 0.85),
                    repeat_penalty=kwargs.get('repetition_penalty', 1.3),
                    presence_penalty=0.0,
                    frequency_penalty=0.0,
                    stream=False,
                    response_format={"type": "json_object"}
                )
                
                raw_output = response['choices'][0]['message']['content']
                print(f"   📊 JSON mode成功")
                
                # JSONパース
                parsed = json.loads(raw_output)
                print(f"   ✅ JSONパース成功")
                return parsed
                
            except Exception as e:
                print(f"   ⚠️ JSON mode失敗: {e}")
                
                # 【フォールバック】通常推論＋後処理
                print(f"   📝 フォールバック：通常推論...")
                response = self.llm.create_chat_completion(
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_p=kwargs.get('top_p', 0.85),
                    repeat_penalty=kwargs.get('repetition_penalty', 1.3),
                    presence_penalty=0.0,
                    frequency_penalty=0.0,
                    stream=False
                )
                
                raw_output = response['choices'][0]['message']['content']
                print(f"   生テキスト長: {len(raw_output)}文字")
                
                # JSONパース試行
                parsed = self._safe_parse_json(raw_output)
                
                if parsed is not None:
                    print(f"   ✅ JSONパース成功（フォールバック）")
                    return parsed
                else:
                    # パース失敗時のフォールバック
                    print(f"   ⚠️ JSONパース失敗、フォールバック辞書返却")
                    return {
                        "raw_intermediate_text": raw_output,
                        "parse_failed": True,
                        "screen_type": "不明",
                        "main_goal": "構造化に失敗",
                        "important_elements": [],
                        "important_text": [],
                        "status_or_warning": None,
                        "unclear_parts": "JSON形式での解析に失敗しました",
                        "confidence": 0.0
                    }
            
        except Exception as e:
            print(f"❌ 第1段階推論中にエラー: {e}")
            return {
                "parse_failed": True,
                "error": str(e),
                "screen_type": "不明",
                "main_goal": "エラー発生",
                "important_elements": [],
                "important_text": [],
                "status_or_warning": None,
                "unclear_parts": f"エラー: {str(e)}",
                "confidence": 0.0
            }
    
    def inference_phase2_generation(self, intermediate_json: dict, prompt_template: str, **kwargs) -> str:
        """
        【第2段階】構造化JSONから自然な説明文を生成
        
        Args:
            intermediate_json: 第1段階で抽出されたJSON辞書
            prompt_template: 第2段階用プロンプトテンプレート（{intermediate_json}を含む）
            **kwargs: temperature, max_tokens など
        
        Returns:
            生成された自然文説明
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")
        
        try:
            # JSONを整形してプロンプトに挿入
            json_str = json.dumps(intermediate_json, ensure_ascii=False, indent=2)
            prompt = prompt_template.replace("{intermediate_json}", json_str)
            
            # メッセージ構築（画像なし、テキストのみ）
            messages = [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]
            
            # 生成パラメータ（第2段階は自然な出力向け）
            max_tokens = kwargs.get('max_tokens', 200)
            temperature = kwargs.get('temperature', 0.1)
            
            # 推論実行
            response = self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=kwargs.get('top_p', 0.85),
                repeat_penalty=kwargs.get('repetition_penalty', 1.3),
                presence_penalty=0.0,
                frequency_penalty=0.0,
                stream=False
            )
            
            result = response['choices'][0]['message']['content']
            
            # 後処理：重複除去と空白整理
            result = self._clean_output(result)
            
            print(f"📝 第2段階（自然文生成）完了（{len(result)}文字）")
            
            return result
            
        except Exception as e:
            print(f"❌ 第2段階推論中にエラー: {e}")
            raise
    
    def inference_phase2_generation_stream(self, intermediate_json: dict, prompt_template: str, **kwargs) -> Generator[str, None, None]:
        """
        【第2段階】構造化JSONから自然な説明文を生成（ストリーミング）
        
        Args:
            intermediate_json: 第1段階で抽出されたJSON辞書
            prompt_template: 第2段階用プロンプトテンプレート
            **kwargs: temperature, max_tokens など
        
        Yields:
            生成されたテキストのチャンク
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")
        
        try:
            # JSONを整形してプロンプトに挿入
            json_str = json.dumps(intermediate_json, ensure_ascii=False, indent=2)
            prompt = prompt_template.replace("{intermediate_json}", json_str)
            
            # メッセージ構築（画像なし、テキストのみ）
            messages = [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]
            
            # 生成パラメータ
            max_tokens = kwargs.get('max_tokens', 200)
            temperature = kwargs.get('temperature', 0.1)
            
            # ストリーミング推論実行
            unicode_buffer = ""
            
            for chunk in self.llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=kwargs.get('top_p', 0.85),
                repeat_penalty=kwargs.get('repetition_penalty', 1.3),
                presence_penalty=0.0,
                frequency_penalty=0.0,
                stream=True
            ):
                if 'choices' in chunk and len(chunk['choices']) > 0:
                    delta = chunk['choices'][0].get('delta', {})
                    content = delta.get('content', '')
                    
                    if content:
                        # Unicodeバッファリング処理
                        unicode_buffer += content
                        
                        try:
                            unicode_buffer.encode('utf-8').decode('utf-8')
                            yield unicode_buffer
                            unicode_buffer = ""
                        except UnicodeDecodeError:
                            continue
            
            # 残りのバッファを出力
            if unicode_buffer:
                yield unicode_buffer
            
            print("✅ 第2段階ストリーミング完了")
            
        except Exception as e:
            print(f"❌ 第2段階ストリーミング推論中にエラー: {e}")
            raise

    def get_info(self) -> Dict[str, Any]:
        """モデル情報を取得する"""
        return {
            'name': 'Qwen2.5-VL GGUF',
            'path': self.model_path,
            'mmproj_path': self.mmproj_path,
            'is_loaded': self.is_loaded,
            'physical_cores': self.physical_cores
        }
