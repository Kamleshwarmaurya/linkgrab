#!/usr/bin/env python3
"""Generate the LinkGrab app icon (original artwork) -> build/icon.png and build/icon.ico.

Design: rounded dark square, bright downward arrow dropping into an open tray.
Usage: python3 scripts/make-icon.py
Requires: pillow
"""
import os
from PIL import Image, ImageDraw

SS = 4            # supersampling factor
BASE = 1024       # master canvas size (before supersampling)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_master():
    n = BASE * SS
    s = n / 1024.0
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # Background: vertical gradient clipped to a rounded square
    top, bot = (34, 40, 62), (14, 17, 30)
    grad = Image.new("RGBA", (n, n))
    gd = ImageDraw.Draw(grad)
    for y in range(n):
        gd.line([(0, y), (n, y)], fill=lerp(top, bot, y / (n - 1)) + (255,))
    mask = Image.new("L", (n, n), 0)
    pad = int(40 * s)
    ImageDraw.Draw(mask).rounded_rectangle(
        [pad, pad, n - pad, n - pad], radius=int(220 * s), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # Subtle inner border
    d.rounded_rectangle([pad, pad, n - pad, n - pad], radius=int(220 * s),
                        outline=(255, 255, 255, 28), width=int(6 * s))

    accent = (0, 214, 170, 255)      # bright teal-green arrow
    accent2 = (90, 140, 255, 255)    # blue tray

    def P(x, y):
        return (x * s, y * s)

    # Arrow shaft
    d.rounded_rectangle([*P(440, 190), *P(584, 560)], radius=int(40 * s), fill=accent)
    # Arrow head
    d.polygon([P(290, 480), P(734, 480), P(512, 735)], fill=accent)

    # Tray: U shape
    tw = 64
    d.rounded_rectangle([*P(250, 640), *P(250 + tw, 810)], radius=int(30 * s), fill=accent2)
    d.rounded_rectangle([*P(774 - tw, 640), *P(774, 810)], radius=int(30 * s), fill=accent2)
    d.rounded_rectangle([*P(250, 746), *P(774, 810)], radius=int(32 * s), fill=accent2)

    return img.resize((BASE, BASE), Image.LANCZOS)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "build")
    os.makedirs(out, exist_ok=True)
    master = draw_master()
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(out, "icon.png"))
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(os.path.join(out, "icon.ico"), format="ICO", sizes=sizes)
    print("wrote", os.path.join(out, "icon.png"), "and icon.ico")


if __name__ == "__main__":
    main()
