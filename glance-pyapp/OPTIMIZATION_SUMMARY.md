# Glance 高速化・最適化まとめ

視覚障害者向け画面説明アプリ（ローカル駆動VLM）の速度/精度改善の記録。
前提: **CPU駆動中心・低スペック仕事PC・クラウド不可・llama.cpp(GGUF)・日本語画面OCR**。
ベースライン: **Qwen3-VL-4B (Q4_K_M 2.3GB) + mmproj Q8**。

> 効果値は dev機(Apple M2 / Metal)の実測。絶対値はマシン依存だが、相対傾向と無損失性は移植可能。

---

## ✅ 実施済み(検証済み)

### A. アーキテクチャ（最大効果）
- **単段化(Cmd+G)**: 画像→JSON→文 の2段階を廃し、画像→要点を1パス生成。第一声 **約11倍**・total **約3倍**。
- **単段化(Cmd+D/質問) (2026-06-11)**: detailed/question も単段化し全タイプ統一。detailed実測(M2/Metal/896): 体感TTFT **16〜17s→1.4s(約12倍)**・total **約-57%**(生成トークン~470→~235)。画像を見ながら書くため具体性も向上(2段階は第2段階が画像を見ず情報欠落)。プロンプトは `single_pass_detailed`。
- **question経路のバグ修正 (2026-06-11)**: 旧2段階の questionPrompt には `{intermediate_json}` プレースホルダが無く、**画面情報ゼロで質問だけがモデルに渡っていた**(回答は常に「読み取れません」系)。単段化(画像+質問を直接)で解消。
- **ストリーミング配線**: アプリをブロッキング `/analyze` → `/analyze-stream` に。文単位で逐次表示。第1文が **+5.3s**(旧は完了まで無表示の7.5s)。第一トークンで継続音停止。CPU機ほど体感効果大。

### B. プロンプト/出力量
- **短文化**: 3〜5文→2〜3文 + max_tokens 200→150。total **約-34%**・尻切れなし。
- **detailed短縮 (2026-06-11)**: 単段化に合わせ maxTokens.detailed 400→350(5〜7文設計、実測220〜260tokで自然完結)。
- **プロンプト再設計**: 「まず何の画面か(全体像)→要点→次の行動」。視覚障害者がまず状況把握できる構成。

### C. 画像入力トークン
- **解像度 896px 既定**(1120から)。無損失で軽量化。
- **28pxグリッド整合リサイズ**: 端数パディング由来の余分視覚トークンを排除（無損失）。
- リクエスト解像度(`imageMaxSize`)を単段経路にも配線。

### D. 推論エンジン(llama-server)
- **flash-attn (-fa on)**: 無損失高速化 + V量子化の前提。
- **KVキャッシュ q8_0**: RAM **約半減**(306MiB実測)。
- **スレッド/CPUアフィニティ設定化**: `-t / --cpu-range / --cpu-strict / --prio`。ハイブリッドIntelでPコア専占可。既定=物理コア数。

### D2. メモリ圧迫対策（低RAM + Teams等常駐の実機向け）(2026-06-11)
- **mlock 設定化**: config の `mlock: true` で llama-server に `--mlock` を付与し、モデル重み(約2.7GB)を物理RAMに固定。mmap既定では他アプリのRAM圧迫で重みページがOSに破棄され、**次の推論でディスク再読込→TTFT激増**（devベンチでは見えない実機特有の劣化）。空きRAMが恒常的にモデルサイズを下回る機体では他アプリを圧迫するため、既定は false・実機で体感比較のうえ有効化。

### E. キャッシュ/省略
- **無変化スキップ**: 同一画像(バイト一致)+同一promptType はキャッシュ即返し（誤返答なし）。
- **G→D 画像prefill再利用**(4秒窓): KV前方一致でDの初動短縮。

