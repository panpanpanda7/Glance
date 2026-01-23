"""
Vision-Language Model のインターフェース定義
"""

from abc import ABC, abstractmethod
from PIL import Image
from typing import Any, Dict


class VisionLanguageModel(ABC):
    """Vision-Language Modelの抽象基底クラス"""
    
    def __init__(self, model_path: str):
        """
        Args:
            model_path: モデルファイルのパス
        """
        self.model_path = model_path
        self.is_loaded = False
    
    @abstractmethod
    def load(self) -> None:
        """モデルをメモリにロードする"""
        pass
    
    @abstractmethod
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
        pass
    
    @abstractmethod
    def unload(self) -> None:
        """モデルをメモリから解放する"""
        pass
    
    @abstractmethod
    def get_info(self) -> Dict[str, Any]:
        """
        モデル情報を取得する
        
        Returns:
            モデル情報の辞書
        """
        pass
