"""
InternVL 2.5 モデル実装
高精度な画像理解と詳細な説明生成
"""

import torch
import os
import sys
import numpy as np
from torchvision import transforms
from transformers import AutoProcessor, AutoTokenizer
from PIL import Image
import importlib.util
from typing import Any, Dict
import warnings
from .model_interface import VisionLanguageModel


class InternVLModel(VisionLanguageModel):
    """InternVL 2.5 Vision-Language Model"""
    
    def __init__(self, model_path: str):
        super().__init__(model_path)
        self.model = None
        self.tokenizer = None
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"🖥️  デバイス: {self.device}")
    
    def _register_model_modules(self):
        """カスタムモデルコードをインポートパスに登録（柔軟なバージョン）"""
        try:
            # モデルフォルダのPythonパスを追加
            model_path = os.path.abspath(self.model_path)
            
            # transformers_modulesフォルダを作成
            transformers_modules_dir = os.path.join(os.path.dirname(os.path.dirname(model_path)), 'transformers_modules')
            os.makedirs(transformers_modules_dir, exist_ok=True)
            
            # InternVL2フォルダを作成
            internvl2_dir = os.path.join(transformers_modules_dir, 'InternVL2')
            os.makedirs(internvl2_dir, exist_ok=True)
            
            # __init__.pyファイルを作成
            with open(os.path.join(transformers_modules_dir, '__init__.py'), 'w') as f:
                f.write('# Auto-generated init file\n')
            with open(os.path.join(internvl2_dir, '__init__.py'), 'w') as f:
                f.write('# Auto-generated init file\n')
            
            # モデルフォルダ内の全てのPythonファイルを自動検出してコピー
            print(f"  📝 モデルファイルをコピー中...")
            copied_count = 0
            
            for file in os.listdir(model_path):
                if file.endswith('.py'):
                    src_path = os.path.join(model_path, file)
                    dst_path = os.path.join(internvl2_dir, file)
                    
                    # ファイルをコピー
                    with open(src_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    with open(dst_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    
                    print(f"    ✓ {file} をコピーしました")
                    copied_count += 1
            
            print(f"  ✅ {copied_count}個のPythonファイルをコピーしました")
            
            # Pythonパスに追加
            sys.path.insert(0, os.path.dirname(os.path.dirname(model_path)))
            print(f"✅ カスタムモデルコードをPythonパスに登録しました")
            
        except Exception as e:
            warnings.warn(f"カスタムモデルコードの登録に失敗しました: {e}")
    
    def load(self) -> None:
        """モデルをロードする"""
        if self.is_loaded:
            print("⚠️  モデルは既にロードされています")
            return
        
        print(f"📦 InternVLをロード中: {self.model_path}")
        print(f"⏳ 初回ロードには数分かかる場合があります...")
        
        try:
            # カスタムモデルコードを登録
            self._register_model_modules()
            
            # 必要なクラスをインポート
            from transformers_modules.InternVL2.modeling_internvl_chat import InternVLChatModel
            
            # モデルのロード
            self.model = InternVLChatModel.from_pretrained(
                self.model_path,
                torch_dtype=torch.float16 if self.device == 'cuda' else torch.float32,
                low_cpu_mem_usage=True,
                trust_remote_code=True,
                local_files_only=True
            ).to(self.device).eval()
            
            # トークナイザーのロード
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_path,
                trust_remote_code=True,
                local_files_only=True
            )
            
            self.is_loaded = True
            print(f"✅ InternVLのロードが完了しました")
            print(f"   デバイス: {self.device}")
            print(f"   モデルサイズ: {self._get_model_size():.2f} GB")
            
        except Exception as e:
            print(f"❌ モデルのロードに失敗しました: {e}")
            raise
    
    def _preprocess_image(self, image: Image.Image):
        """
        PIL画像をモデルに適したテンソルに変換
        
        Args:
            image: PIL Image
            
        Returns:
            torch.Tensor: 処理済み画像テンソル
        """
        # InternVL用の画像前処理
        # モデル設定に基づき448x448にリサイズ（force_image_size: 448）
        transform = transforms.Compose([
            transforms.Resize((448, 448)),  # モデルの期待サイズに合わせる
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        ])
        
        # PIL ImageをPyTorch Tensorに変換
        img_tensor = transform(image).unsqueeze(0)  # バッチ次元を追加
        
        return img_tensor.to(self.device)
    
    def inference(self, image: Image.Image, prompt: str, **kwargs) -> str:
        """
        画像から説明文を生成する
        
        Args:
            image: PIL Image
            prompt: プロンプト
            **kwargs: temperature, max_tokens, top_p など
        
        Returns:
            生成された説明文
        """
        if not self.is_loaded:
            raise RuntimeError("モデルがロードされていません。先にload()を呼び出してください。")
        
        print("🔮 画像分析を開始...")
        
        try:
            # PIL ImageをPyTorch Tensorに変換
            pixel_values = self._preprocess_image(image)
            
            # 生成パラメータを辞書形式で作成
            # モデルのchatメソッドは辞書を受け取り、内部でGenerationConfigに変換する
            generation_config = {
                'max_length': kwargs.get('max_tokens', 1000),
                'do_sample': kwargs.get('temperature', 0.1) > 0,
                'temperature': kwargs.get('temperature', 0.1),
                'top_p': kwargs.get('top_p', 0.9),
            }
            
            # 繰り返し防止パラメータ（オプション）
            if 'repetition_penalty' in kwargs:
                generation_config['repetition_penalty'] = kwargs['repetition_penalty']
            if 'no_repeat_ngram_size' in kwargs:
                generation_config['no_repeat_ngram_size'] = kwargs['no_repeat_ngram_size']
            
            # InternVL 2.5のchatメソッドを使用
            # chatメソッドは辞書形式のgeneration_configを受け取る
            with torch.no_grad():
                response = self.model.chat(
                    self.tokenizer,
                    pixel_values,
                    prompt,
                    generation_config  # 辞書形式で渡す（モデル側で処理）
                )
            
            print(f"✅ 画像分析完了（{len(response)}文字）")
            
            return response
            
        except Exception as e:
            print(f"❌ 推論中にエラーが発生: {e}")
            raise
    
    def unload(self) -> None:
        """モデルをメモリから解放する"""
        if self.model is not None:
            del self.model
            self.model = None
        
        if self.tokenizer is not None:
            del self.tokenizer
            self.tokenizer = None
        
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        
        self.is_loaded = False
        print("🗑️  モデルをアンロードしました")
    
    def get_info(self) -> Dict[str, Any]:
        """モデル情報を取得する"""
        return {
            'name': 'InternVL 2.5',
            'path': self.model_path,
            'device': self.device,
            'is_loaded': self.is_loaded,
            'model_size_gb': self._get_model_size() if self.is_loaded else 0
        }
    
    def _get_model_size(self) -> float:
        """モデルのメモリサイズを取得（GB）"""
        if self.model is None:
            return 0.0
        
        param_size = 0
        for param in self.model.parameters():
            param_size += param.nelement() * param.element_size()
        
        buffer_size = 0
        for buffer in self.model.buffers():
            buffer_size += buffer.nelement() * buffer.element_size()
        
        size_gb = (param_size + buffer_size) / 1024 ** 3
        return size_gb
