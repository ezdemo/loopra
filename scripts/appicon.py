"""Embed the Loopra mark into packaged Windows and macOS apps.

Source: web/public/icon-512.png. Windows gets an icon resource in the exe.
macOS gets loopra.icns inside the .app. The Linux desktop binary embeds the
same PNG and installs it on startup.
"""

import io
import os
import struct
import subprocess
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "web", "public", "icon-512.png")
WINDOWS_SIZES = (16, 24, 32, 48, 64, 128, 256)
# Skip 16 and 32 point icp4/icp5: Finder treats those payloads as old ARGB.
ICNS_ENTRIES = (
    ("ic11", 32),
    ("ic12", 64),
    ("ic07", 128),
    ("ic13", 256),
    ("ic08", 256),
    ("ic14", 512),
    ("ic09", 512),
    ("ic10", 1024),
)


def source_image():
    return Image.open(SOURCE).convert("RGBA")


def png_bytes(image, size):
    scaled = image.resize((size, size), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    scaled.save(buf, format="PNG")
    return buf.getvalue()


def icns_bytes(image):
    body = bytearray()
    for kind, size in ICNS_ENTRIES:
        payload = png_bytes(image, size)
        body += kind.encode("ascii")
        body += struct.pack(">I", len(payload) + 8)
        body += payload
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def align(value, boundary):
    return (value + boundary - 1) & ~(boundary - 1)


def resource_section(pngs):
    """Build a .rsrc section: RT_ICON images plus one RT_GROUP_ICON."""
    group = bytearray(struct.pack("<HHH", 0, 1, len(pngs)))
    for index, (size, payload) in enumerate(pngs, 1):
        dim = 0 if size >= 256 else size
        group += bytes((dim, dim, 0, 0))
        group += struct.pack("<HHIH", 1, 32, len(payload), index)
    items = [(3, index, payload) for index, (_, payload) in enumerate(pngs, 1)]
    items.append((14, 1, bytes(group)))
    grouped = {}
    for kind, ident, payload in items:
        grouped.setdefault(kind, []).append((ident, payload))
    types = sorted(grouped)
    for kind in types:
        grouped[kind].sort()

    def directory_size(count):
        return 16 + 8 * count

    cursor = directory_size(len(types))
    type_at = {}
    for kind in types:
        type_at[kind] = cursor
        cursor += directory_size(len(grouped[kind]))
    lang_at = {}
    for kind in types:
        for ident, _ in grouped[kind]:
            lang_at[(kind, ident)] = cursor
            cursor += directory_size(1)
    entry_at = {}
    for kind in types:
        for ident, _ in grouped[kind]:
            entry_at[(kind, ident)] = cursor
            cursor += 16
    data_at = {}
    blob = bytearray()
    for kind in types:
        for ident, payload in grouped[kind]:
            while len(blob) % 8:
                blob.append(0)
            data_at[(kind, ident)] = cursor + len(blob)
            blob += payload
    raw = bytearray(cursor) + blob

    def put_directory(at, count):
        struct.pack_into("<IIHHHH", raw, at, 0, 0, 0, 0, 0, count)

    put_directory(0, len(types))
    for index, kind in enumerate(types):
        struct.pack_into("<II", raw, 16 + 8 * index, kind, type_at[kind] | 0x80000000)
        put_directory(type_at[kind], len(grouped[kind]))
        base = type_at[kind] + 16
        for slot, (ident, payload) in enumerate(grouped[kind]):
            struct.pack_into("<II", raw, base + 8 * slot, ident, lang_at[(kind, ident)] | 0x80000000)
            put_directory(lang_at[(kind, ident)], 1)
            struct.pack_into("<II", raw, lang_at[(kind, ident)] + 16, 0x0409, entry_at[(kind, ident)])
            struct.pack_into("<IIII", raw, entry_at[(kind, ident)], data_at[(kind, ident)], len(payload), 0, 0)
    return raw, entry_at, data_at


def inject_exe(path, image):
    data = bytearray(open(path, "rb").read())
    if data[:2] != b"MZ":
        raise SystemExit("不是 Windows 可执行文件: " + path)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise SystemExit("PE 头损坏: " + path)
    coff = pe + 4
    sections = struct.unpack_from("<H", data, coff + 2)[0]
    optional_size = struct.unpack_from("<H", data, coff + 16)[0]
    optional = coff + 20
    magic = struct.unpack_from("<H", data, optional)[0]
    if magic == 0x20B:
        directories = optional + 112
    elif magic == 0x10B:
        directories = optional + 96
    else:
        raise SystemExit("不认识的 PE 可选头: " + path)
    section_align = struct.unpack_from("<I", data, optional + 32)[0]
    file_align = struct.unpack_from("<I", data, optional + 36)[0]
    size_of_image = struct.unpack_from("<I", data, optional + 56)[0]
    size_of_headers = struct.unpack_from("<I", data, optional + 60)[0]
    table = optional + optional_size
    names = []
    first_raw = None
    for index in range(sections):
        header = table + 40 * index
        names.append(data[header:header + 8].split(b"\0", 1)[0])
        raw = struct.unpack_from("<I", data, header + 20)[0]
        if raw and (first_raw is None or raw < first_raw):
            first_raw = raw
    if b".rsrc" in names:
        print("已有图标资源，跳过 " + os.path.basename(path))
        return
    header_at = table + 40 * sections
    if header_at + 40 > size_of_headers or (first_raw is not None and header_at + 40 > first_raw):
        raise SystemExit("PE 节表没有空位，无法写入图标: " + path)
    pngs = [(size, png_bytes(image, size)) for size in WINDOWS_SIZES]
    raw, entries, data_at = resource_section(pngs)
    section_va = align(size_of_image, section_align)
    for key, at in entries.items():
        struct.pack_into("<I", raw, at, section_va + data_at[key])
    file_off = align(len(data), file_align)
    if file_off > len(data):
        data.extend(b"\0" * (file_off - len(data)))
    raw_size = align(len(raw), file_align)
    struct.pack_into("<8sIIIIIIHHI", data, header_at, b".rsrc\0\0\0", len(raw), section_va, raw_size, file_off, 0, 0, 0, 0, 0x40000040)
    struct.pack_into("<H", data, coff + 2, sections + 1)
    struct.pack_into("<I", data, optional + 56, section_va + align(len(raw), section_align))
    struct.pack_into("<II", data, directories + 16, section_va, len(raw))
    data.extend(raw)
    data.extend(b"\0" * (raw_size - len(raw)))
    with open(path, "r+b") as handle:
        handle.seek(0)
        handle.write(data)
        handle.truncate()
    print("图标 " + os.path.basename(path))


def stamp_app(path, image):
    if not path.endswith(".app") or not os.path.isdir(path):
        raise SystemExit("不是 .app 目录: " + path)
    resources = os.path.join(path, "Contents", "Resources")
    os.makedirs(resources, exist_ok=True)
    icns = os.path.join(resources, "loopra.icns")
    with open(icns, "wb") as handle:
        handle.write(icns_bytes(image))
    plist = os.path.join(path, "Contents", "Info.plist")
    text = open(plist, "r", encoding="utf-8").read()
    if "CFBundleIconFile" not in text:
        text = text.replace(
            "</dict>",
            "\t<key>CFBundleIconFile</key>\n\t<string>loopra</string>\n</dict>",
            1,
        )
        with open(plist, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    zip_path = path[:-4] + ".zip"
    if os.path.isfile(zip_path):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zip-macos-app.py")
        subprocess.check_call([sys.executable, script, path, zip_path])
    print("图标 " + os.path.basename(path))


def stamp_bin(directory):
    image = source_image()
    seen = set()
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            if name.endswith(".app"):
                stamp_app(path, image)
            continue
        ident = (os.stat(path).st_dev, os.stat(path).st_ino)
        if name.endswith(".exe"):
            if ident in seen:
                print("同一文件，跳过 " + name)
                continue
            seen.add(ident)
            inject_exe(path, image)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: appicon.py exe|app|bin PATH")
    kind, path = sys.argv[1], sys.argv[2]
    image = source_image()
    if kind == "exe":
        inject_exe(path, image)
    elif kind == "app":
        stamp_app(path, image)
    elif kind == "bin":
        stamp_bin(path)
    else:
        raise SystemExit("未知种类: " + kind)


if __name__ == "__main__":
    main()
