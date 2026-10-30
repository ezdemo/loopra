#!/bin/sh
set -eu
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required by the release updater'; exit 1; }
python3 - <<'PY'
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request
import uuid
import zipfile

def fetch(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "Looprax-Updater"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("Release download exceeds size limit")
    return data

api = os.environ.get("LOOPRAX_RELEASE_API_URL", "https://api.github.com/repos/ezdemo/loopra-release/releases/latest")
release = json.loads(fetch(api, 4 * 1024 * 1024))
platform, arch = os.environ["LOOPRAX_UPDATE_OS"], os.environ["LOOPRAX_UPDATE_ARCH"]
target_name = Path(os.environ.get("LOOPRAX_UPDATE_TARGET", "")).name
desktop = "desktop" in target_name.lower() or target_name in ("Loopra", "LoopraX")

def tokens(name):
    base = Path(name).name.lower()
    for suffix in (".tar.gz", ".exe", ".zip", ".tgz"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.split("-")

def arch_ok(name):
    parts = tokens(name)
    if arch == "arm":
        return "armv7" in parts or "arm" in parts
    return arch in parts

assets = [asset for asset in release.get("assets", [])
          if platform in tokens(asset["name"]) and arch_ok(asset["name"])
          and ("desktop" in tokens(asset["name"])) == desktop]
if not assets:
    raise RuntimeError("No matching platform binary in this release")
asset = assets[0]
url = os.environ.get("LOOPRA_MIRROR", "") + asset["browser_download_url"]
data = fetch(url, 128 * 1024 * 1024)
digest = asset.get("digest", "")
if digest.startswith("sha256:") and hashlib.sha256(data).hexdigest() != digest[7:].lower():
    raise RuntimeError("Release checksum mismatch")
if asset["name"].endswith(".zip"):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = ("Loopra", "LoopraX") if desktop else ("loopra", "looprax")
        entries = [entry for entry in archive.infolist() if Path(entry.filename).name in names]
        if not entries or entries[0].file_size > 128 * 1024 * 1024:
            raise RuntimeError("Archive does not contain a valid loopra binary")
        data = archive.read(entries[0])
elif asset["name"].endswith((".tar.gz", ".tgz")):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        names = ("Loopra", "LoopraX") if desktop else ("loopra", "looprax")
        entries = [entry for entry in archive.getmembers() if entry.isfile() and Path(entry.name).name in names]
        if not entries or entries[0].size > 128 * 1024 * 1024:
            raise RuntimeError("Archive does not contain a valid loopra binary")
        data = archive.extractfile(entries[0]).read()
if len(data) < 64 or data[:4] not in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"):
    raise RuntimeError("Downloaded file is not a supported native executable")
directory = Path(os.environ["LOOPRA_HOME"]) / "updates"
staged = directory / (uuid.uuid4().hex + ".bin")
staged.write_bytes(data)
staged.chmod(0o755)
helper = directory / (uuid.uuid4().hex + "-apply.sh")
helper.write_text("""#!/bin/sh
set -eu
while kill -0 "$LOOPRAX_UPDATE_PID" 2>/dev/null; do sleep 1; done
cp "$LOOPRAX_UPDATE_STAGED" "$LOOPRAX_UPDATE_TARGET.new"
chmod 755 "$LOOPRAX_UPDATE_TARGET.new"
mv -f "$LOOPRAX_UPDATE_TARGET.new" "$LOOPRAX_UPDATE_TARGET"
rm -f "$LOOPRAX_UPDATE_STAGED"
""")
environment = dict(os.environ, LOOPRAX_UPDATE_STAGED=str(staged))
subprocess.Popen(["sh", str(helper)], env=environment, stdin=subprocess.DEVNULL,
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
print("Update downloaded and verified. Exit Looprax to apply it, then start Looprax again.", flush=True)
PY
