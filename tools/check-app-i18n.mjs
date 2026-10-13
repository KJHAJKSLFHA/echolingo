#!/usr/bin/env node
/**
 * 校验 app/js/i18n.js 里的三份字典（中文 / English / Español）：
 *   ① 每份的条数、内部重复 key
 *   ② 三份的 key 是否完全一致（互为基准找缺失）
 *   ③ 有没有空词条
 *   ④ app/index.html + app/js/*.js 里引用的 key 是否都存在
 *
 * 用法：node tools/check-app-i18n.mjs     退出码非 0 表示有问题
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'app');
const SRC = readFileSync(join(APP, 'js', 'i18n.js'), 'utf8');

/** 从 `const NAME = {` 开始按括号配对抠出整个对象字面量 */
function sliceObject(name) {
  const head = SRC.indexOf(`const ${name} = {`);
  if (head < 0) throw new Error(`找不到 const ${name} = {`);
  const open = SRC.indexOf('{', head);
  let depth = 0, i = open, inStr = null, esc = false;
  for (; i < SRC.length; i++) {
    const ch = SRC[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name} 的括号没有配对`);
  return SRC.slice(open, i + 1);
}

/** 数一下字面量里出现了几次某个 key（用来抓重复 key） */
function countKeys(lit) {
  const seen = new Map();
  const re = /(?:^|[{,\s])(?:'([^']+)'|"([^"]+)")\s*:/g;
  let m;
  while ((m = re.exec(lit))) {
    const k = m[1] ?? m[2];
    if (k.includes('(') || k.includes(' ')) continue;   // 跳过非 i18n key 的字段
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return seen;
}

const LANGS = [['zh', 'ZH'], ['en', 'EN'], ['es', 'ES']];
const dicts = {};
const counts = {};
let problems = 0;
const fail = (msg) => { console.log('  ✗ ' + msg); problems++; };

for (const [code, name] of LANGS) {
  const lit = sliceObject(name);
  dicts[code] = new Function(`return (${lit});`)();
  counts[code] = countKeys(lit);
  const keys = Object.keys(dicts[code]);
  const dup = [...counts[code]].filter(([, n]) => n > 1).map(([k]) => k);
  const empty = keys.filter((k) => !String(dicts[code][k]).trim());
  console.log(`${code}: ${keys.length} 条`);
  if (dup.length) fail(`${code} 里有重复 key：${dup.join(', ')}`);
  if (empty.length) fail(`${code} 里有空词条：${empty.join(', ')}`);
}

// ② 三份互为基准
const base = new Set(Object.keys(dicts.zh));
for (const [code] of LANGS) {
  const cur = new Set(Object.keys(dicts[code]));
  const missing = [...base].filter((k) => !cur.has(k));
  const extra = [...cur].filter((k) => !base.has(k));
  if (missing.length) fail(`${code} 缺 ${missing.length} 个 key：${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
  if (extra.length) fail(`${code} 多出 ${extra.length} 个 key：${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ' …' : ''}`);
}

// ④ 引用检查
const used = new Map();   // key → 出处
const addUse = (key, where) => { if (!used.has(key)) used.set(key, where); };

const html = readFileSync(join(APP, 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)) addUse(m[1], 'app/index.html');

for (const f of readdirSync(join(APP, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(join(APP, 'js', f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^'\\]+)'\s*[,)]/g)) addUse(m[1], `app/js/${f}`);
  for (const m of src.matchAll(/data-i18n(?:-html|-title|-ph)?':\s*'([^']+)'/g)) addUse(m[1], `app/js/${f}`);
}

const missingKeys = [...used].filter(([k]) => !base.has(k));
if (missingKeys.length) fail(`引用了字典里没有的 key：${missingKeys.map(([k, w]) => `${k}（${w}）`).join(', ')}`);
else console.log(`✓ markup / 代码引用 ${used.size} 个 key 全部命中`);

console.log(problems === 0
  ? `✓ 三语字典一致：各 ${base.size} 条`
  : `✗ 发现 ${problems} 个问题`);
process.exit(problems ? 1 : 0);
