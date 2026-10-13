// 在打包好的 App 里测「画面字幕遮罩」：定位、样式、自动检测、Alt 揭开。
// usage: node bench/test-mask.mjs <videoPath> [port]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[3] || 9555);
const videoPath = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
});
async function cmd(method, params) {
  const i = ++id;
  const m = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
  return m.result;
}
async function ev(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

await cmd('Runtime.enable');
await cmd('DOM.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(1200);

const out = {};

// 1) 载入真实视频
const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [videoPath], nodeId: q.nodeId });
await ev(`new Promise((res) => { const p = document.getElementById('player');
  if (p.readyState >= 2 && p.videoWidth) return res(1);
  p.addEventListener('loadeddata', () => res(1), { once: true }); setTimeout(() => res(0), 25000); })`);
await ev(`new Promise((res) => { const p = document.getElementById('player');
  const on = () => { p.removeEventListener('seeked', on); setTimeout(res, 800); };
  p.addEventListener('seeked', on); p.pause(); p.currentTime = 95; setTimeout(res, 6000); })`);

out.video = JSON.parse(await ev(`JSON.stringify({ w: document.getElementById('player').videoWidth, h: document.getElementById('player').videoHeight, dur: document.getElementById('player').duration })`));

// 2) 开关存在吗
out.toggleButton = await ev(`(function(){ const b = document.getElementById('btnMask');
  return b ? { text: b.textContent.trim(), hasI18n: !!b.dataset.i18n, on: b.classList.contains('on') } : null; })()`);

// 3) 默认应该是关的
out.beforeEnable = JSON.parse(await ev(`JSON.stringify({
  layer: !!document.querySelector('.submask'),
  layerHidden: document.querySelector('.submask')?.hidden,
  chipHidden: document.querySelector('.submask-chip')?.hidden
})`));

// 4) 点开关
await ev(`document.getElementById('btnMask').click(); 1`);
await sleep(900);

const state = () => ev(`(function(){
  const l = document.querySelector('.submask');
  const c = document.querySelector('.submask-chip');
  const r = l ? l.getBoundingClientRect() : null;
  const p = document.getElementById('player').getBoundingClientRect();
  const cs = l ? getComputedStyle(l) : null;
  const v = document.getElementById('player');
  const mA = v.videoWidth / v.videoHeight, cA = p.width / p.height;
  let cw, ch; if (mA > cA) { cw = p.width; ch = cw / mA; } else { ch = p.height; cw = ch * mA; }
  const cy = p.y + (p.height - ch) / 2;
  return JSON.stringify({
    layerHidden: l?.hidden,
    chipHidden: c?.hidden,
    chipText: c?.textContent || '',
    backdropFilter: cs?.backdropFilter || '',
    background: cs?.backgroundColor || '',
    maskImage: (cs?.maskImage || '').slice(0, 44),
    box: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    videoContent: { y: Math.round(cy), h: Math.round(ch) },
    // 遮罩覆盖了画面内容的哪一段（比例）
    coverTop: r ? +(((r.y - cy) / ch).toFixed(3)) : null,
    coverBottom: r ? +(((r.bottom - cy) / ch).toFixed(3)) : null,
    settings: { style: document.getElementById('setMaskStyle').value,
                strength: +document.getElementById('setMaskStrength').value,
                auto: document.getElementById('chkMaskAuto').checked,
                top: +document.getElementById('setMaskTop').value,
                bottom: +document.getElementById('setMaskBottom').value },
    btnOn: document.getElementById('btnMask').classList.contains('on')
  });
})()`);

out.enabled = JSON.parse(await state());

// 5) Alt 临时揭开
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' })); 1`);
await sleep(350);
out.peekOn = JSON.parse(await ev(`JSON.stringify({
  peek: document.querySelector('.submask')?.classList.contains('peek'),
  opacity: getComputedStyle(document.querySelector('.submask')).opacity
})`));
await ev(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' })); 1`);
await sleep(350);
out.peekOff = JSON.parse(await ev(`JSON.stringify({
  peek: document.querySelector('.submask')?.classList.contains('peek'),
  opacity: getComputedStyle(document.querySelector('.submask')).opacity
})`));

// 6) 整片自动定位
const beforeDetect = JSON.parse(await state());
await ev(`document.getElementById('btnMaskDetect').click(); 1`);
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const chip = await ev(`document.querySelector('.submask-chip')?.textContent || ''`);
  if (!/定位/.test(chip)) break;
}
await sleep(600);
out.detect = { before: beforeDetect.settings, after: JSON.parse(await state()).settings };
// 真值：这一帧的字幕在 1080 里约 y=989..1034，即 0.916~0.957
out.detect.groundTruth = { topRatio: 0.916, bottomRatio: 0.957 };

// 7) 四种样式各截一张（裁视频内容区）
for (const style of ['soft', 'frosted', 'mosaic', 'solid']) {
  await ev(`(function(){ const s = document.getElementById('setMaskStyle'); s.value = '${style}'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await sleep(900);
  const g = JSON.parse(await ev(`JSON.stringify((function(){
    const v = document.getElementById('player'); const r = v.getBoundingClientRect();
    const mA = v.videoWidth/v.videoHeight, cA = r.width/r.height;
    let cw, ch; if (mA > cA) { cw = r.width; ch = cw/mA; } else { ch = r.height; cw = ch*mA; }
    return { x: r.x + (r.width-cw)/2, y: r.y + (r.height-ch)/2, width: cw, height: ch };
  })())`));
  const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { ...g, scale: 1 } });
  writeFileSync(`shots/mask-${style}.png`, Buffer.from(shot.data, 'base64'));
  out[`style_${style}`] = JSON.parse(await ev(`JSON.stringify({ filter: getComputedStyle(document.querySelector('.submask')).backdropFilter, canvasHidden: document.querySelector('.submask-canvas')?.hidden })`));
}

// 8) 整页截图（柔和模糊）
await ev(`(function(){ const s = document.getElementById('setMaskStyle'); s.value = 'soft'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(900);
writeFileSync('shots/mask-fullpage.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

out.logs = logs.filter((l) => /EXCEPTION|Error/.test(l)).slice(0, 6);
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
