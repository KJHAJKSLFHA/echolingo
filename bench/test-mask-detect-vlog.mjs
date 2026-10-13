// 用**用户那条真实的西语 Vlog** 验收「自动定位字幕位置」。
//
// 这条素材就是用户截图里报的那条：旧检测器在它上面返回 null，App 于是提示
// 「没找到烧录字幕，遮罩保持默认位置」，遮罩停在默认位置、盖不住字幕。
// 这个测试走的是真实的界面按钮（#btnMaskDetect → runMaskSeekScan），
// 断言它现在真的能圈到画面下方那一条字幕。
//
// 画面里字幕的地面真相来自 bench/probe-mask-detect.mjs 的 ASCII 亮度图：
// 180 行里字幕占 157~175 行（87.5% ~ 97.5%）。
//
//   node bench/test-mask-detect-vlog.mjs [httpPort] [cdpPort] [videoPath]
import { spawn } from 'node:child_process';
import { statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9354);
const MEDIA = process.argv[4] || '/Users/orion/Movies/西语Vlog｜我终于来到了巴塔哥尼亚.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 地面真相：字幕行占画面的这个纵向范围（见文件头注释）
const TRUTH_TOP = 0.875, TRUTH_BOTTOM = 0.975;

try { const st = statSync(MEDIA); log(`素材 ${MEDIA.split('/').pop()}  ${(st.size / 1048576).toFixed(0)} MB`); }
catch { console.log('✗ 找不到素材：' + MEDIA); process.exit(1); }

