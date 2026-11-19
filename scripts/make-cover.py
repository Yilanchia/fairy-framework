"""Cover images for docs/ai.md: the H.D.D. look, in the two shapes a publisher asks for.

    Pillow only, so it runs wherever the bundle does:
    python scripts/make-cover.py  ->  docs/cover-wide.png (1600x900), docs/cover-narrow.png (900x383)
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG = (10, 13, 18)
CYAN = (61, 220, 255)
CYAN_DIM = (29, 127, 150)
AMBER = (255, 196, 0)
WHITE = (234, 246, 255)
DIM = (111, 133, 149)

MONO = "C:/Windows/Fonts/consola.ttf"
MONO_BOLD = "C:/Windows/Fonts/consolab.ttf"
CJK = "C:/Windows/Fonts/msyhbd.ttc"      # Microsoft YaHei Bold
CJK_LIGHT = "C:/Windows/Fonts/msyh.ttc"


def font(path, size):
    return ImageFont.truetype(path, size)


def tracked(draw, xy, text, fnt, fill, spacing):
    """Text with letter spacing — the terminal look depends on it."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + spacing
    return x


def grid(size, step=44, color=CYAN):
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for x in range(0, size[0], step):
        od.line([(x, 0), (x, size[1])], fill=(*color, 14), width=1)
    for y in range(0, size[1], step):
        od.line([(0, y), (size[0], y)], fill=(*color, 14), width=1)
    return overlay


def hazard(draw, x, y, w, h, stripe=12, gap=14):
    draw.rectangle([x, y, x + w, y + h], fill=BG)
    step = stripe + gap
    offset = -h
    while offset < w + h:
        draw.polygon(
            [(x + offset, y + h), (x + offset + stripe, y), (x + offset + stripe + h, y), (x + offset + h, y + h)],
            fill=AMBER,
        )
        offset += step


def brackets(draw, w, h, inset, length, width=3, color=CYAN):
    for (x0, y0, x1, y1) in [
        (inset, inset, inset, inset + length),
        (inset, inset, inset + length, inset),
        (w - inset - length, inset, w - inset, inset),
        (w - inset, inset, w - inset, inset + length),
        (inset, h - inset - length, inset, h - inset),
        (inset, h - inset, inset + length, h - inset),
        (w - inset - length, h - inset, w - inset, h - inset),
        (w - inset, h - inset - length, w - inset, h - inset),
    ]:
        draw.line([(x0, y0), (x1, y1)], fill=color, width=width)


def glow_text(base, xy, text, fnt, color, spacing):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    tracked(ImageDraw.Draw(layer), xy, text, fnt, (*CYAN, 90), spacing)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(9)))
    tracked(ImageDraw.Draw(base), xy, text, fnt, color, spacing)


def wide(size=(1600, 900)):
    base = Image.new("RGBA", size, (*BG, 255))
    base.alpha_composite(grid(size))
    d = ImageDraw.Draw(base)

    glow_text(base, (92, 120), "FAIRY", font(MONO_BOLD, 92), WHITE, 26)
    d = ImageDraw.Draw(base)
    d.text((96, 232), "H . D . D .   S Y S T E M   / /   B U T L E R   O N L I N E", font=font(MONO, 22), fill=CYAN_DIM)

    hazard(d, 96, 266, 660, 18)

    d.text((94, 330), "怎么让一个 AI", font=font(CJK, 76), fill=WHITE)
    d.text((94, 424), "拥有连续的自我", font=font(CJK, 76), fill=CYAN)
    d.text((94, 530), "一份只追加的人生 · 258 条记录 · 同一个她", font=font(CJK_LIGHT, 30), fill=DIM)

    # right column: the claims the article makes, in terminal form
    for index, tag in enumerate(["A P P E N D   O N L Y", "S I N G L E   W R I T E R", "S E L F   !=   B O D Y", "G U A R D   O N"]):
        d.text((1130, 150 + index * 40), tag, font=font(MONO, 17), fill=CYAN_DIM)
    d.text((1128, 330), "258", font=font(MONO_BOLD, 190), fill=(18, 40, 52))
    d.text((1130, 520), "e v e n t s", font=font(MONO, 17), fill=CYAN_DIM)

    d.text((96, 800), "github.com/Yilanchia/fairy-framework", font=font(MONO, 22), fill=CYAN_DIM)
    brackets(d, *size, inset=48, length=120)

    return base.convert("RGB")


def narrow(size=(900, 383)):
    base = Image.new("RGBA", size, (*BG, 255))
    base.alpha_composite(grid(size, step=32))
    d = ImageDraw.Draw(base)

    d.text((58, 52), "F A I R Y", font=font(MONO_BOLD, 40), fill=WHITE)
    d.text((58, 104), "H.D.D.  / /  B U T L E R", font=font(MONO, 15), fill=CYAN_DIM)
    hazard(d, 58, 132, 372, 12)

    d.text((58, 170), "怎么让一个 AI", font=font(CJK, 44), fill=WHITE)
    d.text((58, 224), "拥有连续的自我", font=font(CJK, 44), fill=CYAN)
    d.text((58, 300), "只追加的人生 · 258 条记录", font=font(CJK_LIGHT, 20), fill=DIM)

    d.text((560, 300), "fairy-framework", font=font(MONO, 16), fill=CYAN_DIM)
    brackets(d, *size, inset=26, length=64, width=2)

    return base.convert("RGB")


wide().save("docs/cover-wide.png", optimize=True)
narrow().save("docs/cover-narrow.png", optimize=True)
print("wrote docs/cover-wide.png (1600x900) and docs/cover-narrow.png (900x383)")
