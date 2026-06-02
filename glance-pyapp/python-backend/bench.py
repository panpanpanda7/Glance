#!/usr/bin/env python3
"""
Glance ベンチマークCLI
======================
速度と精度のトレードオフを「画像ごとに目で見て」比較するための計測ツール。

test_images/ の各画像に対し、複数のパイプライン・バリアントを実行し、
TTFT(最初の一語までの時間)・総時間・トークン/秒・出力本文を計測する。
結果はコンソールの表 + ブラウザで開けるHTMLレポートに出力する。

バリアント:
  2pass      : 現行の2段階パイプライン(Phase1=画像→JSON, Phase2=JSON→文)。mmproj=Q8_0
  1pass      : 単段(画像→行動指針を直接生成・ストリーミング)。mmproj=Q8_0
  1pass_f16  : 単段だが mmproj=f16(高精度視覚プロジェクタ)。OCR精度の差分を見る

llama-server を自前で起動・停止する(mmproj差し替えのため)。
Mac/Linux/Windows のいずれでも、PATH上の llama-server を利用する。

使い方:
    python bench.py                          # 既定の全バリアントを実行
    python bench.py --variants 2pass 1pass   # バリアントを限定
    python bench.py --images Google画面.png  # 画像を限定
    python bench.py --no-open                # HTMLを自動で開かない
"""

import argparse
import base64
import html
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import requests
import yaml
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.yaml"
TEST_IMAGES_DIR = BASE_DIR / "test_images"
RESULTS_DIR = BASE_DIR / "bench_results"
MODELS_DIR = BASE_DIR / "models" / "gguf"

# 画像リサイズの上限(現行アプリの IMAGE_MAX_SIZE と同じ既定値)
DEFAULT_IMAGE_MAX_SIZE = 1120

# ベースラインモデル(Qwen3-VL-4B)
DEFAULT_MODEL = MODELS_DIR / "Qwen3VL-4B-Instruct-Q4_K_M.gguf"
MMPROJ_Q8 = MODELS_DIR / "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"
MMPROJ_F16 = MODELS_DIR / "mmproj-Qwen3VL-4B-Instruct-F16.gguf"
MMPROJ_F32 = MODELS_DIR / "mmproj-Qwen3VL-4B-Instruct-F32.gguf"
# F16 mmproj のダウンロード元(Qwen公式GGUFリポジトリ)。F32は配布が無く変換が必要。
MMPROJ_F16_URL = (
    "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/"
    "mmproj-Qwen3VL-4B-Instruct-F16.gguf?download=true"
)

SYSTEM_PROMPT = "視覚障害者向け画面説明アシスタントです。見えている内容のみを、日本語で説明してください。"

# バリアント定義: pipeline と必要な mmproj 種別
VARIANT_SPECS = {
    "2pass":     {"pipeline": "two_pass",    "mmproj": "q8",  "label": "2段階 (現行)"},
    "1pass":     {"pipeline": "single_pass", "mmproj": "q8",  "label": "単段 (mmproj Q8)"},
    "1pass_f16": {"pipeline": "single_pass", "mmproj": "f16", "label": "単段 + mmproj F16"},
    "1pass_f32": {"pipeline": "single_pass", "mmproj": "f32", "label": "単段 + mmproj F32"},
}