### F. バックエンド自動選定（Option B）
- **GPU/CPU速度プローブ**: 起動時に GPU(-ngl 99)とCPU(-ngl 0)を実測 → 速い方採用 → マシン単位でキャッシュ → `accel: auto/gpu/cpu` で手動上書き → GPU起動失敗時はCPU復帰。「**遅くならない・必ず動く**」。
- **Vulkanバイナリ同梱**: CI(`build-windows.yml`)+実行時(`download-llama-server.ps1`)をVulkanビルド優先に。対応iGPUなら自動でGPUへ。CPUも同一バイナリ(-ngl 0)で動作。API URLは `ggml-org/llama.cpp` へ更新。

### G. モデル/量子化の判断（測定で決定）
- mmproj精度: F16==F32同一 → **Q8採用**(軽量・OCR維持)。
- **ctx_size 4096維持**（縮小は逆効果＝コンテキストシフトと実測）。

### 計測基盤（残置）
- `bench.py`: モデル/解像度/mmproj比較（HTML+console+JSON）。
- `bench_speed.py`: `--cpu`(CPUプロファイル) / `--shootout`(モデル対決) / OFAT速度レバー。

---

## 🔲 残っている候補（余地）

### 実装すれば効く（未着手/条件付き）
- **2B高速モードのトグル**: CPUで生成約2倍速・RAM-1.3GB。ただし日本語密テキストで幻覚 → 既定にせず手動オプション（UI追加要）。
- **Vulkan経路の実機有効化**: コード/同梱は完成。古いIntel UHDでの安定性・iGPUでmmprojが載るかを対象実機で確認。
- **CPUアフィニティの実値設定**: Pコア番号は機種依存。対象機で `cpu_range` 等を実測設定（枠は実装済）。

### 上流待ち/様子見
- **N-gram(prompt-lookup)投機デコード**: ゼロRAM・無損失で理想だが、llama-serverに未配線（ドラフトモデル方式のみ＝RAM増+多モーダル不可）。
- **MTP対応GGUF**: Qwen3-VLのMTP版が出れば無損失で生成高速化。現状なし。
- **keep-warm ping**: mlockの代替案（アイドル時に1トークン生成し重みページをキャッシュに保つ）。mlockで不足する場合のみ実装。

---

## 🖥️ CPUベンダー/アーキ別 最適化マトリクス

**要点: 実装済みの Vulkan が Intel+AMD の iGPU を横断カバー。OpenVINO/IPEX はその上のIntel特化策（NPU/AMX）で別ランタイム=高コスト。ARMは arm64ビルドの同梱が鍵。Apple Siliconは既存プローブがMetalを自動選択。**

