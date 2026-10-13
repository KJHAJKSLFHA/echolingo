// 遮罩「烧录字幕带」定位器 · 纯 Node 单测
//
// 不需要浏览器、不需要视频文件 —— 直接喂合成的灰度帧给 app/js/subtitle-mask.js
// 里的 createBandDetector()。
//
// 为什么要有这个测试（而不是只靠 bench/probe-mask-detect.mjs 跑真视频）：
//   2026-10-13 那次失败来自「背景的每一行都在大幅变化」这种画面（手持镜头
//   拍的水面）。真视频探针只有手边正好有那条素材时才能复现，而且 900MB 的
//   文件不适合当回归测试。这里把那种画面**按真实剖面合成出来**，把回归钉死。
//
// 合成背景的三个性质，就是照那次失败的真视频捏的：
//   · 横向很平滑（240px 长周期正弦）→ edge 很低
//   · 每帧相位平移很大、逐行再叠随机直流偏移 → change 很高，**每一行都高**
//   · 振幅大 → 行内方差高
// 旧算法（除以全局最大值）在这三条下必然被淹：实测真视频里搜索区 87 行里有
// 80 行的得分 ≥ 0.42×峰值，区间一路长到画面高 44%，被「太宽」自检打回。
//
// 用法：node bench/test-band-detect.mjs        （退出码 0 = 全过）

import { readFileSync } from 'node:fs';
import { createBandDetector, scoreRows, bandFromScore } from '../app/js/subtitle-mask.js';

const W = 320, H = 180;
const SUB_TOP = 158, SUB_BOT = 172;        // 合成字幕带的行范围（含两端）
const X0 = Math.round(W * 0.10), X1 = Math.round(W * 0.90);

// 确定性伪随机（mulberry32）。测试必须可复现，不能用 Math.random。
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成一帧灰度图。
 * @param {number} frame 帧序号
 * @param {object} o
 * @param {boolean} o.text    是否画字幕
 * @param {number}  o.textTop 字幕带首行
 * @param {number}  o.textBot 字幕带末行
 */
function makeFrame(frame, { text = false, textTop = SUB_TOP, textBot = SUB_BOT } = {}) {
  const r = rng(1000 + frame);
  const g = new Uint8ClampedArray(W * H);
  const rowNoise = new Float64Array(H);
  for (let y = 0; y < H; y++) rowNoise[y] = (r() - 0.5) * 14;

  for (let y = 0; y < H; y++) {
    const phase = frame * 1.7 + y * 0.013;
    for (let x = 0; x < W; x++) {
      g[y * W + x] = 128 + 100 * Math.sin((2 * Math.PI * x) / 240 + phase) + rowNoise[y];
    }
  }

  if (text) {
    // 字幕：黑白方波（模拟笔画），每帧只挪一点点 —— 时间上的变化**故意做得
    // 比背景小**，这样 change 这一路特征就完全是背景在主导，跟真视频一致。
    const shift = frame % 3;
    for (let y = textTop; y <= textBot; y++) {
      for (let x = X0; x < X1; x++) {
        const on = ((x + shift) * 7 + y * 13) % 11 < 5;
        g[y * W + x] = on ? 20 : 235;
      }
    }
  }
  return g;
}

function detect(frames, opts) {
  const det = createBandDetector();
  for (let f = 0; f < frames; f++) {
    if (!det.push(makeFrame(f, opts), W, H)) break;
  }
  return det;
}