# ----------------------------------------------------------------------------
# llama-server ライフサイクル管理
# ----------------------------------------------------------------------------
class LlamaServer:
    """指定の (model, mmproj) で llama-server を起動・停止する"""

    def __init__(self, binary, model_path, mmproj_path, host="127.0.0.1",
                 port=8080, ctx_size=8192, n_gpu_layers=-1, threads=None):
        self.binary = binary
        self.model_path = str(model_path)
        self.mmproj_path = str(mmproj_path)
        self.host = host
        self.port = port
        self.ctx_size = ctx_size
        self.n_gpu_layers = n_gpu_layers  # 0 で CPU 専用（仕事PC想定）
        self.threads = threads            # CPU スレッド数（None でサーバー既定）
        self.url = f"http://{host}:{port}"
        self.proc = None

    def _port_free(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            return s.connect_ex((self.host, self.port)) != 0

    def start(self):
        if not self._port_free():
            raise RuntimeError(
                f"ポート {self.port} は既に使用中です。既存の llama-server を停止するか "
                f"--port で別ポートを指定してください。"
            )
        log_path = RESULTS_DIR / "llama-server.bench.log"
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.binary,
            "-m", self.model_path,
            "--mmproj", self.mmproj_path,
            "--host", self.host,
            "--port", str(self.port),
            "--ctx-size", str(self.ctx_size),
            "-ngl", str(self.n_gpu_layers),
        ]
        if self.threads:
            cmd += ["--threads", str(self.threads)]
        mode = "CPU専用" if self.n_gpu_layers == 0 else f"ngl={self.n_gpu_layers}"
        print(f"🚀 llama-server 起動 [{mode}"
              f"{', t=' + str(self.threads) if self.threads else ''}]: "
              f"{Path(self.model_path).name} + {Path(self.mmproj_path).name}")
        print(f"   ログ: {log_path}")
        logf = open(log_path, "a", encoding="utf-8")
        logf.write(f"\n\n===== {datetime.now()} : {' '.join(cmd)} =====\n")
        logf.flush()
        preexec = os.setsid if hasattr(os, "setsid") else None
        creationflags = (subprocess.CREATE_NEW_PROCESS_GROUP
                         if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP")
                         else 0)
        self.proc = subprocess.Popen(
            cmd, stdout=logf, stderr=logf,
            preexec_fn=preexec, creationflags=creationflags,
        )
        self._wait_ready(log_path)

    def _wait_ready(self, log_path, timeout=120):
        print("⏳ モデルロード待機中...", end="", flush=True)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                print()
                raise RuntimeError(
                    f"llama-server が起動直後に終了しました (code={self.proc.returncode})。"
                    f"ログを確認: {log_path}"
                )
            try:
                r = requests.get(f"{self.url}/health", timeout=2)
                if r.status_code == 200:
                    print(" 完了 ✅")
                    return
            except requests.exceptions.RequestException:
                pass
            print(".", end="", flush=True)
            time.sleep(1)
        print()
        raise RuntimeError(f"llama-server 起動タイムアウト。ログを確認: {log_path}")

    def stop(self):
        if not self.proc:
            return
        print("🛑 llama-server 停止...")
        try:
            if os.name == "nt":
                self.proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            self.proc.wait()
        self.proc = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()


# ----------------------------------------------------------------------------
# 推論呼び出し
# ----------------------------------------------------------------------------
def encode_image(path, max_size=DEFAULT_IMAGE_MAX_SIZE):
    """画像を(必要ならリサイズして)PNG base64 にエンコード"""
    img = Image.open(path)
    if max_size and max(img.size) > max_size:
        ratio = max_size / max(img.size)
        img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)),
                         Image.Resampling.LANCZOS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def chat_stream(url, messages, max_tokens, temperature=0.0, top_p=0.85,
                extra_payload=None):
    """
    /v1/chat/completions をストリーミングで叩き、
    (本文, TTFT秒, 生成時間秒, completion_tokens) を返す。
    TTFT = 最初のトークンが届くまでの時間(体感速度の指標)。
    extra_payload: 追加のペイロード(例: Gemma4の思考無効化 chat_template_kwargs)。
    """
    payload = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if extra_payload:
        payload.update(extra_payload)
    start = time.time()
    ttft = None
    text_parts = []
    completion_tokens = None
    resp = requests.post(f"{url}/v1/chat/completions", json=payload,
                         stream=True, timeout=600)
    resp.raise_for_status()
    for line in resp.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8") if isinstance(line, bytes) else line
        if not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str == "[DONE]":
            break
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        if data.get("usage"):
            completion_tokens = data["usage"].get("completion_tokens")
        choices = data.get("choices") or []
        if choices:
            content = choices[0].get("delta", {}).get("content", "")
            if content:
                if ttft is None:
                    ttft = time.time() - start
                text_parts.append(content)
    total = time.time() - start
    text = "".join(text_parts).strip()
    gen_time = max(total - (ttft or total), 1e-6)
    return text, (ttft or total), total, completion_tokens, gen_time


