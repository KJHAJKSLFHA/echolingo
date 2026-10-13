// 分词器 Unicode 化验证（阶段 0）
//   node bench/test-tokenize.mjs
// 两件事必须同时成立：
//   1) 西语带重音/ñ 的词不再被切碎
//   2) 英语行为与改造前【逐 token 完全一致】（防止砸掉现网英语链路）

import { tokenize, isWordToken } from '../app/js/subtitle.js';
import { normalizeWord } from '../app/js/dict.js';

/* ---- 改造前的旧实现（原样抄自 git HEAD~ 的 app/js/subtitle.js） ---- */
const oldTokenize = (text) => String(text || '').match(/[A-Za-z][A-Za-z\u2019'\-]*|[^A-Za-z]+/g) || [];
const oldNormalizeWord = (raw) => String(raw || '')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/^[^a-z]+|[^a-z'\-]+$/g, '');

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) pass++;
  else fails.push(label + (extra ? '  →  ' + extra : ''));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ================= 1. 英语：新旧必须逐 token 一致 ================= */
const EN_CORPUS = [
  "Welcome to this offline listening practice.",
  "So I've been thinking about it, and—well—it's not that simple.",
  "The 3 most common mistakes in 2024 were: 'a', \"b\", and c.",
  "It costs $1,299.99 (roughly 20% more).",
  "don't can't won't shouldn't I'll we're they've",
  "well-known state-of-the-art up-to-date",
  "He said, \u201cI\u2019m ready.\u201d Then he left.",
  "MIXED case Words LIKE This",
  "multi\nline\nsubtitle\ntext",
  "   leading and trailing spaces   ",
  "",
  "!!!???...",
  "12345",
  "a",
  "A1B2C3",
  "Caf\u00e9 na\u00efve r\u00e9sum\u00e9",   // 英语语料里偶见的借词，允许新旧不同（下面单独说明）
];
let enMismatch = 0;
for (const s of EN_CORPUS) {
  const a = oldTokenize(s), b = tokenize(s);
  if (!eq(a, b)) {
    // 借词那句是【预期】的差异：旧版砍掉重音，新版保留
    if (s === "Caf\u00e9 na\u00efve r\u00e9sum\u00e9") continue;
    enMismatch++;
    fails.push(`英语 token 变了: ${JSON.stringify(s)}`, `  旧=${JSON.stringify(a)}\n  新=${JSON.stringify(b)}`);
  }
}
ok(enMismatch === 0, '英语语料逐 token 一致');

// 纯 ASCII 英语（真正的主流输入）必须【零差异】
const ASCII_EN = EN_CORPUS.filter((s) => /^[\x00-\x7F]*$/.test(s));
let asciiDiff = 0;
for (const s of ASCII_EN) {
  const a = oldTokenize(s), b = tokenize(s);
  if (!eq(a, b)) { asciiDiff++; fails.push(`ASCII 英语 token 变了: ${JSON.stringify(s)}`); }
}
ok(asciiDiff === 0, `纯 ASCII 英语 ${ASCII_EN.length} 条零差异`);

/* ================= 2. 西语：词必须完整 ================= */
const ES_CASES = [
  ["\u00a1Hola! \u00bfC\u00f3mo est\u00e1s?", ["Hola", "C\u00f3mo", "est\u00e1s"]],
  ["El ni\u00f1o ten\u00eda much\u00edsimo fr\u00edo.", ["El", "ni\u00f1o", "ten\u00eda", "much\u00edsimo", "fr\u00edo"]],
  ["\u00bfQu\u00e9 hiciste ayer?", ["Qu\u00e9", "hiciste", "ayer"]],
  ["Ayer camin\u00e9 por el glaciar Perito Moreno.", ["Ayer", "camin\u00e9", "por", "el", "glaciar", "Perito", "Moreno"]],
  ["La Patagonia es impresionante, \u00bfverdad?", ["La", "Patagonia", "es", "impresionante", "verdad"]],
  ["\u00danltimamente el ping\u00fcino peque\u00f1uelo comi\u00f3.", ["\u00danltimamente", "el", "ping\u00fcino", "peque\u00f1uelo", "comi\u00f3"]],
];
for (const [text, want] of ES_CASES) {
  const got = tokenize(text).filter(isWordToken);
  ok(eq(got, want), `西语分词: ${text}`, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// 重构检查：所有 token 拼回去必须还原原文（渲染层依赖这一点）
for (const s of [...EN_CORPUS, ...ES_CASES.map((c) => c[0])]) {
  const joined = tokenize(s).join('');
  ok(joined === String(s || ''), `tokenize 可无损拼回: ${JSON.stringify(s)}`, `got=${JSON.stringify(joined)}`);
}

// NFD（分解形）也要能跟上基字母
const nfd = 'cafe\u0301 nin\u0303o';
ok(eq(tokenize(nfd).filter(isWordToken), ['cafe\u0301', 'nin\u0303o']), 'NFD 组合重音不被拆开',
  JSON.stringify(tokenize(nfd).filter(isWordToken)));

/* ================= 3. normalizeWord ================= */
// 英语（纯 ASCII）必须零差异
const EN_WORDS = ["Hello", "DON'T", "Don\u2019t", "well-known", "word.", "...word...", "'quoted'", "UPPER", "a", "123abc"];
let nwDiff = 0;
for (const w of EN_WORDS) {
  const a = oldNormalizeWord(w), b = normalizeWord(w);
  if (a !== b) { nwDiff++; fails.push(`英语 normalizeWord 变了: ${JSON.stringify(w)} 旧=${a} 新=${b}`); }
}
ok(nwDiff === 0, `英语 normalizeWord ${EN_WORDS.length} 条零差异`);

// 西语：重音必须保留
for (const [w, want] of [["camin\u00e9", "camin\u00e9"], ["ni\u00f1o", "ni\u00f1o"], ["C\u00f3mo", "c\u00f3mo"],
                         ["much\u00edsimo,", "much\u00edsimo"], ["\u00bfverdad?", "verdad"]]) {
  const got = normalizeWord(w);
  ok(got === want, `西语 normalizeWord: ${w}`, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ================= 结果 ================= */
console.log(`\n通过 ${pass} 项`);
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log(' ✗ ' + f);
  process.exit(1);
}
console.log('分词器 Unicode 化：全部通过（西语不再被切碎，英语零回归）');
