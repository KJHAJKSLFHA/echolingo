#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 macOS 应用图标 desktop/icon.icns。

画法：蓝色圆角方块 + 白色 EL，四周留出 macOS 风格的边距。
只用 Pillow 画主图，缩放交给系统的 sips，最后用 iconutil 合成 icns。
"""

import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MASTER = os.path.join(HERE, "icon-1024.png")
ICONSET = os.path.join(HERE, "icon.iconset")
ICNS = os.path.join(HERE, "icon.icns")

SIZE = 1024
INSET = 96                      # macOS 图标四周的留白
RADIUS = 210
TOP = (47, 127, 245)            # #2f7ff5
BOTTOM = (23, 92, 208)          # #175cd0
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def make_master() -> None:
    # 竖直渐变
    grad = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        grad.putpixel((0, y), tuple(
            round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)
        ))
    grad = grad.resize((SIZE, SIZE))

    # 圆角遮罩
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [INSET, INSET, SIZE - INSET, SIZE - INSET], radius=RADIUS, fill=255
    )

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    # 白色 EL 居中
    font = None
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            for size in range(430, 200, -10):
                try:
                    font = ImageFont.truetype(path, size)
                    break
                except OSError:
                    continue
            if font:
                break
    if font is None:
        print("警告：没找到可用字体，退化为 Pillow 默认字体", file=sys.stderr)
        font = ImageFont.load_default()

    draw = ImageDraw.Draw(icon)
    text = "EL"
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(
        ((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1] - 12),
        text, font=font, fill=(255, 255, 255, 255),
    )

    icon.save(MASTER)
    print("主图:", MASTER)


def build_iconset() -> None:
    if os.path.isdir(ICONSET):
        shutil.rmtree(ICONSET)
    os.makedirs(ICONSET)
    # iconutil 要求的固定文件名 → 像素尺寸
    plan = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    for name, px in plan.items():
        subprocess.run(
            ["sips", "-z", str(px), str(px), MASTER, "--out", os.path.join(ICONSET, name)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    print("iconset:", ICONSET)


def build_icns() -> None:
    subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", ICNS], check=True)
    print("icns:", ICNS, os.path.getsize(ICNS), "bytes")


if __name__ == "__main__":
    make_master()
    build_iconset()
    build_icns()
