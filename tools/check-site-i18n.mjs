#!/usr/bin/env node
// 校验官网首页（index.html）三份字典的 key 是否完全一致，以及 markup 里绑定的 key 是否都存在。
//
// 为什么要有这个脚本：三份字典加起来 280 个词条，靠眼睛比对必然漏。
// 漏 key 的表现是「切到西语后某一块还是中文 / 英文」，而且不报错 —— 静默降级最难查。
//
// 用法：node tools/check-site-i18n.mjs   （退出码非 0 表示有问题）

import { readFileSync, existsSync } from 'node:fs';
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

// 6. Netlify HUD 隐藏标记必须在 <head> 的同步脚本里写好。
// 为什么要有这条：线上会注入 `/.netlify/scripts/hud`（async），它启动时读
// localStorage 的 nl-hud:<variant>:v1，不是 "hidden" 就挂一个 202×64、
// z-index 21 亿的浮层，钉死右下角挡住内容 —— 它自身不支持拖动，只能关掉。
// 这段标记一旦被误删或挪到异步脚本里，徽章就会回来，而且不报任何错。
//
// 注意：必须匹配 `setItem('nl-hud...')` 这个**调用**，不能只搜字符串
// `nl-hud:public:v1` —— 上面注释里也写着这几个 key，只搜字符串的话
// 把真正的调用删掉、注释还在，检查会误判为通过。
const HUD_KEYS = ['nl-hud:public:v1', 'nl-hud:owner-private:v1'];
for (const key of HUD_KEYS) {
  const call = `setItem('${key}'`;
  const pos = html.indexOf(call);
  if (pos < 0) {
    console.error(`✗ 缺少 Netlify HUD 隐藏标记 ${call}…)（徽章会挡住右下角内容）`);
    bad++;
    continue;
  }
  // 必须在 </head> 内，且在本页任何 async/defer 脚本之前 —— HUD 脚本是 async，
  // 谁先跑不确定；写晚了徽章可能已经挂上。
  const headEnd = html.indexOf('</head>');
  if (headEnd >= 0 && pos > headEnd) {
    console.error(`✗ HUD 标记 ${key} 在 </head> 之后，会晚于 HUD 脚本执行`);
    bad++;
  }
  const later = [...html.matchAll(/<script[^>]*>/g)].filter((m) => m.index < pos && /async|defer/.test(m[0]));
  if (later.length) {
    console.error(`✗ HUD 标记 ${key} 之前有 async/defer 脚本，会和 HUD 抢执行顺序`);
    bad++;
  }
}
// try/catch 兜底：隐私模式下 localStorage.setItem 会抛异常，不能因此弄坏整页
{
  const i = html.indexOf("setItem('nl-hud:public:v1'");
  if (i >= 0) {
    const around = html.slice(Math.max(0, i - 300), i + 400);
    if (!/try\s*\{/.test(around) || !/\}\s*catch/.test(around)) {
      console.error('✗ HUD 标记没有用 try/catch 包住（隐私模式下会抛异常弄坏页面）');
      bad++;
    }
  }
}
if (bad === 0) console.log(`✓ Netlify HUD 隐藏标记：${HUD_KEYS.length} 条 key，位置正确且已兜底`);

