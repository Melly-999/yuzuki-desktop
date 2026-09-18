"""Generate minimal Tauri icons (PNG family + Windows ICO).

Tauri requires these files to exist for the bundle config and to embed into the
Windows .exe. We use a simple gradient circle on a transparent background.
"""
from PIL import Image, ImageDraw
import os

ICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")
ICON_DIR = os.path.normpath(ICON_DIR)
os.makedirs(ICON_DIR, exist_ok=True)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # violet-to-indigo gradient circle (Yuzuki palette)
    pad = max(1, size // 16)
    for i in range(size):
        t = i / max(1, size - 1)
        r = int((1 - t) * 167 + t * 99)   # #A700B0 -> #6357FF
        g = int((1 - t) * 0   + t * 87)
        b = int((1 - t) * 255 + t * 255)
        draw.line([(i, pad), (i, size - pad)], fill=(r, g, b, 255))
    # center mask: round corners
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([pad, pad, size - pad, size - pad], fill=255)
    img.putalpha(mask)
    return img


# PNG family
sizes = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256}
for name, sz in sizes.items():
    out = os.path.join(ICON_DIR, name)
    make_icon(sz).save(out, "PNG")
    print(f"wrote {out}")

# Multi-resolution Windows ICO
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_imgs = [make_icon(s) for s in ico_sizes]
ico_path = os.path.join(ICON_DIR, "icon.ico")
ico_imgs[0].save(
    ico_path,
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
    append_images=ico_imgs[1:],
)
print(f"wrote {ico_path}")

# macOS ICNS — Tauri only reads it on macOS bundle, but the config lists it.
# A valid empty ICNS placeholder (1x1) is fine for Windows-only dev/build.
# Use a 512px PNG wrapped in ICNS by writing the ic09 atom.
icns_path = os.path.join(ICON_DIR, "icon.icns")
big = make_icon(512)
tmp_png = os.path.join(ICON_DIR, "_icns_src.png")
big.save(tmp_png, "PNG")
with open(tmp_png, "rb") as f:
    png_bytes = f.read()

# Minimal ICNS with one 'ic09' (512x512 PNG) atom
import struct

def icns_atom(tag: bytes, payload: bytes) -> bytes:
    return tag + struct.pack(">I", len(payload) + 8) + payload

icns = b"icns" + struct.pack(">I", 8 + 8 + len(png_bytes)) + icns_atom(b"ic09", png_bytes)
with open(icns_path, "wb") as f:
    f.write(icns)
print(f"wrote {icns_path}")

os.remove(tmp_png)
print("done")
