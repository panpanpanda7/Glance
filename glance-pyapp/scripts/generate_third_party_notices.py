"""インストーラに同梱する第三者ソフトウェアのライセンス表記を生成する。

出力先はリポジトリ直下の THIRD_PARTY_NOTICES.txt。electron-builder の
extraResources でインストーラに入る。

依存を変えたとき（requirements.txt / package.json / LLAMA_CPP_TAG）に
再実行してコミットする。Python の依存はこのスクリプトを動かしている
インタプリタから読むので、バックエンドの venv で実行すること。

    cd glance-pyapp/electron && npm ci
    glance-pyapp/python-backend/venv/bin/python glance-pyapp/scripts/generate_third_party_notices.py <llama.cpp の zip を展開したフォルダ>

CI ではビルドのたびに Windows 上で作り直す（Windows でだけ入る依存も拾うため）。
"""

import json
import re
import shutil
import ssl
import subprocess
import sys
import urllib.request
from importlib import metadata
from pathlib import Path

import certifi

ROOT = Path(__file__).resolve().parents[2]
REQUIREMENTS = ROOT / "glance-pyapp/python-backend/requirements.txt"
ELECTRON_DIR = ROOT / "glance-pyapp/electron"
WORKFLOW = ROOT / ".github/workflows/build-windows.yml"
# CI が llama.cpp の zip を展開してコピーする先。zip 同梱の libomp.dll などの
# ライセンス文（LICENSE-LLVM-OpenMP）もここに入っている。手元で生成するときは
# 第1引数で、展開した zip のフォルダを渡せる。
LLAMA_BIN = ROOT / "glance-pyapp/python-backend/llama-cpp-bin"
OUTPUT = ROOT / "THIRD_PARTY_NOTICES.txt"

LICENSE_FILE = re.compile(r"(LICEN[CS]E|COPYING|NOTICE)", re.IGNORECASE)
RULE = "=" * 72

