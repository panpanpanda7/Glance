@echo off
rem ============================================================
rem  Glance 高速モード (Qwen3.5-2B) で更新 ^& 起動
rem  低スペックPC向け: 説明が速い(CPUで約2倍)代わりに、
rem  読み取り精度は標準モードより一段下がります。
rem  仕組み: GLANCE_MODEL を設定して通常の update-and-run.bat を呼ぶだけ。
rem  初回はモデル(約1.9GB)を自動ダウンロードします。
rem ============================================================
set GLANCE_MODEL=qwen3_5-2b-server
call "%~dp0update-and-run.bat" %*