def build_image_message(prompt, image_b64):
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": [
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            {"type": "text", "text": prompt},
        ]},
    ]


def run_single_pass(url, image_b64, prompts, max_tokens):
    """単段: 画像 + 行動指針プロンプト → 文(ストリーミング)"""
    msgs = build_image_message(prompts["single_pass_summary"], image_b64)
    text, ttft, total, ctok, gen = chat_stream(url, msgs, max_tokens)
    tps = (ctok / gen) if ctok else None
    return {
        "output": text, "ttft": ttft, "total": total,
        "tokens": ctok, "tps": tps, "phase1": None,
    }


def run_two_pass(url, image_b64, prompts, max_tokens):
    """2段階: Phase1(画像→JSON, 非ストリーム計測) → Phase2(JSON→文, ストリーム)"""
    # --- Phase1: 構造化抽出 ---
    p1_msgs = build_image_message(prompts["phase1_extraction"], image_b64)
    p1_text, _, p1_total, _, _ = chat_stream(url, p1_msgs, max_tokens=300)
    # JSONを抽出(失敗してもPhase2へそのまま渡す)
    p1_clean = p1_text.strip()
    if p1_clean.startswith("```"):
        nl = p1_clean.find("\n")
        if nl != -1:
            p1_clean = p1_clean[nl + 1:]
        fence = p1_clean.rfind("```")
        if fence != -1:
            p1_clean = p1_clean[:fence]
    try:
        intermediate = json.loads(p1_clean.strip())
        json_str = json.dumps(intermediate, ensure_ascii=False, indent=2)
    except json.JSONDecodeError:
        json_str = p1_clean.strip()

    # --- Phase2: 自然文生成(画像なし) ---
    prompt = prompts["phase2_summary"].replace("{intermediate_json}", json_str)
    p2_msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    text, p2_ttft, p2_total, ctok, gen = chat_stream(url, p2_msgs, max_tokens)
    # 体感TTFT = Phase1完了 + Phase2の最初の一語まで
    perceived_ttft = p1_total + p2_ttft
    total = p1_total + p2_total
    tps = (ctok / gen) if ctok else None
    return {
        "output": text, "ttft": perceived_ttft, "total": total,
        "tokens": ctok, "tps": tps, "phase1": json_str,
    }


PIPELINES = {"single_pass": run_single_pass, "two_pass": run_two_pass}


# ----------------------------------------------------------------------------
# レポート出力
# ----------------------------------------------------------------------------
def print_console_table(results, variants):
    """コンソールに集計表を出力"""
    print("\n" + "=" * 78)
    print("📊 ベンチ結果 (TTFT=最初の一語まで / total=完了まで, 秒)")
    print("=" * 78)
    header = f"{'画像':<22}{'バリアント':<22}{'TTFT':>8}{'total':>9}{'tok/s':>8}{'文字':>7}"
    print(header)
    print("-" * 78)
    for img_name in results:
        for v in variants:
            r = results[img_name].get(v)
            if not r:
                continue
            if r.get("error"):
                print(f"{img_name[:20]:<22}{VARIANT_SPECS[v]['label'][:20]:<22}"
                      f"{'ERROR':>8}")
                continue
            tps = f"{r['tps']:.1f}" if r.get("tps") else "-"
            print(f"{img_name[:20]:<22}{VARIANT_SPECS[v]['label'][:20]:<22}"
                  f"{r['ttft']:>8.2f}{r['total']:>9.2f}{tps:>8}"
                  f"{len(r['output']):>7}")
    # バリアント別の平均
    print("-" * 78)
    print("【バリアント別 平均】")
    for v in variants:
        rs = [results[i][v] for i in results
              if v in results[i] and not results[i][v].get("error")]
        if not rs:
            continue
        avg_ttft = sum(r["ttft"] for r in rs) / len(rs)
        avg_total = sum(r["total"] for r in rs) / len(rs)
        print(f"  {VARIANT_SPECS[v]['label']:<24} "
              f"TTFT平均 {avg_ttft:6.2f}s  /  total平均 {avg_total:6.2f}s")
    print("=" * 78 + "\n")


