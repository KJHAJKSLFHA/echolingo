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

// 7. 海水背景 + 液态玻璃 + 双主题（外观改造的守护规则）
//
// 为什么这些必须自动检查：这一层的正确性完全依赖几个「看不出来但一破坏
// 就出事」的性质 —— 照片没加载会静默变纯色、动画不尊重
// prefers-reduced-motion 会让前庭障碍用户难受、两套主题令牌一旦不对齐
// 就会出现「某个面板在浅色下还是深色」这种不报错只难看的问题、
// 文字色若被调暗在照片上就不可读。这些都不会报错。
{
  const css = html.slice(html.search(/^<style>/m), html.indexOf('\n</style>'));
  let n = 0;

  // 7.1 背景两层必须在位且 z-index 为负（否则会盖住内容）
  for (const [cls, z] of [['.sea-bg', '-2'], ['.sea-veil', '-1']]) {
    const re = new RegExp(`\\${cls}\\s*\\{[^}]*z-index:\\s*${z}`, 's');
    if (!re.test(css)) { console.error(`✗ 缺少 ${cls} 层或 z-index 不是 ${z}`); bad++; }
    else n++;
  }
  if (!/\.sea-bg::before\s*\{/.test(css)) { console.error('✗ 缺少 .sea-bg::before 图片层'); bad++; } else n++;
  // 兜底底色：图没加载完 / 失败时不能露白底
  if (!/\.sea-bg\s*\{[^}]*background:\s*var\(--bg-solid\)/.test(css)) {
    console.error('✗ .sea-bg 缺少兜底底色（图片未加载时会露出白底）'); bad++;
  } else n++;

  // 7.2 两套主题 × 三档尺寸 = 6 张背景图，都必须存在且被 CSS 引用。
  //     图片 404 时页面**不会报错**，只会静默变成纯色 —— 最难查的一类问题。
  const seaImgs = [];
  for (const theme of ['dark', 'light']) for (const w of [800, 1280, 1920]) seaImgs.push(`sea-${theme}-${w}.jpg`);
  for (const f of seaImgs) {
    if (!css.includes(`url('shots/${f}')`)) {
      console.error(`✗ CSS 未引用 shots/${f}`); bad++;
      continue;
    }
    if (!existsSync(join(root, 'shots', f))) {
      console.error(`✗ 文件 shots/${f} 不存在（页面不会报错，只会变成纯色背景）`); bad++;
    } else n++;
  }

  // 7.3 Ken Burns + prefers-reduced-motion 关闭开关（无障碍硬要求）
  if (!/@keyframes\s+kenburns\s*\{/.test(css)) { console.error('✗ 缺少 @keyframes kenburns'); bad++; } else n++;
  const rm = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
  if (!rm || !/\.sea-bg::before\s*\{[^}]*animation:\s*none/.test(rm[1])) {
    console.error('✗ prefers-reduced-motion: reduce 下没有关掉背景动画（无障碍问题）'); bad++;
  } else n++;
  if (!/\.sea-bg::before\s*\{[^}]*will-change:\s*transform/.test(css)) {
    console.error('✗ .sea-bg::before 缺少 will-change: transform（动画会走主线程）'); bad++;
  } else n++;

  // 7.4 不许再有「局部 scrim」色块。
  //     上一版在 hero / 章节标题下垫了 radial 半透明黑，实测形成一条 1144px 宽、
  //     边缘亮度跳变 16 级的硬边暗块，看起来像贴了一张脏卡片（用户明确反馈
  //     「黑色的影子特别奇怪」）。对比度改为做进「照片先压暗 + 连续渐变压暗层」。
  if (/\.scrim\s*\{|class="[^"]*\bscrim\b/.test(html)) {
    console.error('✗ 又出现了 .scrim 局部压暗色块（会产生硬边暗影，已被用户否掉）'); bad++;
  } else n++;

  // 7.5 两套主题的令牌 key 必须完全一致。
  //     少一个 key 不会报错，只会让某个面板在浅色下仍用深色值 —— 静默不一致。
  const grab = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) return null;
    const a = css.indexOf('{', i);
    let d = 0;
    for (let k = a; k < css.length; k++) {
      if (css[k] === '{') d++;
      else if (css[k] === '}') { d--; if (d === 0) return css.slice(a, k + 1); }
    }
    return null;
  };
  const darkBlk = grab(':root, :root[data-theme="dark"]');
  const lightBlk = grab(':root[data-theme="light"]');
  if (!darkBlk || !lightBlk) {
    console.error('✗ 找不到深色或浅色主题令牌块'); bad++;
  } else {
    const decls = (b) => new Set([...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const dk = decls(darkBlk), lt = decls(lightBlk);
    // 尺寸类令牌只在深色块里定义就够了（两套共用），排除它们
    const shared = new Set(['--radius', '--maxw', '--glass-blur', '--glass-sat']);
    const onlyD = [...dk].filter((k) => !lt.has(k) && !shared.has(k));
    const onlyL = [...lt].filter((k) => !dk.has(k) && !shared.has(k));
    if (onlyD.length) { console.error(`✗ 主题令牌只在 dark 里：${onlyD.join(', ')}`); bad++; }
    if (onlyL.length) { console.error(`✗ 主题令牌只在 light 里：${onlyL.join(', ')}`); bad++; }
    if (!onlyD.length && !onlyL.length) n++;
  }

  // 7.6 规则体里不许有硬编码颜色（令牌定义行除外，它们本来就要写字面值）。
  //     硬编码色会让主题切换时某处不跟着变 —— 最常见的是「浅色下这块还是黑的」。
  {
    const body = css.replace(/:root[^{]*\{[^}]*\}/g, '');
    const hits = [...body.matchAll(/^\s*[^@/\n][^\n]*?:[^;\n]*(#[0-9a-fA-F]{3,8}\b|\brgba?\()/gm)]
      .filter((m) => !/^\s*--/.test(m[0]))
      .filter((m) => !/data:image\/svg/.test(m[0]));
    if (hits.length) {
      console.error(`✗ 规则体里有 ${hits.length} 处硬编码颜色（切主题时不会跟着变）`);
      hits.slice(0, 3).forEach((h) => console.error('    ' + h[0].trim().slice(0, 90)));
      bad++;
    } else n++;
  }

  // 7.7 玻璃令牌齐全 + 退化方案
  for (const t of ['--glass-bg', '--glass-bg-strong', '--glass-bg-soft', '--glass-edge', '--glass-line', '--glass-shadow']) {
    if (!css.includes(t + ':')) { console.error(`✗ 缺少玻璃令牌 ${t}`); bad++; } else n++;
  }
  if (!/@supports not \(\(backdrop-filter/.test(css)) {
    console.error('✗ 缺少 backdrop-filter 不支持时的退化方案（老浏览器会看不清）'); bad++;
  } else n++;

  // 7.8 两个主题下、正文区与玻璃卡片上的文字都必须 ≥4.5:1。
  //     底色取「该主题下最坏的合成底」（由脚本扫描照片 × 压暗层得出）。
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // 深色最坏底 = 压暗后最亮的海水；浅色最坏底 = 白纱后最亮的水面附近
  const WORST = { dark: [24, 56, 69], light: [251, 253, 254] };
  for (const [theme, blk] of [['dark', darkBlk], ['light', lightBlk]]) {
    for (const t of ['--text', '--text-2', '--text-3', '--brand']) {
      const m = blk && blk.match(new RegExp(`${t}:\\s*(#[0-9a-fA-F]{6})`));
      if (!m) { console.error(`✗ ${theme} 主题缺少 ${t}`); bad++; continue; }
      const r = ratio(rgb(m[1]), WORST[theme]);
      if (r < 4.5) {
        console.error(`✗ ${theme} 主题 ${t} ${m[1]} 在最坏底色上只有 ${r.toFixed(2)}:1（需 ≥4.5:1）`); bad++;
      } else n++;
    }
  }

  // 7.9 主题三处状态都必须在 <head> 的同步预涂脚本里设置好，
  //     否则首帧会先按深色画一遍再跳浅色（肉眼看到「闪一下」）。
  {
    const headEnd = html.indexOf('\n</head>');
    // 用行首的 <style> —— 注释里可能正提到过这个标签名（这个检查自己就被坑过一次）
    const styleAt = html.search(/^<style>/m);
    const pre = html.slice(0, Math.min(headEnd < 0 ? html.length : headEnd, styleAt < 0 ? html.length : styleAt));
    for (const [what, re] of [
      ['data-theme-pref', /dataset\.themePref\s*=/],
      ['data-theme', /dataset\.theme\s*=/],
      ['localStorage 读主题', /getItem\('echolingo\.site\.theme'\)/],
    ]) {
      if (!re.test(pre)) {
        console.error(`✗ <head> 预涂脚本里没有设置 ${what}（会闪一帧）`); bad++;
      } else n++;
    }
  }
  // 主题图标：三颗 SVG 都要真的在按钮里。
  // 注意不能只搜 'i-moon' —— CSS 规则里也有这几个字，删掉 SVG 上的 class 仍然能通过
  //（这个检查自己被这样骗过一次），所以必须匹配 <svg class="i-xxx"。
  for (const ic of ['i-auto', 'i-sun', 'i-moon']) {
    if (!new RegExp(`<svg[^>]*class="${ic}"`).test(html)) {
      console.error(`✗ 缺少主题图标 SVG ${ic}（只写进 CSS 不算）`); bad++;
    } else n++;
  }
  for (const p of ['auto', 'light', 'dark']) {
    if (!new RegExp(`data-theme-pref="${p}"\\]\\s+#btnTheme`).test(css)) {
      console.error(`✗ 缺少 data-theme-pref="${p}" 时的图标显示规则`); bad++;
    } else n++;
  }

  if (bad === 0) console.log(`✓ 海水背景 + 液态玻璃 + 双主题：${n} 项检查通过`);
}

console.log(bad === 0
  ? `✓ 三语字典一致：各 ${keySets[langs[0]].size} 条，markup 绑定 ${bound.size} 个 key 全部命中`
  : `✗ 共 ${bad} 个问题`);
process.exit(bad === 0 ? 0 : 1);
