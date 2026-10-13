// 把「模糊画面烧录字幕」这个功能**真的注入**到运行中的 App 里截屏。
// 不是 PS 效果图：注入的就是将来要写进正式代码的那套定位 + backdrop-filter。
// usage: node bench/mock-blur.mjs [port]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9555);
const SEC = Number(process.env.SEC || 95);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
async function cmd(method, params) {
  const i = ++id;
  const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
  return m.result;
}
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

await cmd('Runtime.enable');
await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(1000);

// 跳到一个有烧录字幕的时间点并暂停
await ev(`new Promise((res) => {
  const p = document.getElementById('player');
  p.pause();
  const on = () => { p.removeEventListener('seeked', on); setTimeout(res, 900); };
  p.addEventListener('seeked', on);
  p.currentTime = ${SEC};
  setTimeout(res, 6000);
})`);

// ── 注入：定位 + 遮罩 + 控件 ──
await ev(`(function(){
  const wrap = document.getElementById('playerWrap');
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

  // 视频内容区（object-fit: contain）在 playerWrap 里的真实位置
  window.__subBand = function () {
    const v = document.getElementById('player');
    const r = v.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const mA = v.videoWidth / v.videoHeight, cA = r.width / r.height;
    let cw, ch;
    if (mA > cA) { cw = r.width; ch = cw / mA; } else { ch = r.height; cw = ch * mA; }
    const ox = (r.x - wr.x) + (r.width - cw) / 2;
    const oy = (r.y - wr.y) + (r.height - ch) / 2;
    // 烧录字幕落在视频内容底部约 11% 的「字幕安全区」里
    return { x: ox, y: oy + ch * 0.905, w: cw, h: ch * 0.082, cw, ch };
  };

  window.__applyBlur = function (on, opts) {
    opts = opts || {};
    let el = document.getElementById('mock-blur');
    if (!on) { if (el) el.remove(); return; }
    const b = window.__subBand();
    if (!el) { el = document.createElement('div'); el.id = 'mock-blur'; wrap.appendChild(el); }
    const feather = opts.feather === false ? 'none'
      : 'linear-gradient(to bottom, transparent 0%, #000 30%, #000 70%, transparent 100%)';
    Object.assign(el.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: 6,
      left: (b.x + b.w * 0.015) + 'px',
      width: (b.w * 0.97) + 'px',
      top: b.y + 'px',
      height: b.h + 'px',
      borderRadius: '8px',
      backdropFilter: 'blur(' + (opts.radius || 34) + 'px) saturate(0.92) brightness(0.94)',
      webkitBackdropFilter: 'blur(' + (opts.radius || 34) + 'px) saturate(0.92) brightness(0.94)',
      background: opts.bg || 'rgba(8,10,14,0.10)',
      maskImage: feather, webkitMaskImage: feather,
    });
  };

  // 播放器栏里的开关按钮（沿用 .pb-btn 的样式）
  if (!document.getElementById('mockToggle')) {
    const bar = document.querySelector('#playerBar .pb-right');
    const btn = document.createElement('button');
    btn.id = 'mockToggle';
    btn.className = 'pb-btn';
    btn.textContent = '模糊字幕';
    btn.style.cssText = 'background:var(--brand);color:#fff;border-color:var(--brand)';
    bar.insertBefore(btn, bar.firstChild);
  }
  // 画面左上角的提示条
  if (!document.getElementById('mockChip')) {
    const b = window.__subBand();
    const chip = document.createElement('div');
    chip.id = 'mockChip';
    chip.textContent = '听力模式 · 画面字幕已模糊（按住 Alt 看原文）';
    chip.style.cssText = 'position:absolute;z-index:7;pointer-events:none;'
      + 'left:' + (b.x + b.w * 0.02) + 'px;top:' + (b.y - 34) + 'px;'
      + 'padding:5px 11px;border-radius:999px;font-size:12.5px;letter-spacing:.2px;'
      + 'background:rgba(12,15,20,.72);color:#e8eefc;backdrop-filter:blur(6px);'
      + 'border:1px solid rgba(255,255,255,.14)';
    wrap.appendChild(chip);
  }
  return 'injected';
})()`);

// 1) 开启前（全页）
await ev(`(function(){
  window.__applyBlur(false);
  document.getElementById('mockChip').style.display = 'none';
  const t = document.getElementById('mockToggle');
  t.style.background = ''; t.style.color = ''; t.style.borderColor = '';
  return 'off';
})()`);
await sleep(500);
writeFileSync('shots/ui-off.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 2) 开启后（全页）
await ev(`(function(){
  window.__applyBlur(true);
  document.getElementById('mockChip').style.display = '';
  const t = document.getElementById('mockToggle');
  t.style.background = 'var(--brand)'; t.style.color = '#fff'; t.style.borderColor = 'var(--brand)';
  return 'on';
})()`);
await sleep(700);
writeFileSync('shots/ui-on.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 3) 关掉遮罩，单独截视频区（给样式对比用）
await ev(`(function(){
  window.__applyBlur(false);
  document.getElementById('mockChip').style.display = 'none';
  return 'clean';
})()`);
await sleep(500);
const rect = JSON.parse(await ev('JSON.stringify((function(){const r=document.getElementById("playerWrap").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})())'));
writeFileSync('shots/video-clean.png', Buffer.from((await cmd('Page.captureScreenshot', {
  format: 'png', clip: { ...rect, scale: 1 },
})).data, 'base64'));

// 视频**内容区**（去掉黑边）在截图像素里的位置，交给排版脚本用
const box = JSON.parse(await ev(`JSON.stringify((function(){
  const v = document.getElementById('player');
  const r = v.getBoundingClientRect();
  const mA = v.videoWidth / v.videoHeight, cA = r.width / r.height;
  let cw, ch;
  if (mA > cA) { cw = r.width; ch = cw / mA; } else { ch = r.height; cw = ch * mA; }
  const dpr = devicePixelRatio;
  const bar = document.getElementById('playerBar').getBoundingClientRect();
  return { x: r.x*dpr + (r.width-cw)/2*dpr, y: r.y*dpr + (r.height-ch)/2*dpr, w: cw*dpr, h: ch*dpr, dpr: dpr,
           bar: { x: Math.max(0, bar.x*dpr - 8), y: Math.max(0, bar.y*dpr - 8), w: (bar.width*dpr) + 16, h: (bar.height*dpr) + 16 } };
})())`));
writeFileSync('shots/geom.json', JSON.stringify(box));
console.log('已保存 shots/ui-off.png / ui-on.png / video-clean.png / geom.json');
console.log('视频内容区(截图px):', JSON.stringify(box));
ws.close();
process.exit(0);
