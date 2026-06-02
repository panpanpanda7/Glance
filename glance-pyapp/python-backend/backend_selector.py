"""
バックエンド自動選定（速度プローブ方式 / Option B）
=====================================================
起動時に GPU(-ngl 99) と CPU(-ngl 0) でそれぞれ短い推論を実測し、
「実際に速い方」を採用する。結果はマシン単位でキャッシュし、以降の起動は即時。

- 単なる対応/非対応判定ではなく「速いか」で決めるため、弱いiGPUでCPUより
  遅くなる罠を回避できる（= 遅くならないことを保証）。
- GPU側が起動失敗/クラッシュ/タイムアウトした場合は自動的に CPU を採用。
- mode='gpu'/'cpu' で手動上書き可能。

このモジュールは「どの -ngl で本番サーバーを起動するか」を返すだけで、
本番サーバー自体は呼び出し側（Qwen3VLServerModel）が起動する。
"""

import os
import io
import json
import time
import socket
import signal
import base64
import hashlib
import platform
import subprocess
from pathlib import Path

import requests
from PIL import Image

GPU_NGL = 99            # 全レイヤーをGPUへ（収まらなければllama.cpp側で調整/失敗）
CPU_NGL = 0
PROBE_CTX = 2048
PROBE_MAX_TOKENS = 24
CACHE_VERSION = 1


def _machine_signature() -> str:
    """ハード/OSが変わったら再判定するためのキー"""
    raw = f"{platform.system()}|{platform.release()}|{platform.machine()}|{platform.processor()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _synthetic_image_b64(w: int = 896, h: int = 504) -> str:
    """プローブ用の合成画像（視覚トークン数は解像度で決まるので内容は単純でよい）"""
    img = Image.new("RGB", (w, h), (250, 250, 250))
    px = img.load()
    for x in range(0, w, 32):
        for y in range(0, h, 32):
            px[x, y] = (10, 10, 10)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) != 0


def _probe(binary, model_path, mmproj_path, ngl, host, port, log_dir,
           threads=None, timeout=120, log=print):
    """
    指定 ngl で llama-server を一時起動し、合成画像で1回推論して所要秒を返す。
    起動失敗/クラッシュ/タイムアウト時は None。
    """
    if not _port_free(host, port):
        log(f"   [probe] ポート {port} 使用中のためスキップ")
        return None

    cmd = [
        str(binary), "-m", str(model_path), "--mmproj", str(mmproj_path),
        "--host", host, "--port", str(port), "--ctx-size", str(PROBE_CTX),
        "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-ngl", str(ngl),
    ]
    if threads:
        cmd += ["-t", str(threads)]

    os.makedirs(log_dir, exist_ok=True)
    logf = open(os.path.join(log_dir, "backend-probe.log"), "a", encoding="utf-8")
    logf.write(f"\n\n===== probe ngl={ngl} {time.ctime()} =====\n")
    logf.flush()

    preexec = os.setsid if hasattr(os, "setsid") else None
    creationflags = (subprocess.CREATE_NEW_PROCESS_GROUP
                     if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP")
                     else 0)
    proc = subprocess.Popen(cmd, stdout=logf, stderr=logf,
                            preexec_fn=preexec, creationflags=creationflags)

    def _kill():
        try:
            if os.name == "nt":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill(); proc.wait()
            except Exception:
                pass

    try:
        # health 待ち（起動直後クラッシュは poll で検知）
        deadline = time.time() + timeout
        ready = False
        url = f"http://{host}:{port}"
        while time.time() < deadline:
            if proc.poll() is not None:
                log(f"   [probe ngl={ngl}] 起動直後に終了 (code={proc.returncode})")
                return None
            try:
                if requests.get(f"{url}/health", timeout=2).status_code == 200:
                    ready = True
                    break
            except requests.exceptions.RequestException:
                pass
            time.sleep(1)
        if not ready:
            log(f"   [probe ngl={ngl}] 起動タイムアウト")
            return None

        # 計測（合成画像 + 短い生成）
        payload = {
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url":
                    {"url": f"data:image/png;base64,{_synthetic_image_b64()}"}},
                {"type": "text", "text": "この画面を1文で。"}]}],
            "max_tokens": PROBE_MAX_TOKENS, "temperature": 0.0, "stream": False,
        }
        t0 = time.time()
        r = requests.post(f"{url}/v1/chat/completions", json=payload, timeout=timeout)
        r.raise_for_status()
        elapsed = time.time() - t0
        log(f"   [probe ngl={ngl}] {elapsed:.2f}s")
        return elapsed
    except Exception as e:
        log(f"   [probe ngl={ngl}] 失敗: {e}")
        return None
    finally:
        _kill()


