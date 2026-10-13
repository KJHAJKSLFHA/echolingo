#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 HuggingFace 下载西语相关的模型，铺成 transformers.js 的本地模型布局。

要下三个：
  Xenova/whisper-tiny   → app/models/whisper-tiny    多语言版，能识别西语
  Xenova/whisper-base   → app/models/whisper-base    同上，默认（更准）
  Xenova/opus-mt-es-en  → app/models/opus-mt-es-en   西→英，配合已有的 en→zh 做两跳翻译

注意 whisper 的 .en 后缀是**纯英语**模型，不认西语，所以西语必须另下多语言版。

网络在这台机器上间歇性抽风（同一分钟里 github 可能 0.9s 返回、下一分钟连 75 秒超时），
所以每个文件都带重试，并且下载到临时文件、校验通过才改名 —— 半截文件绝不留下来。
"""

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS = os.path.join(ROOT, "app", "models")

REPOS = {
    "whisper-tiny": "Xenova/whisper-tiny",
    "whisper-base": "Xenova/whisper-base",
    "opus-mt-es-en": "Xenova/opus-mt-es-en",
}

# 每个模型需要的文件。transformers.js 只会去要这些，其余（fp16/bnb4 等）不必下载。
WHISPER_FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "added_tokens.json",
    "normalizer.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
]

MT_FILES = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "source.spm",
    "target.spm",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
]

CTX = ssl.create_default_context()


def api(url, tries=6):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "echolingo-setup"})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:                       # noqa: BLE001
            last = e
            time.sleep(2 + i * 3)
    raise RuntimeError(f"接口请求失败 {url}: {last}")


def download(url, dest, tries=8):
    """下载到 .part，完整了才改名。已存在且大小吻合就跳过。"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return "cached"
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "echolingo-setup"})
            with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
                total = int(r.headers.get("content-length") or 0)
                got = 0
                with open(tmp, "wb") as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            pct = got * 100 // total
                            sys.stdout.write(f"\r      {pct:3d}%  {got/1048576:6.1f}/{total/1048576:.1f} MB")
                            sys.stdout.flush()
            sys.stdout.write("\r" + " " * 46 + "\r")
            if total and got != total:
                raise IOError(f"大小不符 收到 {got} 期望 {total}")
            os.replace(tmp, dest)
            return "ok"
        except Exception as e:                       # noqa: BLE001
            last = e
            print(f"      第 {i+1}/{tries} 次失败：{e}，重试…")
            time.sleep(3 + i * 4)
    raise RuntimeError(f"下载失败 {url}: {last}")


def main():
    for local_id, repo in REPOS.items():
        print(f"\n=== {repo}  →  app/models/{local_id}/ ===")
        meta = api(f"https://huggingface.co/api/models/{repo}")
        have = {f["rfilename"] for f in meta.get("siblings", [])}
        want = WHISPER_FILES if "whisper" in repo else MT_FILES
        missing = [f for f in want if f not in have]
        if missing:
            print(f"  ⚠ 仓库里没有这些文件，跳过：{missing}")
        out_dir = os.path.join(MODELS, local_id)
        total = 0
        for rel in want:
            if rel not in have:
                continue
            url = f"https://huggingface.co/{repo}/resolve/main/{rel}"
            dest = os.path.join(out_dir, rel)
            print(f"  {rel}")
            state = download(url, dest)
            size = os.path.getsize(dest) if os.path.exists(dest) else 0
            total += size
            if state == "cached":
                print(f"      已存在，跳过（{size/1048576:.1f} MB）")
        print(f"  → 合计 {total/1048576:.0f} MB")

    print("\n全部完成。")
    for local_id in REPOS:
        d = os.path.join(MODELS, local_id)
        if os.path.isdir(d):
            n = sum(len(f) for _, _, f in os.walk(d))
            sz = sum(os.path.getsize(os.path.join(r, f))
                     for r, _, fs in os.walk(d) for f in fs)
            print(f"  {local_id:20} {n:3d} 个文件  {sz/1048576:6.1f} MB")


if __name__ == "__main__":
    main()
