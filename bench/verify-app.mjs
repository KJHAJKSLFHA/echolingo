// 连接到一个**已经在运行**的 Electron 应用（--remote-debugging-port=9555），
// 把真实媒体文件塞进页面，实测整条识别链路。
//
// usage: node bench/verify-app.mjs <mediaPath> [port]
import { readFileSync } from 'node:fs';

const PORT = Number(process.argv[3] || 9555);
const mediaPath = process.argv[2];
if (!mediaPath) { console.error('usage: node bench/verify-app.mjs <mediaPath> [port]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        c.logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, timeout: 1800000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('找不到页面目标:', list.map((t) => t.type + ' ' + t.url)); process.exit(1); }

const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');

const env = await cdp.eval(`({
  iso: self.crossOriginIsolated,
  sab: typeof SharedArrayBuffer !== 'undefined',
  hc: navigator.hardwareConcurrency,
  mem: navigator.deviceMemory || 0,
  origin: location.origin,
  sw: !!navigator.serviceWorker.controller,
  online: navigator.onLine,
  ua: (navigator.userAgent.match(/Electron\\/[\\d.]+/) || [])[0] || navigator.userAgent.slice(0, 60)
})`);

// 等应用把模型预热好
let ready = 'timeout';
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const s = await cdp.eval('document.getElementById("txtAsr")?.textContent || ""');
  if (/就绪|ready/.test(s)) { ready = 'ready'; break; }
  await sleep(500);
}

await cdp.eval(`
  window.__v = { t0: 0, cues: 0, first: null, last: null, done: false, prog: [] };
  window.__vReset = () => { const v = window.__v; v.t0 = performance.now(); v.cues = 0; v.first = null; v.last = null; v.done = false; v.prog = []; };
  window.__vTick = () => {
    const v = window.__v; if (!v.t0) return null;
    const now = Math.round(performance.now() - v.t0);
    const n = document.querySelectorAll('#subs .cue').length;
    if (n !== v.cues) { v.cues = n; if (v.first === null) v.first = now; v.last = now; }
    const p = (document.getElementById('progressText')?.textContent || '').trim();
    if (p && p !== v.prog.at(-1)?.p) v.prog.push({ t: now, p: p.slice(0, 90) });
    const busy = document.getElementById('btnTranscribe')?.disabled;
    const hint = document.querySelectorAll('.recog-hint').length;
    if (n > 0 && !busy && document.getElementById('progressWrap')?.hidden && !hint) v.done = true;
    return v;
  };
  'ok';
`);

const doc = await cdp.send('DOM.getDocument', { depth: 1 });
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileVideo' });
if (!q.nodeId) throw new Error('找不到 #fileVideo');
await cdp.send('DOM.setFileInputFiles', { files: [mediaPath], nodeId: q.nodeId });
await cdp.eval('window.__vReset(); "go"');

let v = null;
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
  v = await cdp.eval('window.__vTick()');
  if (v?.done) break;
  await sleep(500);
}

const tail = await cdp.eval(`({
  duration: document.getElementById('player').duration || null,
  asr: document.getElementById('txtAsr')?.textContent,
  mt: document.getElementById('txtMt')?.textContent,
  en: [...document.querySelectorAll('#subs .cue .cue-en')].slice(0,3).map(e=>e.textContent.trim()),
  zh: [...document.querySelectorAll('#subs .cue .cue-zh')].slice(0,3).map(e=>e.textContent.trim()),
  words: [...document.querySelectorAll('#subs .cue .cue-en')].reduce((n,e)=>n+e.textContent.trim().split(/\\s+/).length,0),
  toast: document.getElementById('toast')?.textContent || ''
})`);

console.log(JSON.stringify({
  media: mediaPath,
  renderer: env,
  modelReady: ready,
  videoDurationSec: tail.duration,
  firstCueMs: v?.first,
  allCuesMs: v?.last,
  cueCount: v?.cues,
  totalEnWords: tail.words,
  asrStatus: tail.asr,
  mtStatus: tail.mt,
  enSample: tail.en,
  zhSample: tail.zh,
  toast: tail.toast,
  progressTail: (v?.prog || []).slice(-6),
  appLogs: cdp.logs.filter((l) => /asr-pool|EchoLingo|并行/.test(l)),
}, null, 2));