def _load_cache(cache_path):
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(cache_path, data):
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def force_backend(cache_dir, ngl, reason="forced"):
    """このマシンの判定を強制上書き（例: GPU起動失敗時にCPUを記憶）"""
    cache_path = os.path.join(cache_dir, "backend_cache.json")
    cache = _load_cache(cache_path)
    cache[_machine_signature()] = {
        "version": CACHE_VERSION, "ngl": ngl,
        "gpu_time": None, "cpu_time": None, "ts": time.time(), "reason": reason,
    }
    _save_cache(cache_path, cache)


def select_backend(binary, model_path, mmproj_path, *, mode="auto",
                   cache_dir, host="127.0.0.1", probe_port=8099,
                   threads=None, log=print):
    """
    使用すべき n_gpu_layers を決める。
    戻り値: {"ngl": int, "source": str, "gpu_time": float|None, "cpu_time": float|None}
    """
    mode = (mode or "auto").lower()
    if mode == "cpu":
        return {"ngl": CPU_NGL, "source": "override-cpu", "gpu_time": None, "cpu_time": None}
    if mode == "gpu":
        return {"ngl": GPU_NGL, "source": "override-gpu", "gpu_time": None, "cpu_time": None}

    # mode == auto
    cache_path = os.path.join(cache_dir, "backend_cache.json")
    sig = _machine_signature()
    cache = _load_cache(cache_path)
    cached = cache.get(sig)
    if cached and cached.get("version") == CACHE_VERSION:
        log(f"🧭 バックエンド判定: キャッシュ採用 ngl={cached['ngl']} "
            f"(gpu={cached.get('gpu_time')}, cpu={cached.get('cpu_time')})")
        return {"ngl": cached["ngl"], "source": "cache",
                "gpu_time": cached.get("gpu_time"), "cpu_time": cached.get("cpu_time")}

    log("🧭 バックエンド速度プローブを実行（初回のみ・以降キャッシュ）...")
    gpu_t = _probe(binary, model_path, mmproj_path, GPU_NGL, host, probe_port,
                   cache_dir, threads=threads, log=log)
    cpu_t = _probe(binary, model_path, mmproj_path, CPU_NGL, host, probe_port,
                   cache_dir, threads=threads, log=log)

    if gpu_t is None:
        ngl, source = CPU_NGL, "auto-gpu-unavailable"
    elif cpu_t is None:
        ngl, source = GPU_NGL, "auto-cpu-failed"
    else:
        # GPUが有意に速い場合のみGPU採用（5%マージンでフラつき防止）
        ngl = GPU_NGL if gpu_t < cpu_t * 0.95 else CPU_NGL
        source = "auto-probed"

    log(f"🧭 バックエンド判定: ngl={ngl} ({source}) gpu={gpu_t} cpu={cpu_t}")
    cache[sig] = {"version": CACHE_VERSION, "ngl": ngl,
                  "gpu_time": gpu_t, "cpu_time": cpu_t, "ts": time.time()}
    _save_cache(cache_path, cache)
    return {"ngl": ngl, "source": source, "gpu_time": gpu_t, "cpu_time": cpu_t}
