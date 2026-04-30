"""
Qwen3-VL GGUF (llama-server経由) モデル実装
llama-server REST API を使った画像理解と2段階生成
Windows 配布対応版（llama-server 自動起動機能付き）
"""

import os
import io
import base64
import json
import requests
import subprocess
import time
import socket
import signal
from pathlib import Path
from PIL import Image
from typing import Any, Dict, Generator, Optional
from .model_interface import VisionLanguageModel


class Qwen3VLServerModel(VisionLanguageModel):
    """Qwen3-VL GGUF (llama-server REST API経由) モデル"""
    
    def __init__(
        self,
        model_path: str,
        mmproj_path: str = None,
        server_url: str = "http://127.0.0.1:8080",
        server_host: str = "127.0.0.1",
        server_port: int = 8080,
        auto_start_server: bool = True,
        bundled_server_binary: str = None,
        server_binary_path: str = None
    ):
        """
        初期化
        
        Args:
            model_path: メインモデルのGGUFファイルパス
            mmproj_path: ビジョンプロジェクタのGGUFファイルパス
            server_url: llama-server の URL
            server_host: llama-server のホスト（デフォルト: 127.0.0.1）
            server_port: llama-server のポート（デフォルト: 8080）
            auto_start_server: サーバーを自動起動するか（デフォルト: True）
            bundled_server_binary: 同梱サーバーバイナリの相対パス（例: llama-server.exe）
            server_binary_path: llama-server のバイナリパス（明示的に指定）
        """
        super().__init__(model_path)
        self.mmproj_path = mmproj_path
        self.server_url = server_url
        self.server_host = server_host
        self.server_port = server_port
        self.auto_start_server = auto_start_server
        self.bundled_server_binary = bundled_server_binary
        self.server_binary_path = server_binary_path
        self.health_checked = False
        self.server_process = None
        self.started_server_by_self = False  # 自前起動したかどうか
        
        # システムプロンプト（簡潔化）
        self.system_prompt = """視覚障害者向け画面説明アシスタントです。見えている内容のみを、日本語で説明してください。"""
    
    def _find_server_binary(self) -> Optional[str]:
        """
        llama-server バイナリを探す（複数の場所を検索）
        
        優先順位:
        1. server_binary_path で明示的に指定
        2. frozen 実行時【最優先】: sys.executable と同じディレクトリ
        3. frozen 実行時: カレントディレクトリ
        4. frozen 実行時: Electronリソース
        5. 開発時: プロジェクトルート相対パス
        6. システムPATH
        """
        
        print(f"\n{'='*60}")
        print(f"🔍 llama-server バイナリを検索中...")
        print(f"{'='*60}")
        
        searched_paths = []  # 検索したパスを記録
        
        # 1. 明示的に指定されている場合
        if self.server_binary_path:
            print(f"\n[検索1] 明示的に指定されたパスを確認...")
            print(f"   パス: {self.server_binary_path}")
            searched_paths.append(str(self.server_binary_path))
            if os.path.exists(self.server_binary_path):
                print(f"   ✅ 検出しました")
                return self.server_binary_path
            else:
                print(f"   ❌ ファイルが見つかりません")
        
        # 2. 実行環境の確認
        is_frozen = getattr(__import__('sys'), 'frozen', False)
        print(f"\n[環境確認] 実行環境...")
        print(f"   frozen: {is_frozen}")
        
        if is_frozen:
            print(f"   → 本番環境モード（PyInstallerでビルドされている）")
            print(f"   sys.executable: {__import__('sys').executable}")
            
            # 【最優先】sys.executable と同じディレクトリ
            # （glance-backend.exe と同じフォルダ）
            print(f"\n[検索2] sys.executable と同じディレクトリ【最優先】...")
            exe_dir = Path(__import__('sys').executable).parent
            
            if self.bundled_server_binary:
                candidate = exe_dir / self.bundled_server_binary
            else:
                candidate = exe_dir / "llama-server.exe" if os.name == 'nt' else exe_dir / "llama-server"
            
            print(f"   候補: {candidate}")
            searched_paths.append(str(candidate))
            
            if candidate.exists():
                print(f"   ✅ 検出しました！【最優先候補で採用】")
                return str(candidate)
            else:
                print(f"   ❌ 見つかりません")
            
            # カレントディレクトリ
            print(f"\n[検索3] カレントディレクトリ...")
            cwd_candidate = Path.cwd() / (self.bundled_server_binary or ("llama-server.exe" if os.name == 'nt' else "llama-server"))
            print(f"   候補: {cwd_candidate}")
            searched_paths.append(str(cwd_candidate))
            
            if cwd_candidate.exists():
                print(f"   ✅ 検出しました！")
                return str(cwd_candidate)
            else:
                print(f"   ❌ 見つかりません")
            
            # Electron パッケージの場合（別フォルダ）
            print(f"\n[検索4] Electronリソース（resources/glance-backend）...")
            base_path = Path(getattr(__import__('sys'), '_MEIPASS', ''))
            electron_candidate = base_path.parent / "glance-backend" / "llama-server.exe"
            print(f"   候補: {electron_candidate}")
            searched_paths.append(str(electron_candidate))
            
            if electron_candidate.exists():
                print(f"   ✅ 検出しました！")
                return str(electron_candidate)
            else:
                print(f"   ❌ 見つかりません")
        else:
            # 開発時（frozen=False）: プロジェクトルート相対パス
            print(f"   → 開発環境モード（PyInstallerでビルドされていない）")
            
            print(f"\n[検索2] プロジェクトルート相対パス...")
            current = Path(__file__).parent.parent
            print(f"   基準パス: {current}")
            
            for i in range(3):  # 3階層上まで探索
                print(f"\n   [階層 {i}] {current}")
                
                if self.bundled_server_binary:
                    candidate = current / self.bundled_server_binary
                else:
                    candidate = current / "llama-server.exe" if os.name == 'nt' else current / "llama-server"
                
                print(f"      候補: {candidate}")
                searched_paths.append(str(candidate))
                
                if candidate.exists():
                    print(f"      ✅ 検出しました！")
                    return str(candidate)
                else:
                    print(f"      ❌ 見つかりません")
                
                current = current.parent
        
        # 最後の手段: システムPATH
        print(f"\n[検索5] システムPATH...")
        
        if os.name == 'nt':
            result = os.system(f"where llama-server > nul 2>&1")
            if result == 0:
                print(f"   ✅ システムPATHで検出しました")
                return "llama-server"
            else:
                print(f"   ❌ システムPATHで見つかりません")
        else:
            result = os.system(f"which llama-server > /dev/null 2>&1")
            if result == 0:
                print(f"   ✅ システムPATHで検出しました")
                return "llama-server"
            else:
                print(f"   ❌ システムPATHで見つかりません")
        
        print(f"\n{'='*60}")
        print(f"❌ llama-server バイナリが見つかりませんでした")
        print(f"   検索したパス:")
        for path in searched_paths:
            print(f"     - {path}")
        print(f"{'='*60}\n")
        
        # 検索したパスリストを返す
        self._searched_binary_paths = searched_paths
        return None
    
    def _is_port_available(self, host: str, port: int) -> bool:
        """ポートが利用可能か確認"""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex((host, port))
            sock.close()
            return result != 0
        except Exception:
            return True
    
    def _get_server_log_path(self) -> str:
        """llama-server ログファイルのパスを取得"""
        if getattr(__import__('sys'), 'frozen', False):
            # EXE実行時はユーザーのAppDataフォルダを使用
            if os.name == 'nt':
                base_dir = os.path.join(os.environ.get('APPDATA', ''), 'Glance', 'logs')
            elif os.name == 'posix':
                base_dir = os.path.join(os.path.expanduser('~'), '.config', 'Glance', 'logs')
            else:
                base_dir = os.path.join(os.path.expanduser('~'), '.Glance', 'logs')
        else:
            # 開発時はローカルのlogsフォルダ
            base_dir = os.path.join(os.path.dirname(__file__), '..', 'logs')
        
        os.makedirs(base_dir, exist_ok=True)
        return os.path.join(base_dir, 'llama-server.log')
    
    def _start_server(self) -> tuple:
        """
        llama-server をサブプロセスで起動
        
        Returns:
            (成功: bool, エラー詳細: str or None)
        """
        if not self.auto_start_server:
            print("⚠️ auto_start_server=False のため、llama-server の自動起動をスキップします")
            return False, "auto_start_server=False"
        
        # バイナリを探す
        server_binary = self._find_server_binary()
        if not server_binary:
            error_msg = (
                f"❌ llama-server バイナリが見つかりません\n"
                f"   検索したパス: {getattr(self, '_searched_binary_paths', [])}\n"
                f"   以下から Windows バイナリをダウンロードしてください:\n"
                f"   https://github.com/ggerganov/llama.cpp/releases"
            )
            print(error_msg)
            return False, "バイナリ未検出: " + str(getattr(self, '_searched_binary_paths', []))
        
        # ポート確認
        if not self._is_port_available(self.server_host, self.server_port):
            error_msg = f"❌ ポート {self.server_port} は既に使用されています"
            print(error_msg)
            return False, f"ポート競合: {self.server_port}"
        
        # ログファイルパスを取得
        log_file_path = self._get_server_log_path()
        
        print(f"🚀 llama-server を起動中...")
        print(f"   バイナリ: {server_binary}")
        print(f"   モデル: {self.model_path}")
        print(f"   mmproj: {self.mmproj_path}")
        print(f"   アドレス: {self.server_host}:{self.server_port}")
        print(f"   ログ出力: {log_file_path}")
        
        try:
            # ログファイルをオープン（追記モード）
            try:
                log_file = open(log_file_path, 'a', encoding='utf-8')
            except Exception as e:
                print(f"⚠️ ログファイルのオープンに失敗: {e}")
                log_file = subprocess.DEVNULL
            
            # llama-server を起動
            cmd = [
                server_binary,
                "-m", self.model_path,
                "--mmproj", self.mmproj_path,
                "--host", self.server_host,
                "--port", str(self.server_port),
                "--log-level", "warn"  # ログレベルを調整
            ]
            
            # Windows の場合は CREATE_NEW_PROCESS_GROUP を使う
            if os.name == 'nt':
                self.server_process = subprocess.Popen(
                    cmd,
                    stdout=log_file,
                    stderr=log_file,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if hasattr(subprocess, 'CREATE_NEW_PROCESS_GROUP') else 0
                )
            else:
                self.server_process = subprocess.Popen(
                    cmd,
                    stdout=log_file,
                    stderr=log_file,
                    preexec_fn=os.setsid if hasattr(os, 'setsid') else None
                )
            
            print(f"✅ llama-server プロセスを起動しました (PID: {self.server_process.pid})")
            
            # 起動直後クラッシュチェック（1秒待機後に確認）
            time.sleep(1)
            return_code = self.server_process.poll()
            
            if return_code is not None:
                # プロセスが既に終了している
                error_msg = f"❌ llama-server が起動直後に終了しました (return code: {return_code})"
                print(error_msg)
                
                # Windows の DLL 不足エラーコード：0xC0000135 = 3221225781
                if return_code == 3221225781 or return_code == -1073741515:
                    dll_error_msg = (
                        f"\n🔴 DLL 不足の可能性が高いです\n"
                        f"   このエラーコード ({return_code}) は Windows では「DLL が見つからない」を示します\n"
                        f"\n📋 確認してください：\n"
                        f"   1. llama-server.exe のパス: {server_binary}\n"
                        f"   2. 親ディレクトリに *.dll ファイルが存在するか確認\n"
                        f"   3. 実行に必要な DLL：\n"
                        f"      - msvcrt.dll, kernel32.dll など Windows 標準 DLL\n"
                        f"      - CUDA/GPU 関連 DLL（使用している場合）\n"
                        f"\n📄 詳細はログを確認：\n"
                        f"   {log_file_path}\n"
                        f"\n🔧 対処法：\n"
                        f"   - Windows release にて llama-server.exe とその DLL が同梱されているか確認\n"
                        f"   - 配置パス: resources/glance-backend/llama-cpp-bin/\n"
                    )
                    print(dll_error_msg)
                    return False, f"DLL 不足エラー: return_code={return_code}, binary={server_binary}, log={log_file_path}"
                else:
                    print(f"   ログを確認してください: {log_file_path}")
                    print(f"   実行ファイル: {server_binary}")
                    return False, f"起動直後クラッシュ: return_code={return_code}, binary={server_binary}, log={log_file_path}"
            
            self.started_server_by_self = True  # 自前起動フラグを設定
            self._server_log_path = log_file_path  # ログパスを保存
            return True, None
            
        except subprocess.CalledProcessError as e:
            error_msg = f"❌ llama-server 起動エラー (CalledProcessError): {e}"
            print(error_msg)
            return False, f"subprocess エラー: {str(e)}"
        except FileNotFoundError as e:
            error_msg = f"❌ llama-server バイナリが実行できません (FileNotFoundError): {e}"
            print(error_msg)
            return False, f"ファイル不検出: {str(e)}"
        except PermissionError as e:
            error_msg = f"❌ llama-server バイナリの実行権限がありません (PermissionError): {e}"
            print(error_msg)
            return False, f"実行権限エラー: {str(e)}"
        except Exception as e:
            error_msg = f"❌ llama-server 起動エラー: {e}"
            print(error_msg)
            return False, f"予期しないエラー: {str(e)}"
    
    def _wait_for_server(self, max_retries: int = 60, retry_interval: float = 1.0) -> bool:
        """
        llama-server が起動するまで待機（health check）
        
        Args:
            max_retries: 最大試行回数（デフォルト: 60回 = 60秒）
            retry_interval: 再試行間隔（デフォルト: 1.0秒）
        
        Returns:
            起動完了: True, タイムアウト: False
        """
        print(f"⏳ llama-server の起動を待機中（最大{max_retries * retry_interval}秒）...")
        
        for attempt in range(max_retries):
            try:
                response = requests.get(f"{self.server_url}/health", timeout=2)
                if response.status_code == 200:
                    print(f"✅ llama-server が起動完了しました（{attempt * retry_interval:.1f}秒）")
                    return True
            except requests.exceptions.RequestException:
                pass
            
            # 進捗を表示（10秒ごと）
            if (attempt + 1) % 10 == 0:
                print(f"   まだ待機中... ({(attempt + 1) * retry_interval:.0f}秒経過)")
            
            time.sleep(retry_interval)
        
        print(f"❌ llama-server の起動がタイムアウトしました（{max_retries * retry_interval}秒以上待機）")
        return False
    
    def load(self) -> None:
        """llama-server への接続確認と自動起動"""
        if self.is_loaded:
            print("⚠️ モデルは既にロードされています")
            return
        
        print(f"📦 Qwen3-VL Server接続確認中: {self.server_url}")
        
        # 1. まず health check を試みる（既に起動しているかもしれない）
        try:
            response = requests.get(f"{self.server_url}/health", timeout=5)
            if response.status_code == 200:
                print(f"✅ llama-server は既に起動しています")
                self.health_checked = True
                self.is_loaded = True
                return
        except requests.exceptions.RequestException:
            pass
        
        # 2. まだ起動していない場合は自動起動
        if self.auto_start_server:
            print(f"ℹ️ llama-server がまだ起動していないため、自動起動を試みます...")
            
            success, error_detail = self._start_server()
            if not success:
                # エラー詳細を含めた詳しいエラーメッセージを生成
                error_msg = f"❌ llama-server の起動に失敗しました\n\n"
                
                # エラー詳細を追加
                if error_detail:
                    error_msg += f"失敗の原因: {error_detail}\n\n"
                
                # バイナリ未検出の場合
                if "バイナリ未検出" in (error_detail or ""):
                    error_msg += f"探索したパス:\n"
                    for path in getattr(self, '_searched_binary_paths', []):
                        error_msg += f"  - {path}\n"
                    error_msg += f"\n以下から Windows バイナリをダウンロードしてください:\n"
                    error_msg += f"https://github.com/ggerganov/llama.cpp/releases\n"
                
                # ポート競合の場合
                elif "ポート競合" in (error_detail or ""):
                    error_msg += f"既に起動しているプロセスを確認してください。\n"
                    if self._server_log_path:
                        error_msg += f"ログを確認: {self._server_log_path}\n"
                
                # 起動直後クラッシュの場合
                elif "起動直後クラッシュ" in (error_detail or ""):
                    if hasattr(self, '_server_log_path') and self._server_log_path:
                        error_msg += f"llama-server のログを確認してください:\n"
                        error_msg += f"  {self._server_log_path}\n\n"
                    error_msg += f"クラッシュ原因の可能性:\n"
                    error_msg += f"  - DLL ライブラリが見つからない\n"
                    error_msg += f"  - GPU ドライバが古い\n"
                    error_msg += f"  - メモリ不足\n"
                
                # 共通の確認項目
                error_msg += f"\n確認項目:\n"
                error_msg += f"1. モデルファイルが存在するか: {self.model_path}\n"
                error_msg += f"2. mmproj ファイルが存在するか: {self.mmproj_path}\n"
                error_msg += f"3. ポート {self.server_port} が利用可能か\n"
                error_msg += f"4. メモリが十分にあるか（最低 8GB 必要）\n"
                error_msg += f"5. Windows Defender や他のセキュリティソフトがブロックしていないか\n\n"
                error_msg += f"llama-server を手動で起動する場合:\n"
                error_msg += f"llama-server -m {self.model_path} --mmproj {self.mmproj_path} "
                error_msg += f"--host {self.server_host} --port {self.server_port}"
                
                raise RuntimeError(error_msg)
            
            # 起動待機
            if not self._wait_for_server():
                log_path_msg = ""
                if hasattr(self, '_server_log_path') and self._server_log_path:
                    log_path_msg = f"ログを確認: {self._server_log_path}\n\n"
                
                raise RuntimeError(
                    f"❌ llama-server が起動しません（タイムアウト）\n\n"
                    f"{log_path_msg}"
                    f"以下を確認してください:\n"
                    f"1. llama-server が実行中か（プロセスマネージャーで確認）\n"
                    f"2. GPU / CPU が十分にあるか\n"
                    f"3. メモリが十分にあるか（最低 8GB 必要）\n"
                    f"4. ディスクスペースが十分にあるか\n"
                    f"5. Windows Defender や他のセキュリティソフトがブロックしていないか\n"
                    f"6. モデルファイルのロード中にクラッシュしていないか\n"
                    f"\nllama-server を手動で起動する場合:\n"
                    f"llama-server -m {self.model_path} --mmproj {self.mmproj_path} "
                    f"--host {self.server_host} --port {self.server_port}"
                )
        else:
            # auto_start_server=False の場合は手動起動を指示
            raise RuntimeError(
                f"❌ llama-server に接続できません\n\n"
                f"auto_start_server=False のため自動起動がスキップされています\n"
                f"手動で llama-server を起動してください:\n\n"
                f"llama-server \\\n"
                f"  -m {self.model_path} \\\n"
                f"  --mmproj {self.mmproj_path} \\\n"
                f"  --host {self.server_host} --port {self.server_port}"
            )
        
        self.health_checked = True
        self.is_loaded = True
        print(f"✅ llama-server への接続が確立されました")
    
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
        """llama-server の接続をクローズ"""
        self.is_loaded = False
        self.health_checked = False
        print("🗑️ llama-server との接続をクローズしました")
        
        # 自前起動したサーバープロセスのみを停止
        if self.server_process and self.started_server_by_self:
            try:
                print(f"   🛑 llama-server を停止します (PID: {self.server_process.pid})")
                
                if os.name == 'nt':
                    # Windows: CTRL_BREAK_EVENT でプロセスグループを停止
                    os.kill(self.server_process.pid, signal.CTRL_BREAK_EVENT)
                else:
                    # Unix: プロセスグループを SIGTERM で停止
                    os.killpg(os.getpgid(self.server_process.pid), signal.SIGTERM)
                
                # プロセス終了を待つ（タイムアウト: 5秒）
                try:
                    self.server_process.wait(timeout=5)
                    print("   ✅ llama-server を停止しました")
                except subprocess.TimeoutExpired:
                    print("   ⚠️ llama-server の停止がタイムアウト、強制終了します")
                    self.server_process.kill()
                    self.server_process.wait()
                    
            except Exception as e:
                print(f"   ⚠️ llama-server 停止中にエラー: {e}")
        elif self.server_process and not self.started_server_by_self:
            print("   注: llama-server は外部で起動されています（停止しません）")
    
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
            'server_host': self.server_host,
            'server_port': self.server_port,
            'auto_start_server': self.auto_start_server,
            'type': 'qwen3_vl_server'
        }
