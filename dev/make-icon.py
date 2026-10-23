# The yadbc icon (python dev/make-icon.py src/Yadbc.Host/yadbc.ico, then copy it to web/public/favicon.ico):
# an indigo rounded square with a white database cylinder, drawn big and scaled down per size.
import sys
from PIL import Image, ImageDraw

def draw(n, bold=False):
    S = 1024
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # vertical gradient square
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    top, bot = (99, 102, 241), (67, 56, 202)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new('L', (S, S), 0)
    pad = 0 if n <= 32 else 40
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - 1 - pad, S - 1 - pad], radius=230 if n > 32 else 200, fill=255)
    img.paste(grad, (0, 0), mask)
    # cylinder
    w = 600 if not bold else 660
    x0, x1 = (S - w) // 2, (S + w) // 2
    eh = 190 if not bold else 210          # ellipse height
    y0, y1 = 250 if not bold else 225, 790 if not bold else 810
    white = (255, 255, 255, 255)
    tint = (199, 210, 254, 255)
    band = (79, 70, 229, 255)
    d.rectangle([x0, y0 + eh // 2, x1, y1 - eh // 2], fill=white)
    d.ellipse([x0, y1 - eh, x1, y1], fill=white)
    d.ellipse([x0, y0, x1, y0 + eh], fill=tint)
    # one band (two at big sizes)
    lw = 34 if n > 32 else 70
    bands = [0.5] if n <= 48 else [0.40, 0.70]
    for f in bands:
        cy = y0 + eh // 2 + (y1 - y0 - eh) * f
        d.arc([x0, cy - eh // 2, x1, cy + eh // 2], 0, 180, fill=band, width=lw)
    return img.resize((n, n), Image.LANCZOS)

sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
frames = [draw(n, bold=n <= 24) for n in sizes]
frames[-1].save(sys.argv[1], format='ICO', sizes=[(n, n) for n in sizes], append_images=frames[:-1])