def render_html(results, variants, meta, out_path):
    """画像と各バリアント出力を横並びにしたHTMLレポートを生成"""
    def esc(s):
        return html.escape(str(s))

    # サマリー(平均)
    summary_rows = []
    for v in variants:
        rs = [results[i][v] for i in results
              if v in results[i] and not results[i][v].get("error")]
        if not rs:
            continue
        avg_ttft = sum(r["ttft"] for r in rs) / len(rs)
        avg_total = sum(r["total"] for r in rs) / len(rs)
        tps_vals = [r["tps"] for r in rs if r.get("tps")]
        avg_tps = sum(tps_vals) / len(tps_vals) if tps_vals else None
        summary_rows.append(
            f"<tr><td>{esc(VARIANT_SPECS[v]['label'])}</td>"
            f"<td class='num'>{avg_ttft:.2f}</td>"
            f"<td class='num'>{avg_total:.2f}</td>"
            f"<td class='num'>{avg_tps:.1f}</td></tr>"
            if avg_tps else
            f"<tr><td>{esc(VARIANT_SPECS[v]['label'])}</td>"
            f"<td class='num'>{avg_ttft:.2f}</td>"
            f"<td class='num'>{avg_total:.2f}</td><td class='num'>-</td></tr>"
        )

    # 画像ごとのカード
    cards = []
    for img_name in results:
        img_b64 = meta["thumbs"].get(img_name, "")
        cols = []
        for v in variants:
            r = results[img_name].get(v)
            if not r:
                continue
            spec = VARIANT_SPECS[v]
            if r.get("error"):
                body = f"<div class='err'>ERROR: {esc(r['error'])}</div>"
                badges = ""
            else:
                tps = f"{r['tps']:.1f} tok/s" if r.get("tps") else "-"
                badges = (
                    f"<span class='badge ttft'>TTFT {r['ttft']:.2f}s</span>"
                    f"<span class='badge total'>total {r['total']:.2f}s</span>"
                    f"<span class='badge'>{tps}</span>"
                    f"<span class='badge'>{len(r['output'])}字</span>"
                )
                phase1 = ""
                if r.get("phase1"):
                    phase1 = (f"<details><summary>中間JSON(Phase1)</summary>"
                              f"<pre>{esc(r['phase1'])}</pre></details>")
                body = f"<div class='out'>{esc(r['output'])}</div>{phase1}"
            cols.append(
                f"<div class='col'><div class='vlabel'>{esc(spec['label'])}</div>"
                f"<div class='badges'>{badges}</div>{body}</div>"
            )
        cards.append(
            f"<div class='card'><h2>{esc(img_name)}</h2>"
            f"<div class='cardbody'>"
            f"<div class='imgwrap'><img src='data:image/png;base64,{img_b64}'/></div>"
            f"<div class='cols'>{''.join(cols)}</div>"
            f"</div></div>"
        )

    html_doc = f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<title>Glance ベンチ {esc(meta['timestamp'])}</title>
