@echo off
chcp 65001 > nul
rem ============================================================
rem  Glance 精度重視モード (Qwen3-VL-4B) で更新 ^& 起動
rem  既定(Qwen3.5-2B)より読み取り精度が一段上がる代わりに、
rem  CPU機では説明が出るまでの時間が約2倍かかります。
rem  RAMは8GB以上を推奨。初回はモデル(約3.0GB)を自動DLします。
rem
rem  用途: 既定モデルとの読み取り精度の比較(A/B)。
rem  ふだんは update-and-run.bat を使ってください。
rem
rem  仕組みは update-and-run-light.bat と同じ。先に git pull で
rem  最新化してから、通常の update-and-run.bat を GLANCE_MODEL 付き・
rem  --skip-pull で呼ぶ(pullの二重実行を防ぐ)。pull〜起動を1行に
rem  まとめているのは、実行中にこのbat自身が更新されても cmd が
rem  読み取り位置を見失わないようにするため。
rem ============================================================
set GLANCE_MODEL=qwen3-vl-4b-server
cd /d "%~dp0"
echo [1/4] 最新版を取得中 (git pull)...
git pull & call "%~dp0update-and-run.bat" --skip-pull & exit /b
