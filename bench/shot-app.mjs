// 连接**已运行**的 Electron 应用，塞入视频、跳到指定时间点、截图。
// usage: node bench/shot-app.mjs <videoPath> <outPrefix> <t1,t2,...> [port]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[5] || 9555);
const [videoPath, outPrefix, timesArg] = process.argv.slice(2);
const TIMES = (timesArg || '25').split(',').map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('找不到页面'); process.exit(1); }

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
await cmd('DOM.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
await sleep(1200);

const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [videoPath], nodeId: q.nodeId });

await ev(`new Promise((res) => {
  const p = document.getElementById('player');
  if (p.readyState >= 2 && p.videoWidth) return res(true);
  const done = () => res(true);
  p.addEventListener('loadeddata', done, { once: true });
  setTimeout(done, 25000);
})`);
console.log('meta:', await ev(`JSON.stringify({w: document.getElementById('player').videoWidth, h: document.getElementById('player').videoHeight, dur: document.getElementById('player').duration})`));

for (const sec of TIMES) {
  await ev(`new Promise((res) => {
    const p = document.getElementById('player');
    p.pause();
    const on = () => { p.removeEventListener('seeked', on); setTimeout(res, 900); };
    p.addEventListener('seeked', on);
    p.currentTime = ${sec};
    setTimeout(res, 6000);
  })`);
  const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${outPrefix}-${sec}s.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(file, await ev(`JSON.stringify({cur: +document.getElementById('player').currentTime.toFixed(2), rs: document.getElementById('player').readyState})`));
}

ws.close();
process.exit(0);