<style>
  body {{ font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 24px;
         background:#f6f7f9; color:#1d1d1f; }}
  h1 {{ font-size: 20px; }}
  .meta {{ color:#666; font-size:13px; margin-bottom:16px; }}
  table.summary {{ border-collapse: collapse; margin-bottom: 28px; background:#fff; }}
  table.summary th, table.summary td {{ border:1px solid #ddd; padding:6px 14px;
         font-size:13px; text-align:left; }}
  table.summary th {{ background:#eef; }}
  td.num {{ text-align:right; font-variant-numeric: tabular-nums; }}
  .card {{ background:#fff; border:1px solid #e3e3e6; border-radius:10px;
         padding:16px; margin-bottom:20px; }}
  .card h2 {{ font-size:15px; margin:0 0 12px; }}
  .cardbody {{ display:flex; gap:16px; align-items:flex-start; }}
  .imgwrap {{ flex:0 0 320px; }}
  .imgwrap img {{ width:320px; border:1px solid #ccc; border-radius:6px; }}
  .cols {{ display:flex; gap:12px; flex:1; flex-wrap:wrap; }}
  .col {{ flex:1 1 240px; min-width:240px; border:1px solid #eee; border-radius:8px;
         padding:10px; background:#fafafb; }}
  .vlabel {{ font-weight:600; font-size:13px; margin-bottom:6px; }}
  .badges {{ margin-bottom:8px; }}
  .badge {{ display:inline-block; font-size:11px; background:#eceff4; color:#333;
         border-radius:10px; padding:2px 8px; margin:0 4px 4px 0; }}
  .badge.ttft {{ background:#dff3e0; }}
  .badge.total {{ background:#fde9d9; }}
  .out {{ font-size:13px; line-height:1.6; white-space:pre-wrap; }}
  .err {{ color:#c00; font-size:13px; }}
  details {{ margin-top:8px; }}
  summary {{ cursor:pointer; font-size:12px; color:#666; }}
  pre {{ font-size:11px; background:#f0f0f3; padding:8px; border-radius:6px;
         overflow:auto; max-height:240px; }}
</style></head><body>
<h1>Glance ベンチマーク結果</h1>
<div class="meta">
  実行: {esc(meta['timestamp'])} ／ モデル: {esc(meta['model'])} ／
  画像上限: {esc(meta['image_max_size'])}px ／ max_tokens: {esc(meta['max_tokens'])}
</div>
<table class="summary">
  <tr><th>バリアント</th><th>TTFT平均(s)</th><th>total平均(s)</th><th>tok/s平均</th></tr>
  {''.join(summary_rows)}
</table>
{''.join(cards)}
</body></html>"""
    out_path.write_text(html_doc, encoding="utf-8")


def make_thumb(path, width=320):
    img = Image.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    ratio = width / img.size[0]
    img = img.resize((width, int(img.size[1] * ratio)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# ----------------------------------------------------------------------------
# メイン
# ----------------------------------------------------------------------------
def find_llama_server():
    return shutil.which("llama-server")


def main():
    ap = argparse.ArgumentParser(description="Glance 速度/精度ベンチマーク")
    ap.add_argument("--variants", nargs="+", default=list(VARIANT_SPECS),
                    choices=list(VARIANT_SPECS),
                    help="実行するバリアント (既定: 全部)")
    ap.add_argument("--images", nargs="+", default=None,
                    help="対象画像ファイル名 (既定: test_images/ 全部)")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--ctx-size", type=int, default=8192)
    ap.add_argument("--image-max-size", type=int, default=DEFAULT_IMAGE_MAX_SIZE)
    ap.add_argument("--max-tokens", type=int, default=200, help="出力文の最大トークン")
    ap.add_argument("--no-open", action="store_true", help="HTMLを自動で開かない")
    args = ap.parse_args()

    binary = find_llama_server()
    if not binary:
        sys.exit("❌ llama-server が見つかりません。PATHに通すか brew install llama.cpp してください。")

    if not Path(args.model).exists():
        sys.exit(f"❌ モデルが見つかりません: {args.model}")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    prompts = config["prompt"]

    # 対象画像
    if args.images:
        image_paths = [TEST_IMAGES_DIR / n for n in args.images]
    else:
        image_paths = sorted(
            p for p in TEST_IMAGES_DIR.iterdir()
            if p.suffix.lower() in (".png", ".jpg", ".jpeg")
        )
    image_paths = [p for p in image_paths if p.exists()]
    if not image_paths:
        sys.exit("❌ 対象画像がありません。")

    # バリアントを mmproj 種別でグループ化(サーバー再起動を最小化)
    variants = args.variants
    mmproj_files = {"q8": Path(MMPROJ_Q8), "f16": Path(MMPROJ_F16),
                    "f32": Path(MMPROJ_F32)}

    # 必要な mmproj ファイルが無いバリアントはスキップ
    hints = {
        "f16": f"    curl -L -o {MMPROJ_F16} \\\n      '{MMPROJ_F16_URL}'",
        "f32": "    F32は配布が無く、元モデルから convert_hf_to_gguf.py で変換が必要です。",
    }
    for kind in ("f16", "f32"):
        if any(VARIANT_SPECS[v]["mmproj"] == kind for v in variants) \
                and not mmproj_files[kind].exists():
            print(f"⚠️  {kind} mmproj が未取得のため該当バリアントをスキップします。")
            print(hints[kind] + "\n")
            variants = [v for v in variants if VARIANT_SPECS[v]["mmproj"] != kind]
    needed_mmproj = {VARIANT_SPECS[v]["mmproj"] for v in variants}
    if not variants:
        sys.exit("❌ 実行可能なバリアントがありません。")

    # 画像をエンコード(リサイズ後)+ サムネ
    print(f"🖼️  画像 {len(image_paths)} 枚をエンコード中...")
    encoded = {p.name: encode_image(p, args.image_max_size) for p in image_paths}
    thumbs = {p.name: make_thumb(p) for p in image_paths}

    results = {p.name: {} for p in image_paths}

    # mmproj グループごとにサーバーを立てて実行
    for mmproj_kind in ["q8", "f16", "f32"]:
        if mmproj_kind not in needed_mmproj:
            continue
        group_variants = [v for v in variants
                          if VARIANT_SPECS[v]["mmproj"] == mmproj_kind]
        with LlamaServer(binary, args.model, mmproj_files[mmproj_kind],
                         port=args.port, ctx_size=args.ctx_size) as server:
            # ウォームアップ(モデルを暖めて1回目の外れ値を防ぐ)
            print("🔥 ウォームアップ...")
            try:
                first_img = encoded[image_paths[0].name]
                chat_stream(server.url,
                            build_image_message("画面を一言で。", first_img),
                            max_tokens=8)
            except Exception as e:
                print(f"   ウォームアップ警告: {e}")

            for img_path in image_paths:
                name = img_path.name
                img_b64 = encoded[name]
                for v in group_variants:
                    spec = VARIANT_SPECS[v]
                    print(f"▶️  {name} / {spec['label']} ...", end="", flush=True)
                    try:
                        fn = PIPELINES[spec["pipeline"]]
                        r = fn(server.url, img_b64, prompts, args.max_tokens)
                        results[name][v] = r
                        print(f" ttft={r['ttft']:.2f}s total={r['total']:.2f}s")
                    except Exception as e:
                        results[name][v] = {"error": str(e), "output": ""}
                        print(f" ERROR: {e}")

    # 出力
    print_console_table(results, variants)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    meta = {
        "timestamp": ts,
        "model": Path(args.model).name,
        "image_max_size": args.image_max_size,
        "max_tokens": args.max_tokens,
        "thumbs": thumbs,
    }
    # JSON(サムネは除外して保存)
    json_path = RESULTS_DIR / f"bench_{ts}.json"
    dump = {"meta": {k: v for k, v in meta.items() if k != "thumbs"},
            "variants": variants, "results": results}
    json_path.write_text(json.dumps(dump, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    html_path = RESULTS_DIR / f"bench_{ts}.html"
    render_html(results, variants, meta, html_path)
    print(f"📄 HTMLレポート: {html_path}")
    print(f"📄 JSON:        {json_path}")

    if not args.no_open:
        webbrowser.open(f"file://{html_path}")


if __name__ == "__main__":
    main()
