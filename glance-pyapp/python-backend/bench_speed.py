#!/usr/bin/env python3
"""
Glance 速度レバー検証ベンチ（OFAT: 一度に1レバー）
====================================================
単段(Cmd+G)パイプラインを対象に、速度に効く各レバーの寄与を切り分けて計測する。
ベースライン(4B / 1120px / max_tokens=200 / ctx4096)から1要素ずつ変えて比較する。

レバー:
  - 解像度 (image_max_size): 視覚トークン数 = prefill = TTFT に直結（クライアント側）
  - 出力長 (max_tokens):     total を短縮（クライアント側）
  - モデル (4B / 2B):        per-token 速度（サーバー再起動）
  - ctx_size:                主に低RAM機のメモリ（サーバー再起動）

共通部品は bench.py から再利用。llama-server を構成ごとに自前起動・停止する。

使い方:
    python bench_speed.py                 # 既定の7トライアル × 代表4画像
    python bench_speed.py --images A.png   # 画像限定
    python bench_speed.py --no-open
"""

import argparse
import html
import json
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import yaml
import bench  # 同ディレクトリの bench.py を再利用
from bench import (LlamaServer, chat_stream, build_image_message, encode_image,
                   make_thumb, find_llama_server, MODELS_DIR, RESULTS_DIR,
                   CONFIG_PATH, TEST_IMAGES_DIR)

MODEL_4B = MODELS_DIR / "Qwen3VL-4B-Instruct-Q4_K_M.gguf"
MMPROJ_4B = MODELS_DIR / "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"
MODEL_2B = MODELS_DIR / "Qwen3VL-2B-Instruct-Q4_K_M.gguf"
MMPROJ_2B = MODELS_DIR / "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"

# モデル対決(shootout)用の候補。ファイルが無いものは自動スキップ。
GEMMA4_MODEL = MODELS_DIR / "gemma-4-E4B-it-Q4_K_M.gguf"
GEMMA4_MMPROJ = MODELS_DIR / "mmproj-gemma-4-E4B-it-Q8_0.gguf"
QWEN35_MODEL = MODELS_DIR / "Qwen3.5-VL-4B-Instruct-Q4_K_M.gguf"
QWEN35_MMPROJ = MODELS_DIR / "mmproj-Qwen3.5-VL-4B-Instruct-Q8_0.gguf"


def build_shootout_trials(mt):
    """モデル対決: 同条件(896px/同プロンプト/同max_tokens)で各モデルを比較"""
    return [
        ("qwen3vl_4b",  "Qwen3-VL-4B/896",  MODEL_4B,     MMPROJ_4B,     4096, 896, mt),
        ("gemma4_e4b",  "Gemma4-E4B/896",   GEMMA4_MODEL,  GEMMA4_MMPROJ, 4096, 896, mt),
        ("qwen35vl_4b", "Qwen3.5-VL-4B/896", QWEN35_MODEL, QWEN35_MMPROJ, 4096, 896, mt),
    ]

DEFAULT_IMAGES = ["Google検索画面.png", "Teams画面.png",
                  "VSCode編集画面.png", "グラフ(総人口).png"]

# トライアル定義（OFAT）。server = (model, mmproj, ctx) が同じものは1サーバーで回す。
TRIALS = [
    # id,           label,                model, mmproj, ctx,  res,  max_tokens
    ("baseline",    "ベースライン(4B/1120/200/ctx4096)", MODEL_4B, MMPROJ_4B, 4096, 1120, 200),
    ("res_896",     "解像度896",          MODEL_4B, MMPROJ_4B, 4096,  896, 200),
    ("res_672",     "解像度672",          MODEL_4B, MMPROJ_4B, 4096,  672, 200),
    ("tok_120",     "出力120tok",         MODEL_4B, MMPROJ_4B, 4096, 1120, 120),
    ("ctx_2048",    "ctx2048",            MODEL_4B, MMPROJ_4B, 2048, 1120, 200),
    ("model_2b",    "2B/1120",            MODEL_2B, MMPROJ_2B, 4096, 1120, 200),
    ("fast_2b_672", "2B/672/120(最速狙い)", MODEL_2B, MMPROJ_2B, 4096,  672, 120),
]


