# glance-extension フォルダ内で実行
cd glance-extension

# 新しいトークンを設定（必ず新しいものを使用）
export HF_TOKEN="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"

# 古いmodelsを削除
rm -rf models

# フォルダ構造を作成
mkdir -p models/onnx-community/Florence-2-base-ft/onnx

# === 設定ファイルをダウンロード ===
echo "設定ファイルをダウンロード中..."

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/config.json" \
  -o models/onnx-community/Florence-2-base-ft/config.json

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/preprocessor_config.json" \
  -o models/onnx-community/Florence-2-base-ft/preprocessor_config.json

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/tokenizer.json" \
  -o models/onnx-community/Florence-2-base-ft/tokenizer.json

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/tokenizer_config.json" \
  -o models/onnx-community/Florence-2-base-ft/tokenizer_config.json

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/generation_config.json" \
  -o models/onnx-community/Florence-2-base-ft/generation_config.json

curl -L -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/vocab.json" \
  -o models/onnx-community/Florence-2-base-ft/vocab.json

# 確認
echo "設定ファイルの確認..."
cat models/onnx-community/Florence-2-base-ft/config.json | head -3

# === ONNXモデルファイルをダウンロード ===

# embed_tokens (q4量子化版, 約26MB)
echo "embed_tokens をダウンロード中..."
curl -L --progress-bar -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/embed_tokens_q4.onnx" \
  -o models/onnx-community/Florence-2-base-ft/onnx/embed_tokens_q4.onnx

# vision_encoder (fp32版, 約340MB - 量子化に弱いため)
echo "vision_encoder をダウンロード中... (約340MB)"
curl -L --progress-bar -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/vision_encoder.onnx" \
  -o models/onnx-community/Florence-2-base-ft/onnx/vision_encoder.onnx

# encoder_model (q4量子化版, 約43MB)
echo "encoder_model をダウンロード中..."
curl -L --progress-bar -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/encoder_model_q4.onnx" \
  -o models/onnx-community/Florence-2-base-ft/onnx/encoder_model_q4.onnx

# decoder_model_merged (q4量子化版, 約85MB)
echo "decoder_model_merged をダウンロード中..."
curl -L --progress-bar -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/decoder_model_merged_q4.onnx" \
  -o models/onnx-community/Florence-2-base-ft/onnx/decoder_model_merged_q4.onnx

# === 確認 ===
echo ""
echo "=== ダウンロード結果 ==="
du -sh models/
ls -lh models/onnx-community/Florence-2-base-ft/onnx/