"""Generate docs/social-preview.png (1280x640) for GitHub / link previews. Needs Pillow."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1280, 640
BG, PANEL, TEXT, MUTED, ACCENT = (20, 22, 26), (30, 34, 41), (236, 239, 244), (150, 160, 175), (59, 130, 246)
FONT_DIR = "/usr/share/fonts/truetype/dejavu/"

def font(name, size):
    try:
        return ImageFont.truetype(FONT_DIR + name, size)
    except OSError:
        return ImageFont.load_default()

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle accent band
d.rectangle([0, 0, 10, H], fill=ACCENT)

icon = Image.open(os.path.join("build", "icon.png")).convert("RGBA").resize((168, 168), Image.LANCZOS)
img.paste(icon, (90, 90), icon)

d.text((290, 92), "LinkGrab", font=font("DejaVuSans-Bold.ttf", 84), fill=TEXT)
d.text((292, 196), "Free IDM-style video and image downloader", font=font("DejaVuSans.ttf", 34), fill=MUTED)

d.text((90, 318), "Paste a link. Pick the quality. Download.", font=font("DejaVuSans-Bold.ttf", 44), fill=TEXT)

chips = ["YouTube", "Facebook", "LinkedIn", "X (Twitter)", "Instagram"]
x, y = 90, 410
f = font("DejaVuSans-Bold.ttf", 28)
for c in chips:
    w = int(d.textlength(c, font=f)) + 44
    d.rounded_rectangle([x, y, x + w, y + 60], radius=30, fill=PANEL, outline=(55, 62, 74), width=2)
    d.text((x + 22, y + 13), c, font=f, fill=TEXT)
    x += w + 16

d.text((90, 530), "Videos + images  |  Windows installer + portable  |  Open source (MIT)", font=font("DejaVuSans.ttf", 28), fill=MUTED)
d.text((90, 580), "github.com/Kamleshwarmaurya/linkgrab", font=font("DejaVuSansMono.ttf", 26), fill=ACCENT)

img.save(os.path.join("docs", "social-preview.png"), optimize=True)
print("saved", img.size)
