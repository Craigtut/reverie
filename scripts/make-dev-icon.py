#!/usr/bin/env python3
"""make-dev-icon.py - stamp a small white "dev" badge onto the app icon and
generate the dev channel icon set.

The dev build runs from a separate bundle identifier; this gives it a visibly
different Dock/Finder icon so it can never be mistaken for a real install. We
composite a rounded white badge with dark "dev" text into the lower-left of the
production master icon, then hand the result to `tauri icon`, which produces the
icns/ico/png set the dev config (tauri.dev.conf.json) points at.

Run after the production icon changes:  python3 scripts/make-dev-icon.py
Requires Pillow (preinstalled on this machine) and the Tauri CLI (npx tauri).
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ICON = REPO_ROOT / "apps/desktop/src-tauri/icons/icon.png"
OUT_DIR = REPO_ROOT / "apps/desktop/src-tauri/icons-dev"
SOURCE_PNG = OUT_DIR / "source.png"

# Fonts to try in order; first one that loads wins. Arial Bold is a static face
# (no variation dance) and present on every macOS, so it leads.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]

BADGE_TEXT = "dev"
TEXT_COLOR = (43, 38, 34, 255)  # warm near-black, matches the product palette
BADGE_FILL = (255, 255, 255, 255)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def make_source() -> None:
    if not SRC_ICON.exists():
        sys.exit(f"make-dev-icon: missing source icon {SRC_ICON}")

    base = Image.open(SRC_ICON).convert("RGBA")
    w, h = base.size

    # Badge geometry, scaled to the master size so this works at any resolution.
    margin = round(w * 0.066)
    badge_w = round(w * 0.39)
    badge_h = round(h * 0.187)
    radius = round(badge_h * 0.30)
    x0 = margin
    y0 = h - margin - badge_h
    x1 = x0 + badge_w
    y1 = y0 + badge_h

    # Soft drop shadow so the badge reads on both light and dark icon art.
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    offset = round(h * 0.012)
    sdraw.rounded_rectangle(
        [x0, y0 + offset, x1, y1 + offset], radius=radius, fill=(0, 0, 0, 90)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(round(h * 0.014)))
    base = Image.alpha_composite(base, shadow)

    # The badge itself, drawn on its own layer for clean anti-aliasing.
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=BADGE_FILL)

    # Fit the text to ~58% of the badge height, then center it in the badge.
    font_size = round(badge_h * 0.58)
    font = load_font(font_size)
    tb = odraw.textbbox((0, 0), BADGE_TEXT, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    tx = x0 + (badge_w - tw) / 2 - tb[0]
    ty = y0 + (badge_h - th) / 2 - tb[1]
    odraw.text((tx, ty), BADGE_TEXT, font=font, fill=TEXT_COLOR)

    composed = Image.alpha_composite(base, overlay)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    composed.save(SOURCE_PNG)
    print(f"make-dev-icon: wrote {SOURCE_PNG.relative_to(REPO_ROOT)} ({w}x{h})")


def make_icon_set() -> None:
    # tauri icon turns the single composed PNG into the full icns/ico/png set.
    print("make-dev-icon: generating icon set via `tauri icon`...")
    result = subprocess.run(
        ["npx", "tauri", "icon", str(SOURCE_PNG), "-o", str(OUT_DIR)],
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        sys.exit("make-dev-icon: `tauri icon` failed")
    print(f"make-dev-icon: icon set written to {OUT_DIR.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    make_source()
    make_icon_set()
