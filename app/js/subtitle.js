// 字幕解析与句子切分

import { hasCJK, cjkRatio } from './util.js';

export function tokenize(text) {
  return String(text || '').match(/[A-Za-z][A-Za-z''\-]*|[^A-Za-z]+/g) || [];
}

export const isWordToken = (t) => /^[A-Za-z]/.test(t);

/* ---------------- 时间码 ---------------- */

function parseTime(str) {
  const m = String(str).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (+(h || 0)) * 3600 + (+mm) * 60 + (+ss) + (+(ms.padEnd(3, '0')) / 1000);
}

/* ---------------- SRT ----------------
   兼容：BOM、CRLF、时间轴后的坐标/样式行、双语（中英混排）文本
-------------------------------------*/

export function parseSRT(text) {
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = clean.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const [a, b] = tl.split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    if (start === null || end === null) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  return decorate(cues);
}

/* ---------------- WebVTT ---------------- */

export function parseVTT(text) {
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  const blocks = clean.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)/i.test(lines[0])) continue;
    let i = 0;
    if (!lines[0].includes('-->') && /^\d+$/.test(lines[0].trim()) === false && lines[1]?.includes('-->')) i = 1;
    const tl = lines[i];
    if (!tl || !tl.includes('-->')) continue;
    const [a, b] = tl.split('-->');
    const start = parseTime(a);
    const end = parseTime(b.split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const body = lines.slice(i + 1).join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  return decorate(cues);
}

export function parseCues(text) {
  if (/^\s*WEBVTT/i.test(text)) return parseVTT(text);
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(text)) return parseSRT(text);
  // 纯文本：一行一句，无时间轴
  return decorate(
    String(text).replace(/^\uFEFF/, '').split(/\n+/).filter((l) => l.trim())
      .map((l, i) => ({ start: i, end: i + 1, text: l.trim(), noAudio: true }))
  );
}

/* ---------------- 双语拆分 ---------------- */

// 一条字幕里可能同时含英文和中文，按行/按 CJK 比例拆成两部分
function splitBilingual(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const en = lines.filter((l) => cjkRatio(l) < 0.25);
    const zh = lines.filter((l) => cjkRatio(l) >= 0.25);
    if (en.length && zh.length) {
      return { en: en.join(' ').replace(/\s+/g, ' '), zh: zh.join('') };
    }
  }
  const flat = lines.join(' ');
  if (cjkRatio(flat) >= 0.25) {
    // 整条都是中文，用标点把中英切出来（中文字幕偶尔夹英文短语）
    return { en: '', zh: flat };
  }
  return { en: flat, zh: '' };
}

function decorate(cues) {
  return cues.map((c, i) => {
    const { en, zh } = splitBilingual(c.text);
    return {
      i,
      start: c.start,
      end: c.end,
      text: en || c.text.replace(/\n/g, ' '),
      zh: zh || '',
      raw: c.text,
      noAudio: !!c.noAudio,
    };
  });
}

/* ---------------- 由逐词时间戳拼句 ----------------
   words: [{ text, start, end }]
   规则：句末标点、长停顿、超长长度三者任一触发断句
-----------------------------------------------*/

const END_PUNCT = /[.!?…]["'”’)\]]*\s*$/;
const SOFT_PUNCT = /[,;:]["'”’)\]]*\s*$/;

export function groupWordsIntoSentences(words, opts = {}) {
  const gap = opts.gap ?? 0.62;
  const minDur = opts.minDur ?? 1.1;
  const maxChars = opts.maxChars ?? 190;
  const out = [];
  let cur = [];

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    out.push({
      start: cur[0].start,
      end: Math.max(cur[cur.length - 1].end, cur[0].start + 0.35),
      text,
      words: cur.map((w) => ({ w: w.text, s: w.start, e: w.end })),
    });
    cur = [];
  };

  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (!w.text || !w.text.trim()) continue;
    cur.push(w);
    const next = words[k + 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0);
    const dur = cur[cur.length - 1].end - cur[0].start;

    const hardEnd = END_PUNCT.test(w.text);
    const softEnd = SOFT_PUNCT.test(w.text);
    const longGap = next ? next.start - w.end > gap : true;
    const longText = chars > maxChars;

    if (hardEnd || longText || (softEnd && longGap && dur > 2.4) || (longGap && dur > minDur)) flush();
  }
  flush();
  return out;
}

/* ---------------- 逐词时间轴（卡拉OK 高亮用） ----------------
   有 whisper 逐词时间戳时直接用真实时间；否则（人工字幕、纯文本、
   或长视频关闭了逐词时间戳）按词长比例把整句时长分摊到每个词，
   这样任何来源的字幕都能跟着播放逐词推进。
   返回数组与 tokenize(text) 里「是单词」的那些 token 一一对应。
---------------------------------------------------------*/

export function wordTimings(cue) {
  if (!cue) return null;
  const toks = tokenize(cue.text).filter(isWordToken);
  if (!toks.length) return null;

  const given = cue.words;
  if (given && given.length === toks.length) {
    return given.map((w) => ({ s: w.s, e: Math.max(w.e, w.s + 0.06) }));
  }

  const weights = toks.map((tk) => Math.max(1, tk.length));
  const total = weights.reduce((n, x) => n + x, 0) || 1;
  const span = Math.max(0.3, (cue.end - cue.start) || 0.3);
  let t = cue.start;
  return toks.map((tk, i) => {
    const d = (weights[i] / total) * span;
    const out = { s: t, e: t + d };
    t += d;
    return out;
  });
}

/* ---------------- 由整段文本估计时间轴 ----------------
   导入纯文本或人工字幕缺少精确时间时的兜底：按字符数比例分配
-------------------------------------------------------*/

export function distributeTiming(texts, duration) {
  const total = texts.reduce((n, t) => n + t.length + 4, 0) || 1;
  let t = 0;
  return texts.map((text) => {
    const span = ((text.length + 4) / total) * duration;
    const cue = { start: t, end: t + span, text };
    t += span;
    return cue;
  });
}

/* ---------------- 合并过碎的字幕 ---------------- */

export function mergeCues(cues, maxGap = 0.5) {
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && c.start - prev.end < maxGap && !/[.!?…]$/.test(prev.text.trim()) &&
        (prev.text.length + c.text.length) < 220 && (!prev.zh || !c.zh)) {
      prev.text = (prev.text + ' ' + c.text).replace(/\s+/g, ' ').trim();
      prev.zh = (prev.zh || '') + (c.zh || '');
      prev.end = c.end;
    } else {
      out.push({ ...c });
    }
  }
  return out.map((c, i) => ({ ...c, i }));
}

export function toSRT(cues) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts = (t) => {
    const ms = Math.floor((t % 1) * 1000);
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(Math.floor(t) % 60)},${pad(ms, 3)}`;
  };
  return cues.map((c, i) =>
    `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}${c.zh ? '\n' + c.zh : ''}\n`
  ).join('\n');
}