| 環境 | GPU/アクセラ手段 | CPU命令最適化 | NPU | 我々の対応 |
|---|---|---|---|---|
| **Intel** (Core / Iris Xe / Arc) | Vulkan(iGPU/Arc) ✅実装済 ／ **OpenVINO・IPEX-LLM**(iGPU+NPU+AMX) ＝候補 | AVX2(既定)→ AVX-512/VNNI/**AMX** ビルドで上積み | AI Boost(Meteor/Lunar/Arrow Lake)→OpenVINO経由、VLMは未成熟 | Vulkanで自動。VINOは別バックエンド候補(下記) |
| **AMD** (Ryzen / Radeon iGPU) | Vulkan(Radeon iGPU) ✅実装済 ／ ROCm/HIP(dGPUのみ・仕事PCでは稀) | AVX2 → AVX-512/VNNI(**Zen4+**) | Ryzen AI(XDNA)→未成熟 | Vulkanで自動（Intelと同一経路） |
| **ARM Windows** (Snapdragon X 等) | iGPU/Adreno は Vulkan可だがVLM経路要検証 | NEON・**i8mm**・SVE・dotprod・Q4_0 repack | Hexagon(QNN/Genie)→未成熟 | **arm64 CPUビルドの同梱が要**（現状x64中心） |
| **Apple Silicon** (Mac) | Metal(-ngl) ✅プローブが自動選択 | NEON・AMX(Accelerate)・repack | — | 既存プローブで対応済 |

### 候補①: Intel OpenVINO / IPEX-LLM（Intel特化バックエンド）
- **内容**: 標準のGGML/llama.cpp に加え、Intel向けに OpenVINO(GenAI) または IPEX-LLM バックエンドを用意。**iGPU(Iris Xe/Arc)・NPU(AI Boost)・AMX/VNNI** をハード密着で活用し、3D RoPEのカーネルフュージョンやINT8 KV圧縮、ステートフル実行でメモリ効率を底上げ。
- **位置づけ**: 我々の `backend_selector`(プローブして速い方を採用)に**第3の候補バックエンドとして追加**できる思想的親和性はある。Intelでは Vulkan を上回る余地（特にNPU/AMX）。
- **コスト/リスク（正直）**:
  - **別ランタイム+別モデル形式**（OpenVINO IR / IPEX）。llama-server・GGUF・mmproj の現スタックを並走させる大規模追加。
  - **Intel限定**（AMD/ARMは恩恵なし → フリート分断）。
  - **Qwen3-VL系のVLM対応はOpenVINOバージョン依存**、NPUでの視覚エンコーダは未成熟（実際はCPU+iGPU中心になりがち）。
- **判断**: **長期R&D枠の候補**。まずは Vulkan(実装済・横断的)で iGPU を取り、Intel機で「Vulkan vs OpenVINO」を実機ベンチして、明確な上振れが確認できた場合のみ第3バックエンドとして追加するのが費用対効果的に妥当。

### 候補②: ISA特化のCPUビルド + 自動選択（全ベンダー横断）
- 配布バイナリは互換性優先で **AVX2 が最大公約数**。対応CPUでは **AVX-512/VNNI/AMX(Intel・AMD Zen4+)** や **i8mm/SVE(ARM)** ビルドの方が純CPUデコードが速い。
- `backend_selector` の「プローブして速い方+フォールバック」思想に乗せ、**CPU機能を検出して最適ビルドを選択**できる。
- コスト: 複数バイナリの管理 + 非対応CPUでのクラッシュ回避（フォールバック必須）。中規模。

### 候補③: ARM Windows(Snapdragon X)対応
- 増えつつある「普通のノート」。**arm64 CPUビルド**（`llama-...-bin-win-cpu-arm64.zip`、リリースに存在）を同梱すれば、i8mm/dotprod でCPU推論が速い。
- Hexagon NPU(QNN)はVLMでは未成熟 → 当面はCPUビルドで。

---

## 🔍 代替モデル対決 第2弾 (2026-06-11, Metal/896px/single_pass_summary/150tok)

| モデル | TTFT平均 | total平均 | tok/s | 日本語品質 | 判定 |
|---|---|---|---|---|---|
| **Qwen3-VL-4B(現行)** | 3.90s | 6.95s | 31.0 | ◎ 具体名・数値を正確に読む | 既定継続 |
| LFM2-VL-3B (Q4 1.4GB) | 2.14s | 4.59s | 53.1 | ✗ 人口グラフで数値捏造・繰り返しループ・固有名を読めない | 見送り |
| MiniCPM-V-4 4.1B (Q4 2.4GB) | 4.97s | 7.45s | 38.0 | ✗✗ 日本語破綻・繰り返しループ | 見送り |
| **Qwen3.5-2B 思考off (Q4 1.2GB)** | **2.00s** | 5.00s | 44.6 | ○ 固有名・カテゴリ項目を正確に読む。捏造なし(旧Qwen3-VL-2Bと別物)。やや冗長+「1文目:」ラベル漏れ | **高速モード有力候補** |

**CPU専用(-ngl 0, 8スレッド)の決定打**: Qwen3-VL-4B = TTFT ~29s/total ~41s/9.3tok/s に対し
**Qwen3.5-2B = TTFT ~10.7s(-63%)/total ~18.3s(-55%)/16〜22tok/s(約2倍)**。
低スペックCPU実機では世代差で「2Bの品質問題」が解消されつつ速度メリットだけ残る可能性。

**高速モード実装済み (2026-06-11)**: Qwen3.5-2B を「別起動」方式で導入。
- **起動**: `update-and-run-light.bat`(通常batを `GLANCE_MODEL=qwen3_5-2b-server` 付きで呼ぶ薄いラッパー)。
  実行時切替ではなく別起動にした理由: 2モデル同時展開はRAMの無駄(低RAM機で致命的)。
- **配線**: app.py が環境変数 `GLANCE_MODEL` で activeModel を上書き / config に `qwen3_5-2b-server`
  エントリ(unsloth GGUF自動DL対応) / qwen3_vl_server に `extra_chat_payload`(思考モード無効化
  `chat_template_kwargs: {enable_thinking: false}` を全payloadへ) / backend_selector のキャッシュを
  マシン×モデル別に(小型モデルだけiGPUに収まる等に対応)。
- **プロンプト改善**: 構成指定を「・1文目:」形式→自然文指示に書き換え(2Bが禁止語に引っ張られて
  「1文目：」を出力する問題を解消。4Bは新プロンプトでも品質同等を確認)。
- **残課題**: 密テキスト日本語画面での幻覚を実機・追加画像で広く確認してから、CPU機での既定切替を判断。

## 評価して見送り（記録）
- **LFM2-VL-3B (2026-06-11実測)**: 53tok/sと最速だが、人口グラフで「約1,800万人」等の数値捏造、Teams画面で同一文の繰り返しループ、固有名(ファイル名・アプリ名)をほぼ読めない。アクセシビリティでは誤誘導リスクで不採用。
- **MiniCPM-V-4 4.1B (2026-06-11実測)**: OCRBench高評価だが日本語生成が破綻(「オフィスペースの意匠」等)+繰り返しループ。中英特化で日本語不適。
- **Qwen3.5-4B (2026-06-11実測)**: ビジョン統合型になりGGUF+mmproj公開(unsloth/Qwen3.5-4B-GGUF)、llama.cpp動作可。ただし**既定が思考モードで本文が空になる**(`chat_template_kwargs: {enable_thinking: false}` 必須)うえ、思考無効でも Metal実測で **TTFT 3.9〜4.0s vs Qwen3-VL-4Bの1.4〜4.0s、生成 20.4 vs 31.4 tok/s(-35%)**。日本語出力の流暢さは良好だが冗長(150tok上限で尻切れ)。速度要件で見送り、Qwen3-VL-4B継続。モデルファイルは models/gguf/ に残置(再評価用、計3GB)。
- **Gemma4-E4B**: 速度互角・RAM倍(5GB)・日本語具体性で劣る・思考モード必須 → 見送り。
- **MiniMax-M3**: 100GB超のフロンティア級MoE → 対象機で動作不可（カテゴリ違い）。
- **極端量子化(1-2bit)/BitNet**: OCR精度破壊 or 視覚なし → 不適。

## やらない方がよい（実測で否定済み）
- ctx_size縮小 → 激遅化（コンテキストシフト） ／ 解像度672 → 密テキスト誤読 ／ 2Bを既定化 → 日本語OCR劣化。

---

## 総括
アーキ（単段化・ストリーミング）で体感を一変させ、入力/出力/エンジン/キャッシュ/バックエンドの各層で無損失系を積み上げ、モデル選定は実測で確定。「効くものはほぼ取り切り」、残るは**実機検証で確定する項目**と**上流対応待ち**、そして**Intel特化(OpenVINO)/ARM対応といったベンダー別の上積み**が中心。横断的な iGPU 活用は実装済みVulkanが担い、OpenVINOはIntelで明確な上振れが取れた場合の追加候補という位置づけ。
