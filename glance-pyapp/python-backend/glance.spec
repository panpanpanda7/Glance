# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Glance Python Backend
モデルファイルを含まず、軽量なバイナリを生成します
"""

import sys
import os
from pathlib import Path
import llama_cpp

block_cipher = None

# プロジェクトのベースディレクトリ
base_dir = Path('.').absolute()

# llama_cppのパスを取得
llama_cpp_path = os.path.dirname(llama_cpp.__file__)

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('config.yaml', '.'),
        ('models/__init__.py', 'models'),
        ('models/model_interface.py', 'models'),
        ('models/internvl.py', 'models'),
        ('models/internvl_gguf.py', 'models'),
        # llama_cppのlibフォルダを含める（DLL読み込みエラー対策）
        (os.path.join(llama_cpp_path, 'lib'), 'llama_cpp/lib'),
        # 注意: modelsフォルダ内の実際のモデルファイル(.gguf)は含めません
        # これらは初回起動時にダウンロードされます
    ],
    hiddenimports=[
        'flask',
        'flask_cors',
        'PIL',
        'yaml',
        'requests',
        'llama_cpp',
        'torch',
        'transformers',
        'models.internvl',
        'models.internvl_gguf',
        'models.model_interface',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
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
    console=True,  # コンソールウィンドウを表示（デバッグ用）
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
