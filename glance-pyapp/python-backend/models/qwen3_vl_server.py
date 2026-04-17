"""
Qwen3-VL GGUF (llama-server経由) モデル実装
llama-server REST API を使った画像理解と2段階生成
"""

import os
import io
import base64
import json
import requests
from PIL import Image
from typing import Any, Dict, Generator, Optional
from .model_interface import VisionLanguageModel


class Qwen3VLServerModel(VisionLanguageModel):
    """Qwen3-VL GGUF (llama-server REST API経由) モデル"""
    
    def __init__(self, model_path: str, mmproj_path: str = None, server_url: str = "http://127.0.0.1:8080"):
        """
        初期化
        
        Args:
            model_path: メインモデルのGGUFファイルパス（参考用）
            mmproj_path: ビジョンプロジェクタのGGUFファイルパス（参考用）
            server_url: llama-server の URL
        """
        super().__init__(model_path)
        self.mmproj_path = mmproj_path
        self.server_url = server_url
        self.health_checked = False
        
        # システムプロンプト（簡潔化）
        self.system_prompt = """視覚障害者向け画面説明アシスタントです。見えている内容のみを、日本語で説明してください。"""
    
    def load(self) -> None:
        """llama-server への接続確認"""
        if self.is_loaded:
            print("⚠️ モデルは既にロードされています")
            return
        
        print(f"📦 Qwen3-VL Server接続確認中: {self.server_url}")
        
        try:
            # health check
            response = requests.get(f"{self.server_url}/health", timeout=5)
            if response.status_code == 200:
                print(f"✅ llama-server 接続成功")
                self.health_checked = True
                self.is_loaded = True
            else:
                raise ConnectionError(f"Server health check failed: {response.status_code}")
        except Exception as e:
            print(f"❌ llama-server 接続失敗: {e}")
            print(f"   llama-server を起動してください:")
            print(f"   llama-server \\")
            print(f"     -m {self.model_path} \\")
            print(f"     --mmproj {self.mmproj_path} \\")
            print(f"     --host 127.0.0.1 --port 8080")
            raise
    
    def _encode_image_to_base64(self, image: Image.Image) -> str:
        """PIL画像をBase64にエンコード"""
        # 画像を最適サイズにリサイズ（448px以下）
        max_size = 448
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
    
    def _clean_output(self, text: str) -> str:
        """
        生成結果の後処理
        - 連続する同一文や同一行の重複を除去
        - 前後の空白や不自然な改行を整理
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
            raise RuntimeError("llama-server に接続されていません。先に load() を呼び出してください。")
        
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
            
            # llama-server への POST リクエスト
            payload = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": kwargs.get('top_p', 0.9),
                "stream": False
            }
            
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                timeout=300
            )
            response.raise_for_status()
            
            result_json = response.json()
            result = result_json['choices'][0]['message']['content']
            
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
            raise RuntimeError("llama-server に接続されていません。先に load() を呼び出してください。")
        
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
            
            # llama-server への POST リクエスト（ストリーミング）
            payload = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": kwargs.get('top_p', 0.9),
                "stream": True
            }
            
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                stream=True,
                timeout=300
            )
            response.raise_for_status()
            
            # SSE形式でストリーム処理
            for line in response.iter_lines():
                if line:
                    line = line.decode('utf-8') if isinstance(line, bytes) else line
                    if line.startswith('data: '):
                        data_str = line[6:]  # "data: " を除去
                        if data_str == '[DONE]':
                            break
                        try:
                            data = json.loads(data_str)
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                content = delta.get('content', '')
                                if content:
                                    yield content
                        except json.JSONDecodeError:
                            pass
            
            print("✅ ストリーミング分析完了")
            
        except Exception as e:
            print(f"❌ ストリーミング推論中にエラーが発生: {e}")
            raise
    
    def unload(self) -> None:
        """llama-server の接続をクローズ（サーバーは起動したままになる）"""
        self.is_loaded = False
        self.health_checked = False
        print("🗑️ llama-server との接続をクローズしました（サーバーは起動したままです）")
    
    def _extract_json_block(self, text: str) -> str:
        """テキストからJSONブロックを抽出"""
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
        """安全にJSONをパース"""
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
        【第1段階】画像から構造化JSON抽出
        
        Args:
            image: PIL Image
            prompt: 第1段階用プロンプト
            **kwargs: temperature, max_tokens など
        
        Returns:
            構造化されたJSON辞書（パース失敗時はフォールバック）
        """
        if not self.is_loaded:
            raise RuntimeError("llama-server に接続されていません。先に load() を呼び出してください。")
        
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
            
            # 生成パラメータ（第1段階は短く、決定論的に）
            max_tokens = kwargs.get('max_tokens', 300)
            temperature = kwargs.get('temperature', 0.0)
            
            # llama-server への POST リクエスト（JSON mode）
            payload = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": kwargs.get('top_p', 0.85),
                "stream": False
            }
            
            print(f"   📝 JSON mode で推論実行...")
            
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                timeout=300
            )
            response.raise_for_status()
            
            result_json = response.json()
            raw_output = result_json['choices'][0]['message']['content']
            print(f"   📊 推論完了")
            
            # JSONパース試行
            parsed = self._safe_parse_json(raw_output)
            
            if parsed is not None:
                print(f"   ✅ JSONパース成功")
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
            prompt_template: 第2段階用プロンプトテンプレート
            **kwargs: temperature, max_tokens など
        
        Returns:
            生成された自然文説明
        """
        if not self.is_loaded:
            raise RuntimeError("llama-server に接続されていません。先に load() を呼び出してください。")
        
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
            
            # llama-server への POST リクエスト
            payload = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": kwargs.get('top_p', 0.85),
                "stream": False
            }
            
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                timeout=300
            )
            response.raise_for_status()
            
            result_json = response.json()
            result = result_json['choices'][0]['message']['content']
            
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
            raise RuntimeError("llama-server に接続されていません。先に load() を呼び出してください。")
        
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
            
            # llama-server への POST リクエスト（ストリーミング）
            payload = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": kwargs.get('top_p', 0.85),
                "stream": True
            }
            
            response = requests.post(
                f"{self.server_url}/v1/chat/completions",
                json=payload,
                stream=True,
                timeout=300
            )
            response.raise_for_status()
            
            # SSE形式でストリーム処理
            for line in response.iter_lines():
                if line:
                    line = line.decode('utf-8') if isinstance(line, bytes) else line
                    if line.startswith('data: '):
                        data_str = line[6:]  # "data: " を除去
                        if data_str == '[DONE]':
                            break
                        try:
                            data = json.loads(data_str)
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                content = delta.get('content', '')
                                if content:
                                    yield content
                        except json.JSONDecodeError:
                            pass
            
            print("✅ 第2段階ストリーミング完了")
            
        except Exception as e:
            print(f"❌ 第2段階ストリーミング推論中にエラー: {e}")
            raise

    def get_info(self) -> Dict[str, Any]:
        """モデル情報を取得する"""
        return {
            'name': 'Qwen3-VL (llama-server)',
            'path': self.model_path,
            'mmproj_path': self.mmproj_path,
            'is_loaded': self.is_loaded,
            'server_url': self.server_url,
            'type': 'qwen3_vl_server'
        }
