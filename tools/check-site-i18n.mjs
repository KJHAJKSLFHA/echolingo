#!/usr/bin/env node
// 校验官网首页（index.html）三份字典的 key 是否完全一致，以及 markup 里绑定的 key 是否都存在。
//
// 为什么要有这个脚本：三份字典加起来 280 个词条，靠眼睛比对必然漏。
// 漏 key 的表现是「切到西语后某一块还是中文 / 英文」，而且不报错 —— 静默降级最难查。
//
// 用法：node tools/check-site-i18n.mjs   （退出码非 0 表示有问题）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

// 1. 把 SITE_I18N 那段抠出来求值（它是纯字面量，没有外部依赖）
const start = html.indexOf('var SITE_I18N = {');
if (start < 0) {
  console.error('✗ index.html 里找不到 `var SITE_I18N = {`');
  process.exit(1);
}
// 从 `{` 开始做括号配对，找到对象的结尾
const objStart = html.indexOf('{', start);
let depth = 0, end = -1;
for (let i = objStart; i < html.length; i++) {
  const c = html[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) {
  console.error('✗ SITE_I18N 对象括号不配对');
  process.exit(1);
}

let SITE_I18N;
try {
  SITE_I18N = eval('(' + html.slice(objStart, end) + ')');
} catch (e) {
  console.error('✗ SITE_I18N 语法错误：' + e.message);
  process.exit(1);
}

const langs = Object.keys(SITE_I18N);
console.log(`字典语言：${langs.join(' / ')}`);

let bad = 0;

// 2. 每份字典内部：key 数、重复 key（同名字面量会静默覆盖前一个）
const keySets = {};
for (const l of langs) {
  const keys = Object.keys(SITE_I18N[l]);
  keySets[l] = new Set(keys);

  // 重复 key 检测：在源码里数每个 key 出现几次
  const re = new RegExp(`'([a-zA-Z0-9_.]+)':`, 'g');
  const bodyStart = html.indexOf(`${l}: {`);
  const bodyEnd = html.indexOf('\n  }', bodyStart);
  const body = html.slice(bodyStart, bodyEnd > 0 ? bodyEnd : undefined);
  const seen = new Map();
  let m;
  while ((m = re.exec(body))) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dup.length) {
    console.error(`✗ ${l}: 重复 key ${dup.join(', ')}`);
    bad++;
  }

  // 空值检测：空字符串会让界面出现一块空白
  const empty = keys.filter((k) => typeof SITE_I18N[l][k] !== 'string' || SITE_I18N[l][k].trim() === '');
  if (empty.length) {
    console.error(`✗ ${l}: 空词条 ${empty.join(', ')}`);
    bad++;
  }

  console.log(`  ${l}: ${keys.length} 条`);
}

// 3. 三份字典互为基准，缺谁报谁
const all = new Set(langs.flatMap((l) => [...keySets[l]]));
for (const l of langs) {
  const missing = [...all].filter((k) => !keySets[l].has(k)).sort();
  if (missing.length) {
    console.error(`✗ ${l} 缺 ${missing.length} 条：${missing.join(', ')}`);
    bad++;
  }
}

// 4. markup 里绑定的 key 必须在每份字典里都存在
const bound = new Set();
for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) bound.add(m[1]);
for (const l of langs) {
  const missing = [...bound].filter((k) => !keySets[l].has(k)).sort();
  if (missing.length) {
    console.error(`✗ ${l} 缺少 markup 绑定的 key：${missing.join(', ')}`);
    bad++;
  }
}

// 5. 字典里有、但 markup 从没用过的 key（不算错，提醒一下）
const unused = [...keySets[langs[0]]].filter((k) => !bound.has(k) && !k.startsWith('page.') && k !== 'logo.sub' && k !== 'nav.open' && k !== 'hero.badge');
// logo.sub / nav.open / hero.badge 其实在 markup 里，只需排除 page.*
const reallyUnused = unused.filter((k) => !bound.has(k));
if (reallyUnused.length) console.log(`· 未被 markup 引用（可能由脚本使用）：${reallyUnused.length} 条`);

console.log(bad === 0
  ? `✓ 三语字典一致：各 ${keySets[langs[0]].size} 条，markup 绑定 ${bound.size} 个 key 全部命中`
  : `✗ 共 ${bad} 个问题`);
process.exit(bad === 0 ? 0 : 1);
