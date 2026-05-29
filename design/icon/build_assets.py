#!/usr/bin/env python3
"""Build the full Tauri/macOS/Windows icon asset set from the chosen aura
(graded fold-04), shaped into a macOS squircle. Pure aura, no letter."""

import os
import subprocess
from PIL import Image, ImageFilter

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "graded", "fold-04-warm-graded.png")
BUILD = os.path.join(HERE, "build")
os.makedirs(BUILD, exist_ok=True)

BASE = 1024
MARGIN = 96            # ~832 body, macOS-correct transparent margin


def squircle_mask(size, inset, n=5.0):
    m = Image.new("L", (size, size), 0)
    px = m.load()
    c = size / 2.0
    a = (size - 2 * inset) / 2.0
    for y in range(size):
        ny = (y + 0.5 - c) / a
        if abs(ny) > 1:
            continue
        ay = abs(ny) ** n
        for x in range(size):
            nx = (x + 0.5 - c) / a
            if ay + abs(nx) ** n <= 1:
                px[x, y] = 255
    return m


def cover_resize(img, size):
    img = img.convert("RGB")
    w, h = img.size
    s = max(size / w, size / h)
    img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    x = (img.width - size) // 2
    y = (img.height - size) // 2
    return img.crop((x, y, x + size, y + size))


def master():
    body = BASE - 2 * MARGIN
    aura = cover_resize(Image.open(SRC), body)
    canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    canvas.paste(aura, (MARGIN, MARGIN))
    canvas.putalpha(squircle_mask(BASE, MARGIN))
    return canvas


ICONSET = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
TAURI_PNGS = [
    ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256),
    ("icon.png", 1024),
    ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
]


def main():
    m = master()
    m.save(os.path.join(BUILD, "_master-1024.png"))

    def at(px):
        return m.resize((px, px), Image.LANCZOS)

    for name, px in TAURI_PNGS:
        at(px).save(os.path.join(BUILD, name))

    iconset = os.path.join(BUILD, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for name, px in ICONSET:
        at(px).save(os.path.join(iconset, name))
    r = subprocess.run(["iconutil", "-c", "icns", iconset,
                        "-o", os.path.join(BUILD, "icon.icns")])
    print("icns:", "ok" if r.returncode == 0 else "FAILED")

    ico_dir = os.path.join(BUILD, "_ico")
    os.makedirs(ico_dir, exist_ok=True)
    inputs = []
    for px in ICO_SIZES:
        p = os.path.join(ico_dir, f"{px}.png")
        at(px).save(p)
        inputs.append(p)
    r = subprocess.run(["magick"] + inputs + [os.path.join(BUILD, "icon.ico")])
    print("ico:", "ok" if r.returncode == 0 else "FAILED")
    import shutil
    shutil.rmtree(ico_dir, ignore_errors=True)
    print("built in", BUILD)


if __name__ == "__main__":
    main()