def build_cpu_trials(mt):
    """仕事PC想定(CPU専用)の検証セット: 4B vs 2B × 解像度896/672"""
    return [
        ("4b_896", "4B/896", MODEL_4B, MMPROJ_4B, 4096, 896, mt),
        ("4b_672", "4B/672", MODEL_4B, MMPROJ_4B, 4096, 672, mt),
        ("2b_896", "2B/896", MODEL_2B, MMPROJ_2B, 4096, 896, mt),
        ("2b_672", "2B/672", MODEL_2B, MMPROJ_2B, 4096, 672, mt),
    ]

CPU_DEFAULT_IMAGES = ["Google検索画面.png", "VSCode編集画面.png"]


def server_key(t):
    return (str(t[2]), str(t[3]), t[4])  # (model, mmproj, ctx)


def main():
    global TRIALS
    ap = argparse.ArgumentParser(description="Glance 速度レバー検証ベンチ(OFAT)")
    ap.add_argument("--images", nargs="+", default=None)
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--cpu", action="store_true",
                    help="CPU専用(-ngl 0)で測定。仕事PC(GPU無し)想定")
    ap.add_argument("--threads", type=int, default=None,
                    help="CPUスレッド数(既定: 物理コア数)")
    ap.add_argument("--max-tokens", type=int, default=150,
                    help="出力上限(本番既定=150)")
    ap.add_argument("--shootout", action="store_true",
                    help="モデル対決(Qwen3-VL-4B vs Gemma4 vs 新Qwen, 同条件)")
    args = ap.parse_args()

    # CPUモード: 物理コア数・GPU無効
    n_gpu_layers = 0 if args.cpu else -1
    threads = args.threads
    if args.cpu:
        if threads is None:
            try:
                import psutil
                threads = psutil.cpu_count(logical=False) or 4
            except Exception:
                threads = 4
        print(f"🖥️  CPU専用モード: -ngl 0, threads={threads}, max_tokens={args.max_tokens}")

    # トライアルセットと既定画像の選択
    if args.shootout:
        TRIALS = build_shootout_trials(args.max_tokens)
        default_images = DEFAULT_IMAGES
    elif args.cpu:
        TRIALS = build_cpu_trials(args.max_tokens)
        default_images = CPU_DEFAULT_IMAGES
    else:
        default_images = DEFAULT_IMAGES
    images = args.images or default_images

    binary = find_llama_server()
    if not binary:
        sys.exit("❌ llama-server が見つかりません。")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    prompt = config["prompt"]["single_pass_summary"]

    # 各トライアルの必要ファイルを確認し、未取得のものはスキップ
    avail = []
    for t in TRIALS:
        if Path(t[2]).exists() and Path(t[3]).exists():
            avail.append(t)
        else:
            print(f"⚠️ スキップ {t[1]}: モデル/ mmproj 未取得")
    TRIALS = avail
    if not TRIALS:
        sys.exit("❌ 実行可能なトライアルがありません(ファイル未取得)。")

    image_paths = [TEST_IMAGES_DIR / n for n in images if (TEST_IMAGES_DIR / n).exists()]
    if not image_paths:
        sys.exit("❌ 対象画像なし。")

    # 画像を解像度ごとにエンコード（必要な解像度のみ）
    needed_res = sorted({t[5] for t in TRIALS})
    print(f"🖼️  画像 {len(image_paths)} 枚 × 解像度 {needed_res} をエンコード中...")
    enc = {}  # (name, res) -> b64
    thumbs = {}
    for p in image_paths:
        for res in needed_res:
            enc[(p.name, res)] = encode_image(p, res)
        thumbs[p.name] = make_thumb(p)

    # results[trial_id][image_name] = {...}
    results = {t[0]: {} for t in TRIALS}

    # サーバー構成ごとにグループ化
    groups = {}
    for t in TRIALS:
        groups.setdefault(server_key(t), []).append(t)

    for (model, mmproj, ctx), trials in groups.items():
        # Gemma4 は既定が思考モードのため無効化（短い回答を直接出させる）
        extra = ({"chat_template_kwargs": {"enable_thinking": False}}
                 if "gemma" in str(model).lower() else None)
        with LlamaServer(binary, model, mmproj, port=args.port, ctx_size=ctx,
                         n_gpu_layers=n_gpu_layers, threads=threads) as server:
            # ウォームアップ
            try:
                w = enc[(image_paths[0].name, trials[0][5])]
                chat_stream(server.url, build_image_message("一言で。", w),
                            max_tokens=8, extra_payload=extra)
            except Exception as e:
                print(f"   ウォームアップ警告: {e}")
            for p in image_paths:
                for t in trials:
                    tid, label, _, _, _, res, mt = t
                    img_b64 = enc[(p.name, res)]
                    print(f"▶️  {p.name} / {label} ...", end="", flush=True)
                    try:
                        text, ttft, total, ctok, gen = chat_stream(
                            server.url, build_image_message(prompt, img_b64),
                            max_tokens=mt, extra_payload=extra)
                        tps = (ctok / gen) if ctok else None
                        results[tid][p.name] = {
                            "output": text, "ttft": ttft, "total": total,
                            "tps": tps, "tokens": ctok}
                        print(f" ttft={ttft:.2f}s total={total:.2f}s")
                    except Exception as e:
                        results[tid][p.name] = {"error": str(e), "output": ""}
                        print(f" ERROR: {e}")

    # 集計
    def avg(tid, key):
        vals = [r[key] for r in results[tid].values()
                if not r.get("error") and r.get(key) is not None]
        return sum(vals) / len(vals) if vals else None

    base_id = TRIALS[0][0]
    base_ttft = avg(base_id, "ttft")
    base_total = avg(base_id, "total")

    print("\n" + "=" * 84)
    print("📊 速度レバー検証 (単段, 平均 / ベースライン比)")
    print("=" * 84)
    print(f"{'トライアル':<28}{'TTFT':>8}{'Δ':>8}{'total':>9}{'Δ':>8}{'tok/s':>8}")
    print("-" * 84)
    for t in TRIALS:
        tid, label = t[0], t[1]
        at, ato, ats = avg(tid, "ttft"), avg(tid, "total"), avg(tid, "tps")
        if at is None:
            print(f"{label[:26]:<28}{'ERROR':>8}")
            continue
        dt = f"{(at-base_ttft)/base_ttft*100:+.0f}%" if base_ttft else "-"
        do = f"{(ato-base_total)/base_total*100:+.0f}%" if base_total else "-"
        ts = f"{ats:.1f}" if ats else "-"
        print(f"{label[:26]:<28}{at:>8.2f}{dt:>8}{ato:>9.2f}{do:>8}{ts:>8}")
    print("=" * 84 + "\n")

    # HTML
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = RESULTS_DIR / f"bench_speed_{ts}.html"
    render_html(results, thumbs, base_ttft, base_total, ts, out)
    (RESULTS_DIR / f"bench_speed_{ts}.json").write_text(
        json.dumps({"results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"📄 HTMLレポート: {out}")
    if not args.no_open:
        webbrowser.open(f"file://{out}")


def render_html(results, thumbs, base_ttft, base_total, ts, out_path):
    def esc(s):
        return html.escape(str(s))

    def avg(tid, key):
        vals = [r[key] for r in results[tid].values()
                if not r.get("error") and r.get(key) is not None]
        return sum(vals) / len(vals) if vals else None

    # サマリー
    rows = []
    for t in TRIALS:
        tid, label = t[0], t[1]
        at, ato, ats = avg(tid, "ttft"), avg(tid, "total"), avg(tid, "tps")
        if at is None:
            rows.append(f"<tr><td>{esc(label)}</td><td colspan=5 class='err'>ERROR</td></tr>")
            continue
        dt = f"{(at-base_ttft)/base_ttft*100:+.0f}%" if base_ttft else "-"
        do = f"{(ato-base_total)/base_total*100:+.0f}%" if base_total else "-"
        hl = " class='base'" if tid == TRIALS[0][0] else ""
        rows.append(
            f"<tr{hl}><td>{esc(label)}</td>"
            f"<td class='num'>{at:.2f}</td><td class='num d'>{dt}</td>"
            f"<td class='num'>{ato:.2f}</td><td class='num d'>{do}</td>"
            f"<td class='num'>{ats:.1f}</td></tr>" if ats else
            f"<tr{hl}><td>{esc(label)}</td>"
            f"<td class='num'>{at:.2f}</td><td class='num d'>{dt}</td>"
            f"<td class='num'>{ato:.2f}</td><td class='num d'>{do}</td><td>-</td></tr>")

    # 画像ごとに全トライアルの出力を並べる（品質確認用）
    img_names = list(thumbs)
    cards = []
    for name in img_names:
        cols = []
        for t in TRIALS:
            tid, label = t[0], t[1]
            r = results[tid].get(name, {})
            if r.get("error"):
                body = f"<div class='err'>ERROR</div>"
                badge = ""
            else:
                badge = (f"<span class='badge ttft'>TTFT {r['ttft']:.2f}s</span>"
                         f"<span class='badge total'>total {r['total']:.2f}s</span>"
                         f"<span class='badge'>{len(r.get('output',''))}字</span>")
                body = f"<div class='out'>{esc(r.get('output',''))}</div>"
            cols.append(f"<div class='col'><div class='vlabel'>{esc(label)}</div>"
                        f"<div class='badges'>{badge}</div>{body}</div>")
        cards.append(f"<div class='card'><h2>{esc(name)}</h2>"
                     f"<div class='cardbody'>"
                     f"<div class='imgwrap'><img src='data:image/png;base64,{thumbs[name]}'/></div>"
                     f"<div class='cols'>{''.join(cols)}</div></div></div>")

    doc = f"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>Glance 速度レバー検証 {esc(ts)}</title><style>
 body{{font-family:-apple-system,"Hiragino Sans",sans-serif;margin:24px;background:#f6f7f9;color:#1d1d1f}}
 h1{{font-size:20px}} .meta{{color:#666;font-size:13px;margin-bottom:16px}}
 table.summary{{border-collapse:collapse;margin-bottom:28px;background:#fff}}
 table.summary th,table.summary td{{border:1px solid #ddd;padding:6px 14px;font-size:13px;text-align:left}}
 table.summary th{{background:#eef}} tr.base{{background:#fffbe6}}
 td.num{{text-align:right;font-variant-numeric:tabular-nums}} td.d{{color:#888;font-size:12px}}
 .card{{background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:16px;margin-bottom:20px}}
 .card h2{{font-size:15px;margin:0 0 12px}}
 .cardbody{{display:flex;gap:16px;align-items:flex-start}}
 .imgwrap{{flex:0 0 260px}} .imgwrap img{{width:260px;border:1px solid #ccc;border-radius:6px}}
 .cols{{display:flex;gap:10px;flex:1;flex-wrap:wrap}}
 .col{{flex:1 1 200px;min-width:200px;border:1px solid #eee;border-radius:8px;padding:8px;background:#fafafb}}
 .vlabel{{font-weight:600;font-size:12px;margin-bottom:6px}} .badges{{margin-bottom:6px}}
 .badge{{display:inline-block;font-size:10px;background:#eceff4;border-radius:10px;padding:2px 7px;margin:0 3px 3px 0}}
 .badge.ttft{{background:#dff3e0}} .badge.total{{background:#fde9d9}}
 .out{{font-size:12px;line-height:1.55;white-space:pre-wrap}} .err{{color:#c00;font-size:12px}}
</style></head><body>
<h1>Glance 速度レバー検証(単段 / OFAT)</h1>
<div class="meta">実行 {esc(ts)} ／ ベースライン=4B・1120px・200tok・ctx4096 ／ Δはベースライン比</div>
<table class="summary">
<tr><th>トライアル</th><th>TTFT平均(s)</th><th>Δ</th><th>total平均(s)</th><th>Δ</th><th>tok/s</th></tr>
{''.join(rows)}
</table>
{''.join(cards)}
</body></html>"""
    out_path.write_text(doc, encoding="utf-8")


if __name__ == "__main__":
    main()
