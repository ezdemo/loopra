"""Zip a .app so macOS keeps the executable bit after the archive leaves Windows."""

import os
import stat
import sys
import zipfile


def unix_info(name, mode, is_dir):
    info = zipfile.ZipInfo(name)
    kind = stat.S_IFDIR if is_dir else stat.S_IFREG
    info.external_attr = (kind | mode) << 16
    info.create_system = 3
    return info


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: zip-macos-app.py APP.zip-source APP.zip")
    app = os.path.abspath(sys.argv[1])
    dest = os.path.abspath(sys.argv[2])
    if not app.endswith(".app") or not os.path.isdir(app):
        sys.exit("不是 .app 目录: " + app)
    parent = os.path.dirname(app)
    tmp = dest + ".tmp"
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for dirpath, _, filenames in os.walk(app):
            rel_dir = os.path.relpath(dirpath, parent).replace("\\", "/")
            archive.writestr(unix_info(rel_dir + "/", 0o755, True), b"")
            for name in filenames:
                full = os.path.join(dirpath, name)
                rel = rel_dir + "/" + name
                executable = "/Contents/MacOS/" in ("/" + rel)
                mode = 0o755 if executable else 0o644
                with open(full, "rb") as handle:
                    archive.writestr(unix_info(rel, mode, False), handle.read())
    os.replace(tmp, dest)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        temp = sys.argv[2] + ".tmp" if len(sys.argv) == 3 else ""
        if temp and os.path.exists(temp):
            os.remove(temp)
        sys.exit(str(error))