MIT_TEXT = """MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def section(title, license_name, texts):
    lines = [RULE, title, f"License: {license_name}", RULE, ""]
    if texts:
        lines += [t.strip() + "\n" for t in texts]
    else:
        lines.append(f"(ライセンス文が配布物に含まれていません。{license_name} に従います)\n")
    return "\n".join(lines)


def requirement_names(path):
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.append(re.split(r"[<>=!~\[; ]", line, 1)[0])
    return names


def python_closure(roots):
    """requirements.txt から辿れる実行時依存（extras は除く）をすべて返す。"""
    seen = {}
    stack = list(roots)
    while stack:
        name = stack.pop()
        key = name.lower().replace("_", "-")
        if key in seen:
            continue
        dist = metadata.distribution(name)
        seen[key] = dist
        for req in dist.requires or []:
            if "extra ==" in req:
                continue
            # Windows 専用の依存（colorama 等）は、手元が macOS でも Windows の
            # 配布物には入るので、環境マーカーに関係なく辿る。入っていなければ飛ばす。
            dep = re.split(r"[<>=!~\[; (]", req, 1)[0]
            try:
                metadata.distribution(dep)
            except metadata.PackageNotFoundError:
                print(f"  注意: {dep}（{name} の依存）が venv にありません", file=sys.stderr)
                continue
            stack.append(dep)
    return sorted(seen.values(), key=lambda d: d.metadata["Name"].lower())


def python_license_name(dist):
    meta = dist.metadata
    return (meta.get("License-Expression")
            or next((c.split(" :: ")[-1] for c in meta.get_all("Classifier") or []
                     if c.startswith("License :: OSI Approved ::")), None)
            or (meta.get("License") or "").splitlines()[0]
            or "不明")


def python_license_texts(dist):
    texts = []
    for f in dist.files or []:
        if ".dist-info" in str(f) and LICENSE_FILE.search(f.name):
            texts.append(Path(dist.locate_file(f)).read_text(encoding="utf-8", errors="replace"))
    return texts


def python_runtime():
    base = Path(sys.base_prefix)
    for candidate in (base / "LICENSE.txt",
                      base / f"lib/python{sys.version_info.major}.{sys.version_info.minor}/LICENSE.txt"):
        if candidate.exists():
            return section(f"Python {sys.version.split()[0]}", "PSF-2.0",
                           [candidate.read_text(encoding="utf-8")])
    raise SystemExit("Python 本体の LICENSE.txt が見つかりません")


def npm_packages():
    out = subprocess.run([shutil.which("npm"), "ls", "--omit=dev", "--all", "--json", "--long"],
                         cwd=ELECTRON_DIR, capture_output=True, text=True, encoding="utf-8",
                         check=True).stdout
    found = {}

    def walk(deps):
        for name, info in (deps or {}).items():
            key = (name, info.get("version"))
            if key not in found and info.get("path"):
                found[key] = info
            walk(info.get("dependencies"))

    walk(json.loads(out).get("dependencies"))
    return [found[k] for k in sorted(found)]


def npm_section(info):
    pkg_dir = Path(info["path"])
    texts = [p.read_text(encoding="utf-8", errors="replace")
             for p in sorted(pkg_dir.iterdir()) if p.is_file() and LICENSE_FILE.search(p.name)]
    license_name = info.get("license") or "不明"
    if isinstance(license_name, dict):
        license_name = license_name.get("type", "不明")
    if not texts and license_name == "MIT":
        # 本文を同梱していないパッケージには、package.json の作者名で MIT 本文を補う
        author = json.loads((pkg_dir / "package.json").read_text(encoding="utf-8")).get("author")
        if isinstance(author, dict):
            author = author.get("name")
        texts = [MIT_TEXT.format(holder=author or f"the {info['name']} authors")]
    return section(f"{info['name']} {info['version']}", license_name, texts)


def llama_cpp(bin_dir):
    tag = re.search(r"^\s*LLAMA_CPP_TAG:\s*(\S+)", WORKFLOW.read_text(encoding="utf-8"), re.M).group(1)
    if tag == "latest":
        raise SystemExit("LLAMA_CPP_TAG が latest のままでは版を特定できません。タグを固定してください")
    url = f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{tag}/LICENSE"
    with urllib.request.urlopen(
            url, context=ssl.create_default_context(cafile=certifi.where())) as res:
        text = res.read().decode("utf-8")
    parts = [section(f"llama.cpp {tag}（llama-server.exe と同梱 DLL）", "MIT", [text])]
    if not bin_dir.is_dir():
        raise SystemExit(f"{bin_dir} がありません。llama.cpp の zip を展開したフォルダを引数で渡してください")
    for path in sorted(bin_dir.rglob("*")):
        if path.is_file() and LICENSE_FILE.search(path.name) and path.name != "LICENSE":
            parts.append(section(f"llama.cpp {tag} 同梱の {path.name}", "配布物の記載どおり",
                                 [path.read_text(encoding="utf-8", errors="replace")]))
    return "\n\n".join(parts)


def main():
    parts = [
        "Glance 第三者ソフトウェアのライセンス表記\n"
        "\n"
        "Glance のインストーラには、以下の第三者ソフトウェアが含まれています。\n"
        "それぞれのライセンスに従って再配布しています。\n"
        "\n"
        "Electron と Chromium のライセンスは、インストール先フォルダの\n"
        "LICENSE.electron.txt と LICENSES.chromium.html にあります。\n"
        "\n"
        "画像認識モデル（Qwen3-VL など）はインストーラに含まれず、初回起動時に\n"
        "Hugging Face から取得します。各モデルのライセンスは配布元のページを\n"
        "参照してください。\n",
        llama_cpp(Path(sys.argv[1]) if len(sys.argv) > 1 else LLAMA_BIN),
        python_runtime(),
    ]
    for dist in python_closure(requirement_names(REQUIREMENTS)):
        parts.append(section(f"{dist.metadata['Name']} {dist.version}（Python）",
                             python_license_name(dist), python_license_texts(dist)))
    for info in npm_packages():
        parts.append(npm_section(info))

    OUTPUT.write_text("\n\n".join(parts), encoding="utf-8", newline="\r\n")
    print(f"{OUTPUT.relative_to(ROOT)} を書き出しました（{len(parts) - 1} 件）")


if __name__ == "__main__":
    main()
