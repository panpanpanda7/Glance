"""
ポートの割り当てと、前回の Glance が残したプロセスの片付け

方針:
- 使うポートは「保存してあるポート（なければ既定のポート）」から試す。
- 起動のたびに、前回の Glance が残した llama-server を先に止める。
  残りがポートを塞いでいても、止めてからそのポートを使う。
  残りを理由に別のポートへ移ると、残ったプロセスがメモリを抱えたまま
  放置されるため。
- 関係のない別のソフトが使っているときだけ、別のポートへ移る。
  移った先のポートは保存し、次の起動からもそのポートを使う。その別のソフトは
  たいてい常駐するか、また起動されるので、毎回既定のポートから試すと、
  Glance が先に起動した日に相手のポートを奪ってしまう。
- 移る先は、OS が通信に一時的に割り当てる範囲（49152 以上など）の外から選ぶ。
  その範囲の番号を保存して使い続けると、ブラウザなどの通信といつか重なる。
"""

import json
import os
import random
import socket
import time

# 移る先のポートを選ぶ範囲。OS が通信に一時的に割り当てる範囲
# （Windows・macOS は 49152〜65535、Linux は既定で 32768〜60999）より下にする
PERSISTENT_PORT_RANGE = (20000, 30000)

# 移った先のポートを保存するファイル（モデルフォルダに置く）
SAVED_PORTS_FILE = "ports.json"


def is_port_in_use(host: str, port: int) -> bool:
    """
    そのポートで何かが接続を受け付けているか

    bind ではなく connect で調べる。Windows では、他のソフトが 0.0.0.0 で
    待ち受けているポートにも 127.0.0.1 で bind できてしまうことがあり、
    bind の成否では「誰も使っていない」と判断できないため。
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            return s.connect_ex((host, port)) == 0
    except OSError:
        return False


def find_free_port(host: str = "127.0.0.1") -> int:
    """OS に空いているポートを割り当ててもらう"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def find_persistent_port(host: str = "127.0.0.1", attempts: int = 100) -> int:
    """
    保存して使い続けるためのポートを選ぶ

    PERSISTENT_PORT_RANGE から、接続を受け付けておらず、実際に待ち受けられる
    番号を選ぶ。見つからなければ OS に割り当ててもらう。
    """
    low, high = PERSISTENT_PORT_RANGE
    for _ in range(attempts):
        port = random.randrange(low, high)
        if is_port_in_use(host, port):
            continue
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((host, port))
            return port
        except OSError:
            continue
    return find_free_port(host)


def load_saved_port(models_dir: str, key: str):
    """保存してあるポートを返す。なければ None"""
    try:
        with open(os.path.join(models_dir, SAVED_PORTS_FILE), "r", encoding="utf-8") as f:
            port = json.load(f).get(key)
        return int(port) if port else None
    except Exception:
        return None


def save_port(models_dir: str, key: str, port: int) -> None:
    """移った先のポートを保存する。次の起動からはこのポートを最初に試す"""
    path = os.path.join(models_dir, SAVED_PORTS_FILE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    data[key] = port
    try:
        os.makedirs(models_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _is_orphan(proc) -> bool:
    """親プロセスが既に終了しているか（＝前回の Glance が残したものか）"""
    try:
        parent = proc.parent()
    except Exception:
        return True
    if parent is None:
        return True
    # macOS / Linux では、親が終了した子は PID 1（launchd / init）に引き取られる
    return parent.pid == 1


def find_leftover_llama_servers(models_dir: str) -> list:
    """
    前回の Glance が残した llama-server を探す

    次の両方を満たすものだけを対象にする。
    - このアプリのモデルフォルダのモデルを読み込んでいる
    - 起動したバックエンドが既に終了している（親がいない）
    親が生きているもの（開発中に bench.py が起動したものなど）は止めない。
    """
    try:
        import psutil
    except ImportError:
        return []

    models_dir = os.path.normcase(os.path.abspath(models_dir))
    found = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (proc.info.get("name") or "").lower()
            if not name.startswith("llama-server"):
                continue
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if models_dir not in os.path.normcase(cmdline):
                continue
            if not _is_orphan(proc):
                continue
            found.append(proc)
        except Exception:
            continue
    return found


def stop_leftover_llama_servers(models_dir: str, log=print) -> int:
    """前回の Glance が残した llama-server を止める。止めた数を返す"""
    leftovers = find_leftover_llama_servers(models_dir)
    if not leftovers:
        return 0
    try:
        import psutil
    except ImportError:
        return 0

    for proc in leftovers:
        log(f"   🧹 前回の Glance が残した llama-server を停止します (PID {proc.pid})")
        try:
            proc.terminate()
        except Exception:
            pass
    _, alive = psutil.wait_procs(leftovers, timeout=5)
    for proc in alive:
        try:
            proc.kill()
        except Exception:
            pass
    psutil.wait_procs(alive, timeout=3)
    return len(leftovers)


def resolve_port(host: str, preferred: int, wait_seconds: float = 0.0, log=print) -> int:
    """
    使うポートを決める

    preferred（保存してあるポート、なければ既定のポート）が空いていればそれを使う。
    前回の残りを止めた直後は、ポートが解放されるまで wait_seconds だけ待つ。
    それでも塞がっていれば、別のソフトが使っているとみなし、別のポートを選ぶ。
    移った先を保存するのは呼び出し側（save_port）。
    """
    deadline = time.time() + wait_seconds
    while True:
        if not is_port_in_use(host, preferred):
            return preferred
        if time.time() >= deadline:
            break
        time.sleep(0.2)

    port = find_persistent_port(host)
    log(f"   ℹ️ ポート {preferred} は別のソフトが使用中のため、ポート {port} を使います")
    return port
