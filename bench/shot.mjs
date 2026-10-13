// 打开站点 → 塞入真实视频 → 在指定时间点暂停 → 截图。
// 用来拿真实视频画面做功能预览图。
// usage: node bench/shot.mjs <videoPath> <outPrefix> <t1,t2,t3...> [port]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;
const APP = 'http://127.0.0.1:8899/index.html';
const [videoPath, outPrefix, timesArg] = process.argv.slice(2);
const TIMES = (timesArg || '20').split(',').map(Number);

const profile = mkdtempSync(join(tmpdir(), 'echo-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox',
  '--disable-crash-reporter', '--disable-breakpad',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', '--window-size=1600,1000', '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}

const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
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
await cmd('Page.navigate', { url: APP });
for (let i = 0; i < 200; i++) {
  if (await ev('document.querySelectorAll("#setAsrModel option").length > 0')) break;
  await sleep(200);
}

const doc = await cmd('DOM.getDocument', { depth: 1 });
const q = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
await cmd('DOM.setFileInputFiles', { files: [videoPath], nodeId: q.nodeId });

// 等元数据 + 首帧
await ev(`new Promise((res) => {
  const p = document.getElementById('player');
  const done = () => res(true);
  if (p.readyState >= 2) return done();
  p.addEventListener('loadeddata', done, { once: true });
  setTimeout(done, 20000);
})`);

// 关掉自动滚动干扰，清空右侧以免挡住画面（右侧是独立列，不影响）
for (const sec of TIMES) {
  await ev(`new Promise((res) => {
    const p = document.getElementById('player');
    const on = () => { p.removeEventListener('seeked', on); setTimeout(res, 700); };
    p.addEventListener('seeked', on);
    p.pause();
    p.currentTime = ${sec};
    setTimeout(res, 4000);
  })`);
  const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${outPrefix}-${sec}s.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const info = await ev(`JSON.stringify({ cur: document.getElementById('player').currentTime, w: document.getElementById('player').videoWidth, h: document.getElementById('player').videoHeight, rs: document.getElementById('player').readyState })`);
  console.log(file, info);
}

chrome.kill('SIGKILL');
process.exit(0);
