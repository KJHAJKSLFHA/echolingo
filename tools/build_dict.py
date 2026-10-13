#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 ECDICT 原始 CSV 构建本应用使用的离线词典。

输入 : ecdict.csv  (word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio)
       lemma.en.txt (词形还原表)

输出 :
  dict/core.json    高频核心词(保证首屏零延迟查词)
  dict/<a-z>.json   按首字母分片, 按需懒加载
  dict/_misc.json   非 a-z 开头的条目
  dict/lemma.json   变形 -> 原形
  dict/meta.json    统计信息

每条记录使用紧凑数组格式以压缩体积:
  { "word": [ "音标", "中文释义", "词性串", "英文释义", 词频, 词形变化 ] }
后两项为空字符串 / 0 时省略。
"""
import csv
import json
import os
import re
import sys
import collections

SRC = sys.argv[1] if len(sys.argv) > 1 else "ecdict.csv"
LEMMA_SRC = sys.argv[2] if len(sys.argv) > 2 else "lemma.en.txt"
OUT = sys.argv[3] if len(sys.argv) > 3 else "dict"

CORE_N = 3500          # 核心词条数, 内联首屏
SHRINK_LIMIT = 34000   # 保留的高频词条上限
DEF_LIMIT = 12000      # 保留英文释义的词频阈值

WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z'\-]*$")
SENSE_SPLIT = re.compile(r"(?:\\n|\n|[；;。])")
DOMAIN_TAG = re.compile(r"^[\[\(][^\]\)]{1,8}[\]\)]\s*")
FULLWIDTH = str.maketrans({"，": " ", "；": " ", "：": " ", "（": " ", "）": " ", "\u3000": " "})

# ECDICT 的音标混用了西里尔字母与希腊字母，且用 ':' 充当长音符，统一成标准 IPA
PHON_MAP = str.maketrans({
    "ә": "ə",   # 西里尔 schwa
    "є": "ɛ",   # 西里尔 ie
    "ε": "ɛ",   # 希腊 epsilon
    "ɡ": "g",   # IPA g
    "ˊ": "ˈ", "´": "ˈ", "'": "ˈ",
    ":": "ː",
    "ū": "u",
    "\u00a0": " ",
    "\ue143": "",
})
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def norm_phonetic(s):
    s = (s or "").translate(PHON_MAP)
    s = CJK_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def rank_of(row):
    """越低越常用。ECDICT 的 bnc / frq 为 0 表示未收录排名。"""
    def num(v):
        try:
            return int(v)
        except Exception:
            return 0
    bnc, frq = num(row.get("bnc")), num(row.get("frq"))
    cand = [x for x in (bnc, frq) if x > 0]
    return min(cand) if cand else 0


def clean_translation(text):
    """压缩为一行, 最多 3 个义项, 控制整体长度。"""
    if not text:
        return ""
    text = text.replace("\\n", "\n")
    out, total = [], 0
    for raw in SENSE_SPLIT.split(text):
        p = raw.strip()
        while True:
            m = DOMAIN_TAG.match(p)
            if not m:
                break
            p = p[m.end():].strip()
        p = p.translate(FULLWIDTH).strip(" ,、")
        p = re.sub(r"\s+", " ", p)
        if not p or len(p) < 1:
            continue
        if total + len(p) > 130 and out:
            break
        out.append(p)
        total += len(p)
        if len(out) >= 3:
            break
    return "；".join(out)


def clean_definition(text):
    if not text:
        return ""
    text = text.replace("\\n", "\n")
    parts = []
    for raw in SENSE_SPLIT.split(text):
        p = DOMAIN_TAG.sub("", raw.strip()).translate(FULLWIDTH).strip()
        if p:
            parts.append(p)
    return " / ".join(parts[:2])[:150]


def suffix_ok(base, form):
    """校验 form 是否真的是 base 的规则屈折形式。"""
    cands = {
        base + 's', base + 'es', base + 'ed', base + 'd', base + 'ing',
        base + 'er', base + 'est', base + 'ly', base + 'ies', base + 'ied',
        base + 'ier', base + 'iest',
        base[:-1] + 'ies', base[:-1] + 'ied', base[:-1] + 'ier', base[:-1] + 'iest',
        base[:-1] + 'ing', base[:-1] + 'ed', base[:-1] + 'es',
        base + base[-1] + 'ing', base + base[-1] + 'ed',
        base + "'s",
    }
    if base.endswith('y'):
        cands.add(base[:-1] + 'ies')
        cands.add(base[:-1] + 'ied')
    if base.endswith('e'):
        cands.add(base[:-1] + 'ing')
    return form in cands


def main():
    os.makedirs(OUT, exist_ok=True)
    buckets = collections.defaultdict(dict)
    lemma = {}

    print("读取 %s ..." % SRC, file=sys.stderr)
    with open(SRC, "r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        rows = list(reader)
    print("共 %d 行" % len(rows), file=sys.stderr)

    for r in rows:
        w = (r.get("word") or "").strip()
        if not w or not WORD_RE.match(w):
            continue
        trans = clean_translation(r.get("translation") or "")
        if not trans:
            continue
        rk = rank_of(r)
        if rk == 0:
            continue
        exch = r.get("exchange") or ""
        # 只保留排名靠前的词条
        buckets["__cand__"][w.lower()] = (rk, w, r, trans, exch)

    cand = buckets.pop("__cand__")
    ordered = sorted(cand.values(), key=lambda x: x[0])[:SHRINK_LIMIT]
    print("筛选后保留 %d 条" % len(ordered), file=sys.stderr)

    for rank, (_rk, w, r, trans, exch) in enumerate(ordered):
        key = w.lower()
        phonetic = norm_phonetic(r.get("phonetic"))
        pos = (r.get("pos") or "").strip()
        # pos 字段常常是 "n:42/v:11" 之类的统计, 只取标签部分
        if ":" in pos:
            pos = "/".join(
                p.split(":")[0] for p in pos.split("/") if p and p.split(":")[0]
            )
        if pos and not re.match(r"^[a-z]{1,6}(/[a-z]{1,6})*$", pos):
            pos = ""
        engdef = clean_definition(r.get("definition") or "") if rank < DEF_LIMIT else ""

        # exchange 字段形如 "p:did/d:done/i:doing/3:does/s:does"
        exch_pairs = []
        for item in exch.split("/"):
            if ":" in item:
                k, v = item.split(":", 1)
                if k in ("p", "d", "i", "3", "s", "r", "t") and v:
                    exch_pairs.append(k + ":" + v)
        exch_s = "/".join(exch_pairs[:6])

        first = key[0]
        frag = [phonetic, trans, pos, engdef, rank + 1, exch_s]
        while frag and (frag[-1] == "" or frag[-1] == 0):
            frag.pop()
        buckets[first if first.isalpha() else "_misc"][w] = frag

    # ---- 词形还原表 ----
    # 首选 exchange 字段（词典自带、精确）：p 过去式 / d 过去分词 / i 现在分词
    # 3 第三人称单数 / s 复数 / r 比较级 / t 最高级
    lemma = {}
    for rank, (_rk, w, r, trans, exch) in enumerate(ordered):
        base = w.lower()
        for item in (exch or '').split('/'):
            if ':' not in item:
                continue
            k, v = item.split(':', 1)
            v = v.strip().lower()
            if not v or not WORD_RE.match(v) or v == base:
                continue
            if k in ('p', 'd', 'i', '3', 's', 'r', 't'):
                # 不作覆盖，避免低频词形被高频词条抢走
                lemma.setdefault(v, base)

    # 次选官方 lemma 表，但必须通过词形规则校验，避免把 they 归到 it 这类错误
    if os.path.exists(LEMMA_SRC):
        added = 0
        with open(LEMMA_SRC, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith(';') or '->' not in line:
                    continue
                left, right = line.split('->', 1)
                base = left.split('/')[0].strip().lower()
                if not base or not WORD_RE.match(base):
                    continue
                for form in right.split(','):
                    form = form.strip().lower()
                    if not form or form == base or form in lemma:
                        continue
                    if not WORD_RE.match(form) or not suffix_ok(base, form):
                        continue
                    lemma[form] = base
                    added += 1
        print("词形还原表 %d 条（其中校正补充 %d）" % (len(lemma), added), file=sys.stderr)
    else:
        print("词形还原表 %d 条（来自 exchange 字段）" % len(lemma), file=sys.stderr)

    # 核心词表 (按首字母分片中的前 N 条, 依据原始排名)
    core = {}
    flat = []
    for k, v in buckets.items():
        if k == "_misc":
            continue
        for word, frag in v.items():
            flat.append((frag[4] if len(frag) > 4 else 999999, word, frag, k))
    flat.sort()
    for _rk, word, frag, k in flat:
        if len(core) >= CORE_N:
            break
        core[word] = frag

    total_bytes = 0
    counts = {}
    for name, data in buckets.items():
        path = os.path.join(OUT, name + ".json")
        blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(blob)
        total_bytes += len(blob.encode("utf-8"))
        counts[name] = len(data)

    with open(os.path.join(OUT, "core.json"), "w", encoding="utf-8") as fh:
        json.dump(core, fh, ensure_ascii=False, separators=(",", ":"))

    with open(os.path.join(OUT, "lemma.json"), "w", encoding="utf-8") as fh:
        json.dump(lemma, fh, ensure_ascii=False, separators=(",", ":"))

    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "source": "ECDICT (MIT License, skywind3000/ECDICT)",
                "entries": sum(counts.values()),
                "core": len(core),
                "shards": counts,
            },
            fh,
            ensure_ascii=False,
            indent=1,
        )

    print(
        "输出完成: %d 词条 / 分片 %d / 核心 %d / 约 %.2f MB"
        % (sum(counts.values()), len(counts), len(core), total_bytes / 1048576.0),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
