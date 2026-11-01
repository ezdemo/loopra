"""Build the per-user Windows installer with NSIS on Windows or Linux."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
        parser.error("Invalid application version")
    core = args.version.split("-")[0]
    if any(int(part) > 65535 for part in core.split(".")):
        parser.error("Windows version parts must be at most 65535")
    binary, output = args.binary.resolve(), args.out.resolve()
    if not binary.is_file():
        parser.error("--binary must be a Windows executable")
    with binary.open("rb") as source:
        header = source.read(64)
        if len(header) < 64 or header[:2] != b"MZ":
            parser.error("--binary must be a Windows executable")
        source.seek(struct.unpack_from("<I", header, 60)[0])
        pe = source.read(6)
        expected = 0x8664 if args.arch == "amd64" else 0xAA64
        if len(pe) != 6 or pe[:4] != b"PE\x00\x00" or struct.unpack_from("<H", pe, 4)[0] != expected:
            parser.error("Windows executable architecture does not match --arch")
    compiler = os.environ.get("NSIS_COMPILER") or shutil.which("makensis")
    if not compiler and os.name == "nt":
        for folder in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
            candidate = Path(folder or "") / "NSIS" / "makensis.exe"
            if candidate.is_file():
                compiler = str(candidate)
                break
    if not compiler:
        parser.error("NSIS is required: install makensis or set NSIS_COMPILER")
    root = Path(__file__).resolve().parent.parent
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".loopra-installer-", dir=output.parent) as work:
        work = Path(work)
        icon, marker, staged = work / "Loopra.ico", work / "loopra-install.json", work / output.name
        with Image.open(root / "web/public/icon-512.png") as image:
            image.convert("RGBA").save(icon, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)], bitmap_format="bmp")
        marker.write_text(json.dumps({"packageType": "nsis", "scope": "user", "arch": args.arch}) + "\n", encoding="utf-8")
        definitions = {"APP_BINARY": binary, "OUTPUT_FILE": staged, "APP_VERSION": args.version, "APP_ARCH": args.arch,
                       "APP_VERSION_INFO": core + ".0", "APP_ICON": icon, "APP_MARKER": marker}
        flag = "/" if os.name == "nt" else "-"
        command = [compiler, flag + "V2", flag + "INPUTCHARSET", "UTF8", *[f"{flag}D{key}={value}" for key, value in definitions.items()], str(root / "scripts/windows/installer.nsi")]
        subprocess.run(command, check=True, env={**os.environ, "TEMP": str(work), "TMP": str(work)})
        if not staged.is_file():
            raise RuntimeError("NSIS did not produce an installer")
        os.replace(staged, output)
    print(f"Installer: {output.name}")


if __name__ == "__main__":
    main()
