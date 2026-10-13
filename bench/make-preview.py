#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把截到的真实截图整理成两张预览图，供确认方案。

产出：
  shots/preview-1-compare.png   前后对比 + 控件位置
  shots/preview-2-styles.png    四种模糊样式对比
"""

import json
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(ROOT, "shots")

# 视频**内容区**（去掉上下黑边）在截图里的位置，由 mock-blur.mjs 实测写出
_G = json.load(open(os.path.join(SHOTS, "geom.json")))
VIDEO_BOX = (round(_G["x"]), round(_G["y"]), round(_G["x"] + _G["w"]), round(_G["y"] + _G["h"]))
# 播放器栏的横条（由 mock-blur.mjs 实测写出），用来做「开关在哪」的放大插图
_B = _G["bar"]
BAR_BOX = (round(_B["x"]), round(_B["y"]), round(_B["x"] + _B["w"]), round(_B["y"] + _B["h"]))

BG = (14, 17, 22)
PANEL = (22, 26, 33)
LINE = (44, 51, 62)
TEXT = (232, 238, 248)
DIM = (150, 162, 180)
BRAND = (47, 127, 245)

FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def text(draw, xy, s, f, fill, anchor="la"):
    draw.text(xy, s, font=f, fill=fill, anchor=anchor)


def rounded(img, radius):
    """给图片加圆角遮罩"""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def blur_band(frame, top_ratio=0.905, bottom_ratio=0.987, kind="soft", radius=22, feather=0.30):
    """在视频帧底部的字幕带上应用一种处理，返回新图。

    字幕在 1920x1080 里大约落在 y=989..1034，即 0.916~0.957；
    这里留出余量取 0.905~0.987（约 8%）作为「字幕安全区」。
    """
    w, h = frame.size
    y0, y1 = int(h * top_ratio), int(h * bottom_ratio)
    band = frame.crop((0, y0, w, y1))

    if kind == "soft":
        processed = band.filter(ImageFilter.GaussianBlur(radius))
    elif kind == "frosted":
        processed = band.filter(ImageFilter.GaussianBlur(radius + 6))
        # 轻微提亮，像一块毛玻璃
        processed = Image.blend(processed, Image.new("RGB", band.size, (255, 255, 255)), 0.06)
    elif kind == "mosaic":
        small = band.resize((max(1, w // 26), max(1, band.size[1] // 14)), Image.BILINEAR)
        processed = small.resize(band.size, Image.NEAREST)
    elif kind == "solid":
        processed = Image.new("RGB", band.size, (8, 10, 14))
    else:
        processed = band

    # 上下羽化，避免出现一条生硬的横杠
    fh = max(2, int(band.size[1] * feather))
    mask = Image.new("L", band.size, 255)
    md = ImageDraw.Draw(mask)
    for i in range(fh):
        v = int(255 * (i / fh))
        md.line([(0, i), (w, i)], fill=v)
        md.line([(0, band.size[1] - 1 - i), (w, band.size[1] - 1 - i)], fill=v)

    out = frame.copy()
    out.paste(processed, (0, y0), mask)
    return out


def label_chip(draw, xy, s, f, fg=TEXT, bg=(0, 0, 0, 170)):
    x, y = xy
    bbox = draw.textbbox((0, 0), s, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad_x, pad_y = 12, 7
    draw.rounded_rectangle(
        [x, y, x + tw + pad_x * 2, y + th + pad_y * 2 + 4],
        radius=9, fill=bg,
    )
    draw.text((x + pad_x, y + pad_y), s, font=f, fill=fg)
    return tw + pad_x * 2


# ---------------------------------------------------------------- 预览图 1

def build_compare():
    full_off = Image.open(os.path.join(SHOTS, "ui-off.png")).convert("RGB")
    full_on = Image.open(os.path.join(SHOTS, "ui-on.png")).convert("RGB")
    off = full_off.crop(VIDEO_BOX)
    on = full_on.crop(VIDEO_BOX)

    W = 1560
    pad = 40
    gap = 26
    half = (W - pad * 2 - gap) // 2
    scale = half / off.size[0]
    ph = int(off.size[1] * scale)
    off_s = off.resize((half, ph), Image.LANCZOS)
    on_s = on.resize((half, ph), Image.LANCZOS)

    # 细节放大：视频内容底部 26%（字幕所在）原始分辨率裁切
    gx, gy, gw, gh = VIDEO_BOX[0], VIDEO_BOX[1], VIDEO_BOX[2] - VIDEO_BOX[0], VIDEO_BOX[3] - VIDEO_BOX[1]
    zb = (gx, int(gy + gh * 0.735), gx + gw, gy + gh)
    z_off = full_off.crop(zb).resize((half, int((zb[3] - zb[1]) * scale)), Image.LANCZOS)
    z_on = full_on.crop(zb).resize((half, int((zb[3] - zb[1]) * scale)), Image.LANCZOS)

    header_h = 172
    zoom_h = z_off.size[1]
    panel_h = 138
    H = header_h + ph + 46 + 40 + zoom_h + 30 + panel_h + 34
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)

    f_title = font(34)
    f_sub = font(19)
    f_tag = font(21)
    f_small = font(17)
    f_tiny = font(15)

    text(d, (pad, 32), "新功能预览 · 自动模糊画面里的烧录字幕", f_title, TEXT)
    text(d, (pad, 82), "强制自己先听，而不是读字幕。下面是真实 App 的截图（功能已注入运行中的程序），不是效果图。",
         f_sub, DIM)
    text(d, (pad, 112), "关闭 = 现在的样子        开启 = 字幕被就地模糊，画面其余部分完全不动",
         f_sub, DIM)
    text(d, (pad, 140), "遮罩只覆盖视频底部约 8% 的「字幕安全区」，上下羽化过渡，所以不会出现一条生硬的横杠。",
         f_tiny, (120, 132, 148))

    y = header_h
    x1, x2 = pad, pad + half + gap
    canvas.paste(rounded(off_s, 14), (x1, y), rounded(off_s, 14))
    canvas.paste(rounded(on_s, 14), (x2, y), rounded(on_s, 14))
    d.rounded_rectangle([x1, y, x1 + half, y + ph], 14, outline=LINE, width=2)
    d.rounded_rectangle([x2, y, x2 + half, y + ph], 14, outline=BRAND, width=2)
    label_chip(d, (x1 + 16, y + 16), "关闭（现在）", f_tag)
    label_chip(d, (x2 + 16, y + 16), "开启后", f_tag, fg=(255, 255, 255), bg=(31, 111, 235, 215))

    # 细节放大
    yz = y + ph + 46
    text(d, (pad, yz - 32), "同一位置原始分辨率放大（看得出上面那点差别到底有多大）", f_tiny, DIM)
    canvas.paste(rounded(z_off, 10), (x1, yz), rounded(z_off, 10))
    canvas.paste(rounded(z_on, 10), (x2, yz), rounded(z_on, 10))
    d.rounded_rectangle([x1, yz, x1 + half, yz + zoom_h], 10, outline=LINE, width=2)
    d.rounded_rectangle([x2, yz, x2 + half, yz + zoom_h], 10, outline=BRAND, width=2)

    # 入口 + 播放器栏插图
    y2 = yz + zoom_h + 30
    d.rounded_rectangle([pad, y2, W - pad, y2 + panel_h], 12, fill=PANEL, outline=LINE, width=1)
    text(d, (pad + 20, y2 + 16), "入口有两处：", f_tag, TEXT)
    text(d, (pad + 20, y2 + 52), "① 播放器栏新增「模糊字幕」开关（默认关）", f_small, DIM)
    text(d, (pad + 20, y2 + 78), "② 鼠标移到画面上出现小提示条，按住 Alt 临时看原文（想核对就核对）", f_small, DIM)
    text(d, (pad + 20, y2 + 104), "设置里可选：模糊强度、遮罩样式（见下一张）、自动检测范围", f_small, DIM)

    bar = full_on.crop(BAR_BOX)
    bw = 600
    bar_s = bar.resize((bw, int(bar.size[1] * bw / bar.size[0])), Image.LANCZOS)
    bxp = W - pad - bw - 18
    byp = y2 + 14
    canvas.paste(rounded(bar_s, 8), (bxp, byp), rounded(bar_s, 8))
    d.rounded_rectangle([bxp, byp, bxp + bw, byp + bar_s.size[1]], 8, outline=BRAND, width=2)
    text(d, (bxp, byp + bar_s.size[1] + 6), "↑ 播放器栏里的新开关（蓝底 = 已开启）", f_tiny, DIM)

    out = os.path.join(SHOTS, "preview-1-compare.png")
    canvas.save(out)
    print("已生成", out, canvas.size)


# ---------------------------------------------------------------- 预览图 2

def build_styles():
    frame = Image.open(os.path.join(SHOTS, "pureframe.png")).convert("RGB")
    fw, fh = frame.size

    kinds = [
        ("soft", "柔和模糊", "最自然，看不出遮罩边界；推荐默认", 22),
        ("frosted", "毛玻璃", "带一点提亮和质感，像一块磨砂贴片", 28),
        ("mosaic", "马赛克", "完全看不出字形，最「干净利落」", 0),
        ("solid", "纯色遮罩条", "最彻底，但会挡住画面底部的其他信息", 0),
    ]

    W = 1560
    pad = 40
    gap = 22
    cols, rows = 2, 2
    cw = (W - pad * 2 - gap * (cols - 1)) // cols
    ch = int(fh * (cw / fw))
    header_h = 132
    cap_h = 62
    H = header_h + rows * (ch + cap_h) + gap + pad
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)

    f_title = font(32)
    f_sub = font(18)
    f_name = font(22)
    f_desc = font(16)

    text(d, (pad, 30), "四种遮罩样式（同一帧，真实画面）", f_title, TEXT)
    text(d, (pad, 76), "字幕带取视频内容底部约 8%（字幕安全区），上下羽化过渡，所以不会出现一条生硬的横杠。", f_sub, DIM)

    for i, (kind, name, desc, radius) in enumerate(kinds):
        r, c = divmod(i, cols)
        x = pad + c * (cw + gap)
        y = header_h + r * (ch + cap_h + gap)
        img = blur_band(frame, kind=kind, radius=radius).resize((cw, ch), Image.LANCZOS)
        canvas.paste(rounded(img, 12), (x, y), rounded(img, 12))
        d.rounded_rectangle([x, y, x + cw, y + ch], 12, outline=LINE, width=2)
        text(d, (x, y + ch + 12), name, f_name, TEXT)
        text(d, (x, y + ch + 40), desc, f_desc, DIM)

    out = os.path.join(SHOTS, "preview-2-styles.png")
    canvas.save(out)
    print("已生成", out, canvas.size)


if __name__ == "__main__":
    build_compare()
    build_styles()