const profile = join(tmpdir(), 'echo-vlogmask-profile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let ok = false;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const errs = [];
  ws.addEventListener('message', (evt) => {
    const m = JSON.parse(evt.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text;
      errs.push(String(d).split('\n')[0]);
    }
  });
  const cmd = async (method, params) => {
    const i = ++id;
    const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
    return m.result;
  };
  const ev = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const J = (expr) => ev(`(async () => JSON.stringify(await (${expr})))()`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 200; i++) { if (await ev(`!!document.getElementById('player')`)) break; await sleep(300); }
  // 从一个**明显不是答案**的位置起步：如果检测没跑成，比例会原样停在这里，
  // 断言就会失败 —— 不会出现「碰巧等于正确答案」的假绿。
  await ev(`localStorage.setItem('echolingo.settings.v1', JSON.stringify({ lang: 'zh',
    mask: { enabled: true, style: 'soft', strength: 34, topRatio: 0.70, bottomRatio: 0.80, auto: false } }))`);
  await cmd('Page.reload');
  for (let i = 0; i < 200; i++) {
    if (await ev(`typeof window.__ECHOLINGO_VER__ !== 'undefined' && !!document.getElementById('btnMaskDetect')`)) break;
    await sleep(300);
  }
  log('应用已打开，版本 ' + await ev(`window.__ECHOLINGO_VER__`));

  // 记录提示条上出现过的文案（检测中/检测完），也记录 toast
  await ev(`(() => {
    window.__chips = [];
    window.__toasts = [];
    const chip = document.querySelector('.submask-chip');
    const push = () => { const s = (chip.textContent || '').trim();
      if (s && window.__chips[window.__chips.length - 1] !== s) window.__chips.push(s); };
    push();
    new MutationObserver(push).observe(chip, { childList: true, characterData: true, subtree: true });
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType === 1) { const s = (n.textContent || '').trim(); if (s) window.__toasts.push(s); }
      }
    }).observe(document.body, { childList: true, subtree: true });
    return true;
  })()`);

  /* ---------------- 导入真视频 ---------------- */
  log('导入真西语 Vlog（914MB，走真实的 #fileVideo 链路）…');
  const { root } = await cmd('DOM.getDocument');
  const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileVideo' });
  await cmd('DOM.setFileInputFiles', { files: [MEDIA], nodeId });

  const meta = await J(`(async () => {
    const p = document.getElementById('player');
    await new Promise((res) => { if (p.videoWidth) return res();
      p.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 60000); });
    return { w: p.videoWidth, h: p.videoHeight, dur: p.duration || 0, name: (document.getElementById('player').src || '').slice(0, 5) };
  })()`);
  log(`视频 ${meta.w}×${meta.h}  时长 ${Number(meta.dur).toFixed(1)}s`);
  check('真视频导入成功并拿到画面尺寸', meta.w > 0 && meta.h > 0 && meta.dur > 60,
    `${meta.w}×${meta.h}  ${Number(meta.dur).toFixed(1)}s`);

  const before = await J(`(async () => {
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    return { top: st.mask.topRatio, bottom: st.mask.bottomRatio };
  })()`);
  check('检测前的起始位置就是那个「找不到字幕」的旧状态', near(before.top, 0.70, 0.0001) && near(before.bottom, 0.80, 0.0001),
    `${(before.top * 100).toFixed(1)}% ~ ${(before.bottom * 100).toFixed(1)}%`);

  /* ---------------- 点「重新检测」 ---------------- */
  log('点设置面板里的「重新检测字幕位置」…');
  await ev(`document.getElementById('btnMaskDetect').click()`);

  let after = before;
  const tStart = Date.now();
  for (let i = 0; i < 600; i++) {   // 最多等 5 分钟（要跳着 seek 14 个位置）
    await sleep(500);
    after = await J(`(async () => {
      const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
      return { top: st.mask.topRatio, bottom: st.mask.bottomRatio };
    })()`);
    if (!near(after.top, before.top, 0.0005) || !near(after.bottom, before.bottom, 0.0005)) break;
    if (i % 20 === 19) log(`  仍在检测… ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
  }
  const took = ((Date.now() - tStart) / 1000).toFixed(1);
  const info = await J(`(async () => {
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    const n = document.querySelector('.submask');
    const r = n ? n.getBoundingClientRect() : null;
    const p = document.getElementById('player').getBoundingClientRect();
    return {
      saved: st.mask,
      chips: window.__chips,
      toasts: window.__toasts,
      maskBox: r ? { y: r.y, h: r.height, w: r.width } : null,
      player: { y: p.y, h: p.height },
      layerHidden: n ? n.hidden : null,
    };
  })()`);

  const got = info.saved;
  log(`检测用时 ${took}s → ${(got.topRatio * 100).toFixed(1)}% ~ ${(got.bottomRatio * 100).toFixed(1)}%`);
  console.log('  提示条文案轨迹：' + JSON.stringify(info.chips));
  console.log('  toast：' + JSON.stringify(info.toasts.slice(0, 6)));

  check('检测确实改动了位置（不是原样停着）',
    !near(got.topRatio, before.top, 0.0005) || !near(got.bottomRatio, before.bottom, 0.0005),
    `${(before.top * 100).toFixed(1)}% → ${(got.topRatio * 100).toFixed(1)}%`);
  check('上边界落在画面下方（不是顶部也不是默认值 90.5%）',
    got.topRatio > 0.60 && got.topRatio < 0.92, `${(got.topRatio * 100).toFixed(1)}%`);
  check('检测出的带子真的盖住了字幕行（87.5% ~ 97.5%）',
    got.topRatio <= TRUTH_TOP + 0.005 && got.bottomRatio >= TRUTH_BOTTOM - 0.005,
    `带子 ${(got.topRatio * 100).toFixed(1)}% ~ ${(got.bottomRatio * 100).toFixed(1)}%  地面真相 ${TRUTH_TOP * 100}% ~ ${TRUTH_BOTTOM * 100}%`);
  check('带高在合理范围（不是整屏、也不是一条线）',
    got.bottomRatio - got.topRatio > 0.04 && got.bottomRatio - got.topRatio < 0.26,
    `带高 ${((got.bottomRatio - got.topRatio) * 100).toFixed(1)}%`);
  check('没有出现「没检测到字幕」的提示',
    !info.toasts.some((s) => s.includes('没检测到') || s.includes('No clear') || s.includes('No se han detectado')),
    info.toasts.length ? info.toasts.slice(0, 3).join(' | ') : '（没有 toast）');
  check('检测过程的提示条出现过「正在定位字幕位置」',
    info.chips.some((s) => s.includes('正在定位')), JSON.stringify(info.chips));

  // 几何：遮罩盒子的位置应该和存档比例对得上（画面内容区里换算出来的那一段）
  const mediaAspect = meta.w / meta.h;
  const vrect = await J(`(async () => { const p = document.getElementById('player').getBoundingClientRect();
    return { x: p.x, y: p.y, w: p.width, h: p.height }; })()`);
  const videoAspect = vrect.w / vrect.h;
  const contentH = mediaAspect > videoAspect ? vrect.w / mediaAspect : vrect.h;
  const contentTop = vrect.y + (vrect.h - contentH) / 2;
  const expectY = contentTop + got.topRatio * contentH;
  const expectH = (got.bottomRatio - got.topRatio) * contentH;
  check('遮罩在屏幕上画的位置和存档比例一致',
    info.maskBox && Math.abs(info.maskBox.y - expectY) < 2.5 && Math.abs(info.maskBox.h - expectH) < 2.5,
    info.maskBox ? `实际 y=${info.maskBox.y.toFixed(0)} h=${info.maskBox.h.toFixed(0)} / 期望 y=${expectY.toFixed(0)} h=${expectH.toFixed(0)}` : '没有遮罩元素');
  check('遮罩是开着的', info.layerHidden === false, `hidden = ${info.layerHidden}`);

  check('过程中没有 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('');
  console.log(fail === 0 ? `✓ 真西语 Vlog 的自动字幕定位全部通过（${pass} 项）` : `✗ 有 ${fail} 项没过（通过 ${pass} 项）`);
  console.log(JSON.stringify({ detected: got, chips: info.chips, toasts: info.toasts.slice(0, 6), tookSec: +took, errs }, null, 2));
  ok = fail === 0;
} catch (e) {
  console.log('✗ 测试中断：' + (e && e.message));
  console.log(e && e.stack);
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