// 7. 海水背景 + 液态玻璃（外观改造的守护规则）
//
// 为什么这些必须自动检查：这一层改造的正确性完全依赖几个「看不出来但一
// 破坏就出事」的性质 —— 照片没加载会静默变成纯色、动画不尊重
// prefers-reduced-motion 会让前庭障碍用户难受、玻璃层若被加到 pre 上会
// 让代码块发灰、文字色若被调暗在照片上就不可读。这些都不会报错。
{
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  let n = 0;

  // 7.1 背景三层结构必须在位，且 z-index 为负（否则会盖住内容）
  for (const [cls, z] of [['.sea-bg', '-2'], ['.sea-veil', '-1']]) {
    const re = new RegExp(`\\${cls}\\s*\\{[^}]*z-index:\\s*${z}`, 's');
    if (!re.test(css)) { console.error(`✗ 缺少 ${cls} 层或 z-index 不是 ${z}`); bad++; }
    else n++;
  }
  // 图片层挂在 ::before 上（因为有 Ken Burns transform）
  if (!/\.sea-bg::before\s*\{/.test(css)) { console.error('✗ 缺少 .sea-bg::before 图片层'); bad++; } else n++;

  // 7.2 三档背景图必须存在且被 CSS 引用 —— 图片 404 时页面会静默变成纯色
  const wantImgs = ['sea-bg-800.jpg', 'sea-bg-1280.jpg', 'sea-bg-1920.jpg'];
  for (const f of wantImgs) {
    if (!css.includes(`url('shots/${f}')`)) {
      console.error(`✗ CSS 未引用 shots/${f}（缺这一档会在某些宽度静默变纯色）`); bad++;
      continue;
    }
    if (!existsSync(join(root, 'shots', f))) {
      console.error(`✗ 文件 shots/${f} 不存在（页面不会报错，只会变成纯色背景）`); bad++;
    } else n++;
  }
  // 兜底底色：图没加载完 / 加载失败时不能是白屏
  if (!/\.sea-bg\s*\{[^}]*background:\s*#/.test(css)) {
    console.error('✗ .sea-bg 缺少兜底底色（图片未加载时会露出白底）'); bad++;
  } else n++;

  // 7.3 Ken Burns 动画 + prefers-reduced-motion 关闭开关
  if (!/@keyframes\s+kenburns\s*\{/.test(css)) { console.error('✗ 缺少 @keyframes kenburns'); bad++; } else n++;
  const rm = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
  if (!rm || !/\.sea-bg::before\s*\{[^}]*animation:\s*none/.test(rm[1])) {
    console.error('✗ prefers-reduced-motion: reduce 下没有关掉背景动画（无障碍问题）'); bad++;
  } else n++;
  // 动画必须有 will-change 或 transform，否则可能不合成、卡顿
  if (!/\.sea-bg::before\s*\{[^}]*will-change:\s*transform/.test(css)) {
    console.error('✗ .sea-bg::before 缺少 will-change: transform（动画会走主线程）'); bad++;
  } else n++;

  // 7.4 scrim 的负 inset 不能撑出横向滚动条。
  //     hero 的 .wrap 已经贴满视口，它的 scrim 只要往左右扩就会溢出
  //     （实测扩 14px 就让 390/360px 的 scrollWidth 多 14px）。
  const heroScrim = css.match(/\.hero\.scrim::before\s*\{([^}]*)\}/);
  if (!heroScrim) { console.error('✗ 缺少 .hero.scrim::before 规则'); bad++; }
  else {
    const ins = heroScrim[1].match(/inset:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/);
    if (!ins) { console.error('✗ .hero.scrim::before 的 inset 不是两值写法，无法校验'); bad++; }
    else if (parseFloat(ins[2]) < 0) {
      console.error(`✗ .hero.scrim::before 横向 inset 是 ${ins[2]}px（负值），会撑出横向滚动条`); bad++;
    } else n++;
  }

  // 7.5 液态玻璃令牌齐全，且 pre 上不许用玻璃（代码块发灰难读）
  for (const t of ['--glass-bg', '--glass-bg-strong', '--glass-blur', '--glass-edge', '--glass-line']) {
    if (!css.includes(t + ':')) { console.error(`✗ 缺少玻璃令牌 ${t}`); bad++; } else n++;
  }
  for (const sel of ['header', '.card', '.btn', '.badge', '.lang-seg', '.shot']) {
    if (new RegExp(`\\${sel}\\s*\\{[^}]*backdrop-filter`, 's').test(css)) n++;
  }
  if (/pre\s*\{[^}]*backdrop-filter/.test(css) === false) {
    // pre 可以有一点点模糊，但背景必须足够实（alpha ≥ .6），否则代码难读
    const preBg = css.match(/pre\s*\{[^}]*background:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/s);
    if (preBg && parseFloat(preBg[1]) < 0.6) {
      console.error(`✗ pre 的背景 alpha 只有 ${preBg[1]}，代码压在海水上会难读（应 ≥ .6）`); bad++;
    } else n++;
  } else n++;
  // 不支持 backdrop-filter 的浏览器必须有退化方案，不能糊成一片
  if (!/@supports not \(\(backdrop-filter/.test(css)) {
    console.error('✗ 缺少 backdrop-filter 不支持时的退化方案（老浏览器会看不清）'); bad++;
  } else n++;

  // 7.6 文字色不能在照片上失去对比度：按 WCAG 相对亮度算，
  //     底色取「压暗后最亮的海水」（由脚本扫描 1280x720 照片得出）。
  //     这里用固定基准色，避免门禁依赖图片解码库。
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // 正文区最亮合成底（实测值，见 index.html 注释）
  const WORST_BG = [24, 56, 69];
  const textTokens = ['--text', '--text-2', '--text-3', '--brand'];
  for (const t of textTokens) {
    const m = css.match(new RegExp(`${t}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) { console.error(`✗ 找不到 ${t} 的十六进制色值`); bad++; continue; }
    const r = ratio(hex2rgb(m[1]), WORST_BG);
    if (r < 4.5) {
      console.error(`✗ ${t} ${m[1]} 在最亮海面上只有 ${r.toFixed(2)}:1（需 ≥4.5:1）`); bad++;
    } else n++;
  }

  if (bad === 0) console.log(`✓ 海水背景 + 液态玻璃：${n} 项检查通过`);
}

console.log(bad === 0
  ? `✓ 三语字典一致：各 ${keySets[langs[0]].size} 条，markup 绑定 ${bound.size} 个 key 全部命中`
  : `✗ 共 ${bad} 个问题`);
process.exit(bad === 0 ? 0 : 1);
