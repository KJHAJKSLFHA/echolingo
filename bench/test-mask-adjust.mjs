// 「在画面上自由拖动调整遮罩位置」的端到端验证。
//
// 不依赖 900MB 的真视频：在页面里用 canvas + MediaRecorder 现场录一段 1.5 秒的
// 小视频（画面底部画一条白色字幕），再用 DataTransfer 塞进 #fileVideo ——
// 走的是**真实的导入链路**（S.file / videoWidth / localStorage 落盘都是真的），
// 只是素材足够小，几秒钟就能跑完，因此可以反复迭代。
//
//   node bench/test-mask-adjust.mjs [httpPort] [cdpPort]
//
// 判定用的都是「拖动前后 S.settings.mask 里那两个比例」而不是像素截图：
// 屏幕位移 ÷ 画面内容高度 = 比例位移，这条换算关系是本功能的全部数学。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8910);
const CDP_PORT = Number(process.argv[3] || 9352);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const profile = join(tmpdir(), 'echo-maskprofile');
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

// 在页面里现场录一段 1.5 秒 640×360 的视频（画面底部画一条"字幕"），
// 再通过 DataTransfer 走真实的 #fileVideo change 链路导入。
// 刷新之后要重来一遍 —— 浏览器不会把 file input 的内容跨 reload 保留，
// 没有 src 的 <video> 会让 #player 的 display:none 生效，遮罩自然量不到。
const GEN_VIDEO = `(async () => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const g = c.getContext('2d');
  const stream = c.captureStream(25);
  // 塞一条静音音轨，免得识别那一步因为「没有音轨」直接失败
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    const gn = ac.createGain(); gn.gain.value = 0;
    const osc = ac.createOscillator();
    osc.connect(gn); gn.connect(dest); osc.start();
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  } catch (e) { /* 没音轨也能测遮罩 */ }
  if (typeof MediaRecorder === 'undefined') return 'no-mediarecorder';
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
  catch (e) { return 'mime-unsupported: ' + e.message; }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  const s0 = performance.now();
  while (performance.now() - s0 < 1500) {
    const k = (performance.now() - s0) / 1000;
    g.fillStyle = 'hsl(' + Math.round(200 + k * 60) + ',45%,30%)';
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff';
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('SUBTITLE TEST', 320, 318);
    await new Promise((r) => setTimeout(r, 40));
  }
  rec.stop();
  await stopped;
  const file = new File(chunks, 'synthetic-640x360.webm', { type: 'video/webm' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const inp = document.getElementById('fileVideo');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok:' + file.size;
})()`;

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
  // 注意：必须把表达式 await 出来再 stringify，否则 Promise 会变成 {}
  const J = (expr) => ev(`(async () => JSON.stringify(await (${expr})))()`).then((s) => JSON.parse(s));

  await cmd('Runtime.enable');
  await cmd('DOM.enable');
  await cmd('Page.enable');
  // 深色主题下主题按钮是月亮，别让它跟别的图标混在一起；这里只关心遮罩
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/app/` });
  for (let i = 0; i < 200; i++) { if (await ev(`!!document.getElementById('player')`)) break; await sleep(300); }
  // 起始位置固定在画面中下部，上下都留足空间 —— 否则默认的 90.5%~98.7%
  // 贴着画面底边，往下拖会立刻撞到 100% 的上限，测不出位移。
  await ev(`localStorage.setItem('echolingo.settings.v1', JSON.stringify({ lang: 'zh',
    mask: { enabled: false, style: 'soft', strength: 34, topRatio: 0.70, bottomRatio: 0.80, auto: true } }))`);
  await cmd('Page.reload');
  for (let i = 0; i < 200; i++) {
    if (await ev(`typeof window.__ECHOLINGO_VER__ !== 'undefined' && !!document.getElementById('btnMaskAdjust')`)) break;
    await sleep(300);
  }
  log('应用已打开，版本 ' + await ev(`window.__ECHOLINGO_VER__`));

  const out = {};

  /* ---------------- 0) 现场录一段小视频并走真实导入 ---------------- */
  log('录制 640×360 合成视频并导入…');
  const gen = await ev(GEN_VIDEO);
  log('生成结果：' + gen);
  check('能在页面里现场生成测试视频', String(gen).startsWith('ok:'), String(gen));

  const meta = await J(`(async () => {
    const p = document.getElementById('player');
    await new Promise((res) => {
      if (p.videoWidth) return res();
      p.addEventListener('loadeddata', res, { once: true });
      setTimeout(res, 15000);
    });
    return { w: p.videoWidth, h: p.videoHeight, dur: p.duration || 0 };
  })()`);
  out.meta = meta;
  check('导入后播放器拿到了画面尺寸', meta.w > 0 && meta.h > 0, `${meta.w}×${meta.h}  时长 ${Number.isFinite(meta.dur) ? meta.dur.toFixed(2) + 's' : meta.dur}`);
  if (!meta.w) throw new Error('合成视频没有画面尺寸，后面的几何断言没有意义');

  /* ---------------- 1) 从设置面板进入调整态 ---------------- */
  log('打开设置面板 → 点「在画面上调整位置」…');
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(250);
  await ev(`document.getElementById('btnMaskAdjust').click()`);
  await sleep(350);
  const s1 = await J(`(async () => {
    const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; };
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    const wr = document.getElementById('playerWrap').getBoundingClientRect();
    const vr = document.getElementById('player').getBoundingClientRect();
    return {
      editHidden: document.querySelector('.submask-edit').hidden,
      box: rect('.submask-edit-box'), gripTop: rect('.submask-edit-grip.top'),
      gripBot: rect('.submask-edit-grip.bottom'), done: rect('.submask-edit-done'),
      doneText: document.querySelector('.submask-edit-done').textContent,
      hint: document.querySelector('.submask-edit-hint').textContent,
      chipHidden: document.querySelector('.submask-chip').hidden,
      layerHidden: document.querySelector('.submask').hidden,
      maskBox: rect('.submask'),
      wrap: { x: wr.x, y: wr.y, w: wr.width, h: wr.height },
      video: { x: vr.x, y: vr.y, w: vr.width, h: vr.height },
      saved: st.mask || null,
      drawerOpen: !document.getElementById('setDrawer').hidden,
      scrim: !document.getElementById('scrim').hidden,
    };
  })()`);
  out.enter = s1;
  check('调整层出现了', s1.editHidden === false && !!s1.box && s1.box.w > 0 && s1.box.h > 0,
    s1.box ? `编辑框 ${Math.round(s1.box.w)}×${Math.round(s1.box.h)}` : '没有编辑框');
  check('上下两条抓手都在', !!s1.gripTop && !!s1.gripBot && s1.gripTop.w > 40 && s1.gripBot.w > 40,
    s1.gripTop ? `抓手宽 ${Math.round(s1.gripTop.w)}px` : '缺少抓手');
  check('画面右上角有「完成」出口', !!s1.done && s1.done.w > 20, `文字「${s1.doneText}」`);
  check('编辑态下遮罩可见（否则看不见自己在拖什么）', s1.layerHidden === false, '');
  check('编辑态下原来的提示条让位', s1.chipHidden === true, '');
  check('进入调整态会自动关掉自动定位', s1.saved && s1.saved.auto === false, `saved.auto = ${s1.saved && s1.saved.auto}`);
  check('进入调整态会自动打开遮罩', s1.saved && s1.saved.enabled === true, `saved.enabled = ${s1.saved && s1.saved.enabled}`);
  check('设置面板的蒙层让开了（否则画面点不到）', s1.drawerOpen === false && s1.scrim === false, `drawer=${s1.drawerOpen} scrim=${s1.scrim}`);

  // 画面内容高度：letterbox 之后真正有画面的那一段（拖动换算用的分母）
  const mediaAspect = s1.meta ? s1.meta.w / s1.meta.h : 640 / 360;
  const videoAspect = s1.video.w / s1.video.h;
  const contentH = mediaAspect > videoAspect ? s1.video.w / mediaAspect : s1.video.h;
  out.contentH = contentH;
  log(`画面内容高度 ${contentH.toFixed(1)}px（视频元素 ${Math.round(s1.video.w)}×${Math.round(s1.video.h)}）`);

  const readState = () => J(`(async () => {
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; };
    return {
      saved: st.mask || null,
      top: +document.getElementById('setMaskTop').value,
      bottom: +document.getElementById('setMaskBottom').value,
      box: rect('.submask-edit-box'), gripTop: rect('.submask-edit-grip.top'), gripBot: rect('.submask-edit-grip.bottom'),
    };
  })()`);

  const dragTo = async (from, dy) => {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.cx, y: from.cy, buttons: 0 });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.cx, y: from.cy, button: 'left', buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await cmd('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: from.cx, y: from.cy + (dy * i) / steps, button: 'left', buttons: 1,
      });
      await sleep(20);
    }
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.cx, y: from.cy + dy, button: 'left', buttons: 0 });
    await sleep(160);
  };

  const a = await readState();
  const baseTop = a.saved.topRatio, baseBottom = a.saved.bottomRatio, baseH = baseBottom - baseTop;
  log(`起始位置 ${(baseTop * 100).toFixed(2)}% ~ ${(baseBottom * 100).toFixed(2)}%（带高 ${(baseH * 100).toFixed(2)}%）`);

  /* ---------------- 2) 拖上边缘 ---------------- */
  log('拖上边缘 +24px…');
  await dragTo(a.gripTop, 24);
  const b = await readState();
  const dTop = b.saved.topRatio - baseTop;
  check('拖上边缘 → 上边界跟着走', dTop > 0.4 * (24 / contentH), `Δ上边界 ${(dTop * 100).toFixed(2)}%（屏幕 24px ≈ ${((24 / contentH) * 100).toFixed(2)}%）`);
  check('拖上边缘 → 下边界不动', near(b.saved.bottomRatio, baseBottom, 0.003), `Δ下边界 ${((b.saved.bottomRatio - baseBottom) * 100).toFixed(2)}%`);
  check('上边界不能越过下边界', b.saved.topRatio < b.saved.bottomRatio, `${(b.saved.topRatio * 100).toFixed(2)}% < ${(b.saved.bottomRatio * 100).toFixed(2)}%`);

  /* ---------------- 3) 拖下边缘 ---------------- */
  log('拖下边缘 +18px…');
  const c0 = await readState();
  await dragTo(c0.gripBot, 18);
  const c = await readState();
  check('拖下边缘 → 下边界跟着走', c.saved.bottomRatio - c0.saved.bottomRatio > 0.4 * (18 / contentH),
    `Δ下边界 ${((c.saved.bottomRatio - c0.saved.bottomRatio) * 100).toFixed(2)}%`);
  check('拖下边缘 → 上边界不动', near(c.saved.topRatio, c0.saved.topRatio, 0.003), `Δ上边界 ${((c.saved.topRatio - c0.saved.topRatio) * 100).toFixed(2)}%`);

  /* ---------------- 4) 拖中间整体移动 ---------------- */
  log('拖中间整体上移 30px（带高应保持不变）…');
  const d0 = await readState();
  const h0 = d0.saved.bottomRatio - d0.saved.topRatio;
  const mid = { cx: d0.box.cx, cy: d0.box.y + d0.box.h / 2 };
  await dragTo(mid, -30);
  const d = await readState();
  const h1 = d.saved.bottomRatio - d.saved.topRatio;
  check('拖中间 → 整条带向上移动', d.saved.topRatio < d0.saved.topRatio - 0.4 * (30 / contentH),
    `Δ上边界 ${((d.saved.topRatio - d0.saved.topRatio) * 100).toFixed(2)}%`);
  check('拖中间 → 带高不变', near(h1, h0, 0.004), `${(h0 * 100).toFixed(2)}% → ${(h1 * 100).toFixed(2)}%`);

  /* ---------------- 5) 越界钳制 ---------------- */
  log('把中间一直往上拖到画面外（应该停在上限 5%，带高不变）…');
  const e0 = await readState();
  const hE = e0.saved.bottomRatio - e0.saved.topRatio;
  await dragTo({ cx: e0.box.cx, cy: e0.box.y + e0.box.h / 2 }, -2000);
  const e = await readState();
  check('拖出上边界会被钳在上限 5%（不会翻出去）', near(e.saved.topRatio, 0.05, 0.0011), `上边界 ${(e.saved.topRatio * 100).toFixed(2)}%`);
  check('钳住之后带高仍然不变', near(e.saved.bottomRatio - e.saved.topRatio, hE, 0.004),
    `${(hE * 100).toFixed(2)}% → ${((e.saved.bottomRatio - e.saved.topRatio) * 100).toFixed(2)}%`);
  check('带高有最小值保护（不会压成 0）', e.saved.bottomRatio - e.saved.topRatio >= 0.019,
    `带高 ${((e.saved.bottomRatio - e.saved.topRatio) * 100).toFixed(2)}%`);
  check('钳住后下边界也还在合理范围（0.08~1）',
    e.saved.bottomRatio >= 0.0799 && e.saved.bottomRatio <= 1.0001, `下边界 ${(e.saved.bottomRatio * 100).toFixed(2)}%`);

  /* ---------------- 6) 滑杆与存档一致 ---------------- */
  const f = await readState();
  check('两条滑杆跟存档一致',
    Math.abs(f.top / 100 - f.saved.topRatio) < 0.011 && Math.abs(f.bottom / 100 - f.saved.bottomRatio) < 0.011,
    `滑杆 ${f.top}% / ${f.bottom}% 存档 ${(f.saved.topRatio * 100).toFixed(2)}% / ${(f.saved.bottomRatio * 100).toFixed(2)}%`);
  check('存档里的 auto 已经关掉', f.saved.auto === false, `auto = ${f.saved.auto}`);

  /* ---------------- 7) 用画面上的「完成」退出 ---------------- */
  log('点画面右上角的「完成」…');
  const beforeDone = await readState();
  await ev(`document.querySelector('.submask-edit-done').click()`);
  await sleep(300);
  const g = await J(`(async () => {
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    return {
      editHidden: document.querySelector('.submask-edit').hidden,
      layerHidden: document.querySelector('.submask').hidden,
      chipHidden: document.querySelector('.submask-chip').hidden,
      chipText: document.querySelector('.submask-chip').textContent,
      saved: st.mask,
    };
  })()`);
  check('「完成」之后编辑层收起', g.editHidden === true, '');
  check('「完成」之后遮罩还在（位置保留）', g.layerHidden === false, '');
  check('「完成」不会改动位置',
    near(g.saved.topRatio, beforeDone.saved.topRatio, 0.0005) && near(g.saved.bottomRatio, beforeDone.saved.bottomRatio, 0.0005),
    `${(g.saved.topRatio * 100).toFixed(2)}% ~ ${(g.saved.bottomRatio * 100).toFixed(2)}%`);
  check('「完成」之后提示条回来', g.chipHidden === false, `「${String(g.chipText).slice(0, 18)}…」`);

  /* ---------------- 8) 刷新后位置还在 ---------------- */
  log('刷新页面，检查位置是否从 localStorage 恢复…');
  const keeper = { top: g.saved.topRatio, bottom: g.saved.bottomRatio };
  await cmd('Page.reload');
  for (let i = 0; i < 200; i++) {
    if (await ev(`typeof window.__ECHOLINGO_VER__ !== 'undefined' && !!document.getElementById('btnMaskAdjust')`)) break;
    await sleep(300);
  }
  await sleep(400);
  // 刷新会把 file input 清空，要重新导一个视频，遮罩才量得到位置
  const gen2 = await ev(GEN_VIDEO);
  await ev(`(async () => {
    const p = document.getElementById('player');
    await new Promise((res) => { if (p.videoWidth) return res();
      p.addEventListener('loadeddata', res, { once: true }); setTimeout(res, 15000); });
    return true;
  })()`);
  await sleep(500);
  const h = await J(`(async () => {
    const st = JSON.parse(localStorage.getItem('echolingo.settings.v1') || '{}');
    const rect = (sel) => { const n = document.querySelector(sel); if (!n) return null;
      const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const p = document.getElementById('player');
    return {
      saved: st.mask || null,
      sliderTop: +document.getElementById('setMaskTop').value,
      sliderBottom: +document.getElementById('setMaskBottom').value,
      autoChecked: document.getElementById('chkMaskAuto').checked,
      enabledChecked: document.getElementById('chkMask').checked,
      layerHidden: document.querySelector('.submask').hidden,
      maskBox: rect('.submask'),
      editHidden: document.querySelector('.submask-edit').hidden,
      video: { w: p.videoWidth, h: p.videoHeight },
    };
  })()`);
  out.reload = h;
  check('刷新后能重新导入视频', gen2 && String(gen2).startsWith('ok:') && h.video.w > 0, String(gen2));
  check('刷新后比例原样恢复',
    near(h.saved.topRatio, keeper.top, 0.0005) && near(h.saved.bottomRatio, keeper.bottom, 0.0005),
    `${(h.saved.topRatio * 100).toFixed(2)}% ~ ${(h.saved.bottomRatio * 100).toFixed(2)}%`);
  check('刷新后滑杆也回到同一位置',
    Math.abs(h.sliderTop / 100 - keeper.top) < 0.011 && Math.abs(h.sliderBottom / 100 - keeper.bottom) < 0.011,
    `滑杆 ${h.sliderTop}% / ${h.sliderBottom}%`);
  check('刷新后「自动定位」的勾选状态也是关的', h.autoChecked === false, `checked = ${h.autoChecked}`);
  check('刷新后遮罩仍然开着、没停在编辑态、并画在恢复的位置上',
    h.enabledChecked === true && h.layerHidden === false && h.editHidden === true && !!h.maskBox && h.maskBox.h > 0,
    h.maskBox ? `遮罩 ${Math.round(h.maskBox.w)}×${Math.round(h.maskBox.h)} @ y=${Math.round(h.maskBox.y)}` : '没有遮罩');

  /* ---------------- 9) 没有 JS 异常 ---------------- */
  out.errs = errs;
  check('过程中没有 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('');
  console.log(fail === 0 ? `✓ 遮罩拖动调整全部通过（${pass} 项）` : `✗ 有 ${fail} 项没过（通过 ${pass} 项）`);
  console.log(JSON.stringify(out, null, 2));
  ok = fail === 0;
} catch (e) {
  console.log('✗ 测试中断：' + (e && e.message));
  console.log(e && e.stack);
} finally {
  chrome.kill('SIGKILL');
}
process.exit(ok ? 0 : 1);
