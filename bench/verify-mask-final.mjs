// 最终验证：在真实视频的同一暂停帧上，逐个样式量「字幕还透出多少」。
// usage: node bench/verify-mask-final.mjs <videoPath> [port]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[3] || 9555);
const videoPath = process.argv[2];
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
const ev = async (e) => {
  const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

await cmd('Runtime.enable');
await cmd('DOM.enable');
// 视口固定，保证每次量到的像素尺寸一致
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

// 1) 重新载入视频（页面刷新后 file input 是空的）
const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [videoPath], nodeId: q.nodeId });
await ev(`new Promise((res) => { const p = document.getElementById('player');
  if (p.readyState >= 2 && p.videoWidth) return res(1);
  p.addEventListener('loadeddata', () => res(1), { once: true }); setTimeout(() => res(0), 25000); })`);

const GEO = `(function(){
  const v = document.getElementById('player');
  const r = v.getBoundingClientRect(), w = document.getElementById('playerWrap').getBoundingClientRect();
  const mA = v.videoWidth / v.videoHeight, cA = r.width / r.height;
  let cw, ch; if (mA > cA) { cw = r.width; ch = cw / mA; } else { ch = r.height; cw = ch * mA; }
  return { x: r.x + (r.width - cw) / 2, y: r.y + (r.height - ch) / 2, w: cw, h: ch,
           wrap: { x: w.x, y: w.y, width: w.width, height: w.height } };
})()`;

const at = Number(process.env.AT_SEC || 95);
await ev(`new Promise((res) => { const p = document.getElementById('player');
  p.pause(); const on = () => { p.removeEventListener('seeked', on); setTimeout(res, 1000); };
  p.addEventListener('seeked', on); p.currentTime = ${at}; setTimeout(res, 8000); })`);
const paused = await ev(`document.getElementById('player').paused`);
const geo = JSON.parse(await ev(`JSON.stringify(${GEO})`));

async function capture(name, { enabled, style }) {
  await ev(`(function(){
    const c = document.getElementById('chkMask');
    if (c.checked !== ${enabled}) { c.checked = ${enabled}; c.dispatchEvent(new Event('change', { bubbles: true })); }
    if (${enabled}) { const s = document.getElementById('setMaskStyle'); s.value = '${style}'; s.dispatchEvent(new Event('change', { bubbles: true })); }
    return 1; })()`);
  await sleep(900);
  const s = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: geo.wrap.x, y: geo.wrap.y, width: geo.wrap.width, height: geo.wrap.height, scale: 1 } });
  writeFileSync('shots/' + name, Buffer.from(s.data, 'base64'));
}

await capture('final-off.png', { enabled: false, style: 'soft' });
for (const style of ['soft', 'frosted', 'mosaic', 'solid']) {
  await capture(`final-${style}.png`, { enabled: true, style });
}
await ev(`(function(){ const c=document.getElementById('chkMask'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);

console.log(JSON.stringify({
  atSeconds: at, paused, videoContent: geo, wrap: geo.wrap,
  files: ['final-off.png', 'final-soft.png', 'final-frosted.png', 'final-mosaic.png', 'final-solid.png'],
}, null, 1));
ws.close();
process.exit(0);
