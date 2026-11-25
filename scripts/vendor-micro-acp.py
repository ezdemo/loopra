#!/usr/bin/env python3
"""Vendor the pinned micro-acp release binaries for Loopra's default Go builds.

Usage: python scripts/vendor-micro-acp.py

Archives are checked against their pinned SHA-256 before use.
"""

import gzip
import hashlib
import io
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.8.1"
REPO = "https://github.com/BrokkAi/micro-acp"
# Pinned digests from the official v0.8.1 GitHub release assets.
SHA256 = {
    ("windows", "amd64"): "b70343574a6c2a0867ec4b7d89c18e7e324f42244a48761bd358502970c76827",
    ("windows", "arm64"): "6777ac8c4238e1d4b41d2aee6419c30eb829de8f4be6948a8bcee75188842434",
    ("darwin", "amd64"): "2301813162b1b00e6eac0b0f96fc1a0bf0ca98a492597be549f43e194466b6de",
    ("darwin", "arm64"): "329d1c1d6d1efe95a1bda037952a0a49ffd3c3a6281a767cf3b49090eb332515",
    ("linux", "amd64"): "b82021f39dc4d19feb2d24f3e9389cca47ccaafc6b9ee2811e709228ea5f00f1",
    ("linux", "arm64"): "0a52580d22a9d82409447b82f86933f81e84b408a6b903711234fb24ffd384d0",
}
MAX_SIZE = 64 * 1024 * 1024


def verified_archive(name: str, expected: str) -> bytes:
    """Return the archive bytes, from the ignored cache or the pinned release URL."""
    cache = ROOT / ".cache" / "micro-acp" / name
    if cache.is_file():
        archive = cache.read_bytes()
        if len(archive) > MAX_SIZE:
            raise SystemExit(f"cached {name} exceeds {MAX_SIZE} bytes; delete {cache}")
        if hashlib.sha256(archive).hexdigest() != expected:
            raise SystemExit(f"cached {name} failed the pinned sha256 check; delete {cache} and rerun")
        print(f"micro-acp: using cached {name}", file=sys.stderr)
        return archive
    url = f"{REPO}/releases/download/v{VERSION}/{name}"
    print(f"micro-acp: downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "loopra-vendor"}), timeout=30
    ) as response:
        archive = response.read(MAX_SIZE + 1)
    if len(archive) > MAX_SIZE:
        raise SystemExit(f"{name} exceeds {MAX_SIZE} bytes")
    if hashlib.sha256(archive).hexdigest() != expected:
        raise SystemExit(f"{name} failed the pinned sha256 check")
    cache.parent.mkdir(parents=True, exist_ok=True)
    temp = tempfile.NamedTemporaryFile(dir=cache.parent, delete=False)
    try:
        with temp:
            temp.write(archive)
        Path(temp.name).replace(cache)
    finally:
        Path(temp.name).unlink(missing_ok=True)
    return archive


def extract_binary(archive: bytes, goos: str, exe: str, name: str) -> bytes:
    """Read the single matching executable member without extracting the archive."""

    def matches(member_name: str) -> bool:
        return PurePosixPath(member_name).name == exe

    if goos == "windows":
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            members = [info for info in zf.infolist() if not info.is_dir() and matches(info.filename)]
            if len(members) != 1:
                raise SystemExit(f"{name}: expected exactly one {exe} member, found {len(members)}")
            if members[0].file_size > MAX_SIZE:
                raise SystemExit(f"{name}: {exe} exceeds {MAX_SIZE} bytes")
            return zf.read(members[0])
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf:
        members = [m for m in tf.getmembers() if m.isfile() and matches(m.name)]
        if len(members) != 1:
            raise SystemExit(f"{name}: expected exactly one {exe} member, found {len(members)}")
        if members[0].size > MAX_SIZE:
            raise SystemExit(f"{name}: {exe} exceeds {MAX_SIZE} bytes")
        source = tf.extractfile(members[0])
        if source is None:
            raise SystemExit(f"{name}: cannot read {exe} member")
        return source.read(MAX_SIZE + 1)


def main() -> int:
    assets = ROOT / "internal" / "infrastructure" / "microacp" / "assets"
    for (goos, goarch), expected in SHA256.items():
        exe = "micro-acp.exe" if goos == "windows" else "micro-acp"
        ext = "zip" if goos == "windows" else "tar.gz"
        name = f"micro-acp_{VERSION}_{goos}_{goarch}.{ext}"
        binary = extract_binary(verified_archive(name, expected), goos, exe, name)
        if not 0 < len(binary) <= MAX_SIZE:
            raise SystemExit(f"{name}: invalid {exe} size: {len(binary)} bytes")
        payload = assets / f"{goos}_{goarch}" / "micro-acp.gz"
        compressed = io.BytesIO()
        with gzip.GzipFile(filename="", fileobj=compressed, mode="wb", compresslevel=6, mtime=0) as out:
            out.write(binary)
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_bytes(compressed.getvalue())
        print(f"micro-acp: vendored {goos}/{goarch} -> {payload}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
