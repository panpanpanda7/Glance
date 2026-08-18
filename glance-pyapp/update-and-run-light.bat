@echo off
chcp 65001 > nul
rem ============================================================
rem  Glance 高速モード (Qwen3.5-2B) で更新 ^& 起動
rem  低スペックPC向け: 説明が速い(CPUで約2倍)代わりに、
rem  読み取り精度は4Bより一段下がります。
rem  初回はモデル(約1.9GB)を自動ダウンロードします。
rem
rem  注: このモデルは config.yaml の activeModel と同じ(既定)になったため、
rem  update-and-run.bat と挙動は同じ。既存テスターのショートカットを
rem  壊さないために残している。4B を試すときは環境変数で:
rem    set GLANCE_MODEL=qwen3-vl-4b-server
rem
rem  仕組み: 先に git pull で最新化してから、通常の update-and-run.bat を
rem  GLANCE_MODEL 付き・--skip-pull で呼ぶ(pullの二重実行を防ぐ)。
rem  pull〜起動を1行にまとめているのは、実行中にこのbat自身が
rem  更新されても cmd が読み取り位置を見失わないようにするため。
rem ============================================================
set GLANCE_MODEL=qwen3_5-2b-server
cd /d "%~dp0"
echo [1/4] 最新版を取得中 (git pull)...
git pull & call "%~dp0update-and-run.bat" --skip-pull & exit /b