/* ---------------- 断言脚手架 ---------------- */

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '   ' + detail : ''}`); }
}
const pct = (v) => (v * 100).toFixed(1) + '%';

/* ---------------- 用例 ---------------- */

console.log('遮罩字幕带定位器 · 合成帧单测');
console.log(`画面 ${W}×${H}，合成字幕带 = 行 ${SUB_TOP}~${SUB_BOT}（${pct(SUB_TOP / H)} ~ ${pct((SUB_BOT + 1) / H)}）\n`);

// ① 闹背景 + 两行字幕：必须找到，而且必须落在字幕带上
{
  console.log('① 大幅度变化的背景 + 两行字幕 → 应该找得到，且位置正确');
  const det = detect(30, { text: true });
  const prof = det.profile();
  const res = det.result();
  console.log(`     帧数 ${prof.frames}  峰值行 ${prof.best}（${pct(prof.best / H)}）  z=${prof.bestVal.toFixed(2)}  背景中位数 z=${prof.bg.toFixed(2)}  突出度 ${prof.prominence}`);
  check('能定位到字幕带', !!res, res ? `→ ${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}（置信度 ${res.confidence}）` : '（返回 null）');
  if (res) {
    check('上边界盖住字幕带首行', res.topRatio <= SUB_TOP / H + 0.02, `上边界 ${pct(res.topRatio)}，首行在 ${pct(SUB_TOP / H)}`);
    check('下边界盖住字幕带末行', res.bottomRatio >= (SUB_BOT + 1) / H - 0.02, `下边界 ${pct(res.bottomRatio)}，末行在 ${pct((SUB_BOT + 1) / H)}`);
    check('带宽没有失控', res.bottomRatio - res.topRatio <= 0.22, `带宽 ${pct(res.bottomRatio - res.topRatio)}`);
    check('峰值落在字幕带里', prof.best >= SUB_TOP - 4 && prof.best <= SUB_BOT + 4, `峰值行 ${prof.best}`);
  }
  console.log('');
}

// ② 只有闹背景、没有任何字幕：必须返回 null（不能瞎猜一条带）
{
  console.log('② 只有大幅度变化的背景、没有字幕 → 应该返回 null');
  const det = detect(30, { text: false });
  const prof = det.profile();
  const res = det.result();
  console.log(`     峰值 z=${prof.bestVal.toFixed(2)}  背景中位数 z=${prof.bg.toFixed(2)}  突出度 ${prof.prominence}`);
  check('没有字幕时不乱猜', res === null, res ? `却给出 ${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}` : '');
  check('突出度确实低于门槛 6', prof.prominence < 6, `突出度 ${prof.prominence}`);
  console.log('');
}

// ③ 字幕只出现在画面上半部：搜索区限制在下半部，仍应返回 null
{
  console.log('③ 字幕只在画面上半部 → 仍应返回 null（只在下半部找）');
  const det = detect(30, { text: true, textTop: 30, textBot: 45 });
  const res = det.result();
  check('上半部的字不会被当成字幕带', res === null, res ? `却给出 ${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}` : '');
  console.log('');
}

// ④ 帧数不够：不能出结论
{
  console.log('④ 只喂 5 帧 → 应该返回 null（样本不足）');
  const det = detect(5, { text: true });
  check('帧数不足时不下结论', det.result() === null, `帧数 ${det.frames}`);
  console.log('');
}

// ⑤ 单行字幕：带高必须收得住，不能糊成一大条
{
  console.log('⑤ 只有一行字幕（行 162~170）→ 找到的带不能太宽');
  const det = detect(30, { text: true, textTop: 162, textBot: 170 });
  const res = det.result();
  check('单行字幕也能定位', !!res, res ? `→ ${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}` : '（返回 null）');
  if (res) check('带高收在 14% 以内', res.bottomRatio - res.topRatio <= 0.14, `带高 ${pct(res.bottomRatio - res.topRatio)}`);
  console.log('');
}

// ⑥ 真实素材：那条「找不到烧录字幕」的西语 Vlog。逐行剖面录在 fixtures 里
//    （bench/probe-mask-detect.mjs 负责生成），真视频 900MB 不适合当测试用例，
//    但剖面只有几 KB，重放的是同一份打分代码。
{
  console.log('⑥ 真实剖面重放：西语 Vlog（旧算法在这条上返回 null）');
  const f = JSON.parse(readFileSync(new URL('./fixtures/mask-profile-vlog.json', import.meta.url), 'utf8'));
  const c = scoreRows(f.edge, f.change, f.variance, f.H);
  const res = bandFromScore(c);
  console.log(`     ${f.H} 行 × ${f.frames} 帧  峰值行 ${c.best}（${pct(c.best / f.H)}）  z=${c.bestVal.toFixed(2)}  背景中位数 z=${c.bg.toFixed(2)}  突出度 ${(c.bestVal - c.bg).toFixed(2)}`);
  check('真实素材上能找到字幕带', !!res, res ? `→ ${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}` : '（返回 null）');
  if (res) {
    check('带宽落在合理区间', res.bottomRatio - res.topRatio >= 0.025 && res.bottomRatio - res.topRatio <= 0.22, `带宽 ${pct(res.bottomRatio - res.topRatio)}`);
    check('覆盖画面底部约 87% 起的那两行字幕', res.topRatio <= 0.90 && res.bottomRatio >= 0.94, `${pct(res.topRatio)} ~ ${pct(res.bottomRatio)}`);
    check('峰值落在字幕行上', c.best >= 156 && c.best <= 174, `峰值行 ${c.best}`);
  }

  // 钉住「这条素材曾经失败」：按旧算法（除以全局最大值 + 0.42 增长 + 22% 上限）
  // 原样算一遍。如果哪天有人把打分改回全局归一化，这里会立刻报警。
  const yStart = Math.floor(f.H * 0.52);
  const norm = (a) => { let m = 0; for (let y = yStart; y < f.H; y++) m = Math.max(m, a[y]); return m > 1e-6 ? 1 / m : 0; };
  const eN = norm(f.edge), cN = norm(f.change), vN = norm(f.variance);
  const old = new Float64Array(f.H);
  let oBest = yStart, oVal = -1, sum = 0, cnt = 0;
  for (let y = yStart; y < f.H; y++) {
    old[y] = 0.45 * f.edge[y] * eN + 0.35 * f.change[y] * cN + 0.20 * f.variance[y] * vN;
    sum += old[y]; cnt++;
    if (old[y] > oVal) { oVal = old[y]; oBest = y; }
  }
  const oMean = sum / cnt;
  let oldOk = false, oldW = 0;
  if (oVal >= oMean * 1.9) {
    const thr = oVal * 0.42;
    let lo = oBest, hi = oBest;
    while (lo > yStart && old[lo - 1] >= thr) lo--;
    while (hi < f.H - 1 && old[hi + 1] >= thr) hi++;
    lo = Math.max(yStart, lo - 3); hi = Math.min(f.H - 1, hi + 3);
    oldW = (hi + 1 - lo) / f.H;
    oldOk = oldW >= 0.025 && oldW <= 0.22;
  }
  console.log(`     对照 · 旧算法：峰值行 ${oBest}，突出度 ${(oVal / oMean).toFixed(3)}（门槛 1.9）→ ${oldOk ? `给出了 ${pct(oldW)} 的带` : '返回 null'}`);
  check('旧算法在这条素材上确实会失败（说明这个用例有意义）', !oldOk, `旧算法带宽 ${pct(oldW)}`);
  console.log('');
}

console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ 有 ${fail} 项没过（通过 ${pass} 项）`);
process.exit(fail === 0 ? 0 : 1);
