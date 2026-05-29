#!/usr/bin/env python3
"""Grade a Draw Things 'fold' aura to Reverie's palette.

FLUX gives great folding structure but a wandering palette (magenta/teal). We
keep only its luminance/structure and re-map it through a warm gradient
(deep warm-black -> dusty clay/rose -> cream), then add fine film grain. This
locks the result to a muted warm aura, no orange, no second hue.
"""

import os
import sys
from PIL import Image, ImageOps, ImageEnhance, ImageChops, ImageFilter

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "aura")
OUT = os.path.join(HERE, "graded")
os.makedirs(OUT, exist_ok=True)

# warm gradient-map ramp
BLACK = (11, 9, 8)
MID = (150, 86, 70)      # dusty terracotta / clay-rose
WHITE = (240, 223, 199)  # soft cream
MIDPOINT = 120


def gradient_map(lum):
    return ImageOps.colorize(lum, black=BLACK, mid=MID, white=WHITE,
                             blackpoint=0, midpoint=MIDPOINT, whitepoint=255)


def add_grain(img, strength=0.5, sigma=26):
    """Fine film grain via an overlay of mid-gray noise."""
    w, h = img.size
    noise = Image.effect_noise((w, h), sigma).convert("L")
    noise_rgb = Image.merge("RGB", (noise, noise, noise))
    overlaid = ImageChops.overlay(img, noise_rgb)
    return Image.blend(img, overlaid, strength)


def grade(name, contrast=1.12, black_lift=0.0, grain=0.5, blur=0.0):
    src = Image.open(os.path.join(SRC, f"{name}.png")).convert("RGB")
    # luminance / structure only
    lum = ImageOps.grayscale(src)
    if blur:
        lum = lum.filter(ImageFilter.GaussianBlur(blur))
    # deepen contrast so blacks stay deep and a highlight survives
    lum = ImageEnhance.Contrast(lum).enhance(contrast)
    graded = gradient_map(lum)
    graded = add_grain(graded, strength=grain)
    out = os.path.join(OUT, f"{name}-graded.png")
    graded.save(out)
    print("wrote", out)
    return out


if __name__ == "__main__":
    targets = sys.argv[1:] or ["fold-02-faithful", "fold-03-warm",
                                "fold-04-warm"]
    for t in targets:
        grade(t)
