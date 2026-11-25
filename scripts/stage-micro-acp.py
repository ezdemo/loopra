#!/usr/bin/env python3
"""Download and stage the pinned micro-acp release binary for `go build -overlay`.

Usage: python scripts/stage-micro-acp.py <goos> <goarch> <stage-dir>

Writes <stage-dir>/payload.gz (gzipped upstream binary) and
<stage-dir>/overlay.json mapping the repo's embed path onto it. The upstream
archive is verified against a pinned SHA-256 before anything is consumed or
cached; there is no fallback to unverified sources.
"""

import argparse
import gzip
import hashlib
import io
import json
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage the pinned micro-acp binary for a Go build overlay.")
    parser.add_argument("goos", help="target GOOS (windows, darwin, linux)")
    parser.add_argument("goarch", help="target GOARCH (amd64, arm64)")
    parser.add_argument("stage", type=Path, help="isolated staging directory to write payload.gz and overlay.json into")
    args = parser.parse_args()
    if (args.goos, args.goarch) not in SHA256:
        parser.error(f"no pinned micro-acp release for {args.goos}/{args.goarch}")
    if not args.stage.is_dir():
        parser.error(f"staging directory does not exist: {args.stage}")
    return args


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
        urllib.request.Request(url, headers={"User-Agent": "loopra-package"}), timeout=30
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
    """Read the single top-level executable member; never touches the filesystem."""

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
    args = parse_args()
    exe = "micro-acp.exe" if args.goos == "windows" else "micro-acp"
    name = f"micro-acp_{VERSION}_{args.goos}_{args.goarch}.{'zip' if args.goos == 'windows' else 'tar.gz'}"
    expected = SHA256[(args.goos, args.goarch)]
    archive = verified_archive(name, expected)
    binary = extract_binary(archive, args.goos, exe, name)
    payload = args.stage.resolve() / "payload.gz"
    payload.write_bytes(gzip.compress(binary, compresslevel=6, mtime=0))
    embed = ROOT / "internal" / "infrastructure" / "microacp" / "payload.gz"
    (args.stage / "overlay.json").write_text(
        json.dumps({"Replace": {str(embed): str(payload)}}), encoding="utf-8"
    )
    print(f"micro-acp: staged {exe} for {args.goos}/{args.goarch} -> {payload}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
