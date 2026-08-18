# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Glance Python Backend

リリース版に入れるものだけを定義します。
- モデルファイル(.gguf)は含めません（初回起動時にダウンロード）
- 推論は llama-server.exe を別プロセスで起動して REST で叩くため、
  Python 側の推論ライブラリ（torch / transformers / llama-cpp-python）は
  一切同梱しません。開発用の依存は requirements-dev.txt 側にあります。
"""

import sys
import os
from pathlib import Path

block_cipher = None

# プロジェクトのベースディレクトリ
base_dir = Path('.').absolute()

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('config.yaml', '.'),
        ('models/__init__.py', 'models'),
        ('models/model_interface.py', 'models'),
        # llama-cpp-python 直叩きの旧経路。app.py が import するので
        # ファイル自体は入れるが、llama_cpp 本体は同梱しない
        # （config の activeModel が type: qwen3_vl_server である限り呼ばれない）
        ('models/internvl_gguf.py', 'models'),
        ('models/qwen_vl_gguf.py', 'models'),
        # 現行の推論経路
        ('models/qwen3_vl_server.py', 'models'),
        # 注意: modelsフォルダ内の実際のモデルファイル(.gguf)は含めません
        # これらは初回起動時にダウンロードされます
    ],
    hiddenimports=[
        'flask',
        'flask_cors',
        'PIL',
        'yaml',
        'requests',
        'psutil',
        'subprocess',
        'socket',
        'time',
        'models.internvl_gguf',
        'models.qwen_vl_gguf',
        'models.qwen3_vl_server',
        'models.model_interface',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 開発環境に入っていてもインストーラには絶対に入れないもの。
        # ここを外すとインストーラが数百MB〜GB単位で膨らみます。
        'torch',
        'torchvision',
        'transformers',
        'accelerate',
        'sentencepiece',
        'timm',
        'einops',
        'llama_cpp',
        'huggingface_hub',
        'matplotlib',
        'scipy',
        'pandas',
        'notebook',
        'jupyter',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='glance-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    # コンソール窓を出さない。出すとバックエンド起動時に
    # フォーカスを奪い、スクリーンリーダーの読み上げが飛ぶ。
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='glance-backend',
)
